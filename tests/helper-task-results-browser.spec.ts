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

async function seed(request: APIRequestContext) {
  const provider = createServer(async (incoming, response) => {
    for await (const _chunk of incoming) {
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const events = [
      { type: 'text_delta', delta: '요청 내용을 확인했어요.' },
      { type: 'usage', inputTokens: 120, outputTokens: 12, costUsd: null },
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
        text: '자료를 변경하지 않고 간단히 답해 주세요.',
      },
    });
    expect(admitted.ok(), await admitted.text()).toBe(true);
    const task = (await admitted.json()) as HelperTaskView;
    await expect
      .poll(async () => {
        const current = await request.get(`/api/helper/tasks/${task.id}`);
        expect(current.ok()).toBe(true);
        return ((await current.json()) as HelperTaskView).status;
      })
      .toBe('completed');
    return { chat, task, conversation };
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

test('HUSAGE02 HUSAGE03 the usage popover compacts manually, then the summary dialog views, edits, keeps a draft through a conflict and resets', async ({
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
    const meter = helper.locator('.helper-context-usage > summary');
    const body = helper.locator('.helper-context-usage-body').filter({ visible: true });
    const openSummary = async () => {
      if (!(await body.isVisible())) await meter.click();
      await body.getByRole('button', { name: '요약 보기', exact: true }).click();
      await expect(dialog).toBeVisible();
    };
    const text = dialog.getByTestId('helper-summary-text');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/?chat=${chat.id}`);
    await openHelper(page);
    await expect(meter).toBeVisible();
    await meter.click();
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
    expect(
      (await (await request.get(`/api/helper/conversations/${conversation.id}/view`)).json())
        .context
    ).toMatchObject({
      compactedMessages: 2,
      uncompactedMessages: 0,
      totalMessages: 2,
      checkpointRevision: 1,
    });
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
