import { MOBILE_WIDTH, DESKTOP_WIDTH, DEFAULT_WIDTHS } from './fixtures/browser-viewports.js';
import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Chat, ChatDetail, Run } from '../core/types.js';
import type {
  HelperConversation,
  HelperEvent,
  HelperMessage,
  HelperScope,
  HelperResourceEdit,
} from '../core/helper.js';
import type { HelperActivityEvent } from '../core/helper-activity.js';
import type { ResponseStreamPage } from '../core/response-stream.js';
import type { HelperArtifactView } from '../web/HelperArtifactCard.js';
import type { HelperTaskView } from '../web/useHelperConversation.js';
import type { ModelWorkspace } from '../core/product.js';
import { postFixtureChat, fixtureBotInput } from './fixtures/chat.js';
import { navigationAction, openSourceActions, openChatMenu } from './ui-navigation.js';
import { openHelper } from './ui-navigation.js';

test.setTimeout(60000);
const usage = { modelCalls: 1, inputTokens: 10, outputTokens: 10, costUsd: null };
type Conversation = HelperConversation & { title: string };
type View = {
  conversation: Conversation;
  messages: HelperMessage[];
  tasks: HelperTaskView[];
  events: HelperEvent[];
  lastResourceEdit?: HelperResourceEdit | null;
};

/** UI projections only. Runtime/SQLite ownership and actual provider streaming have separate tests. */
async function harness(page: Page, seedCount = 0) {
  const views = new Map<string, View>();
  const receipts = new Map<string, HelperTaskView>();
  const streams = new Map<string, ResponseStreamPage>();
  const artifacts = new Map<string, HelperArtifactView[]>();
  const activities = new Map<string, HelperActivityEvent[]>();
  const undoPosts: { editSeq: number }[] = [];
  let loseUndo = false;
  const posts: { requestKey: string; text: string; selection?: unknown }[] = [];
  const steerPosts: { taskId: string; requestKey: string; text: string }[] = [];
  const streamReads = new Map<string, number>();
  const streamCursors = new Map<string, number[]>();
  const pendingStreams = new Map<string, number>();
  const maxPendingStreams = new Map<string, number>();
  const streamHolds = new Map<string, Promise<void>>();
  const heldStreams = new Set<string>();
  let nextSeq = 0,
    loseNext = false,
    eventReads = 0,
    viewReads = 0,
    sessionReads = 0,
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
      modelTitle: '예약 당시 도우미 모델',
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
    if (path === '/api/helper/conversations' && request.method() === 'GET') {
      sessionReads++;
      return route.fulfill({
        json: [...views.values()]
          .filter((view) => {
            const scope = view.conversation.scope;
            return (
              scope.kind === url.searchParams.get('kind') &&
              (scope.kind === 'library' || scope.chatId === url.searchParams.get('chatId'))
            );
          })
          .map((view) => ({
            ...view.conversation,
            activity: {
              running: view.tasks.filter((task) => task.status === 'running').length,
              queued: view.tasks.filter((task) => task.status === 'queued').length,
            },
            latestEventSeq: view.events.at(-1)?.seq ?? 0,
          }))
          .reverse(),
      });
    }
    if (
      ['/api/helper/conversations', '/api/helper/conversations/new'].includes(path) &&
      request.method() === 'POST'
    ) {
      const scope = body.scope as HelperScope;
      let view = path.endsWith('/new')
        ? undefined
        : [...views.values()].find(
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
          updatedAt: new Date().toISOString(),
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
      /^\/api\/helper\/conversations\/([^/]+)(?:\/(view|messages|tasks|events|undo-resource))?$/u.exec(
        path
      );
    if (conversationMatch) {
      const view = views.get(conversationMatch[1]);
      if (!view)
        return route.fulfill({ status: 404, json: { error: 'Helper conversation not found' } });
      const kind = conversationMatch[2];
      if (!kind && request.method() === 'PATCH') {
        view.conversation = {
          ...view.conversation,
          title: body.title ?? view.conversation.title,
          persona: body.persona ?? view.conversation.persona,
          limits: body.limits ?? view.conversation.limits,
          revision: view.conversation.revision + 1,
        };
        return route.fulfill({ json: view.conversation });
      }
      if (!kind) return route.fulfill({ json: view.conversation });
      if (kind === 'undo-resource') {
        undoPosts.push(body);
        const edit = view.lastResourceEdit;
        if (!edit || edit.editSeq !== body.editSeq || !edit.canUndo)
          return route.fulfill({
            status: 409,
            json: { error: '최근 저장 이후 자료가 변경됐어요.' },
          });
        view.lastResourceEdit = { ...edit, canUndo: false, undone: true };
        if (loseUndo) {
          loseUndo = false;
          return route.abort('failed');
        }
        return route.fulfill({ json: view.lastResourceEdit });
      }
      if (kind === 'view') {
        viewReads++;
        return route.fulfill({
          json: {
            conversation: view.conversation,
            messages: view.messages.slice(-100).map((message) => ({
              ...message,
              taskStatus: view.tasks.find((task) => task.id === message.taskId)?.status,
            })),
            tasks: view.tasks.slice(0, 50),
            eventCursor: view.events.at(-1)?.seq ?? 0,
            lastResourceEdit: view.lastResourceEdit ?? null,
          },
        });
      }
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
    const taskMatch = /^\/api\/helper\/tasks\/([^/]+)(\/cancel|\/activity|\/steer)?$/u.exec(path);
    if (taskMatch) {
      const view = [...views.values()].find((view) =>
        view.tasks.some((task) => task.id === taskMatch[1])
      )!;
      const task = view.tasks.find((task) => task.id === taskMatch[1])!;
      if (taskMatch[2] === '/steer') {
        steerPosts.push({ taskId: task.id, requestKey: body.requestKey, text: body.text });
        const instructions = (task.instructions ??= []);
        if (!instructions.some((instruction) => instruction.requestKey === body.requestKey)) {
          instructions.push({
            id: instructions.length + 1,
            requestKey: body.requestKey,
            text: body.text,
            status: 'pending',
          });
          event(view, task, 'instruction.added');
        }
        if (loseNext) {
          loseNext = false;
          return route.abort('failed');
        }
        return route.fulfill({ json: task });
      }
      if (taskMatch[2] === '/activity')
        return route.fulfill({
          json: {
            taskId: task.id,
            status: task.status,
            events: activities.get(task.id) ?? [],
            hasEarlier: false,
          },
        });
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
          return route.fulfill({ status: 409, json: { error: '다른 장면 변경이 저장됐어요.' } });
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
    steerPosts,
    artifacts,
    undoPosts,
    loseUndo: () => {
      loseUndo = true;
    },
    activity: (task: HelperTaskView, events: HelperActivityEvent[]) =>
      activities.set(task.id, events),
    streamReads,
    streams,
    streamCursors,
    maxPendingStreams,
    heldStreams,
    get eventReads() {
      return eventReads;
    },
    get viewReads() {
      return viewReads;
    },
    get sessionReads() {
      return sessionReads;
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
    emit(kind: string) {
      const view = [...views.values()].at(-1)!;
      view.events.push({
        seq: ++nextSeq,
        conversationId: view.conversation.id,
        taskId: null,
        kind,
        data: null,
      });
    },
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
  await openHelper(page);
  const panel = page.locator('#helper-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByLabel('도우미에게 요청')).toBeEnabled();
  await expect(panel.getByText('대화를 불러오는 중…', { exact: true })).toHaveCount(0);
  return panel;
}

for (const width of [MOBILE_WIDTH, DESKTOP_WIDTH]) {
  test(`HELPSTEER adds instructions to the active task and keeps ordinary requests queued ${width}`, async ({
    page,
    request,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const chat = await create(request),
      state = await harness(page);
    await page.goto(`/?chat=${chat.id}`);
    let panel = await open(page);
    await panel.getByLabel('도우미에게 요청').fill('자료 전체를 살펴봐 주세요');
    await panel.getByRole('button', { name: '도우미 요청 보내기', exact: true }).click();
    await expect(panel.getByLabel('도우미에게 요청')).toHaveValue('');
    const task = state.current().tasks[0];
    const instructionText = '우선 설명문만 살펴봐 주세요';
    await panel.getByLabel('도우미에게 요청').fill(instructionText);
    if (width === DESKTOP_WIDTH) state.loseNext();
    await panel.getByRole('button', { name: '현재 작업에 추가', exact: true }).click();
    if (width === DESKTOP_WIDTH) {
      await expect(panel.getByRole('button', { name: '접수 확인·다시 시도' })).toBeVisible();
      await expect(panel.getByLabel('도우미에게 요청')).toHaveValue(instructionText);
      await page.reload();
      panel = await open(page);
      await panel.getByRole('button', { name: '접수 확인·다시 시도' }).click();
      await expect(panel.locator('.helper-outbox')).toHaveCount(0);
      expect(state.steerPosts).toHaveLength(2);
      expect(state.steerPosts[1]).toEqual(state.steerPosts[0]);
    }
    await expect(panel.getByLabel('도우미에게 요청')).toHaveValue('');
    expect(state.steerPosts[0]).toMatchObject({ taskId: task.id, text: instructionText });
    expect(state.posts).toHaveLength(1);
    expect(state.current().tasks).toHaveLength(1);
    expect(task.instructions).toHaveLength(1);
    const instruction = panel
      .locator(`.helper-task[data-task-id="${task.id}"]`)
      .getByTestId('helper-instruction');
    await expect(instruction).toContainText(instructionText);
    await expect(instruction.getByRole('status')).toContainText('전달 대기');
    task.instructions![0].status = 'delivered';
    state.emit('instruction.updated');
    await expect(instruction.getByRole('status')).toContainText('작업 입력에 반영');

    await panel.getByLabel('도우미에게 요청').fill('그다음 첫 메시지를 검토해 주세요');
    const send = panel.getByRole('button', { name: '도우미 요청 보내기', exact: true });
    await expect(send).toHaveAttribute('title', '다음 요청으로 보내기');
    await send.click();
    await expect(panel.getByLabel('도우미에게 요청')).toHaveValue('');
    expect(state.posts).toHaveLength(2);
    expect(state.current().tasks).toHaveLength(2);
    expect(state.current().tasks[0]).toMatchObject({
      request: '그다음 첫 메시지를 검토해 주세요',
      status: 'queued',
    });
    expect(task.status).toBe('running');
    await page.screenshot({ path: info.outputPath(`helper-steer-${width}.png`), fullPage: true });
  });
}

test('HELPUI13 completed helper response renders common Markdown and copies its exact source', async ({
  page,
  request,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.setViewportSize({ width: MOBILE_WIDTH, height: 844 });
  const chat = await create(request),
    state = await harness(page, 1);
  await page.goto(`/?chat=${chat.id}`);
  let panel = await open(page);
  const view = state.current();
  const answer = view.messages.find((message) => message.role === 'assistant')!;
  answer.text =
    '| 영향 | 이전 동작 | 변경 후 |\n| :--- | :---: | ---: |\n| 표 | `a|b` | **정상** |\n\n- [x] 확인됨\n\n<https://example.com/report>';
  await page.reload();
  panel = await open(page);
  const message = panel.locator('.helper-message.assistant').first();
  const table = message.getByRole('table');
  await expect(table).toBeVisible();
  await expect(table.getByRole('columnheader')).toHaveCount(3);
  await expect(table.getByRole('cell').nth(1)).toHaveText('a|b');
  await expect(message.locator('.prose-task-item input[type="checkbox"]')).toBeChecked();
  await expect(message.getByRole('link', { name: 'https://example.com/report' })).toBeVisible();
  expect(await panel.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);

  await message.getByRole('button', { name: '도우미 응답 복사', exact: true }).click();
  await expect(
    message.getByRole('button', { name: '도우미 응답 복사됨', exact: true })
  ).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied.replace(/\r\n/gu, '\n')).toBe(answer.text);
});

test('HELPUI12 helper settings event refreshes an open model editor without replacing its draft', async ({
  page,
  request,
}, info) => {
  const state = await harness(page);
  await page.goto('/');
  await navigationAction(page, '서재');
  const panel = await open(page);
  await panel.getByRole('button', { name: '도우미 말투 설정' }).click();
  await panel.locator('.helper-limits > summary').click();
  for (const width of [1440, MOBILE_WIDTH]) {
    await page.setViewportSize({ width, height: 900 });
    const settings = panel.locator('.helper-settings');
    await expect(settings.locator('input[type="number"]')).toHaveCount(3);
    expect(
      await settings.evaluate((node) => node.scrollWidth - node.clientWidth)
    ).toBeLessThanOrEqual(1);
    await settings.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    const save = panel.getByRole('button', { name: '도우미 설정 저장', exact: true });
    await expect(save).toBeInViewport();
    const saveBox = (await save.boundingBox())!;
    const actionBox = (await settings.locator('.helper-settings-actions').boundingBox())!;
    expect(Math.abs(actionBox.x + actionBox.width - saveBox.x - saveBox.width)).toBeLessThanOrEqual(
      1
    );
    await page.screenshot({ path: info.outputPath(`helper-settings-${width}.png`) });
    await settings.evaluate((node) => {
      node.scrollTop = 0;
    });
  }
  await panel.getByRole('button', { name: /^현재 도우미 모델/ }).click();
  const editor = page.getByRole('region', { name: '역할별 모델 설정', exact: true });
  await expect(editor).toBeVisible();
  await editor.locator('.task-behavior-settings > summary').click();
  const draft = editor.getByLabel('번역 작업 호출 한도', { exact: true });
  await draft.fill('9');

  const before = (await (await request.get('/api/model-workspace')).json()) as ModelWorkspace;
  const changed = await request.put('/api/model-workspace', {
    data: {
      expectedRevision: before.revision,
      routes: before.routes,
      mainJudgmentEnabled: before.mainJudgmentEnabled,
      mainJudgmentThreshold: before.mainJudgmentThreshold,
      translationPolicy: { ...before.translationPolicy, maxCalls: 12 },
    },
  });
  expect(changed.ok()).toBe(true);
  state.emit('settings.updated');

  await expect(editor.getByRole('alert')).toContainText('초안은 유지했어요', { timeout: 15000 });
  await expect(draft).toHaveValue('9');
  await expect(editor.getByRole('button', { name: '역할별 모델 설정 저장' })).toBeDisabled();
});

test(`HELPUI01 helper panel preserves separate input, reading position and Back behavior at ${MOBILE_WIDTH}/${DESKTOP_WIDTH}`, async ({
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
  for (const width of DEFAULT_WIDTHS) {
    await page.setViewportSize({ width, height: 844 });
    await open(page);
    if (width === DESKTOP_WIDTH)
      await expect(page.getByRole('button', { name: '도우미 열기', exact: true })).toBeHidden();
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
    if (width === DESKTOP_WIDTH)
      await expect(page.getByRole('button', { name: '도우미 열기', exact: true })).toBeVisible();
  }
});

test('HELPUI14 idle and hidden helper views pause reads and resume cursors, effects and drafts', async ({
  page,
  request,
}) => {
  const chat = await create(request);
  const state = await harness(page);
  await page.goto(`/?chat=${chat.id}`);
  const panel = await open(page);
  const input = panel.getByLabel('도우미에게 요청');
  const idleSessions = state.sessionReads;
  const idleEvents = state.eventReads;
  // The former 1.2/2.4-second idle loops both fired within this window.
  await page.waitForTimeout(2800);
  expect(state.sessionReads).toBe(idleSessions);
  expect(state.eventReads).toBe(idleEvents);

  await input.fill('화면 밖에서도 계속할 작업');
  await panel.getByRole('button', { name: '도우미 요청 보내기' }).click();
  await expect.poll(() => state.sessionReads).toBeGreaterThan(idleSessions);
  const task = state.current().tasks[0];
  state.progress(task, '첫 조각', 4);
  await expect(panel.locator('.streaming-text')).toHaveText('첫 조각');
  await input.fill('다시 열어도 남길 초안');
  await panel.getByRole('button', { name: '도우미 닫기', exact: true }).click();
  await expect(panel).toBeHidden();
  const closedReads = state.streamReads.get(task.id);
  const closedEvents = state.eventReads;
  const clock = panel.locator('.activity-elapsed');
  const closedTime = await clock.textContent();
  state.progress(task, '과 두 번째 조각', 13);
  await page.waitForTimeout(1600);
  expect(state.streamReads.get(task.id)).toBe(closedReads);
  expect(state.eventReads).toBe(closedEvents);
  expect(await clock.textContent()).toBe(closedTime);
  expect(task.status).toBe('running');

  await open(page);
  await expect(input).toHaveValue('다시 열어도 남길 초안');
  await expect(panel.locator('.streaming-text')).toHaveText('첫 조각과 두 번째 조각');
  expect(state.streamCursors.get(task.id)?.at(-1)).toBeGreaterThan(0);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const hiddenReads = state.streamReads.get(task.id);
  const hiddenSessions = state.sessionReads;
  const hiddenEvents = state.eventReads;
  const hiddenTime = await clock.textContent();
  await page.waitForTimeout(2800);
  expect(state.streamReads.get(task.id)).toBe(hiddenReads);
  expect(state.sessionReads).toBe(hiddenSessions);
  expect(state.eventReads).toBe(hiddenEvents);
  expect(await clock.textContent()).toBe(hiddenTime);

  await page.evaluate(() => {
    (window as unknown as { receivedHelperEffects: string[] }).receivedHelperEffects = [];
    for (const type of [
      'uimori-helper-updated',
      'uimori-themes-changed',
      'uimori-illustration-presets-changed',
    ])
      window.addEventListener(type, () =>
        (window as unknown as { receivedHelperEffects: string[] }).receivedHelperEffects.push(type)
      );
  });
  state.complete(task);
  for (const kind of ['settings.updated', 'theme.updated', 'illustration-preset.updated'])
    state.emit(kind);
  await page.evaluate(() => {
    delete (document as unknown as { hidden?: boolean }).hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(panel.getByText('합성 완료 응답', { exact: true })).toBeVisible();
  await expect(input).toHaveValue('다시 열어도 남길 초안');
  expect(
    await page.evaluate(
      () => (window as unknown as { receivedHelperEffects: string[] }).receivedHelperEffects
    )
  ).toEqual(
    expect.arrayContaining([
      'uimori-helper-updated',
      'uimori-themes-changed',
      'uimori-illustration-presets-changed',
    ])
  );
  expect(state.posts).toHaveLength(1);
});

test('HELPUI10 a full localStorage keeps helper input in IndexedDB and still admits the request', async ({
  page,
  request,
}) => {
  const chat = await create(request),
    state = await harness(page);
  await page.goto(`/?chat=${chat.id}`);
  let panel = await open(page);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('uimori:helper-')) throw new DOMException('Full', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  });
  await panel.getByLabel('도우미에게 요청').fill('저장 공간이 가득 차도 남는 초안');
  await page.reload();
  panel = await open(page);
  await expect(panel.getByLabel('도우미에게 요청')).toHaveValue('저장 공간이 가득 차도 남는 초안');
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('uimori:helper-')) throw new DOMException('Full', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  });
  await panel.getByRole('button', { name: '도우미 요청 보내기' }).click();
  await expect.poll(() => state.posts.length).toBe(1);
  expect(state.posts[0].text).toBe('저장 공간이 가득 차도 남는 초안');
});

test('HELPUI11 an IndexedDB write failure retains the exact request for explicit sending', async ({
  page,
  request,
}) => {
  const chat = await create(request),
    state = await harness(page);
  await page.goto(`/?chat=${chat.id}`);
  const panel = await open(page),
    input = panel.getByLabel('도우미에게 요청');
  await page.evaluate(() => {
    const original = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args) {
      if (this.name === 'uimori-editor-recovery' && args[1] === 'readwrite')
        throw new DOMException('Disk full', 'QuotaExceededError');
      return original.apply(this, args);
    };
  });
  await input.fill('보관에 실패한 첫 요청');
  await panel.getByRole('button', { name: '도우미 요청 보내기' }).click();
  await expect(panel.getByRole('button', { name: '보관 없이 보내기' })).toBeVisible();
  expect(state.posts).toHaveLength(0);
  await input.fill('보내는 동안 남길 새 입력');
  await panel.getByRole('button', { name: '보관 없이 보내기' }).click();
  await expect.poll(() => state.posts.length).toBe(1);
  expect(state.posts[0].text).toBe('보관에 실패한 첫 요청');
  await expect(input).toHaveValue('보내는 동안 남길 새 입력');
});

test('HELPUI02 cursor deltas stay sequential, skip diagnostic view reloads and recover one request key', async ({
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
  await expect.poll(() => state.current().tasks.length).toBe(1);
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
  const viewsBeforeDiagnostics = state.viewReads,
    eventsBeforeDiagnostics = state.eventReads;
  for (const kind of [
    'tool.finished',
    'input.measured',
    'progress',
    'context.compaction',
    'context.segment',
  ])
    state.emit(kind);
  // Consume the diagnostic page and a later poll, so a pending reload cannot pass unnoticed.
  await expect.poll(() => state.eventReads).toBeGreaterThanOrEqual(eventsBeforeDiagnostics + 2);
  expect(state.viewReads).toBe(viewsBeforeDiagnostics);
  await expect(panel.locator('.streaming-text')).toHaveText(`실제 공개 조각${continuation}`);
  const firstTaskStatus = panel.locator(`.helper-task[data-task-id="${first.id}"]`);
  await firstTaskStatus.locator(':scope > details > summary').click();
  first.usage = { ...first.usage, modelCalls: 2, inputTokens: 25 };
  state.emit('attempt.finished');
  state.emit('tool.finished');
  await expect(firstTaskStatus).toContainText('실행 요청 2회 · 누적 입력 25');
  expect(state.viewReads).toBe(viewsBeforeDiagnostics + 1);
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
  // This external change arrives while idle: allow the 10-second list poll and its follow-up reads.
  await expect(panel.getByRole('region', { name: '독립 가정 장면' })).toBeVisible({
    timeout: 15000,
  });
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
  await panel.getByRole('button', { name: '새 도우미 세션' }).click();
  await expect(
    panel.getByText('작품에 대해 묻거나, 설정을 다듬거나, 가정 장면을 부탁해 보세요.')
  ).toBeVisible();
  await panel.getByLabel('도우미에게 요청').fill('새 작업의 초안');
  await panel.getByLabel('도우미 세션 선택').selectOption(view.conversation.id);
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
  const saved = (await (await request.get(`/api/chats/${chat.id}`)).json()) as ChatDetail;
  const selectedText =
    '선택의 시작\n' + '길게 이어지는 선택 원문이에요.\n'.repeat(7000) + '선택의 끝';
  expect(selectedText.length).toBeGreaterThan(123_162);
  const edited = await request.put(`/api/sources/${saved.sources[0].id}/text`, {
    data: { text: selectedText, expectedRevision: saved.sources[0].editRevision ?? 0 },
  });
  expect(edited.ok(), await edited.text()).toBe(true);
  const source = (await edited.json()) as ChatDetail['sources'][number];
  const selectedSources = (
    (await (await request.get(`/api/chats/${chat.id}`)).json()) as ChatDetail
  ).sources;
  await page.goto(`/?chat=${chat.id}`);
  const article = page.locator(`[data-testid="source"][data-source-id="${source.id}"]`);
  // A session deleted in another window must not break the source-to-helper entry point.
  await page.evaluate((chatId) => {
    const scope = { kind: 'chat', chatId };
    localStorage.setItem(
      `uimori:helper-session-scope:${JSON.stringify(scope)}`,
      'deleted-helper-session'
    );
  }, chat.id);
  await openSourceActions(article);
  await article.getByRole('button', { name: '도우미에게 물어보기' }).click();
  const panel = page.locator('#helper-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByLabel('도우미에게 요청')).toHaveValue('선택한 원문을 검토해 주세요.');
  await expect(
    panel.getByText(`선택한 원문 · ${selectedText.length.toLocaleString()}자`, { exact: true })
  ).toBeVisible();
  const customRequest = '선택한 원문 전체에서 마지막 문장이 앞부분과 모순되는지 검토해 주세요.';
  await panel.getByLabel('도우미에게 요청').fill(customRequest);
  await panel.getByRole('button', { name: '도우미 닫기', exact: true }).click();
  await openSourceActions(article);
  await article.getByRole('button', { name: '도우미에게 물어보기' }).click();
  await expect(panel.getByLabel('도우미에게 요청')).toHaveValue(customRequest);
  await panel.getByRole('button', { name: '도우미 요청 보내기' }).click();
  await expect.poll(() => state.posts.length).toBe(1);
  expect(state.posts[0].selection).toEqual({
    sourceId: source.id,
    sourceHash: source.hash,
    text: selectedText,
  });
  expect(state.posts[0].text).toBe(customRequest);
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
  ).toEqual(selectedSources);
});

test('HELPUI05 retry edits in place, preserves composer and hides historical failure after reload', async ({
  page,
  request,
}) => {
  const chat = await create(request),
    state = await harness(page);
  await page.goto(`/?chat=${chat.id}`);
  let panel = await open(page);
  const failed = state.addFailed(state.current());
  failed.modelTitle = '이전 시도의 도우미 모델';
  await page.reload();
  panel = await open(page);
  const details = panel.locator(
    `[data-testid="helper-task-activity"][data-task-id="${failed.id}"]`
  );
  await details.locator(':scope > summary').click();
  await expect(details.getByText('모델 · 이전 시도의 도우미 모델', { exact: true })).toBeVisible();
  await panel.getByLabel('도우미에게 요청').fill('새 요청 작성 중');
  await panel.getByRole('button', { name: '요청 편집', exact: true }).click();
  await panel.getByLabel('요청 수정 내용').fill('고친 요청');
  state.loseNext();
  await panel.getByRole('button', { name: '수정한 요청 보내기', exact: true }).click();
  await expect(panel.getByRole('button', { name: '접수 확인·다시 시도' })).toBeVisible();
  const key = state.posts.at(-1)!.requestKey;
  await page.reload();
  panel = await open(page);
  await expect(panel.getByRole('button', { name: '접수 확인·다시 시도' })).toBeVisible();
  await panel.getByRole('button', { name: '접수 확인·다시 시도' }).click();
  await expect.poll(() => state.posts.length).toBe(2);
  expect(state.posts[1].requestKey).toBe(key);
  await expect(panel.getByLabel('도우미에게 요청')).toHaveValue('새 요청 작성 중');
  await expect(panel.getByRole('group', { name: '실패한 요청' })).toHaveCount(0);
  const retried = state.current().tasks[0];
  retried.modelTitle = '재시도에 선택한 도우미 모델';
  state.complete(retried);
  await expect(panel.getByText('합성 완료 응답', { exact: true })).toBeVisible();
  await page.reload();
  panel = await open(page);
  await expect(panel.locator('[data-testid="source-request"]')).toHaveCount(1);
  await expect(panel.getByText('고친 요청', { exact: true })).toBeVisible();
  await expect(panel.getByRole('group', { name: '실패한 요청' })).toHaveCount(0);
  await panel.locator('summary[aria-label="도우미 대화 더보기"]').click();
  await panel.getByRole('button', { name: '작업 기록', exact: true }).click();
  await expect(panel.locator('[data-testid="helper-task-record"]')).toHaveCount(2);
  await expect(
    panel.locator(`[data-testid="helper-task-record"][data-task-id="${failed.id}"]`)
  ).toContainText('모델 · 이전 시도의 도우미 모델');
  await expect(
    panel.locator(`[data-testid="helper-task-record"][data-task-id="${retried.id}"]`)
  ).toContainText('모델 · 재시도에 선택한 도우미 모델');
  await expect(panel.locator('.helper-task-history').getByText('SYNTHETIC_FAILURE')).toBeVisible();
});

test('HELPUI06 saved effects survive response failure and cannot be replayed from retry controls', async ({
  page,
  request,
}) => {
  const chat = await create(request),
    state = await harness(page);
  await page.goto(`/?chat=${chat.id}`);
  await open(page);
  const failed = state.addFailed(state.current());
  failed.error = 'UNEXPECTED_EOF';
  failed.completedEffects = { count: 1, labels: ['다음 요청 옵션'] };
  await page.reload();
  const panel = await open(page);
  await expect(panel.getByTestId('helper-completed-effects')).toContainText(
    '변경 1건은 저장됐지만 응답은 완료되지 않았어요.'
  );
  await expect(panel.getByRole('button', { name: '다시 시도', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: '요청 편집', exact: true })).toHaveCount(0);
  await panel.getByLabel('도우미에게 요청').fill('저장한 옵션의 현재 값을 확인해 줘');
  await expect(panel.getByLabel('도우미에게 요청')).toHaveValue(
    '저장한 옵션의 현재 값을 확인해 줘'
  );
  expect(state.posts).toHaveLength(0);
  const details = panel.locator(
    `[data-testid="helper-task-activity"][data-task-id="${failed.id}"]`
  );
  await details.locator(':scope > summary').click();
  await expect(details.getByText('저장한 작업 · 다음 요청 옵션')).toBeVisible();
  await expect(details.getByText('UNEXPECTED_EOF', { exact: true })).toBeVisible();
});

test('HELPUI07 switching sessions isolates late responses and retains the background task', async ({
  page,
  request,
}) => {
  const chat = await create(request),
    state = await harness(page);
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
  await page.goto(`/?chat=${chat.id}`);
  const panel = await open(page),
    input = panel.getByLabel('도우미에게 요청');
  const picker = panel.getByLabel('도우미 세션 선택');
  const firstId = await picker.inputValue();
  await input.fill('첫 세션의 실행');
  await panel.getByRole('button', { name: '도우미 요청 보내기', exact: true }).click();
  await expect(input).toHaveValue('');
  const firstTask = state.views.get(firstId)!.tasks[0];
  await input.fill('첫 세션의 다음 초안');
  const release = state.holdNextStream(firstTask.id);
  try {
    await expect.poll(() => state.heldStreams.has(firstTask.id)).toBe(true);
    await panel.getByRole('button', { name: '새 도우미 세션', exact: true }).click();
    await expect(picker).not.toHaveValue(firstId);
    await expect(input).toBeEnabled();
    await expect(input).toHaveValue('');
    await input.fill('다른 세션에서 쓰는 초안');
    expect(firstTask.status).toBe('running');
    state.complete(firstTask);
    release();
    await expect
      .poll(() => picker.locator(`option[value="${firstId}"]`).textContent())
      .toContain('●');
    await expect(input).toHaveValue('다른 세션에서 쓰는 초안');
    await expect(panel.getByText('합성 완료 응답', { exact: true })).toHaveCount(0);
    await picker.selectOption(firstId);
    await expect(input).toHaveValue('첫 세션의 다음 초안');
    await expect(panel.getByText('합성 완료 응답', { exact: true })).toBeVisible();
    expect(state.posts).toHaveLength(1);
  } finally {
    release();
  }
});

test('HELPUI07 keeps the displayed response until the delayed final message arrives', async ({
  page,
  request,
}, info) => {
  const chat = await create(request),
    state = await harness(page);
  await page.goto(`/?chat=${chat.id}`);
  const panel = await open(page);
  await panel.getByLabel('도우미에게 요청').fill('완료 화면 연결 검사');
  await panel.getByRole('button', { name: '도우미 요청 보내기' }).click();
  await expect(panel.getByText('완료 화면 연결 검사', { exact: true }).first()).toBeVisible();
  const task = state.current().tasks[0];
  const text = '이미 화면에 표시된 응답 내용이에요.';
  state.progress(task, text, text.length);
  await expect(panel.locator('.streaming-text')).toHaveText(text);
  let release = () => {};
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = false,
    completedSeen = false;
  await page.route('**/api/helper/**', async (route) => {
    if (
      route.request().method() === 'GET' &&
      /\/(events|messages)(?:\?|$)/u.test(route.request().url())
    ) {
      held = true;
      await delayed;
    }
    await route.fallback();
  });
  await page.route(`**/api/response-streams/helper/${task.id}?*`, async (route) => {
    completedSeen = true;
    await route.fulfill({
      json: {
        taskKind: 'helper',
        taskId: task.id,
        status: 'completed',
        chunks: [],
        cursor: Number(new URL(route.request().url()).searchParams.get('after') ?? 0),
        hasMore: false,
      },
    });
  });
  state.complete(task);
  try {
    await expect.poll(() => held && completedSeen).toBe(true);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    );
    await expect(panel.locator('.streaming-text')).toHaveText(text);
    await expect(panel.getByText('합성 완료 응답', { exact: true })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('continuous-response-before-final.png') });
    await info.attach('continuous-response-handoff', {
      body: JSON.stringify(
        {
          alreadyDisplayedResponsePreserved: true,
          canonicalResponseNotYetAvailable: true,
          scenario:
            'Completed stream status arrives before delayed helper events/messages request. No server data loss.',
        },
        null,
        2
      ),
      contentType: 'application/json',
    });
  } finally {
    release();
  }
  await expect(panel.getByText('합성 완료 응답', { exact: true })).toBeVisible();
  await expect(panel.locator('.streaming-text')).toHaveCount(0);
});

test('DISPLAY helper complete mode skips public reads across tools, toggles and reload until the stored final answer', async ({
  page,
  request,
}) => {
  const chat = await create(request),
    state = await harness(page);
  await page.goto(`/?chat=${chat.id}`);
  const setMode = async (mode: string) => {
    const panel = page.locator('#helper-panel');
    if (await panel.isVisible())
      await panel.getByRole('button', { name: '도우미 닫기', exact: true }).click();
    const menu = await openChatMenu(page);
    await menu.getByRole('button', { name: '읽기 설정', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '읽기 설정', exact: true });
    await dialog.getByLabel('응답 표시 방식', { exact: true }).selectOption(mode);
    await page.keyboard.press('Escape');
    return open(page);
  };
  const panel = await setMode('complete');
  await panel.getByLabel('도우미에게 요청').fill('최종 답변까지 기다려 주세요');
  await panel.getByRole('button', { name: '도우미 요청 보내기' }).click();
  await expect.poll(() => state.posts.length).toBe(1);
  const task = state.current().tasks[0];
  state.progress(task, '도구 실행 전 설명', '도구 실행 전 설명'.length);
  state.emit('tool.finished');
  const events = state.eventReads;
  await expect.poll(() => state.eventReads).toBeGreaterThanOrEqual(events + 2);
  expect(state.streamReads.get(task.id) ?? 0).toBe(0);
  await expect(panel.locator('.streaming-response')).toHaveCount(0);
  await expect(panel.getByTestId('helper-activity-status')).toContainText('처리 중');
  await setMode('stream');
  await expect(panel.locator('.streaming-text')).toHaveText('도구 실행 전 설명');
  await setMode('complete');
  const reads = state.streamReads.get(task.id);
  await expect(panel.locator('.streaming-response')).toHaveCount(0);
  await page.reload();
  await open(page);
  const reloadedEvents = state.eventReads;
  await expect.poll(() => state.eventReads).toBeGreaterThanOrEqual(reloadedEvents + 2);
  expect(state.streamReads.get(task.id)).toBe(reads);
  expect(state.posts).toHaveLength(1);
  // Transport completion alone is not the completed helper tool loop/message.
  state.streams.get(task.id)!.status = 'completed';
  state.emit('attempt.finished');
  await expect.poll(() => state.viewReads).toBeGreaterThan(1);
  await expect(panel.locator('.helper-message.assistant')).toHaveCount(0);
  state.complete(task);
  await expect(panel.getByText('합성 완료 응답', { exact: true })).toBeVisible();
  await expect(panel.locator('.streaming-response')).toHaveCount(0);
  expect(state.streamReads.get(task.id)).toBe(reads);
  expect(state.posts).toHaveLength(1);
});

test('DISPLAY helper incomplete saved answers stay collapsed and committed changes stay visible', async ({
  page,
  request,
}) => {
  const chat = await create(request),
    state = await harness(page);
  await page.addInitScript(() => localStorage.setItem('uimori:response-display', 'complete'));
  await page.goto(`/?chat=${chat.id}`);
  const panel = await open(page),
    view = state.current();
  const failed = state.addFailed(view);
  failed.completedEffects = { count: 1, labels: ['채팅 제목 변경'] };
  view.messages.push({
    id: randomUUID(),
    conversationId: view.conversation.id,
    taskId: failed.id,
    role: 'assistant',
    text: '마지막 설명은 완성되지 않았어요',
    artifacts: [],
    createdAt: new Date().toISOString(),
  });
  state.emit('task.failed');
  // Read the seeded terminal projection directly instead of racing the idle 10-second poll.
  await page.reload();
  await open(page);
  await expect(panel.getByTestId('helper-completed-effects')).toContainText(
    '변경 1건은 저장됐지만'
  );
  const partial = panel.locator('.partial-response');
  await expect(partial).toBeVisible();
  await expect(partial).not.toHaveAttribute('open');
  await expect(panel.getByText('마지막 설명은 완성되지 않았어요', { exact: true })).toHaveCount(0);
  expect(state.streamReads.get(failed.id) ?? 0).toBe(0);
  await partial.locator('summary').click();
  await expect(partial.getByText('마지막 설명은 완성되지 않았어요', { exact: true })).toBeVisible();
  await page.reload();
  await open(page);
  await expect(partial).not.toHaveAttribute('open');
  await expect(panel.getByTestId('helper-completed-effects')).toBeVisible();

  await panel.getByLabel('도우미에게 요청').fill('취소할 다음 작업');
  await panel.getByRole('button', { name: '도우미 요청 보내기' }).click();
  await expect.poll(() => state.posts.length).toBe(1);
  const task = view.tasks[0];
  state.progress(task, '취소 직전 받은 내용', '취소 직전 받은 내용'.length);
  const row = panel.locator(`.helper-task[data-task-id="${task.id}"]`);
  await row.getByTestId('helper-task-activity').locator(':scope > summary').click();
  await row.getByRole('button', { name: '진행 중인 도우미 작업 취소', exact: true }).click();
  await expect(row).toContainText('작업을 취소했어요');
  expect(state.streamReads.get(task.id) ?? 0).toBe(0);
  await row.locator('.partial-response > summary').click();
  await expect(row.locator('.streaming-text')).toHaveText('취소 직전 받은 내용');
  expect(state.streamReads.get(task.id)).toBe(1);
});

for (const width of [MOBILE_WIDTH, DESKTOP_WIDTH]) {
  test(`HELPUNDO latest edit confirms once and reconciles a lost response ${width}`, async ({
    page,
    request,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const chat = await create(request),
      state = await harness(page, 1);
    await page.goto(`/?chat=${chat.id}`);
    let panel = await open(page);
    const view = state.current();
    view.lastResourceEdit = {
      editSeq: 37,
      taskId: view.tasks[0].id,
      kind: 'content',
      id: 'saved-bot',
      revision: 2,
      title: '하린의 인물 설정',
      canUndo: true,
    };
    await page.reload();
    panel = await open(page);
    await panel.getByLabel('도우미에게 요청').fill('계속 보관할 다음 요청');
    const undo = panel.getByRole('button', { name: '마지막 자료 수정 되돌리기' });
    await undo.click();
    const dialog = page.getByRole('dialog', { name: '자료 수정 되돌리기', exact: true });
    await expect(dialog).toContainText('하린의 인물 설정');
    await dialog.getByRole('button', { name: '취소', exact: true }).click();
    await expect(undo).toBeFocused();
    expect(state.undoPosts).toHaveLength(0);
    await undo.click();
    if (width === DESKTOP_WIDTH) state.loseUndo();
    await dialog.getByRole('button', { name: '되돌리기', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(panel.getByRole('region', { name: '도우미 최근 자료 수정' })).toContainText(
      '수정 되돌림'
    );
    expect(state.undoPosts).toEqual([{ editSeq: 37 }]);
    await expect(panel.getByLabel('도우미에게 요청')).toHaveValue('계속 보관할 다음 요청');
    await expect(undo).toHaveCount(0);
    await expect(panel.getByRole('alert')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`helper-undo-${width}.png`), fullPage: true });
  });
}

test('HELPUNDO blocks a dirty editor and a changed saved revision without losing its draft', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 1000 });
  const response = await request.post('/api/content', {
    data: fixtureBotInput(`Undo draft ${randomUUID()}`, 'Original source.'),
  });
  expect(response.ok()).toBe(true);
  const bot = await response.json();
  const state = await harness(page, 1);
  const openEditor = async () => {
    await page.goto('/');
    await navigationAction(page, '서재');
    await page.getByRole('searchbox', { name: '서재 검색', exact: true }).fill(bot.title);
    await page.getByRole('button', { name: `${bot.title} 상세 보기`, exact: true }).click();
    await page.getByRole('button', { name: '편집', exact: true }).click();
    await expect(page.getByLabel('Risu 자료 이름', { exact: true })).toBeVisible();
  };
  const openEditorHelper = async () => {
    await page
      .getByRole('region', { name: '자료 상세', exact: true })
      .getByRole('button', { name: '도우미 열기', exact: true })
      .click();
    const panel = page.locator('#helper-panel');
    await expect(panel.getByLabel('도우미에게 요청')).toBeEnabled();
    await expect(panel.getByText('대화를 불러오는 중…', { exact: true })).toHaveCount(0);
    return panel;
  };
  await openEditor();
  await openEditorHelper();
  const view = state.current();
  view.lastResourceEdit = {
    editSeq: 41,
    taskId: view.tasks[0].id,
    kind: 'content',
    id: bot.id,
    revision: bot.revision,
    title: bot.title,
    canUndo: true,
  };
  await openEditor();
  const draft = page.getByLabel('Risu 자료 이름', { exact: true });
  await draft.fill('지키려는 미저장 입력');
  const panel = await openEditorHelper();
  const undo = panel.getByRole('button', { name: '마지막 자료 수정 되돌리기' });
  await expect(undo).toBeDisabled();
  await expect(
    panel.getByText('이 자료의 편집을 저장하거나 취소한 뒤 되돌려 주세요.')
  ).toBeVisible();
  expect(state.undoPosts).toHaveLength(0);
  await expect(draft).toHaveValue('지키려는 미저장 입력');
  // Restoring the local value only removes the local guard; the server still owns the revision check.
  await draft.fill(bot.title);
  await expect(undo).toBeEnabled();
  await undo.click();
  view.lastResourceEdit.canUndo = false;
  view.lastResourceEdit.reason = '최근 수정 이후 자료가 변경되어 되돌릴 수 없어요.';
  await page
    .getByRole('dialog', { name: '자료 수정 되돌리기', exact: true })
    .getByRole('button', { name: '되돌리기', exact: true })
    .click();
  await expect(undo).toBeDisabled();
  await expect(draft).toHaveValue(bot.title);
  expect(state.undoPosts).toEqual([{ editSeq: 41 }]);
  expect((await (await request.get(`/api/content/${bot.id}`)).json()).title).toBe(bot.title);
});

test('HELPACTIVITY observed stages retain tool errors and cancellation on desktop and mobile', async ({
  page,
  request,
}, info) => {
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
  const chat = await create(request),
    state = await harness(page);
  await page.goto(`/?chat=${chat.id}`);
  const panel = await open(page);
  await panel.getByLabel('도우미에게 요청').fill('설정을 읽고 바꿔 주세요');
  await panel.getByRole('button', { name: '도우미 요청 보내기' }).click();
  await expect.poll(() => state.posts.length).toBe(1);
  const task = state.current().tasks[0];
  state.activity(task, [
    { seq: 1, kind: 'attempt.started', attemptId: 'helper', purpose: 'helper' },
    { seq: 2, kind: 'attempt.finished', attemptId: 'helper', status: 'tool_calls' },
    { seq: 3, kind: 'tool.finished', name: 'resource.read', denied: false },
    { seq: 4, kind: 'tool.finished', name: 'data.search', denied: false },
    {
      seq: 5,
      kind: 'tool.finished',
      name: 'resource.patch',
      denied: true,
      error: 'EDITOR_SAVE_REQUIRED',
    },
    { seq: 6, kind: 'attempt.started', attemptId: 'context', purpose: 'context' },
  ]);
  await expect(panel.getByTestId('helper-activity-status').locator('.activity-label')).toHaveText(
    '대화 내용 정리 중이에요'
  );
  const row = panel.locator(`.helper-task[data-task-id="${task.id}"]`);
  await row.getByTestId('helper-task-activity').locator(':scope > summary').click();
  const activity = row.getByTestId('helper-activity-details');
  await activity.locator(':scope > summary').click();
  await expect(activity.locator('.helper-activity-stages > li')).toHaveCount(4);
  await expect(activity.locator('[data-state="running"]')).toContainText('대화 내용 정리');
  await expect(
    activity.getByText('resource.patch · EDITOR_SAVE_REQUIRED', { exact: true })
  ).toBeVisible();
  await activity.getByText('자료 확인', { exact: true }).click();
  await expect(activity.locator('code').filter({ hasText: /^resource\.read$/u })).toBeVisible();
  await expect(activity.locator('code').filter({ hasText: /^data\.search$/u })).toBeVisible();
  await page.screenshot({ path: info.outputPath('helper-activity-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: MOBILE_WIDTH, height: 900 });
  await expect(
    activity.getByText('resource.patch · EDITOR_SAVE_REQUIRED', { exact: true })
  ).toBeVisible();
  expect(await panel.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('helper-activity-mobile.png'), fullPage: true });
  await row.getByRole('button', { name: '진행 중인 도우미 작업 취소', exact: true }).click();
  await expect(row.getByTestId('helper-task-activity').locator(':scope > summary')).toContainText(
    '작업을 취소했어요'
  );
  await expect(activity.locator('[data-state="running"]')).toHaveCount(0);
  await expect(
    activity.getByText('resource.patch · EDITOR_SAVE_REQUIRED', { exact: true })
  ).toBeVisible();
});
