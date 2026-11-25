import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import type {
  HelperContextSummaryView,
  HelperConversation,
  HelperConversationSummary,
  HelperTaskResultsView,
} from '../core/helper.js';
import type { Content, ModelWorkspace } from '../core/product.js';
import type { Chat, ChatDetail } from '../core/types.js';
import type { HelperTaskView } from '../web/useHelperConversation.js';
import { postFixtureChat, fixtureBotInput } from './fixtures/chat.js';
import { nativeContent } from './fixtures/native-content.js';
import {
  navigationAction,
  openHelper,
  expectEditorSection,
  selectEditorSection,
} from './ui-navigation.js';
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

const traceDefaults = {
  kind: 'helper' as const,
  owner: 'helper' as const,
  sceneRunId: null,
  modelId: 'fixture-helper',
  startedAt: null,
  elapsedMs: null,
  firstByteMs: null,
  estimatedUsd: null,
  estimatedSubtotalUsd: 0,
  tools: [],
};
const usageValue = (results: Locator, row: string) =>
  results.locator(`.trace-summary [data-row="${row}"] dd`);

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
    confirmations: [],
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

test('HRESULT-THEME a changed Story UI theme shows its preview under the last change', async ({
  page,
  request,
}, info) => {
  const { chat, task } = await seed(request);
  const catalogResponse = await request.get('/api/themes');
  expect(catalogResponse.ok()).toBe(true);
  const catalog = (await catalogResponse.json()) as { themes: Record<string, unknown>[] };
  const storyTheme = {
    ...catalog.themes[0],
    id: 'story-theme',
    name: '등대 테마',
    storyUi: { baseStyle: 'neon', css: '& { --story-accent: #1d3a8a; }' },
  };
  await page.route('**/api/themes', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const body = (await response.json()) as { themes: unknown[] };
    await route.fulfill({ response, json: { ...body, themes: [...body.themes, storyTheme] } });
  });
  const change = (action: 'create' | 'update') => ({
    domain: 'resource' as const,
    targetId: 'story-theme',
    title: '등대 테마',
    location: { kind: 'resource-field' as const, path: ['storyUi', 'css'] },
    action,
    diff: null,
    anchor: null,
  });
  const projection: HelperTaskResultsView = {
    taskId: task.id,
    status: 'completed',
    results: [],
    changes: [change('create'), change('update')],
    confirmations: [],
    unrecordedOperations: 0,
    usage: { toolExecutions: 2, attempts: [], latestInputEstimate: null },
  };
  await page.route(`**/api/helper/tasks/${task.id}/results`, (route) =>
    route.fulfill({ json: projection })
  );
  await page.goto(`/?chat=${chat.id}`);
  await openHelper(page);
  const results = page
    .locator(`.helper-message.assistant[data-task-id="${task.id}"]`)
    .getByTestId('helper-task-results');
  const previews = results.locator('.helper-story-ui-preview');
  await expect(previews).toHaveCount(1);
  await expect(results.locator('.helper-result-list > li').last()).toContainText('오래된 정원');
  await expect(previews.locator('[data-story-ui-style="neon"]')).toBeVisible();
  await previews.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('helper-story-ui-theme-preview.png') });
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
    confirmations: [],
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
    confirmations: [],
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
    .getByRole('button', { name: `${destination.title} 채팅 변수 열기`, exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: '채팅 설정', exact: true });
  await expect(dialog.getByRole('region', { name: '채팅 변수 편집', exact: true })).toBeVisible();
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
  await expect(usageValue(results, 'calls')).toHaveText('모델 1회');
  await expect(results.locator('.trace-summary dt')).toHaveText(['실행', '누적 입력', '누적 출력']);
  await expect(results.locator('.trace-summary [data-row="cost"]')).toHaveCount(0);
});

test('HRESULT02 actual results retain partial usage and recover from refresh/open failures', async ({
  page,
  request,
}) => {
  const { chat, task, conversation } = await seed(request);
  const taskFrame = async () => {
    const injected = await request.post('/api/test/live-frame', {
      data: {
        event: 'helper',
        data: { seq: 0, conversationId: conversation.id, taskId: task.id, kind: 'artifact.saved' },
      },
    });
    expect(injected.ok()).toBe(true);
  };
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
    confirmations: [],
    unrecordedOperations: 0,
    usage: {
      toolExecutions: 7,
      latestInputEstimate: 850,
      attempts: [
        {
          id: 'known',
          ...traceDefaults,
          ...traceDefaults,
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
          ...traceDefaults,
          ...traceDefaults,
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
  await expect(usageValue(results, 'calls')).toHaveText('모델 2회도구 7회내부 호출 2회');
  await expect(usageValue(results, 'input')).toHaveText('1,000미확인 1회(캐시 600, 60%)');
  await expect(usageValue(results, 'output')).toHaveText('90미확인 1회(추론 30, 33%)');
  await expect(usageValue(results, 'cost')).toHaveText('$0.02+미확인 1회');
  await expect(results.locator('.helper-usage-headline')).toHaveText('마지막 요청 컨텍스트 약 850');
  await expect(results.getByRole('button', { name: '누적 입력 설명', exact: true })).toBeVisible();
  await expect(results.locator('.context-breakdown-bar')).toHaveCount(0);
  await expect(results.getByRole('meter')).toHaveCount(0);
  projection.usage.latestInputLimit = 1000;
  await taskFrame();
  await expect(results.locator('.helper-usage-headline')).toHaveText(
    '마지막 요청 컨텍스트 약 850 / 1,000'
  );
  await expect(results.locator('.context-breakdown-bar')).toHaveCount(0);
  refreshFails = true;
  await taskFrame();
  await expect(results.getByRole('alert')).toContainText('결과를 새로 확인하지 못했어요.');
  await expect(saved).toBeVisible();
  await expect(usageValue(results, 'input')).toHaveText('1,000미확인 1회(캐시 600, 60%)');
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
      await history.getByRole('tab', { name: /^미확인 활동/ }).click();
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
        results.getByRole('button', { name: '등대지기의 밤, 장면 3, 원문 열기', exact: true })
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
      expect(
        await paragraph
          .locator('del + ins')
          .first()
          .evaluate((inserted) => {
            const removed = inserted.previousElementSibling!.getClientRects();
            return inserted.getClientRects()[0]!.left - removed[removed.length - 1]!.right;
          })
      ).toBeGreaterThanOrEqual(2);
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

test('HCHANGE04 change locations follow the UI language and keep authored names', async ({
  page,
  request,
}, info) => {
  const { chat, task } = await seed(request);
  await page.route(`**/api/helper/tasks/${task.id}/results`, (route) =>
    route.fulfill({ json: changeProjection(task.id, chat.id) })
  );
  await page.setViewportSize({ width: 412, height: 915 });
  await page.goto(`/?chat=${chat.id}`);
  await openHelper(page);
  const results = page
    .locator(`.helper-message.assistant[data-task-id="${task.id}"]`)
    .getByTestId('helper-task-results');
  const location = (title: string) =>
    results.locator('.helper-change', { hasText: title }).locator('.helper-change-location > *');
  const expected = {
    ko: {
      scene: ['장면 3', '원문'],
      regex: ['정규식'],
      description: ['기본 정보', '카드 설명'],
      lore: ['로어북', '폭풍의 항구 (Storm)', '로어 본문'],
      storyUi: ['이야기 UI CSS'],
      topLevel: ['설명'],
    },
    en: {
      scene: ['Scene 3', 'Original'],
      regex: ['Regex'],
      description: ['Basic information', 'Card description'],
      lore: ['Lorebook', '폭풍의 항구 (Storm)', 'Lore text'],
      storyUi: ['Story UI CSS'],
      topLevel: ['Description'],
    },
  };
  for (const locale of ['ko', 'en'] as const) {
    if (locale !== 'ko')
      await page.evaluate((value) => {
        localStorage.setItem('uimori:ui-language', value);
        dispatchEvent(new StorageEvent('storage', { key: 'uimori:ui-language', newValue: value }));
      }, locale);
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    const parts = expected[locale];
    await expect(location('등대지기의 밤')).toHaveText(parts.scene);
    await expect(location('정규식 봇')).toHaveText(parts.regex);
    await expect(location('긴 설명 봇')).toHaveText(parts.description);
    await expect(location('항구 봇')).toHaveText(parts.lore);
    await expect(location('등대 테마')).toHaveText(parts.storyUi);
    await expect(location('항구 삽화')).toHaveText(parts.topLevel);
    await expect(location('예전 봇')).toHaveText(['로어북 › 등대']);
    await expect(results.locator('.helper-change-location code')).toHaveText([
      'extensions/customField',
    ]);
    for (const text of await results.locator('.helper-change-location').allTextContents())
      expect(text).not.toContain('·');
    await page.screenshot({ path: info.outputPath(`change-locations-${locale}.png`) });
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

test('HCHANGE03 opening a change lands on its paragraph or lore entry and keeps the helper beside it', async ({
  page,
  request,
}, info) => {
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
  await page.screenshot({ path: info.outputPath('open-scene-from-side-panel.png') });

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
  await page.screenshot({ path: info.outputPath('open-lore-from-expanded-workspace.png') });
  expect(
    await library.locator('.nl-detail.arrival-mark').evaluate((node) => {
      const style = getComputedStyle(node);
      const extent = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
      const ring = node.getBoundingClientRect();
      let clip = node.parentElement;
      while (clip && getComputedStyle(clip).overflowX === 'visible') clip = clip.parentElement;
      const box = clip!.getBoundingClientRect();
      return (
        ring.left - extent >= box.left &&
        ring.top - extent >= box.top &&
        ring.right + extent <= box.right &&
        ring.bottom + extent <= box.bottom
      );
    })
  ).toBe(true);

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
  const landing = library.locator('.nl-detail');
  expect(await landing.evaluate((node) => getComputedStyle(node).animationName)).toBe('none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await results
    .getByRole('button', { name: `${content.title}, 로어북, 폭풍, 로어 본문 열기`, exact: true })
    .click();
  await expect(landing).toHaveClass(/arrival-mark/);
  expect(await landing.evaluate((node) => getComputedStyle(node).animationName)).toBe(
    'arrival-mark'
  );
  await expect(landing).not.toHaveClass(/arrival-mark/, { timeout: 5000 });
});

test('HRESULT03 the usage record splits the last request context and keeps short rows on one line', async ({
  page,
  request,
}, info) => {
  const { chat, task } = await seed(request);
  const usage: HelperTaskResultsView['usage'] = {
    toolExecutions: 4,
    latestInputEstimate: 48_000,
    latestInputTokens: 46_310,
    latestInputLimit: 128_000,
    latestInputExecution: 'provider-tool-loop',
    latestInputParts: {
      instructions: 5_200,
      toolSchemas: 13_800,
      history: 21_000,
      source: 6_000,
      toolResults: null,
    },
    attempts: [
      {
        id: 'first',
        ...traceDefaults,
        purpose: 'helper',
        status: 'completed',
        inputTokens: 40_000,
        outputTokens: 1_200,
        cachedInputTokens: 30_000,
        reasoningTokens: 400,
        costUsd: null,
        internalModelCalls: null,
      },
      {
        id: 'second',
        ...traceDefaults,
        purpose: 'helper',
        status: 'completed',
        inputTokens: 46_310,
        outputTokens: 800,
        cachedInputTokens: 38_000,
        reasoningTokens: 200,
        costUsd: null,
        internalModelCalls: null,
      },
    ],
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
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto(`/?chat=${chat.id}`);
    await openHelper(page);
    const answer = page.locator(`.helper-message.assistant[data-task-id="${task.id}"]`);
    const results = answer.getByTestId('helper-task-results');
    const summary = results.locator('.helper-result-usage > details > summary');
    const duration = answer.locator('.helper-task > .turn-activity > summary');
    await expect(summary).toContainText('마지막 입력 46.31K');
    if (width === 1440)
      expect(
        Math.abs((await summary.boundingBox())!.y - (await duration.boundingBox())!.y)
      ).toBeLessThan(4);
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
      await answer.screenshot({
        path: info.outputPath(`helper-usage-collapsed-${width}-${colorScheme}.png`),
      });
    }
    await summary.click();
    await expect(results.locator('.helper-usage-headline')).toHaveText(
      '마지막 요청 컨텍스트 약 48K / 128K보고된 입력 46,310'
    );
    expect(
      await results
        .locator('.context-breakdown-bar .context-breakdown-segment')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-part')))
    ).toEqual(['instructions', 'toolSchemas', 'history', 'source', 'other']);
    await expect(results.locator('.context-breakdown-legend > li')).toHaveText([
      '지시문5,200',
      '도구 설명13.8K',
      '대화21K',
      '원문과 자료6,000',
      '기타2,000',
    ]);
    await expect(usageValue(results, 'calls')).toHaveText('모델 2회도구 4회');
    await expect(usageValue(results, 'input')).toHaveText('86,310(캐시 68,000, 79%)');
    await expect(usageValue(results, 'output')).toHaveText('2,000(추론 600, 30%)');
    await expect(results.locator('.trace-summary [data-row="cost"]')).toHaveCount(0);
    for (const term of await results.locator('.trace-summary dt').all()) {
      const box = (await term.boundingBox())!;
      expect(box.height).toBeLessThan(30);
    }
    await expect(results.getByText('누적 입력은 각 요청에', { exact: false })).toBeHidden();
    await results.getByRole('button', { name: '구분 보기', exact: true }).click();
    const table = results.getByRole('table', { name: '마지막 요청 컨텍스트 구분', exact: true });
    for (const [label, value, share] of [
      ['대화', '21,000', '16.4%'],
      ['도구 결과', '미확인', ''],
      ['기타', '2,000', '1.6%'],
      ['합계 (추정)', '48,000', '37.5%'],
      ['남은 여유', '80,000', '62.5%'],
      ['자동 정리 기준', '108,800', '85%'],
    ])
      await expect(
        table
          .getByRole('row')
          .filter({ has: page.getByRole('rowheader', { name: label, exact: true }) })
          .getByRole('cell')
      ).toHaveText([value, share]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true
    );
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
      await answer.screenshot({
        path: info.outputPath(`helper-usage-expanded-${width}-${colorScheme}.png`),
      });
    }
    await page.emulateMedia({ colorScheme: 'light' });
  }
  usage.latestInputExecution = 'codex-native';
  usage.latestInputParts = null;
  usage.latestInputTokens = 90_040;
  await page.goto(`/?chat=${chat.id}`);
  await openHelper(page);
  const results = page
    .locator(`.helper-message.assistant[data-task-id="${task.id}"]`)
    .getByTestId('helper-task-results');
  await results.locator('.helper-result-usage > details > summary').click();
  await expect(results.locator('.helper-usage-headline')).toHaveText('마지막 요청 입력 90,040');
  await expect(results.locator('.context-breakdown-bar')).toHaveCount(0);
  await expect(results.getByRole('button', { name: '구분 보기', exact: true })).toHaveCount(0);
});

test('HUSAGE01 the composer shows the latest context estimate, its parts and the compaction mark', async ({
  page,
  request,
}, info) => {
  const { chat, task } = await seed(request);
  const usage: HelperTaskResultsView['usage'] = {
    toolExecutions: 3,
    attempts: [],
    latestInputEstimate: 240_000,
    latestInputLimit: 272_000,
    latestInputExecution: 'provider-tool-loop',
    latestInputParts: {
      instructions: 6_100,
      toolSchemas: 14_200,
      history: 180_000,
      source: 30_000,
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
  for (const [width, height, colorScheme] of [
    [1440, 900, 'light'],
    [1440, 900, 'dark'],
    [412, 915, 'light'],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await page.goto(`/?chat=${chat.id}`);
    await openHelper(page);
    const helper = page.locator('#helper-panel');
    const meter = helper.locator('.helper-context-usage > summary');
    await expect(meter).toContainText('컨텍스트 약');
    await expect(meter).toHaveAttribute(
      'aria-label',
      '컨텍스트 사용량: 추정 240,000 / 예산 272,000 토큰'
    );
    await expect(meter.locator('[data-level="near"]')).toHaveCount(1);
    const parts = ['instructions', 'toolSchemas', 'history', 'source', 'other'];
    await expect(meter.locator('.context-breakdown-segment')).toHaveCount(parts.length);
    await meter.click();
    const body = helper.locator('.helper-context-usage-body').filter({ visible: true });
    await expect(body.locator('.helper-context-usage-headline')).toHaveText(
      '약 240K / 272K 토큰88.2%'
    );
    const bar = body.locator('.context-breakdown-bar');
    await expect(bar).toHaveAttribute('aria-hidden', 'true');
    expect(
      await bar
        .locator('.context-breakdown-segment')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-part')))
    ).toEqual(parts);
    const table = body.getByRole('table', { name: '컨텍스트 사용량' });
    for (const [label, value, share] of [
      ['지시문', '6,100', '2.2%'],
      ['도구 설명', '14,200', '5.2%'],
      ['대화', '180,000', '66.2%'],
      ['원문과 자료', '30,000', '11%'],
      ['도구 결과', '미확인', ''],
      ['기타', '9,700', '3.6%'],
      ['합계 (추정)', '240,000', '88.2%'],
      ['남은 여유', '32,000', '11.8%'],
      ['자동 정리 기준', '231,200', '85%'],
    ])
      await expect(
        table
          .getByRole('row')
          .filter({ has: page.getByRole('rowheader', { name: label, exact: true }) })
          .getByRole('cell')
      ).toHaveText([value, share]);
    await expect(table.getByRole('rowheader', { name: '입력 예산' })).toHaveCount(0);
    await expect(body).not.toContainText('이 기기에서 센 추정치');
    await page.screenshot({ path: info.outputPath(`context-usage-${width}-${colorScheme}.png`) });
    await page.keyboard.press('Escape');
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => localStorage.setItem('uimori:panel-width', '360'));
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await page.goto(`/?chat=${chat.id}`);
    await openHelper(page);
    const modeChip = page.locator('#helper-panel .helper-mode-chip');
    if (colorScheme === 'light') await modeChip.click();
    await expect(modeChip).toHaveAccessibleName('요청 방식: 계획만');
    const summary = page.locator('#helper-panel .helper-context-usage > summary');
    await expect(summary).toHaveAccessibleName('컨텍스트 사용량: 추정 240,000 / 예산 272,000 토큰');
    await expect(summary.locator('.helper-context-usage-short')).toHaveText('약 240K');
    await expect(summary.locator('.helper-context-usage-short')).toBeVisible();
    await expect(summary.locator('.helper-context-usage-text')).toBeHidden();
    await expectOneToolRow(page);
    await page.screenshot({
      path: info.outputPath(`context-usage-plan-narrow-panel-${colorScheme}.png`),
    });
  }
  await page.evaluate(() => localStorage.removeItem('uimori:panel-width'));
  usage.latestInputExecution = 'codex-native';
  usage.latestInputTokens = 90_040;
  await page.goto(`/?chat=${chat.id}`);
  await openHelper(page);
  const native = page.locator('#helper-panel .helper-context-usage > summary');
  await expect(native).not.toContainText('약');
  await expect(native.locator('.context-breakdown-bar')).toHaveCount(0);
  await native.click();
  const nativeBody = page
    .locator('#helper-panel .helper-context-usage-body')
    .filter({ visible: true });
  await expect(nativeBody.locator('.context-breakdown-bar')).toHaveCount(0);
  await expect(
    nativeBody
      .getByRole('row')
      .filter({ has: page.getByRole('rowheader', { name: '마지막 보고 입력', exact: true }) })
      .getByRole('cell')
  ).toHaveText(['90,040']);
  await expect(nativeBody).toContainText('Codex가 컨텍스트를 직접 관리해요.');
  await page.keyboard.press('Escape');
  usage.latestInputExecution = 'provider-tool-loop';
  usage.latestInputTokens = null;
  usage.latestInputEstimate = null;
  await page.goto(`/?chat=${chat.id}`);
  await openHelper(page);
  await expect(page.locator('#helper-panel .helper-context-usage > summary')).toContainText(
    '컨텍스트 미확인'
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => localStorage.setItem('uimori:panel-width', '360'));
  await page.goto(`/?chat=${chat.id}`);
  await openHelper(page);
  const unknown = page.locator('#helper-panel .helper-context-usage > summary');
  await expect(unknown).toHaveAccessibleName('컨텍스트 사용량: 컨텍스트 미확인');
  await expect(unknown.locator('.helper-context-usage-icon')).toBeVisible();
  await expect(unknown.locator('.helper-context-usage-text')).toBeHidden();
  await expectOneToolRow(page);
  await page.screenshot({ path: info.outputPath('context-usage-unknown-narrow-panel.png') });
});

test('HUSAGE02 the context usage popover manually compacts the helper conversation and updates state', async ({
  page,
  request,
}, info) => {
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
    await expect(compactButton).toBeEnabled();
    await page.screenshot({ path: info.outputPath('manual-compact-before.png') });
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
    await expect(row('정리 전 대화')).toHaveCount(2);
    await expect(row('정리 후 요약')).toHaveCount(2);
    await expect(body).toContainText('정리 결과를 반영한 추정치예요.');
    await expect(body).toContainText('지금까지의 대화가 이미 정리돼 있어요.');
    await expect(compactButton).toBeDisabled();
    await page.screenshot({ path: info.outputPath('manual-compact-after.png') });

    const view = await (
      await request.get(`/api/helper/conversations/${conversation.id}/view`)
    ).json();
    expect(view.context).toMatchObject({
      compactedMessages: 2,
      uncompactedMessages: 0,
      totalMessages: 2,
      checkpointRevision: 1,
    });

    usage.latestInputExecution = 'codex-native';
    usage.latestInputTokens = 12_000;
    await page.reload();
    await openHelper(page);
    await helper.locator('.helper-context-usage > summary').click();
    await expect(
      helper
        .locator('.helper-context-usage-body')
        .filter({ visible: true })
        .getByRole('button', { name: '지금 대화 정리하기', exact: true })
    ).toHaveCount(0);
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

test('HUSAGE03 the helper summary dialog views, edits, keeps a draft through a conflict, resets, and locks while a task runs', async ({
  page,
  request,
}, info) => {
  const { chat, conversation, task } = await seed(request);
  let reply = '정리한 도우미 요약: 주인공은 아직 약속을 지키지 않았다.';
  let hold: Promise<void> | null = null;
  let release = () => {};
  const provider = createServer(async (incoming, response) => {
    for await (const _chunk of incoming) {
    }
    if (hold) await hold;
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
    const openSummary = async (screenshot?: string) => {
      await helper.locator('.helper-context-usage > summary').click();
      const show = page
        .locator('.helper-context-usage-body')
        .filter({ visible: true })
        .getByRole('button', { name: '요약 보기', exact: true });
      await expect(show).toBeVisible();
      if (screenshot) await page.screenshot({ path: info.outputPath(screenshot) });
      await show.click();
      await expect(dialog).toBeVisible();
    };
    const text = dialog.getByTestId('helper-summary-text');
    for (const [width, height, colorScheme] of [
      [1440, 900, 'light'],
      [1440, 900, 'dark'],
      [412, 915, 'light'],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
      await page.goto(`/?chat=${chat.id}`);
      await openHelper(page);
      await openSummary(`summary-menu-${width}-${colorScheme}.png`);
      await expect(text).toHaveText(reply);
      await expect(dialog.getByRole('list', { name: '요약 정보' })).toContainText('수동 정리');
      await expect(dialog.getByRole('list', { name: '요약 정보' })).toContainText(
        '메시지 2개 요약'
      );
      await page.screenshot({ path: info.outputPath(`summary-view-${width}-${colorScheme}.png`) });
      await dialog.getByRole('button', { name: '요약 편집', exact: true }).click();
      await expect(dialog.getByRole('textbox', { name: '편집할 컨텍스트 요약' })).toBeFocused();
      await page.screenshot({ path: info.outputPath(`summary-edit-${width}-${colorScheme}.png`) });
      await dialog.getByRole('button', { name: '편집 취소', exact: true }).click();
      await expect(dialog.getByRole('button', { name: '요약 편집', exact: true })).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    }

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    await page.goto(`/?chat=${chat.id}`);
    await openHelper(page);
    await openSummary();
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
    await page.screenshot({ path: info.outputPath('summary-conflict.png') });
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
    await expect(confirm).toContainText('다음 요청부터 전체 대화를 보내요.');
    await expect(confirm).toContainText('자동 정리 요청이 다시 실행될 수 있어요.');
    await page.screenshot({ path: info.outputPath('summary-reset-confirm.png') });
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
    await page.keyboard.press('Escape');
    await helper.locator('.helper-context-usage > summary').click();
    await expect(
      page
        .locator('.helper-context-usage-body')
        .filter({ visible: true })
        .getByRole('button', { name: '요약 보기', exact: true })
    ).toHaveCount(0);
    await page.keyboard.press('Escape');

    await compact();
    await page.reload();
    await openHelper(page);
    await openSummary();
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = await request.post(`/api/helper/conversations/${conversation.id}/messages`, {
      data: { requestKey: randomUUID(), text: '요약을 바꾸기 전에 오래 걸리는 작업' },
    });
    expect(running.ok(), await running.text()).toBe(true);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(dialog.getByText('진행 중인 작업이나 정리가 끝난 뒤 바꿀 수 있어요.')).toBeVisible(
      {
        timeout: 15_000,
      }
    );
    await expect(dialog.getByRole('button', { name: '요약 편집', exact: true })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: '요약 초기화', exact: true })).toBeDisabled();
    await page.screenshot({ path: info.outputPath('summary-busy.png') });
    hold = null;
    release();
    const runningTask = (await running.json()) as HelperTaskView;
    await expect
      .poll(
        async () =>
          (
            (await (
              await request.get(`/api/helper/tasks/${runningTask.id}`)
            ).json()) as HelperTaskView
          ).status
      )
      .toBe('completed');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(dialog.getByRole('button', { name: '요약 편집', exact: true })).toBeEnabled({
      timeout: 15_000,
    });
  } finally {
    release();
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

async function expectOneToolRow(page: Page) {
  const row = await page.locator('#helper-panel .helper-composer').evaluate((composer) => {
    const box = composer.getBoundingClientRect();
    const items = [
      ...composer.querySelectorAll<HTMLElement>(':is(.quick-controls > *, .send-button)'),
    ]
      .filter((node) => node.checkVisibility())
      .map((node) => ({
        rect: node.getBoundingClientRect(),
        clipped: node.scrollWidth > node.clientWidth + 1,
        name: node.getAttribute('aria-label') ?? node.className,
      }))
      .sort((a, b) => a.rect.left - b.rect.left);
    return {
      centers: items.map(({ rect }) => rect.top + rect.height / 2),
      overflow: Math.max(...items.map(({ rect }) => rect.right)) - box.right,
      overlaps: items.flatMap((item, index) =>
        index && items[index - 1]!.rect.right > item.rect.left + 0.5 ? [item.name] : []
      ),
      clipped: items.filter((item) => item.clipped).map((item) => item.name),
    };
  });
  expect(Math.max(...row.centers) - Math.min(...row.centers)).toBeLessThanOrEqual(2);
  expect(row.overflow).toBeLessThanOrEqual(0);
  expect(row.overlaps).toEqual([]);
  expect(row.clipped).toEqual([]);
}
