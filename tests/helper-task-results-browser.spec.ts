import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { expect, test, type APIRequestContext, type Locator } from '@playwright/test';
import type {
  HelperConversation,
  HelperConversationSummary,
  HelperTaskResultsView,
} from '../core/helper.js';
import type { Content, ModelWorkspace } from '../core/product.js';
import type { Chat, ChatDetail } from '../core/types.js';
import type { HelperTaskView } from '../web/useHelperConversation.js';
import { postFixtureChat, fixtureBotInput } from './fixtures/chat.js';
import { navigationAction, openHelper } from './ui-navigation.js';
import { DESKTOP_HEIGHT, DESKTOP_WIDTH } from './fixtures/browser-viewports.js';

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

const usageValue = (results: Locator, label: string) =>
  results.getByText(label, { exact: true }).locator('xpath=following-sibling::dd[1]');

test('HRESULT-STORYUI setting results identify changes and open generation settings', async ({
  page,
  request,
}, info) => {
  const { chat, task } = await seed(request);
  const projection: HelperTaskResultsView = {
    taskId: task.id,
    status: 'completed',
    results: [
      {
        eventSeq: 1,
        receiptId: 'story-ui-settings',
        operation: 'settings.update',
        requestedTargets: 2,
        changedTargets: 2,
        targets: [
          {
            kind: 'settings',
            id: chat.id,
            title: chat.title,
            revision: 1,
            setting: 'chat.storyUi',
            before: false,
            after: true,
          },
          {
            kind: 'settings',
            id: chat.id,
            title: chat.title,
            revision: 2,
            setting: 'chat.storyUiStyle',
            before: 'auto',
            after: 'blue-archive',
          },
        ],
      },
    ],
    changes: [],
    unrecordedOperations: 0,
    usage: { toolExecutions: 2, attempts: [], latestInputEstimate: null },
  };
  await page.route(`**/api/helper/tasks/${task.id}/results`, (route) =>
    route.fulfill({ json: projection })
  );
  for (const label of ['이야기 UI', '이야기 UI 스타일']) {
    await page.goto(`/?chat=${chat.id}`);
    await openHelper(page);
    const results = page
      .locator(`.helper-message.assistant[data-task-id="${task.id}"]`)
      .getByTestId('helper-task-results');
    const target = results.getByRole('button').filter({
      has: page.getByText(label, { exact: true }),
    });
    await expect(target).toBeVisible();
    if (label === '이야기 UI 스타일') {
      await expect(target).toContainText('자동');
      await expect(target).toContainText('블루 아카이브');
      await expect(target).not.toContainText('blue-archive');
      await page.screenshot({ path: info.outputPath('story-ui-setting-results.png') });
    }
    await target.click();
    const dialog = page.getByRole('dialog', { name: '채팅 설정', exact: true });
    const storyUi = dialog.getByRole('switch', { name: '이야기 UI', exact: true });
    await expect(storyUi).toBeVisible();
    await expect(dialog.getByLabel('이야기 UI 스타일')).toHaveCount(
      (await storyUi.isChecked()) ? 1 : 0
    );
  }
  await page.screenshot({ path: info.outputPath('story-ui-setting-destination.png') });
  projection.results[0].targets = [
    {
      kind: 'settings',
      id: chat.botId,
      title: '관측소 봇',
      revision: 1,
      setting: 'bot.storyUiTheme',
      before: null,
      after: 'theme-id',
      afterLabel: '별빛 테마',
    },
  ];
  await page.goto(`/?chat=${chat.id}`);
  await openHelper(page);
  const botResult = page
    .getByTestId('helper-task-results')
    .getByRole('button')
    .filter({
      has: page.getByText('봇의 이야기 UI 기본값', { exact: true }),
    });
  await expect(botResult).toContainText('별빛 테마');
  await botResult.click();
  const settings = page.getByRole('dialog', { name: '설정', exact: true });
  await expect(
    settings.getByRole('combobox', { name: '봇의 이야기 UI 기본값', exact: true })
  ).toBeVisible();
  await expect(settings.getByText('관측소 봇', { exact: true })).toBeVisible();
});

test('HRESULT-ILLUSTRATION queued and placed results open their scene and references without losing a draft', async ({
  page,
  request,
}) => {
  const { chat, task } = await seed(request);
  const created = await postFixtureChat(request, { data: { title: '삽화 결과 목적지' } });
  expect(created.ok()).toBe(true);
  const destination = (await created.json()) as Chat;
  const sources: string[] = [];
  for (const marker of ['기록할 첫 장면', '나중에 이어진 장면']) {
    const before = (await (await request.get(`/api/chats/${destination.id}`)).json()) as ChatDetail;
    const started = await request.post(`/api/chats/${destination.id}/runs`, {
      data: {
        request: marker,
        expectedRevision: before.chat.headRevision,
        expectedSettingsRevision: before.chat.settingsRevision,
        idempotencyKey: randomUUID(),
      },
    });
    expect(started.ok(), await started.text()).toBe(true);
    const run = (await started.json()) as { id: string };
    await expect
      .poll(async () => {
        const current = (await (
          await request.get(`/api/chats/${destination.id}`)
        ).json()) as ChatDetail;
        return current.runs.find((item) => item.id === run.id)?.status;
      })
      .toBe('completed');
    const current = (await (
      await request.get(`/api/chats/${destination.id}`)
    ).json()) as ChatDetail;
    sources.push(current.sources.find((source) => source.runId === run.id)!.id);
  }
  const operations = [
    ['illustration.generate', '강가 첫 장면', '삽화 예약됨'],
    ['illustration.cut.redraw', '등불을 든 손', '다시 그리기 예약됨'],
    ['illustration.cuts.place', '다리 문단 뒤', '배치 변경됨'],
    ['illustration.continuity.save', '미라의 옷차림', '연속성 저장됨'],
  ];
  const projection: HelperTaskResultsView = {
    taskId: task.id,
    status: 'completed',
    results: [
      ...operations.map(([operation, title], index) => ({
        eventSeq: index + 1,
        receiptId: `illustration-result-${index}`,
        operation,
        requestedTargets: 1,
        changedTargets: 1,
        targets: [
          {
            kind: 'illustration' as const,
            id: sources[0],
            chatId: destination.id,
            title,
            revision: 1,
          },
        ],
      })),
      {
        eventSeq: 5,
        receiptId: 'references',
        operation: 'illustration.references.assign',
        requestedTargets: 1,
        changedTargets: 1,
        targets: [
          {
            kind: 'settings',
            id: destination.id,
            title: destination.title,
            revision: 1,
            setting: 'chat.illustrationReferences',
          },
        ],
      },
    ],
    changes: [],
    unrecordedOperations: 0,
    usage: { toolExecutions: 5, latestInputEstimate: null, attempts: [] },
  };
  await page.route(`**/api/helper/tasks/${task.id}/results`, (route) =>
    route.fulfill({ json: projection })
  );
  await page.goto(`/?chat=${chat.id}`);
  const composer = page.getByRole('textbox', { name: '다음 장면 요청', exact: true });
  await composer.fill('계속 쓸 원고 요청 초안');
  await openHelper(page);
  const results = page
    .locator(`.helper-message.assistant[data-task-id="${task.id}"]`)
    .getByTestId('helper-task-results');
  for (const [, title, outcome] of operations) {
    const target = results.getByRole('button', { name: `${title} 열기`, exact: true });
    await expect(target).toContainText(outcome);
    await expect(target).toHaveAttribute('aria-description', outcome);
  }
  await results
    .getByRole('button', { name: '삽화 결과 목적지 삽화 참고 열기', exact: true })
    .click();
  await expect(page.getByTestId('illustration-references')).toBeVisible();
  await page.goto(`/?chat=${chat.id}`);
  await expect(composer).toHaveValue('계속 쓸 원고 요청 초안');
  await openHelper(page);
  await results.getByRole('button', { name: '강가 첫 장면 열기', exact: true }).click();
  await expect
    .poll(() => {
      const params = new URL(page.url()).searchParams;
      return [params.get('chat'), params.get('source'), params.get('mode')];
    })
    .toEqual([destination.id, sources[0], 'original']);
  await expect(
    page.locator(`[data-testid="source"][data-source-id="${sources[0]}"]`)
  ).toBeVisible();
  await page.goto(`/?chat=${chat.id}`);
  await expect(composer).toHaveValue('계속 쓸 원고 요청 초안');
});

test('HRESULT-STORY scene, translation, scene name and card variable results open their chat destinations', async ({
  page,
  request,
}) => {
  const { chat, task } = await seed(request);
  const created = await postFixtureChat(request, { data: { title: '요청 결과 목적지' } });
  expect(created.ok()).toBe(true);
  const destination = (await created.json()) as Chat;
  const before = (await (await request.get(`/api/chats/${destination.id}`)).json()) as ChatDetail;
  const started = await request.post(`/api/chats/${destination.id}/runs`, {
    data: {
      request: '번역할 장면',
      expectedRevision: before.chat.headRevision,
      expectedSettingsRevision: before.chat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
  });
  expect(started.ok(), await started.text()).toBe(true);
  const run = (await started.json()) as { id: string };
  await expect
    .poll(async () => {
      const current = (await (
        await request.get(`/api/chats/${destination.id}`)
      ).json()) as ChatDetail;
      return current.runs.find((item) => item.id === run.id)?.status;
    })
    .toBe('completed');
  const detail = (await (await request.get(`/api/chats/${destination.id}`)).json()) as ChatDetail;
  const sourceId = detail.sources.find((source) => source.runId === run.id)!.id;
  const projection: HelperTaskResultsView = {
    taskId: task.id,
    status: 'completed',
    results: [
      {
        eventSeq: 1,
        receiptId: 'scene-request',
        operation: 'scene.request',
        requestedTargets: 1,
        changedTargets: 1,
        targets: [{ kind: 'chat', id: destination.id, title: destination.title, revision: 1 }],
      },
      {
        eventSeq: 2,
        receiptId: 'scene-translate',
        operation: 'scene.translate',
        requestedTargets: 1,
        changedTargets: 1,
        targets: [
          {
            kind: 'translation',
            id: sourceId,
            chatId: destination.id,
            title: destination.title,
            revision: 1,
          },
        ],
      },
      {
        eventSeq: 4,
        receiptId: 'scene-title',
        operation: 'scene.title',
        requestedTargets: 1,
        changedTargets: 1,
        targets: [
          { kind: 'scene', id: sourceId, chatId: destination.id, title: '종소리', revision: 1 },
        ],
      },
      {
        eventSeq: 3,
        receiptId: 'variables',
        operation: 'chat.variables.update',
        requestedTargets: 1,
        changedTargets: 1,
        targets: [
          {
            kind: 'settings',
            id: destination.id,
            title: destination.title,
            revision: 1,
            setting: 'chat.variables',
          },
        ],
      },
    ],
    changes: [],
    unrecordedOperations: 0,
    usage: { toolExecutions: 4, latestInputEstimate: null, attempts: [] },
  };
  await page.route(`**/api/helper/tasks/${task.id}/results`, (route) =>
    route.fulfill({ json: projection })
  );
  const results = page
    .locator(`.helper-message.assistant[data-task-id="${task.id}"]`)
    .getByTestId('helper-task-results');
  const target = (outcome: string) =>
    results.getByRole('button', { name: `${destination.title} 열기`, exact: true }).filter({
      hasText: outcome,
    });
  const location = () => {
    const params = new URL(page.url()).searchParams;
    return [params.get('chat'), params.get('source'), params.get('mode')];
  };

  await page.goto(`/?chat=${chat.id}`);
  await openHelper(page);
  await expect(target('장면 요청됨')).toHaveAttribute('aria-description', '장면 요청됨');
  await expect(target('번역 요청됨')).toHaveAttribute('aria-description', '번역 요청됨');
  await target('장면 요청됨').click();
  await expect.poll(() => location()[0]).toBe(destination.id);

  await page.goto(`/?chat=${chat.id}`);
  await openHelper(page);
  await target('번역 요청됨').click();
  await expect.poll(location).toEqual([destination.id, sourceId, 'translation']);

  await page.goto(`/?chat=${chat.id}`);
  await openHelper(page);
  const named = results.getByRole('button', { name: '종소리 열기', exact: true });
  await expect(named).toHaveAttribute('aria-description', '장면 이름 저장됨');
  await named.click();
  await expect.poll(location).toEqual([destination.id, sourceId, 'original']);

  await page.goto(`/?chat=${chat.id}`);
  await openHelper(page);
  await results
    .getByRole('button', { name: `${destination.title} 카드 변수 열기`, exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: '채팅 설정', exact: true });
  await expect(dialog.getByRole('region', { name: '카드 변수 편집', exact: true })).toBeVisible();
});

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

test('HRESULT01 ordinary answers show usage without a permanent empty-change message', async ({
  page,
  request,
}) => {
  const { chat, task } = await seed(request);
  await page.goto(`/?chat=${chat.id}`);
  await openHelper(page);
  const answer = page.locator(`.helper-message.assistant[data-task-id="${task.id}"]`);
  await expect(answer).toContainText('요청 내용을 확인했어요.');
  const results = answer.getByTestId('helper-task-results');
  const summary = results.locator('summary');
  await expect(summary).toContainText('사용량');
  await expect(summary).toContainText('마지막 입력 120');
  await expect(summary).toContainText('출력 12 토큰');
  await expect(summary).not.toContainText('·');
  await expect(summary).not.toContainText('도구');
  await expect(summary).not.toContainText('일부 미확인');
  await expect(results.locator('.helper-result-note')).toHaveCount(0);
  await expect(results.locator('.helper-result-list > li')).toHaveCount(0);
  await results.locator('summary').click();
  await expect(usageValue(results, '모델 실행 요청')).toHaveText('1');
  await expect(usageValue(results, '확인된 비용')).toHaveText('미확인');
});

test('HRESULT02 actual results retain partial usage and recover from refresh/open failures', async ({
  page,
  request,
}) => {
  const { chat, task } = await seed(request);
  const created = await request.post('/api/content', {
    data: fixtureBotInput('다시 열어 볼 저장 자료'),
  });
  expect(created.ok(), await created.text()).toBe(true);
  const content = (await created.json()) as Content;
  const projection: HelperTaskResultsView = {
    taskId: task.id,
    status: 'completed',
    results: [
      {
        eventSeq: 10,
        receiptId: 'saved',
        operation: 'resource.patch',
        requestedTargets: 1,
        changedTargets: 1,
        targets: [
          { kind: 'content', id: content.id, title: content.title, revision: content.revision },
        ],
      },
      {
        eventSeq: 11,
        receiptId: 'deleted',
        operation: 'resource.delete',
        requestedTargets: 1,
        changedTargets: 1,
        targets: [
          { kind: 'content', id: 'deleted-resource', title: '삭제한 이전 자료', revision: 2 },
        ],
      },
      {
        eventSeq: 12,
        receiptId: 'settings',
        operation: 'settings.update',
        requestedTargets: 1,
        changedTargets: 1,
        targets: [
          {
            kind: 'settings',
            id: 'global',
            title: '공통 설정',
            revision: 2,
            setting: 'global.helperModel',
            before: 'old-id',
            after: 'new-id',
            beforeLabel: '이전 도우미',
            afterLabel: '새 도우미',
          },
        ],
      },
    ],
    changes: [],
    unrecordedOperations: 0,
    usage: {
      toolExecutions: 7,
      latestInputEstimate: 850,
      attempts: [
        {
          id: 'known',
          purpose: 'helper',
          status: 'completed',
          inputTokens: 1000,
          outputTokens: 90,
          cachedInputTokens: 600,
          reasoningTokens: 30,
          costUsd: 0.02,
          internalModelCalls: 2,
        },
        {
          id: 'unknown',
          purpose: 'helper',
          status: 'error',
          inputTokens: null,
          outputTokens: null,
          cachedInputTokens: null,
          reasoningTokens: null,
          costUsd: null,
          internalModelCalls: null,
        },
      ],
    },
  };
  let refreshFails = false;
  let reads = 0;
  await page.route(`**/api/helper/tasks/${task.id}/results`, async (route) => {
    reads++;
    await route.fulfill(
      refreshFails
        ? { status: 503, json: { error: 'SYNTHETIC_RESULT_REFRESH_FAILURE' } }
        : { json: projection }
    );
  });
  await page.goto(`/?chat=${chat.id}`);
  await openHelper(page);
  const results = page
    .locator(`.helper-message.assistant[data-task-id="${task.id}"]`)
    .getByTestId('helper-task-results');
  const saved = results.getByRole('button', { name: `${content.title} 열기`, exact: true });
  await expect(saved).toBeVisible();
  await expect(results.getByText('삭제한 이전 자료', { exact: true })).toBeVisible();
  await expect(results.getByText('삭제됨', { exact: true })).toBeVisible();
  await expect(
    results.getByRole('button', { name: '삭제한 이전 자료 열기', exact: true })
  ).toHaveCount(0);
  await expect(results.getByText('이전 도우미', { exact: true })).toBeVisible();
  await expect(results.getByText('새 도우미', { exact: true })).toBeVisible();
  await expect(results.locator('summary')).toContainText('입력 추정 850');
  await expect(results.locator('summary')).toContainText('출력 90 토큰');
  await expect(results.locator('summary')).toContainText('도구 7회');
  await expect(results.locator('summary')).toContainText('일부 미확인');
  await results.locator('summary').click();
  await expect(usageValue(results, '모델 실행 요청')).toHaveText('2');
  await expect(usageValue(results, '도구 실행')).toHaveText('7');
  await expect(usageValue(results, '누적 입력 토큰')).toHaveText('1,000미확인 1회');
  await expect(usageValue(results, '입력 중 캐시 토큰')).toHaveText('600미확인 1회');
  await expect(usageValue(results, '누적 출력 토큰')).toHaveText('90미확인 1회');
  await expect(usageValue(results, '출력 중 추론 토큰')).toHaveText('30미확인 1회');
  await expect(usageValue(results, '확인된 비용')).toHaveText('US$0.02미확인 1회');
  await expect(usageValue(results, '마지막 전송 입력 (추정)')).toHaveText('850');
  await expect(results).not.toContainText('%');
  await expect(results.getByRole('meter')).toHaveCount(0);
  projection.usage.latestInputLimit = 1000;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  const inputMeter = results.getByRole('meter', {
    name: '입력 예산 대비 마지막 전송 입력 추정치',
  });
  await expect(inputMeter).toHaveAttribute('max', '1000');
  await expect(inputMeter).toHaveAttribute('value', '850');
  await expect(usageValue(results, '마지막 전송 입력 (추정)')).toHaveText('850 / 1,000');
  await expect(inputMeter).toHaveAttribute('aria-valuetext', '입력 예산 1,000 토큰 중 약 850 토큰');
  refreshFails = true;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(results.getByRole('alert')).toContainText('결과를 새로 확인하지 못했어요.');
  await expect(saved).toBeVisible();
  await expect(usageValue(results, '누적 입력 토큰')).toHaveText('1,000미확인 1회');
  const beforeRetry = reads;
  refreshFails = false;
  await results.getByRole('button', { name: '다시 불러오기', exact: true }).click();
  await expect.poll(() => reads).toBeGreaterThan(beforeRetry);
  await expect(results.getByRole('alert')).toHaveCount(0);
  let releaseOpen = () => {};
  const openGate = new Promise<void>((resolve) => {
    releaseOpen = resolve;
  });
  await page.route(`**/api/content/${content.id}`, async (route) => {
    await openGate;
    await route.fulfill({ status: 503, json: { error: 'SYNTHETIC_OPEN_FAILURE' } });
  });
  try {
    await saved.click();
    await expect(saved).toBeDisabled();
  } finally {
    releaseOpen();
  }
  await expect(results.getByRole('alert')).toContainText('결과를 열지 못했어요.');
  await expect(saved).toBeEnabled();
});

test('HREAD01 a helper result read in one browser, or read earlier on this browser, is read in another', async ({
  page,
  browser,
  request,
}, info) => {
  const acknowledged = (await seed(request)).conversation;
  const remembered = (await seed(request)).conversation;
  const summaries = async () =>
    (await (
      await request.get('/api/helper/conversations?kind=all')
    ).json()) as HelperConversationSummary[];
  const latest = async (id: string) => (await summaries()).find((item) => item.id === id)!;
  const rememberedSequence = (await latest(remembered.id)).latestActivityEventSeq;
  const other = await browser.newContext({
    viewport: { width: DESKTOP_WIDTH, height: DESKTOP_HEIGHT },
    reducedMotion: 'reduce',
  });
  try {
    const second = await other.newPage();
    const unreadIn = async (target: typeof page) => {
      await navigationAction(target, '도우미');
      const history = target.getByRole('navigation', { name: '도우미 대화', exact: true });
      await history.getByRole('button', { name: /^미확인 활동/ }).click();
      return history.locator('[data-activity-section="unread"]');
    };
    await second.goto('/');
    const secondUnread = await unreadIn(second);
    for (const id of [acknowledged.id, remembered.id])
      await expect(secondUnread.locator(`[data-conversation-id="${id}"]`)).toBeVisible();

    await page.setViewportSize({ width: DESKTOP_WIDTH, height: DESKTOP_HEIGHT });
    await page.addInitScript(
      ([id, sequence]) => localStorage.setItem(`uimori:helper-seen:${id}`, sequence),
      [remembered.id, String(rememberedSequence)] as const
    );
    await page.goto('/');
    const firstUnread = await unreadIn(page);
    await expect(firstUnread.locator(`[data-conversation-id="${remembered.id}"]`)).toHaveCount(0);
    await expect
      .poll(async () => (await latest(remembered.id)).readActivityEventSeq)
      .toBe(rememberedSequence);
    await expect
      .poll(() =>
        page.evaluate((id) => localStorage.getItem(`uimori:helper-seen:${id}`), remembered.id)
      )
      .toBeNull();
    await firstUnread
      .locator(`[data-conversation-id="${acknowledged.id}"]`)
      .getByRole('button', { name: /활동 확인$/ })
      .click();
    await expect
      .poll(async () => {
        const item = await latest(acknowledged.id);
        return item.readActivityEventSeq === item.latestActivityEventSeq;
      })
      .toBe(true);

    await second.evaluate(() => window.dispatchEvent(new Event('focus')));
    for (const id of [acknowledged.id, remembered.id])
      await expect(secondUnread.locator(`[data-conversation-id="${id}"]`)).toHaveCount(0);
    await second.screenshot({ path: info.outputPath('helper-read-in-second-browser.png') });
  } finally {
    await other.close();
  }
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
        location: '장면 3 · 원문',
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
        location: 'extensions/risuai/customScripts',
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
        location: 'description',
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
    unrecordedOperations: 0,
    usage: { toolExecutions: 5, attempts: [], latestInputEstimate: null },
  };
}

test('HCHANGE01 change cards show marked words, code lines and the states without a diff', async ({
  page,
  request,
}, info) => {
  const { chat, task } = await seed(request);
  await page.route(`**/api/helper/tasks/${task.id}/results`, (route) =>
    route.fulfill({ json: changeProjection(task.id, chat.id) })
  );
  for (const [width, height] of [
    [412, 915],
    [1440, 900],
  ] as const) {
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
      await page.goto(`/?chat=${chat.id}`);
      await openHelper(page);
      const results = page
        .locator(`.helper-message.assistant[data-task-id="${task.id}"]`)
        .getByTestId('helper-task-results');
      const prose = results.locator('.helper-change-toggle', { hasText: '등대지기의 밤' });
      await expect(prose).toHaveAttribute('aria-expanded', 'false');
      await expect(prose).toContainText('+2');
      await expect(prose).toContainText('−2');
      await expect(prose).toContainText('단어 2개 추가, 2개 삭제');
      await expect(results.getByRole('region', { name: /등대지기의 밤/ })).toBeHidden();
      await expect(results.getByText('바뀐 내용이 너무 커서 비교를 생략했어요.')).toBeVisible();
      await expect(results.getByText('대상이 삭제되어 바뀐 내용을 지웠어요.')).toBeVisible();
      await expect(results.getByText('삭제됨', { exact: true })).toBeVisible();
      for (const title of ['삭제한 봇', '지운 장면'])
        await expect(
          results.getByRole('button', { name: `${title} 열기`, exact: true })
        ).toHaveCount(0);
      await expect(
        results.getByRole('button', { name: '등대지기의 밤 장면 3 · 원문 열기', exact: true })
      ).toBeVisible();
      const label = `${width}-${colorScheme}`;
      await page.screenshot({ path: info.outputPath(`change-cards-${label}.png`) });
      await prose.click();
      await expect(prose).toHaveAttribute('aria-expanded', 'true');
      const paragraph = results.getByRole('region', { name: /등대지기의 밤/ }).locator('p');
      await expect(paragraph).toHaveCount(1);
      await expect(paragraph.locator('del')).toHaveText([
        '삭제된 부분 다리를',
        '삭제된 부분 건넜다.',
      ]);
      await expect(paragraph.locator('ins')).toHaveText([
        '추가된 부분 강을',
        '추가된 부분 헤엄쳤다.',
      ]);
      await expect(paragraph).toContainText('그는 등불을 들고');
      const decoration = (selector: string) =>
        paragraph
          .locator(selector)
          .first()
          .evaluate((node) => getComputedStyle(node).textDecorationLine);
      expect(await decoration('del')).toContain('line-through');
      expect(await decoration('ins')).toContain('underline');
      await results.locator('.helper-change-toggle', { hasText: '정규식 봇' }).click();
      const code = results.getByRole('region', { name: /정규식 봇/ });
      await expect(code.locator('.helper-diff-line')).toHaveCount(4);
      await expect(code.locator('.helper-diff-line[data-op="delete"] code')).toHaveText(
        '    "in": "foo",'
      );
      const inserted = code.locator('.helper-diff-line[data-op="insert"]');
      await expect(inserted.locator('code')).toHaveText('    "in": "bar",');
      await expect(inserted.locator('.helper-diff-gutter')).toHaveText('+');
      await page.screenshot({ path: info.outputPath(`change-diffs-${label}.png`) });
      if (width === 1440 && colorScheme === 'light') {
        await page
          .locator('#helper-panel')
          .getByRole('button', { name: '도우미 크게 보기', exact: true })
          .click();
        await expect(results.getByRole('region', { name: /등대지기의 밤/ })).toBeVisible();
        await page.screenshot({ path: info.outputPath('change-diffs-expanded-workspace.png') });
      }
    }
  }
});

test('HCHANGE02 earlier task results load when their answer comes into view', async ({
  page,
  request,
}) => {
  const { chat, task, later } = await seed(request, undefined, 7);
  const reads = new Map<string, number>();
  page.on('request', (sent) => {
    const match = /\/api\/helper\/tasks\/([^/]+)\/results$/u.exec(new URL(sent.url()).pathname);
    if (match) reads.set(match[1]!, (reads.get(match[1]!) ?? 0) + 1);
  });
  await page.setViewportSize({ width: 412, height: 600 });
  await page.goto(`/?chat=${chat.id}`);
  await openHelper(page);
  const latest = later.at(-1)!;
  await expect(
    page
      .locator(`.helper-message.assistant[data-task-id="${latest.id}"]`)
      .getByTestId('helper-task-results')
      .locator('summary')
  ).toBeVisible();
  await expect.poll(() => reads.get(latest.id) ?? 0).toBeGreaterThan(0);
  expect(reads.get(task.id) ?? 0).toBe(0);
  const first = page.locator(`.helper-message.assistant[data-task-id="${task.id}"]`);
  await first.scrollIntoViewIfNeeded();
  await expect(first.getByTestId('helper-task-results').locator('summary')).toBeVisible();
  expect(reads.get(task.id)).toBe(1);
});
