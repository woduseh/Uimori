import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { expect, test, type APIRequestContext } from '@playwright/test';
import type {
  HelperContextSummaryView,
  HelperConversation,
  HelperTaskResultsView,
} from '../core/helper.js';
import type { Content, ModelWorkspace } from '../core/product.js';
import type { Chat, ChatDetail } from '../core/types.js';
import type { HelperTaskView } from '../web/useHelperConversation.js';
import { postFixtureChat, fixtureBotInput } from './fixtures/chat.js';
import { nativeContent } from './fixtures/native-content.js';
import { openHelper, expectEditorSection, selectEditorSection } from './ui-navigation.js';

test.setTimeout(60000);

async function seed(
  request: APIRequestContext,
  profiles?: { name: string; appearance: string }[],
  followUps = 0
) {
  let sendProfiles = !!profiles;
  const provider = createServer(async (incoming, response) => {
    for await (const _chunk of incoming) {
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const events = sendProfiles
      ? [
          {
            type: 'tool_delta',
            index: 0,
            id: 'save-profiles',
            name: 'app.call',
            argumentsDelta: JSON.stringify({
              name: 'illustration.profiles.save',
              arguments: { expectedRevision: 0, profiles },
            }),
          },
          { type: 'done', reason: 'tool_calls' },
        ]
      : [
          { type: 'text_delta', delta: '요청 내용을 확인했어요.' },
          { type: 'usage', inputTokens: 120, outputTokens: 12, costUsd: null },
          { type: 'done', reason: 'stop' },
        ];
    sendProfiles = false;
    response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
  });
  await new Promise<void>((resolve, reject) => {
    provider.once('error', reject);
    provider.listen(0, '127.0.0.1', resolve);
  });
  const address = provider.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server did not start');
  const baselineResponse = await request.get('/api/model-workspace');
  expect(baselineResponse.ok()).toBe(true);
  const baseline = (await baselineResponse.json()) as ModelWorkspace;
  let selected = false;
  try {
    const connection = await request.post('/api/connections', {
      data: {
        title: `결과 검증 연결 ${randomUUID()}`,
        protocol: 'fixture-sse-v1',
        endpoint: `http://127.0.0.1:${address.port}/`,
        enabled: true,
      },
    });
    expect(connection.ok(), await connection.text()).toBe(true);
    const model = await request.post('/api/model-presets', {
      data: {
        title: '결과 검증 도우미',
        connectionId: (await connection.json()).id,
        modelId: 'synthetic-results-helper',
        inputTokenLimit: 272000,
        maxOutputTokens: 1024,
        temperature: null,
      },
    });
    expect(model.ok(), await model.text()).toBe(true);
    const selection = await request.put('/api/model-workspace', {
      data: {
        expectedRevision: baseline.revision,
        routes: baseline.routes,
        translationPolicy: baseline.translationPolicy,
        helperModel: { id: (await model.json()).id },
      },
    });
    expect(selection.ok(), await selection.text()).toBe(true);
    selected = true;
    const created = await postFixtureChat(request, {
      data: { title: `도우미 결과 ${randomUUID()}` },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const chat = (await created.json()) as Chat;
    const opened = await request.post('/api/helper/conversations', {
      data: { scope: { kind: 'chat', chatId: chat.id } },
    });
    expect(opened.ok(), await opened.text()).toBe(true);
    const conversation = (await opened.json()) as HelperConversation;
    const admitted = await request.post(`/api/helper/conversations/${conversation.id}/messages`, {
      data: {
        requestKey: randomUUID(),
        text: profiles
          ? '두 인물의 외형을 삽화 참고에 저장해 줘.'
          : '자료를 변경하지 않고 간단히 답해 주세요.',
      },
    });
    expect(admitted.ok(), await admitted.text()).toBe(true);
    const task = (await admitted.json()) as HelperTaskView;
    const completed = async (id: string) =>
      expect
        .poll(async () => {
          const current = await request.get(`/api/helper/tasks/${id}`);
          expect(current.ok()).toBe(true);
          return ((await current.json()) as HelperTaskView).status;
        })
        .toBe('completed');
    await completed(task.id);
    const later: HelperTaskView[] = [];
    for (let index = 0; index < followUps; index++) {
      const next = await request.post(`/api/helper/conversations/${conversation.id}/messages`, {
        data: { requestKey: randomUUID(), text: `이어지는 요청 ${index + 1}` },
      });
      expect(next.ok(), await next.text()).toBe(true);
      later.push((await next.json()) as HelperTaskView);
      await completed(later.at(-1)!.id);
    }
    return { chat, task, conversation, later };
  } finally {
    try {
      if (selected) {
        const current = (await (
          await request.get('/api/model-workspace')
        ).json()) as ModelWorkspace;
        const restored = await request.put('/api/model-workspace', {
          data: {
            expectedRevision: current.revision,
            routes: baseline.routes,
            translationPolicy: baseline.translationPolicy,
            helperModel: baseline.helperModel ?? null,
          },
        });
        expect(restored.ok(), await restored.text()).toBe(true);
        expect(await (await request.get('/api/model-workspace')).json()).toEqual({
          ...baseline,
          revision: expect.any(Number),
        });
      }
    } finally {
      provider.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        provider.close((error) => (error ? reject(error) : resolve()))
      );
    }
  }
}

test('an appearance result opens both saved characters in the chat image settings', async ({
  page,
  request,
}) => {
  const { chat } = await seed(request, [
    { name: '미라', appearance: '은빛 단발' },
    { name: '준', appearance: '검은 곱슬머리' },
  ]);
  const { characterProfiles: profiles, revision } = await (
    await request.get(`/api/chats/${chat.id}/illustration-references`)
  ).json();
  await page.goto(`/?chat=${chat.id}`);
  await openHelper(page);
  await page.getByRole('button', { name: '준 인물 외형 열기', exact: true }).click();
  const editor = page.getByTestId('illustration-references');
  await expect(editor).toBeVisible();
  await expect(editor.getByRole('textbox', { name: '외형', exact: true }).nth(1)).toHaveValue(
    '검은 곱슬머리'
  );
  const changed = await request.put(`/api/chats/${chat.id}/illustration-references`, {
    data: {
      expectedRevision: revision,
      references: [],
      characterProfiles: [profiles[0], { ...profiles[1], appearance: '짧은 곱슬머리' }],
    },
  });
  expect(changed.ok(), await changed.text()).toBe(true);
  await expect(editor.getByRole('textbox', { name: '외형', exact: true }).nth(1)).toHaveValue(
    '짧은 곱슬머리'
  );
});

function changeProjection(taskId: string, chatId: string): HelperTaskResultsView {
  return {
    taskId,
    status: 'completed',
    results: [],
    changes: [
      {
        domain: 'scene',
        targetId: 'scene-source:original',
        title: '등대지기의 밤',
        location: { kind: 'scene', scene: 3, field: 'original' },
        action: 'update',
        diff: {
          mode: 'prose',
          unit: 'word',
          added: 2,
          removed: 2,
          hunks: [
            {
              beforeOffset: 0,
              afterOffset: 0,
              segments: [
                { op: 'equal', text: '그는 등불을 들고 ' },
                { op: 'delete', text: '다리를' },
                { op: 'insert', text: '강을' },
                { op: 'equal', text: ' 천천히 ' },
                { op: 'delete', text: '건넜다.' },
                { op: 'insert', text: '헤엄쳤다.' },
                { op: 'equal', text: '\n바람이 차가웠다.' },
              ],
            },
          ],
        },
        anchor: {
          domain: 'scene',
          chatId,
          sourceId: 'scene-source',
          field: 'original',
          paragraph: 0,
        },
      },
      {
        domain: 'resource',
        targetId: 'regex-bot',
        title: '정규식 봇',
        location: {
          kind: 'resource-field',
          path: ['package', 'nativeRisu', 'card', 'extensions', 'risuai', 'customScripts'],
        },
        action: 'update',
        diff: {
          mode: 'code',
          unit: 'line',
          added: 1,
          removed: 1,
          hunks: [
            {
              beforeOffset: 10,
              afterOffset: 10,
              segments: [
                { op: 'equal', text: '  {\n' },
                { op: 'delete', text: '    "in": "foo",\n' },
                { op: 'insert', text: '    "in": "bar",\n' },
                { op: 'equal', text: '  }\n' },
              ],
            },
          ],
        },
        anchor: {
          domain: 'resource',
          kind: 'content',
          id: 'regex-bot',
          path: '/package/nativeRisu/card/extensions/risuai/customScripts',
          section: 'field',
          index: null,
        },
      },
      {
        domain: 'resource',
        targetId: 'large-bot',
        title: '긴 설명 봇',
        location: {
          kind: 'resource-field',
          path: ['package', 'nativeRisu', 'card', 'description'],
        },
        action: 'update',
        diff: { mode: 'prose', unit: 'word', omitted: 'size' },
        anchor: {
          domain: 'resource',
          kind: 'content',
          id: 'large-bot',
          path: '/package/nativeRisu/card/description',
          section: 'field',
          index: null,
        },
      },
      {
        domain: 'resource',
        targetId: 'lore-bot',
        title: '항구 봇',
        location: {
          kind: 'resource-list',
          path: ['package', 'nativeRisu', 'card', 'character_book', 'entries'],
          section: 'lore',
          item: { name: '폭풍의 항구 (Storm)', index: 2 },
          field: ['content'],
        },
        action: 'create',
        diff: null,
        anchor: null,
      },
      {
        domain: 'resource',
        targetId: 'custom-bot',
        title: '사용자 필드 봇',
        location: {
          kind: 'resource-field',
          path: ['package', 'nativeRisu', 'card', 'extensions', 'customField'],
        },
        action: 'update',
        diff: null,
        anchor: null,
      },
      {
        domain: 'resource',
        targetId: 'story-theme',
        title: '등대 테마',
        location: { kind: 'resource-field', path: ['storyUi', 'css'] },
        action: 'update',
        diff: null,
        anchor: null,
      },
      {
        domain: 'resource',
        targetId: 'harbor-preset',
        title: '항구 삽화',
        location: { kind: 'resource-field', path: ['description'] },
        action: 'update',
        diff: null,
        anchor: null,
      },
      {
        domain: 'resource',
        targetId: 'legacy-bot',
        title: '예전 봇',
        location: '로어북 › 등대',
        action: 'update',
        diff: null,
        anchor: null,
      },
      {
        domain: 'scene',
        targetId: 'removed-source:original',
        title: '지운 장면',
        location: null,
        action: 'update',
        diff: null,
        anchor: null,
        textRemoved: 'deleted',
      },
      {
        domain: 'resource',
        targetId: 'gone-bot',
        title: '삭제한 봇',
        location: null,
        action: 'delete',
        diff: null,
        anchor: null,
      },
    ],
    confirmations: [],
    unrecordedOperations: 0,
    usage: { toolExecutions: 5, attempts: [], latestInputEstimate: null },
  };
}

test('HCHANGE01 change cards show marked words, code lines and the states without a diff', async ({
  page,
  request,
}) => {
  const { chat, task } = await seed(request);
  await page.route(`**/api/helper/tasks/${task.id}/results`, (route) =>
    route.fulfill({ json: changeProjection(task.id, chat.id) })
  );
  await page.goto(`/?chat=${chat.id}`);
  await openHelper(page);
  const results = page
    .locator(`.helper-message.assistant[data-task-id="${task.id}"]`)
    .getByTestId('helper-task-results');
  const prose = results.locator('.helper-change-toggle', { hasText: '등대지기의 밤' });
  await expect(prose).toHaveAttribute('aria-expanded', 'false');
  await expect(results.getByRole('region', { name: /등대지기의 밤/ })).toBeHidden();
  await expect(results.getByText('삭제됨', { exact: true })).toBeVisible();
  await expect(
    results.getByRole('button', { name: '등대지기의 밤, 장면 3, 원문 열기', exact: true })
  ).toBeVisible();
  await prose.click();
  await expect(prose).toHaveAttribute('aria-expanded', 'true');
  const paragraph = results.getByRole('region', { name: /등대지기의 밤/ }).locator('p');
  await expect(paragraph).toHaveCount(1);
  await expect(paragraph.locator('del')).toHaveText(['삭제된 부분 다리를', '삭제된 부분 건넜다.']);
  await expect(paragraph.locator('ins')).toHaveText(['추가된 부분 강을', '추가된 부분 헤엄쳤다.']);
  await expect(paragraph).toContainText('그는 등불을 들고');
  await results.locator('.helper-change-toggle', { hasText: '정규식 봇' }).click();
  const code = results.getByRole('region', { name: /정규식 봇/ });
  await expect(code.locator('.helper-diff-line')).toHaveCount(4);
  await expect(code.locator('.helper-diff-line[data-op="delete"] code')).toHaveText(
    '    "in": "foo",'
  );
  await expect(code.locator('.helper-diff-line[data-op="insert"] code')).toHaveText(
    '    "in": "bar",'
  );
});

test('HCHANGE03 opening a change lands on its paragraph or lore entry and keeps the helper beside it', async ({
  page,
  request,
}) => {
  const { chat, task } = await seed(request);
  const before = (await (await request.get(`/api/chats/${chat.id}`)).json()) as ChatDetail;
  const started = await request.post(`/api/chats/${chat.id}/runs`, {
    data: {
      request: '긴 장면',
      expectedRevision: before.chat.headRevision,
      expectedSettingsRevision: before.chat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
  });
  expect(started.ok(), await started.text()).toBe(true);
  const run = (await started.json()) as { id: string };
  await expect
    .poll(async () => {
      const current = (await (await request.get(`/api/chats/${chat.id}`)).json()) as ChatDetail;
      return current.runs.find((item) => item.id === run.id)?.status;
    })
    .toBe('completed');
  const generated = ((await (await request.get(`/api/chats/${chat.id}`)).json()) as ChatDetail)
    .sources[0]!;
  const paragraphs = Array.from(
    { length: 40 },
    (_, index) => `문단 ${index + 1}: 등대지기는 젖은 계단을 하나씩 올라 불을 살폈다.`
  );
  const edited = await request.put(`/api/sources/${generated.id}/text`, {
    data: { text: paragraphs.join('\n\n'), expectedRevision: generated.editRevision ?? 0 },
  });
  expect(edited.ok(), await edited.text()).toBe(true);
  const source = (await edited.json()) as ChatDetail['sources'][number];
  const bot = fixtureBotInput('로어 이동 봇', '설명');
  bot.package = nativeContent({
    name: '로어 이동 봇',
    description: '설명',
    character_book: {
      entries: ['항구', '등대', '폭풍'].map((name) => ({
        keys: [name],
        comment: name,
        content: `${name}에 관한 설명`,
      })),
    },
  });
  const created = await request.post('/api/content', { data: bot });
  expect(created.ok(), await created.text()).toBe(true);
  const content = (await created.json()) as Content;
  const projection: HelperTaskResultsView = {
    taskId: task.id,
    status: 'completed',
    results: [],
    changes: [
      {
        domain: 'scene',
        targetId: `${source.id}:original`,
        title: chat.title,
        location: { kind: 'scene', scene: 1, field: 'original' },
        action: 'update',
        diff: {
          mode: 'prose',
          unit: 'word',
          added: 1,
          removed: 1,
          hunks: [
            {
              beforeOffset: 0,
              afterOffset: 0,
              segments: [
                { op: 'equal', text: '문단 31: ' },
                { op: 'delete', text: '마른' },
                { op: 'insert', text: '젖은' },
              ],
            },
          ],
        },
        anchor: {
          domain: 'scene',
          chatId: chat.id,
          sourceId: source.id,
          field: 'original',
          paragraph: 60,
        },
      },
      {
        domain: 'resource',
        targetId: content.id,
        title: content.title,
        location: {
          kind: 'resource-list',
          path: ['package', 'nativeRisu', 'card', 'character_book', 'entries'],
          section: 'lore',
          item: { name: '폭풍', index: 0 },
          field: ['content'],
        },
        action: 'update',
        diff: {
          mode: 'prose',
          unit: 'word',
          added: 1,
          removed: 0,
          hunks: [
            {
              beforeOffset: 0,
              afterOffset: 0,
              segments: [
                { op: 'equal', text: '폭풍에 관한 ' },
                { op: 'insert', text: '설명' },
              ],
            },
          ],
        },
        anchor: {
          domain: 'resource',
          kind: 'content',
          id: content.id,
          path: '/package/nativeRisu/card/character_book/entries/2/content',
          section: 'lore',
          index: 2,
        },
      },
    ],
    confirmations: [],
    unrecordedOperations: 0,
    usage: { toolExecutions: 2, attempts: [], latestInputEstimate: null },
  };
  await page.route(`**/api/helper/tasks/${task.id}/results`, (route) =>
    route.fulfill({ json: projection })
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/?chat=${chat.id}`);
  await openHelper(page);
  const helper = page.locator('#helper-panel');
  const results = helper.getByTestId('helper-task-results');
  await results
    .getByRole('button', { name: `${chat.title}, 장면 1, 원문 열기`, exact: true })
    .click();
  await expect.poll(() => new URL(page.url()).searchParams.get('source')).toBe(source.id);
  const marked = page.locator(`[data-source-id="${source.id}"] .arrival-mark`);
  await expect(marked).toHaveCount(1);
  const target = page
    .locator(`[data-source-id="${source.id}"]`)
    .getByText('문단 31: 등대지기는', { exact: false });
  await expect(target).toBeInViewport();
  await expect(helper).toBeVisible();
  await expect(helper.getByRole('button', { name: '도우미 크게 보기', exact: true })).toBeVisible();

  await helper.getByRole('button', { name: '도우미 크게 보기', exact: true }).click();
  await results
    .getByRole('button', { name: `${content.title}, 로어북, 폭풍, 로어 본문 열기`, exact: true })
    .click();
  const library = page.getByTestId('library-panel');
  await expectEditorSection(library, '로어북');
  await expect(library.getByRole('button', { name: '폭풍', exact: true })).toHaveAttribute(
    'aria-current',
    'true'
  );
  await expect(library.locator('.nl-detail.arrival-mark')).toBeVisible();
  await expect(helper).toBeVisible();
  await expect(helper.getByRole('button', { name: '도우미 크게 보기', exact: true })).toBeVisible();

  await selectEditorSection(library, '기본 정보');
  const name = library.getByRole('textbox', { name: /^(봇|페르소나|모듈) 이름$/u });
  await name.fill('저장하지 않은 이름');
  await helper.getByRole('button', { name: '도우미 크게 보기', exact: true }).click();
  await results
    .getByRole('button', { name: `${content.title}, 로어북, 폭풍, 로어 본문 열기`, exact: true })
    .click();
  await expect(library.getByRole('button', { name: '폭풍', exact: true })).toHaveAttribute(
    'aria-current',
    'true'
  );
  await expect(helper.getByRole('button', { name: '도우미 크게 보기', exact: true })).toBeVisible();
  await selectEditorSection(library, '기본 정보');
  await expect(name).toHaveValue('저장하지 않은 이름');
});

test('HUSAGE02 the context usage popover manually compacts the helper conversation and updates state', async ({
  page,
  request,
}) => {
  const { chat, conversation, task } = await seed(request);
  const provider = createServer(async (incoming, response) => {
    for await (const _chunk of incoming) {
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const events = [
      { type: 'text_delta', delta: '수동으로 정리한 도우미 대화 요약이에요.' },
      { type: 'usage', inputTokens: 80, outputTokens: 24, costUsd: null },
      { type: 'done', reason: 'stop' },
    ];
    response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
  });
  await new Promise<void>((resolve, reject) => {
    provider.once('error', reject);
    provider.listen(0, '127.0.0.1', resolve);
  });
  const address = provider.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server did not start');
  const baseline = (await (await request.get('/api/model-workspace')).json()) as ModelWorkspace;
  try {
    const connection = await (
      await request.post('/api/connections', {
        data: {
          title: `수동 압축 연결 ${randomUUID()}`,
          protocol: 'fixture-sse-v1',
          endpoint: `http://127.0.0.1:${address.port}/`,
          enabled: true,
        },
      })
    ).json();
    const model = await (
      await request.post('/api/model-presets', {
        data: {
          title: '수동 압축 모델',
          connectionId: connection.id,
          modelId: 'synthetic-manual-compact',
          inputTokenLimit: 200000,
          maxOutputTokens: 1024,
          temperature: null,
        },
      })
    ).json();
    const updated = await request.put('/api/model-workspace', {
      data: {
        expectedRevision: baseline.revision,
        routes: baseline.routes,
        translationPolicy: baseline.translationPolicy,
        helperModel: { id: model.id },
        contextModel: { id: model.id },
      },
    });
    expect(updated.ok(), await updated.text()).toBe(true);

    const usage: HelperTaskResultsView['usage'] = {
      toolExecutions: 1,
      attempts: [],
      latestInputEstimate: 42_000,
      latestInputLimit: 200_000,
      latestInputExecution: 'provider-tool-loop',
      latestInputParts: {
        instructions: 4_000,
        toolSchemas: 8_000,
        history: 24_000,
        source: 6_000,
        toolResults: null,
      },
    };
    await page.route(`**/api/helper/tasks/${task.id}/results`, (route) =>
      route.fulfill({
        json: {
          taskId: task.id,
          status: 'completed',
          results: [],
          changes: [],
          confirmations: [],
          unrecordedOperations: 0,
          usage,
        } satisfies HelperTaskResultsView,
      })
    );
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/?chat=${chat.id}`);
    await openHelper(page);
    const helper = page.locator('#helper-panel');
    const meter = helper.locator('.helper-context-usage > summary');
    await expect(meter).toBeVisible();
    await meter.click();
    const body = helper.locator('.helper-context-usage-body').filter({ visible: true });
    const compactButton = body.getByRole('button', { name: '지금 대화 정리하기', exact: true });
    await compactButton.click();

    await expect(
      page.locator('.transient-notice', {
        hasText: '대화 메시지 2개를 정리했어요. 다음 요청부터 요약본을 이어 써요.',
      })
    ).toBeVisible();
    const row = (label: string) =>
      body
        .getByRole('row')
        .filter({ has: page.getByRole('rowheader', { name: label, exact: true }) })
        .getByRole('cell');
    await expect(row('정리된 대화')).toHaveText(['메시지 2개', '']);
    await expect(compactButton).toBeDisabled();

    const view = await (
      await request.get(`/api/helper/conversations/${conversation.id}/view`)
    ).json();
    expect(view.context).toMatchObject({
      compactedMessages: 2,
      uncompactedMessages: 0,
      totalMessages: 2,
      checkpointRevision: 1,
    });
  } finally {
    const current = (await (await request.get('/api/model-workspace')).json()) as ModelWorkspace;
    await request.put('/api/model-workspace', {
      data: {
        expectedRevision: current.revision,
        routes: baseline.routes,
        translationPolicy: baseline.translationPolicy,
        helperModel: baseline.helperModel ? { id: baseline.helperModel.id } : null,
        contextModel: baseline.contextModel ? { id: baseline.contextModel.id } : null,
      },
    });
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
});

test('HUSAGE03 the helper summary dialog views, edits, keeps a draft through a conflict and resets', async ({
  page,
  request,
}) => {
  const { chat, conversation, task } = await seed(request);
  const reply = '정리한 도우미 요약: 주인공은 아직 약속을 지키지 않았다.';
  const provider = createServer(async (incoming, response) => {
    for await (const _chunk of incoming) {
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const events = [
      { type: 'text_delta', delta: reply },
      { type: 'usage', inputTokens: 80, outputTokens: 24, costUsd: null },
      { type: 'done', reason: 'stop' },
    ];
    response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
  });
  await new Promise<void>((resolve, reject) => {
    provider.once('error', reject);
    provider.listen(0, '127.0.0.1', resolve);
  });
  const address = provider.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server did not start');
  const baseline = (await (await request.get('/api/model-workspace')).json()) as ModelWorkspace;
  const contextUrl = `/api/helper/conversations/${conversation.id}/context`;
  const summaryOf = async () =>
    (await (await request.get(contextUrl)).json()) as HelperContextSummaryView;
  const compact = async () => {
    const started = await request.post(`/api/helper/conversations/${conversation.id}/compact`, {
      data: {},
    });
    expect(started.ok(), await started.text()).toBe(true);
    await expect.poll(async () => (await summaryOf()).summary).toBe(reply);
  };
  try {
    const connection = await (
      await request.post('/api/connections', {
        data: {
          title: `요약 편집 연결 ${randomUUID()}`,
          protocol: 'fixture-sse-v1',
          endpoint: `http://127.0.0.1:${address.port}/`,
          enabled: true,
        },
      })
    ).json();
    const model = await (
      await request.post('/api/model-presets', {
        data: {
          title: '요약 편집 모델',
          connectionId: connection.id,
          modelId: 'synthetic-summary-edit',
          inputTokenLimit: 200000,
          maxOutputTokens: 1024,
          temperature: null,
        },
      })
    ).json();
    const updated = await request.put('/api/model-workspace', {
      data: {
        expectedRevision: baseline.revision,
        routes: baseline.routes,
        translationPolicy: baseline.translationPolicy,
        helperModel: { id: model.id },
        contextModel: { id: model.id },
      },
    });
    expect(updated.ok(), await updated.text()).toBe(true);
    await compact();

    const usage: HelperTaskResultsView['usage'] = {
      toolExecutions: 1,
      attempts: [],
      latestInputEstimate: 42_000,
      latestInputLimit: 200_000,
      latestInputExecution: 'provider-tool-loop',
      latestInputParts: {
        instructions: 4_000,
        toolSchemas: 8_000,
        history: 24_000,
        source: 6_000,
        toolResults: null,
      },
    };
    await page.route(`**/api/helper/tasks/${task.id}/results`, (route) =>
      route.fulfill({
        json: {
          taskId: task.id,
          status: 'completed',
          results: [],
          changes: [],
          confirmations: [],
          unrecordedOperations: 0,
          usage,
        } satisfies HelperTaskResultsView,
      })
    );
    const helper = page.locator('#helper-panel');
    const dialog = page.getByRole('dialog', { name: '대화 요약', exact: true });
    const openSummary = async () => {
      await helper.locator('.helper-context-usage > summary').click();
      const show = page
        .locator('.helper-context-usage-body')
        .filter({ visible: true })
        .getByRole('button', { name: '요약 보기', exact: true });
      await show.click();
      await expect(dialog).toBeVisible();
    };
    const text = dialog.getByTestId('helper-summary-text');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/?chat=${chat.id}`);
    await openHelper(page);
    await openSummary();
    await expect(text).toHaveText(reply);
    const editor = dialog.getByRole('textbox', { name: '편집할 컨텍스트 요약' });
    const save = dialog.getByRole('button', { name: '요약 저장', exact: true });
    await dialog.getByRole('button', { name: '요약 편집', exact: true }).click();
    await editor.fill('직접 고친 요약: 주인공은 약속을 아직 지키지 않았다.');
    await save.click();
    await expect(
      page.locator('.transient-notice', { hasText: '요약을 저장했어요.' })
    ).toBeVisible();
    await expect(text).toHaveText('직접 고친 요약: 주인공은 약속을 아직 지키지 않았다.');
    await expect(dialog.getByRole('list', { name: '요약 정보' })).toContainText('직접 편집');
    expect(await summaryOf()).toMatchObject({ checkpointRevision: 2, origin: 'edit' });

    await dialog.getByRole('button', { name: '요약 편집', exact: true }).click();
    await editor.fill('브라우저에서 쓰던 초안');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await openSummary();
    await expect(editor).toHaveValue('브라우저에서 쓰던 초안');
    const changed = await request.put(`${contextUrl}/summary`, {
      data: { expectedRevision: 2, summary: '다른 탭에서 바꾼 요약' },
    });
    expect(changed.ok(), await changed.text()).toBe(true);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(dialog.getByText('저장된 요약이 바뀌었어요.')).toBeVisible({ timeout: 15_000 });
    await expect(text).toHaveText('다른 탭에서 바꾼 요약');
    await expect(editor).toHaveValue('브라우저에서 쓰던 초안');
    await expect(save).toBeDisabled();
    await dialog
      .getByRole('button', { name: '최신 요약을 확인하고 내 초안 유지', exact: true })
      .click();
    await expect(save).toBeEnabled();
    await save.click();
    await expect(text).toHaveText('브라우저에서 쓰던 초안');
    expect(await summaryOf()).toMatchObject({
      checkpointRevision: 4,
      summary: '브라우저에서 쓰던 초안',
    });

    await dialog.getByRole('button', { name: '요약 초기화', exact: true }).click();
    const confirm = page.getByRole('alertdialog', { name: '요약을 초기화할까요?' });
    await confirm.getByRole('button', { name: '초기화', exact: true }).click();
    await expect(
      page.locator('.transient-notice', { hasText: '요약을 초기화했어요.' })
    ).toBeVisible();
    await expect(dialog).toContainText('저장된 요약이 없어요.');
    await expect(dialog.getByRole('button', { name: '요약 편집', exact: true })).toHaveCount(0);
    expect(
      (await (await request.get(`/api/helper/conversations/${conversation.id}/view`)).json())
        .context
    ).toMatchObject({ compactedMessages: 0, summaryChars: 0 });
  } finally {
    const current = (await (await request.get('/api/model-workspace')).json()) as ModelWorkspace;
    await request.put('/api/model-workspace', {
      data: {
        expectedRevision: current.revision,
        routes: baseline.routes,
        translationPolicy: baseline.translationPolicy,
        helperModel: baseline.helperModel ? { id: baseline.helperModel.id } : null,
        contextModel: baseline.contextModel ? { id: baseline.contextModel.id } : null,
      },
    });
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
});
