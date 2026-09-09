import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Chat, ChatDetail, Run } from '../core/types.js';
import type {
  HelperConversation,
  HelperEvent,
  HelperMessage,
  HelperScope,
} from '../core/helper.js';
import type { ResponseStreamPage } from '../core/response-stream.js';
import type { HelperArtifactView } from '../web/HelperArtifactCard.js';
import type { HelperTaskView } from '../web/useHelperConversation.js';
import { postFixtureChat } from './fixtures/chat.js';
import { navigationAction, openSourceActions } from './ui-navigation.js';

test.setTimeout(60000);
const usage = { modelCalls: 1, inputTokens: 10, outputTokens: 10, costUsd: null };
type Conversation = HelperConversation & { title: string };
type View = {
  conversation: Conversation;
  messages: HelperMessage[];
  tasks: HelperTaskView[];
  events: HelperEvent[];
};

/** UI projections only. Runtime/SQLite ownership and actual provider streaming have separate tests. */
async function harness(page: Page, seedCount = 0) {
  const views = new Map<string, View>();
  const receipts = new Map<string, HelperTaskView>();
  const streams = new Map<string, ResponseStreamPage>();
  const artifacts = new Map<string, HelperArtifactView[]>();
  const posts: { requestKey: string; text: string; selection?: unknown }[] = [];
  const streamReads = new Map<string, number>();
  const streamCursors = new Map<string, number[]>();
  const pendingStreams = new Map<string, number>();
  const maxPendingStreams = new Map<string, number>();
  const streamHolds = new Map<string, Promise<void>>();
  const heldStreams = new Set<string>();
  let nextSeq = 0,
    loseNext = false,
    eventReads = 0,
    eventStreamReads = 0;
  const event = (view: View, task: HelperTaskView, kind: string) =>
    view.events.push({
      seq: ++nextSeq,
      conversationId: view.conversation.id,
      taskId: task.id,
      kind,
      data: null,
    });
  const message = (
    view: View,
    task: HelperTaskView,
    role: HelperMessage['role'],
    text: string,
    refs: HelperMessage['artifacts'] = []
  ) =>
    view.messages.push({
      id: randomUUID(),
      conversationId: view.conversation.id,
      taskId: task.id,
      role,
      text,
      artifacts: refs,
      createdAt: new Date().toISOString(),
    });
  const add = (view: View, text: string, status: HelperTaskView['status']) => {
    const time = new Date().toISOString();
    const task: HelperTaskView = {
      id: randomUUID(),
      conversationId: view.conversation.id,
      request: text,
      status,
      generation: status === 'queued' ? 0 : 1,
      error: null,
      usage: { ...usage },
      createdAt: time,
      startedAt: status === 'queued' ? null : time,
      updatedAt: time,
    };
    view.tasks.unshift(task);
    message(view, task, 'user', text);
    return task;
  };
  await page.addInitScript(() => {
    (window as unknown as { helperUpdates: number }).helperUpdates = 0;
    window.addEventListener('uimori-helper-updated', () => {
      (window as unknown as { helperUpdates: number }).helperUpdates++;
    });
  });
  await page.route('**/api/response-streams/helper/**', async (route) => {
    const url = new URL(route.request().url()),
      taskId = url.pathname.split('/')[4];
    if (url.pathname.endsWith('/events')) {
      eventStreamReads++;
      return route.fulfill({ status: 400, json: { error: 'UI must use cursor HTTP batches' } });
    }
    streamReads.set(taskId, (streamReads.get(taskId) ?? 0) + 1);
    const after = Number(url.searchParams.get('after') ?? 0);
    streamCursors.set(taskId, [...(streamCursors.get(taskId) ?? []), after]);
    const pending = (pendingStreams.get(taskId) ?? 0) + 1;
    pendingStreams.set(taskId, pending);
    maxPendingStreams.set(taskId, Math.max(maxPendingStreams.get(taskId) ?? 0, pending));
    try {
      const hold = streamHolds.get(taskId);
      if (hold) {
        streamHolds.delete(taskId);
        heldStreams.add(taskId);
        await hold;
        heldStreams.delete(taskId);
      }
      const value = streams.get(taskId);
      if (!value)
        return await route.fulfill({ status: 404, json: { error: 'Response stream not found' } });
      return await route.fulfill({
        json: { ...value, chunks: value.chunks.filter((chunk) => chunk.seq > after) },
      });
    } finally {
      pendingStreams.set(taskId, (pendingStreams.get(taskId) ?? 1) - 1);
    }
  });
  await page.route('**/api/helper/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    const body = request.method() === 'GET' ? null : request.postDataJSON();
    if (path === '/api/helper/conversations' && request.method() === 'GET')
      return route.fulfill({
        json: [...views.values()]
          .filter((view) => view.conversation.scope.kind === url.searchParams.get('kind'))
          .map((view) => view.conversation)
          .reverse(),
      });
    if (path === '/api/helper/conversations' && request.method() === 'POST') {
      const scope = body.scope as HelperScope;
      let view = [...views.values()].find(
        (value) => JSON.stringify(value.conversation.scope) === JSON.stringify(scope)
      );
      if (!view) {
        const conversation: Conversation = {
          id: randomUUID(),
          scope,
          revision: 1,
          persona: '',
          limits: { totalCalls: 24, helperCalls: 12, artifacts: 1 },
          createdAt: new Date().toISOString(),
          title: `합성 작업 ${views.size + 1}`,
        };
        view = { conversation, messages: [], tasks: [], events: [] };
        views.set(conversation.id, view);
        if (views.size === 1)
          for (let index = 0; index < seedCount; index++) {
            const task = add(view, `합성 요청 ${index + 1}`, 'completed');
            message(
              view,
              task,
              'assistant',
              `합성 응답 ${index + 1}\n${'기록을 읽는 동안 입력한 초안과 위치를 보존해요. '.repeat(8)}`
            );
          }
      }
      return route.fulfill({ json: view.conversation });
    }
    const conversationMatch =
      /^\/api\/helper\/conversations\/([^/]+)(?:\/(messages|tasks|events))?$/u.exec(path);
    if (conversationMatch) {
      const view = views.get(conversationMatch[1])!;
      const kind = conversationMatch[2];
      if (!kind && request.method() === 'PATCH') {
        view.conversation = {
          ...view.conversation,
          persona: body.persona,
          limits: body.limits ?? view.conversation.limits,
          revision: view.conversation.revision + 1,
        };
        return route.fulfill({ json: view.conversation });
      }
      if (!kind) return route.fulfill({ json: view.conversation });
      if (kind === 'events') {
        eventReads++;
        return route.fulfill({
          json: view.events
            .filter((value) => value.seq > Number(url.searchParams.get('after') ?? 0))
            .slice(0, 500),
        });
      }
      if (kind === 'messages' && request.method() === 'POST') {
        posts.push(body);
        const previous = receipts.get(body.requestKey);
        const task =
          previous ??
          add(
            view,
            body.text,
            view.tasks.some((task) => task.status === 'running') ? 'queued' : 'running'
          );
        if (!previous) {
          if (body.retryOf) {
            const old = view.messages.find((message) => message.taskId === body.retryOf)!;
            const group = old.requestGroupId ?? old.taskId;
            for (const item of view.messages)
              if (item.taskId === task.id || (item.requestGroupId ?? item.taskId) === group) {
                item.requestGroupId = group;
                item.latestTaskId = task.id;
                item.requestOrder = old.requestOrder ?? 1;
              }
          }
          receipts.set(body.requestKey, task);
          event(view, task, 'task.queued');
          streams.set(task.id, {
            taskKind: 'helper',
            taskId: task.id,
            status: 'running',
            chunks: [],
            cursor: 0,
            hasMore: false,
          });
        }
        if (loseNext) {
          loseNext = false;
          return route.abort('failed');
        }
        return route.fulfill({ json: task });
      }
      const before = url.searchParams.get('before');
      if (kind === 'messages') {
        const end = before
          ? view.messages.findIndex((message) => message.id === before)
          : view.messages.length;
        return route.fulfill({ json: view.messages.slice(Math.max(0, end - 100), end) });
      }
      const start = before ? view.tasks.findIndex((task) => task.id === before) + 1 : 0;
      return route.fulfill({ json: view.tasks.slice(start, start + 50) });
    }
    const taskMatch = /^\/api\/helper\/tasks\/([^/]+)(\/cancel)?$/u.exec(path);
    if (taskMatch) {
      const view = [...views.values()].find((view) =>
        view.tasks.some((task) => task.id === taskMatch[1])
      )!;
      const task = view.tasks.find((task) => task.id === taskMatch[1])!;
      if (taskMatch[2]) {
        task.status = 'cancelled';
        event(view, task, 'task.cancelled');
        const stream = streams.get(task.id);
        if (stream) stream.status = 'cancelled';
      }
      return route.fulfill({ json: task });
    }
    const artifactMatch = /^\/api\/helper\/artifacts\/([^/]+)$/u.exec(path);
    if (artifactMatch) {
      const revisions = artifacts.get(artifactMatch[1])!;
      if (request.method() === 'PATCH') {
        const latest = revisions.at(-1)!;
        if (body.expectedRevision !== latest.revision)
          return route.fulfill({ status: 409, json: { error: '다른 장면 개정이 저장됐어요.' } });
        const next = {
          ...latest,
          revision: latest.revision + 1,
          origin: 'edit' as const,
          text: body.text,
        };
        revisions.push(next);
        return route.fulfill({ json: next });
      }
      const revision = url.searchParams.get('revision');
      return route.fulfill({
        json: revision
          ? revisions.find((value) => value.revision === Number(revision))
          : revisions.at(-1),
      });
    }
    return route.fulfill({ status: 404, json: { error: 'Synthetic route not configured' } });
  });
  return {
    views,
    posts,
    artifacts,
    streamReads,
    streamCursors,
    maxPendingStreams,
    heldStreams,
    get eventReads() {
      return eventReads;
    },
    get eventStreamReads() {
      return eventStreamReads;
    },
    holdNextStream(taskId: string) {
      let release = () => {};
      streamHolds.set(taskId, new Promise<void>((resolve) => (release = resolve)));
      return release;
    },
    loseNext: () => {
      loseNext = true;
    },
    current: () => [...views.values()].at(-1)!,
    progress(task: HelperTaskView, text: string, offset: number) {
      const value = streams.get(task.id)!;
      value.chunks.push({
        seq: ++nextSeq,
        attemptId: `attempt-${task.id}`,
        segment: 0,
        text,
        offset,
      });
      value.cursor = nextSeq;
    },
    complete(task: HelperTaskView) {
      const view = views.get(task.conversationId)!;
      task.status = 'completed';
      message(view, task, 'assistant', '합성 완료 응답');
      const user = view.messages.find((item) => item.taskId === task.id)!;
      Object.assign(view.messages.at(-1)!, {
        requestGroupId: user.requestGroupId,
        latestTaskId: user.latestTaskId,
        requestOrder: user.requestOrder,
      });
      event(view, task, 'task.completed');
      const stream = streams.get(task.id)!;
      stream.status = 'completed';
    },
    addFailed(view: View) {
      const task = add(view, '공개 응답이 없는 실패', 'failed');
      task.error = 'SYNTHETIC_FAILURE';
      return task;
    },
  };
}
async function create(request: APIRequestContext) {
  const response = await postFixtureChat(request, {
    data: { title: `도우미 합성 ${randomUUID()}` },
  });
  expect(response.ok()).toBe(true);
  return response.json() as Promise<Chat>;
}
async function open(page: Page) {
  await page.getByRole('button', { name: '도우미 열기', exact: true }).click();
  const panel = page.locator('#helper-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByText('대화를 불러오는 중…', { exact: true })).toHaveCount(0);
  return panel;
}

test('HELPUI01 helper panel preserves separate input, reading position and Back behavior at 390/1440', async ({
  page,
  request,
}, info) => {
  const chat = await create(request);
  await harness(page, 20);
  await page.goto(`/?chat=${chat.id}`);
  await page.getByLabel('다음 장면 요청').fill('본문 입력 초안');
  const panel = await open(page),
    input = panel.getByLabel('도우미에게 요청');
  await input.fill('도우미 입력 초안');
  const list = panel.locator('.helper-messages');
  await list.evaluate((node) => {
    node.scrollTop = 400;
  });
  const before = await list.evaluate((node) => node.scrollTop);
  await panel.getByRole('button', { name: '도우미 닫기', exact: true }).click();
  await expect(panel).toBeHidden();
  await expect(page.getByLabel('다음 장면 요청')).toHaveValue('본문 입력 초안');
  await open(page);
  await expect(input).toHaveValue('도우미 입력 초안');
  await expect.poll(() => list.evaluate((node) => node.scrollTop)).toBe(before);
  const url = page.url();
  await page.goBack();
  await expect(panel).toBeHidden();
  expect(page.url()).toBe(url);
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    await open(page);
    await expect(input).toHaveValue('도우미 입력 초안');
    const box = await panel.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true
    );
    await page.screenshot({ path: info.outputPath(`helper-panel-${width}.png`) });
    await panel.getByRole('button', { name: '도우미 닫기', exact: true }).click();
    await expect(panel).toBeHidden();
  }
});

test('HELPUI02 cursor HTTP deltas stay sequential and queued followups recover one request key', async ({
  page,
  request,
}) => {
  const chat = await create(request),
    state = await harness(page);
  await page.goto(`/?chat=${chat.id}`);
  const panel = await open(page),
    input = panel.getByLabel('도우미에게 요청');
  await input.fill('첫 작업');
  await panel.getByRole('button', { name: '도우미 요청 보내기' }).click();
  await expect(panel.getByText('첫 작업', { exact: true }).first()).toBeVisible();
  const first = state.current().tasks[0];
  await state.progress(first, '실제 공개 조각', 8);
  await expect(panel.locator('.streaming-text')).toHaveText('실제 공개 조각');
  const release = state.holdNextStream(first.id);
  try {
    await expect.poll(() => state.heldStreams.has(first.id)).toBe(true);
    const streamReads = state.streamReads.get(first.id),
      eventReads = state.eventReads;
    // An independent helper refresh advances while one deliberately slow response read is pending.
    await expect.poll(() => state.eventReads).toBeGreaterThanOrEqual(eventReads + 2);
    expect(state.streamReads.get(first.id)).toBe(streamReads);
    expect(state.maxPendingStreams.get(first.id)).toBe(1);
  } finally {
    release();
  }
  const continuation = ' · 이어진 조각';
  state.progress(first, continuation, 8 + continuation.length);
  await expect(panel.locator('.streaming-text')).toHaveText(`실제 공개 조각${continuation}`);
  expect(state.streamCursors.get(first.id)?.some((cursor) => cursor > 0)).toBe(true);
  expect(state.eventStreamReads).toBe(0);
  await input.fill('뒤이어 처리할 작업');
  await panel.getByRole('button', { name: '도우미 요청 보내기' }).click();
  const activity = panel.locator('[data-testid="helper-activity-status"]');
  await expect(activity.locator('.activity-label')).toHaveText('처리 중이에요');
  await expect(activity.locator('.activity-count')).toHaveText('외 1개');
  state.loseNext();
  await input.fill('접수 응답을 잃은 작업');
  await panel.getByRole('button', { name: '도우미 요청 보내기' }).click();
  await expect(panel.getByRole('button', { name: '접수 확인·다시 시도' })).toBeVisible();
  const key = state.posts.at(-1)!.requestKey;
  expect(state.current().tasks).toHaveLength(3);
  await page.reload();
  await open(page);
  await expect(panel.locator('.streaming-text')).toHaveText(`실제 공개 조각${continuation}`);
  await expect(panel.getByRole('button', { name: '접수 확인·다시 시도' })).toBeVisible();
  await panel.getByRole('button', { name: '접수 확인·다시 시도' }).click();
  await expect(panel.getByRole('button', { name: '접수 확인·다시 시도' })).toHaveCount(0);
  expect(state.posts.at(-1)!.requestKey).toBe(key);
  expect(state.current().tasks).toHaveLength(3);
  await state.complete(first);
  await expect(panel.getByText('합성 완료 응답', { exact: true })).toBeVisible();
  const reads = state.eventReads,
    completedStreamReads = state.streamReads.get(first.id);
  await expect.poll(() => state.eventReads).toBeGreaterThanOrEqual(reads + 2);
  expect(state.streamReads.get(first.id)).toBe(completedStreamReads);
  expect(state.eventStreamReads).toBe(0);
  expect(
    await page.evaluate(() => (window as unknown as { helperUpdates: number }).helperUpdates)
  ).toBe(1);
});

test('HELPUI03 library work selection, older pages and direct artifact edit preserve exact message references', async ({
  page,
  request,
}) => {
  const chat = await create(request),
    state = await harness(page, 55);
  await page.goto(`/?chat=${chat.id}`);
  await navigationAction(page, '서재');
  const panel = await open(page);
  const view = state.current(),
    task = view.tasks[0];
  const artifact: HelperArtifactView = {
    id: 'synthetic-artifact',
    revision: 1,
    origin: 'model',
    conversationId: view.conversation.id,
    taskId: task.id,
    request: '독립 장면',
    text: '원래 가정 장면',
    usage: { ...usage },
    createdAt: new Date().toISOString(),
  };
  state.artifacts.set(artifact.id, [artifact]);
  view.messages.at(-1)!.artifacts = [{ id: artifact.id, revision: 1 }];
  view.events.push({
    seq: 1,
    conversationId: view.conversation.id,
    taskId: task.id,
    kind: 'artifact.saved',
    data: null,
  });
  await expect(panel.getByRole('region', { name: '독립 가정 장면' })).toBeVisible();
  await panel.getByRole('button', { name: '이전 메시지 불러오기' }).click();
  await expect(panel.getByText('합성 요청 1', { exact: true }).first()).toBeVisible();
  await panel.locator('summary[aria-label="도우미 대화 더보기"]').click();
  await panel.getByRole('button', { name: '작업 기록', exact: true }).click();
  await panel.getByRole('button', { name: '이전 작업 더 보기' }).click();
  await expect(panel.locator('.helper-task-history h2')).toHaveText('도우미 작업 기록');
  await expect(panel.locator('[data-testid="helper-task-record"]')).toHaveCount(55);
  await panel.getByRole('button', { name: '도우미 작업 기록 닫기', exact: true }).click();
  const card = panel.getByRole('region', { name: '독립 가정 장면' });
  await card.getByRole('button', { name: '직접 편집', exact: true }).click();
  await card.getByLabel('가정 장면 직접 편집').fill('내 장면 편집 초안');
  await panel.getByLabel('도우미에게 요청').fill('별도로 유지할 요청 초안');
  state.artifacts
    .get(artifact.id)!
    .push({ ...artifact, revision: 2, origin: 'edit', text: '다른 창의 편집' });
  await card.getByRole('button', { name: '장면 편집 저장' }).click();
  await expect(card.getByLabel('가정 장면 직접 편집')).toHaveValue('내 장면 편집 초안');
  await card.getByRole('button', { name: '최신 장면을 확인했어요 · 내 초안 유지' }).click();
  await card.getByRole('button', { name: '장면 편집 저장' }).click();
  await expect(card.locator('.helper-prose')).toHaveText('내 장면 편집 초안');
  expect(state.artifacts.get(artifact.id)!.at(-1)!.revision).toBe(3);
  expect(view.messages.at(-1)!.artifacts).toEqual([{ id: artifact.id, revision: 1 }]);
  await expect(panel.getByLabel('도우미에게 요청')).toHaveValue('별도로 유지할 요청 초안');
  await panel.getByRole('button', { name: '새 서재 작업' }).click();
  await expect(
    panel.getByText('작품에 대해 묻거나, 설정을 다듬거나, 가정 장면을 부탁해 보세요.')
  ).toBeVisible();
  await panel.getByLabel('도우미에게 요청').fill('새 작업의 초안');
  await panel.getByLabel('서재 작업 선택').selectOption(view.conversation.id);
  await expect(panel.getByLabel('도우미에게 요청')).toHaveValue('별도로 유지할 요청 초안');
  await panel.locator('summary[aria-label="도우미 대화 더보기"]').click();
  await panel.getByRole('button', { name: '작업 기록', exact: true }).click();
  await expect(panel.locator('[data-testid="helper-task-record"]')).toHaveCount(55);
});

test('HELPUI04 selected source is frozen in the request and a terminal missing stream does not reconnect', async ({
  page,
  request,
}) => {
  const chat = await create(request),
    state = await harness(page);
  expect(
    (
      await request.patch(`/api/chats/${chat.id}/settings`, {
        data: {
          ...chat.settings,
          translation: false,
          status: false,
          expectedSettingsRevision: chat.settingsRevision,
        },
      })
    ).ok()
  ).toBe(true);
  const before = (await (await request.get(`/api/chats/${chat.id}`)).json()) as ChatDetail;
  const created = await request.post(`/api/chats/${chat.id}/runs`, {
    data: {
      request: '합성 항구의 종이 울린다.',
      expectedRevision: null,
      expectedSettingsRevision: before.chat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const run = (await created.json()) as Run;
  await expect
    .poll(
      async () =>
        ((await (await request.get(`/api/chats/${chat.id}`)).json()) as ChatDetail).runs.find(
          (value) => value.id === run.id
        )?.status
    )
    .toBe('completed');
  const saved = (await (await request.get(`/api/chats/${chat.id}`)).json()) as ChatDetail,
    source = saved.sources[0];
  await page.goto(`/?chat=${chat.id}`);
  const article = page.locator(`[data-testid="source"][data-source-id="${source.id}"]`);
  await openSourceActions(article);
  await article.getByRole('button', { name: '도우미에게 물어보기' }).click();
  const panel = page.locator('#helper-panel');
  await expect(panel).toBeVisible();
  await expect.poll(() => panel.getByLabel('도우미에게 요청').inputValue()).toContain(source.id);
  await panel.getByRole('button', { name: '도우미 요청 보내기' }).click();
  await expect.poll(() => state.posts.length).toBe(1);
  expect(state.posts[0].selection).toEqual({
    sourceId: source.id,
    sourceHash: source.hash,
    text: source.text.slice(0, 20000),
  });
  const failed = state.addFailed(state.current());
  state.current().events.push({
    seq: 100,
    conversationId: failed.conversationId,
    taskId: failed.id,
    kind: 'task.failed',
    data: null,
  });
  await expect(panel.getByText('공개 응답이 없는 실패', { exact: true }).first()).toBeVisible();
  await expect.poll(() => state.streamReads.get(failed.id) ?? 0).toBe(1);
  const reads = state.eventReads;
  await expect.poll(() => state.eventReads).toBeGreaterThanOrEqual(reads + 2);
  expect(state.streamReads.get(failed.id)).toBe(1);
  expect(
    ((await (await request.get(`/api/chats/${chat.id}`)).json()) as ChatDetail).sources
  ).toEqual(saved.sources);
});

test('HELPUI05 retry edits in place, preserves composer and hides historical failure after reload', async ({
  page,
  request,
}) => {
  const chat = await create(request),
    state = await harness(page);
  await page.goto(`/?chat=${chat.id}`);
  let panel = await open(page);
  state.addFailed(state.current());
  await page.reload();
  panel = await open(page);
  await panel.getByLabel('도우미에게 요청').fill('새 요청 작성 중');
  await panel.getByRole('button', { name: '요청 편집', exact: true }).click();
  await panel.getByLabel('요청 수정 내용').fill('고친 요청');
  await panel.getByRole('button', { name: '수정한 요청 보내기', exact: true }).click();
  await expect(panel.getByLabel('도우미에게 요청')).toHaveValue('새 요청 작성 중');
  await expect(panel.getByRole('group', { name: '실패한 요청' })).toHaveCount(0);
  state.complete(state.current().tasks[0]);
  await expect(panel.getByText('합성 완료 응답', { exact: true })).toBeVisible();
  await page.reload();
  panel = await open(page);
  await expect(panel.locator('[data-testid="source-request"]')).toHaveCount(1);
  await expect(panel.getByText('고친 요청', { exact: true })).toBeVisible();
  await expect(panel.getByRole('group', { name: '실패한 요청' })).toHaveCount(0);
  await panel.locator('summary[aria-label="도우미 대화 더보기"]').click();
  await panel.getByRole('button', { name: '작업 기록', exact: true }).click();
  await expect(panel.locator('[data-testid="helper-task-record"]')).toHaveCount(2);
  await expect(panel.locator('.helper-task-history').getByText('SYNTHETIC_FAILURE')).toBeVisible();
});
