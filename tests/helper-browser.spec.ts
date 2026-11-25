import { DESKTOP_WIDTH, MOBILE_WIDTH } from './fixtures/browser-viewports.js';
import { visualReview } from './fixtures/visual-review.js';
import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { Chat, ChatDetail, Run } from '../core/types.js';
import type {
  HelperConversation,
  HelperEvent,
  HelperMessage,
  HelperMessageMutation,
  HelperScope,
  HelperChange,
  HelperRollbackUnit,
  HelperRollbackView,
  HelperTaskResultsView,
} from '../core/helper.js';
import type { HelperActivityEvent } from '../core/helper-activity.js';
import type { ResponseStreamPage } from '../core/response-stream.js';
import type { HelperArtifactView } from '../web/HelperArtifactCard.js';
import type { HelperTaskView } from '../web/useHelperConversation.js';
import type { ModelPreset, ModelWorkspace } from '../core/product.js';
import { messages } from '../web/locales/index.js';
import { longestHelperPollDelay } from '../web/poll-delays.js';
import { postFixtureChat, fixtureBotInput } from './fixtures/chat.js';
import { trackPageFetches } from './fixtures/page-fetches.js';
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
};

async function harness(page: Page, seedCount = 0) {
  const views = new Map<string, View>();
  const receipts = new Map<string, HelperTaskView>();
  const streams = new Map<string, ResponseStreamPage>();
  const artifacts = new Map<string, HelperArtifactView[]>();
  const artifactWrites: string[] = [];
  const activities = new Map<string, HelperActivityEvent[]>();
  const results = new Map<string, Partial<HelperTaskResultsView>>();
  const rollbacks = new Map<string, HelperRollbackView>();
  const rollbackPosts: { unit?: string }[] = [];
  let onRollback: ((units: HelperRollbackUnit[]) => Promise<void>) | undefined;
  let loseRollback = false;
  const posts: {
    requestKey: string;
    text: string;
    selection?: unknown;
    mode?: string;
    confirmations?: string[];
  }[] = [];
  const steerPosts: { taskId: string; requestKey: string; text: string }[] = [];
  const messageMutations: {
    messageId: string;
    method: string;
    expectedRevision: number;
    text?: string;
    scope?: 'pair' | 'following';
  }[] = [];
  let failNextMessageMutation = false;
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
  const record = (view: View, entry: HelperEvent) => {
    view.events.push(entry);
    const { seq, conversationId, taskId, kind } = entry;
    void page.request
      .post('/api/test/live-frame', {
        data: { event: 'helper', data: { seq, conversationId, taskId, kind } },
      })
      .catch(() => undefined);
    return seq;
  };
  const event = (view: View, task: HelperTaskView, kind: string) =>
    record(view, {
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
      mode: 'apply',
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
    const observed = window as unknown as { helperFrames: string[] };
    observed.helperFrames = [];
    const Original = window.EventSource;
    window.EventSource = class extends Original {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        this.addEventListener('helper', (message) =>
          observed.helperFrames.push(JSON.parse((message as MessageEvent).data).kind)
        );
      }
    };
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
              (url.searchParams.get('kind') === 'all' ||
                scope.kind === url.searchParams.get('kind')) &&
              (url.searchParams.get('kind') === 'all' ||
                scope.kind === 'library' ||
                scope.chatId === url.searchParams.get('chatId'))
            );
          })
          .map((view) => ({
            ...view.conversation,
            activity: {
              running: view.tasks.filter((task) => task.status === 'running').length,
              queued: view.tasks.filter((task) => task.status === 'queued').length,
            },
            latestEventSeq: view.events.at(-1)?.seq ?? 0,
            latestActivityEventSeq:
              view.events.findLast((entry) =>
                ['task.completed', 'task.failed', 'task.cancelled', 'task.interrupted'].includes(
                  entry.kind
                )
              )?.seq ?? 0,
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
          limits: { totalCalls: 128, helperCalls: 64 },
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
    const messageMatch = /^\/api\/helper\/conversations\/([^/]+)\/messages\/([^/]+)$/u.exec(path);
    if (messageMatch && ['PATCH', 'DELETE'].includes(request.method())) {
      const view = views.get(messageMatch[1])!;
      messageMutations.push({ messageId: messageMatch[2], method: request.method(), ...body });
      if (failNextMessageMutation) {
        failNextMessageMutation = false;
        return route.fulfill({ status: 503, json: { error: '합성 저장 실패' } });
      }
      if (body.expectedRevision !== view.conversation.revision)
        return route.fulfill({ status: 409, json: { error: '합성 대화 충돌' } });
      const selected = view.messages.find((item) => item.id === messageMatch[2])!;
      const mutation: HelperMessageMutation = { conversation: view.conversation };
      if (request.method() === 'PATCH') {
        selected.text = body.text;
        mutation.updatedMessage = { id: selected.id, text: selected.text };
      } else {
        const group = selected.requestGroupId ?? selected.taskId;
        const first = view.messages.findIndex(
          (item) => (item.requestGroupId ?? item.taskId) === group
        );
        const removed = view.messages.filter((item, index) =>
          body.scope === 'following'
            ? index >= first
            : (item.requestGroupId ?? item.taskId) === group
        );
        mutation.deletedMessageIds = removed.map((item) => item.id);
        const removedIds = new Set(mutation.deletedMessageIds);
        view.messages = view.messages.filter((item) => !removedIds.has(item.id));
      }
      const seq = ++nextSeq;
      view.conversation = {
        ...view.conversation,
        revision: view.conversation.revision + 1,
        historyRevision: seq,
      };
      mutation.conversation = view.conversation;
      record(view, {
        seq,
        conversationId: view.conversation.id,
        taskId: null,
        kind: 'messages.changed',
        data: {
          revision: view.conversation.revision,
          ...(mutation.updatedMessage ? { updatedMessage: mutation.updatedMessage } : {}),
          ...(mutation.deletedMessageIds ? { deletedMessageIds: mutation.deletedMessageIds } : {}),
        },
      });
      return route.fulfill({ json: mutation });
    }
    const conversationMatch =
      /^\/api\/helper\/conversations\/([^/]+)(?:\/(view|messages|tasks|events))?$/u.exec(path);
    if (conversationMatch) {
      const view = views.get(conversationMatch[1]);
      if (!view)
        return route.fulfill({ status: 404, json: { error: 'Helper conversation not found' } });
      const kind = conversationMatch[2];
      if (!kind && request.method() === 'PATCH') {
        if (body.expectedRevision !== view.conversation.revision)
          return route.fulfill({ status: 409, json: { error: '합성 대화 충돌' } });
        view.conversation = {
          ...view.conversation,
          title: body.title ?? view.conversation.title,
          persona: body.persona ?? view.conversation.persona,
          revision: view.conversation.revision + 1,
        };
        return route.fulfill({ json: view.conversation });
      }
      if (!kind) return route.fulfill({ json: view.conversation });
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
          task.mode = body.mode ?? 'apply';
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
    const taskMatch =
      /^\/api\/helper\/tasks\/([^/]+)(\/cancel|\/activity|\/steer|\/results|\/rollback)?$/u.exec(
        path
      );
    if (taskMatch) {
      const view = [...views.values()].find((view) =>
        view.tasks.some((task) => task.id === taskMatch[1])
      )!;
      const task = view.tasks.find((task) => task.id === taskMatch[1])!;
      if (taskMatch[2] === '/rollback') {
        const current = rollbacks.get(task.id) ?? { taskId: task.id, blocked: null, units: [] };
        if (request.method() === 'GET') return route.fulfill({ json: current });
        rollbackPosts.push(body);
        const selected = current.units.filter(
          (unit) => unit.status === 'restorable' && (!body.unit || unit.unit === body.unit)
        );
        await onRollback?.(selected);
        const restored = selected.map((unit) => ({ ...unit, status: 'restored' as const }));
        current.units = current.units.map(
          (unit) => restored.find((item) => item.unit === unit.unit) ?? unit
        );
        rollbacks.set(task.id, current);
        const kinds = restored.some((unit) => unit.domain === 'resource')
          ? ['resource.updated', 'task.rolled-back']
          : ['task.rolled-back'];
        for (const kind of kinds)
          record(view, {
            seq: ++nextSeq,
            conversationId: view.conversation.id,
            taskId: task.id,
            kind,
            data: null,
          });
        if (loseRollback) {
          loseRollback = false;
          return route.abort('failed');
        }
        return route.fulfill({ json: { taskId: task.id, blocked: null, units: restored } });
      }
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
      if (taskMatch[2] === '/results')
        return route.fulfill({
          json: {
            taskId: task.id,
            status: task.status,
            results: [],
            changes: [],
            confirmations: [],
            unrecordedOperations: 0,
            usage: { attempts: [], toolExecutions: 0, latestInputEstimate: null },
            ...results.get(task.id),
          },
        });
      if (taskMatch[2] === '/activity')
        return route.fulfill({
          json: {
            taskId: task.id,
            status: task.status,
            events: activities.get(task.id) ?? [],
            hasEarlier: false,
            helperCalls: (activities.get(task.id) ?? []).filter(
              (item) => item.kind === 'attempt.started' && item.purpose === 'helper'
            ).length,
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
      if (request.method() !== 'GET') {
        artifactWrites.push(request.method());
        return route.fulfill({ status: 410, json: { error: 'HELPER_ARTIFACT_READ_ONLY' } });
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
    messageMutations,
    failNextMessageMutation: () => {
      failNextMessageMutation = true;
    },
    artifacts,
    artifactWrites,
    results,
    rollbacks,
    rollbackPosts,
    onRollback(handler: (units: HelperRollbackUnit[]) => Promise<void>) {
      onRollback = handler;
    },
    loseRollback: () => {
      loseRollback = true;
    },
    activity: (task: HelperTaskView, events: HelperActivityEvent[]) => {
      activities.set(task.id, events);
      const view = [...views.values()].find((item) =>
        item.tasks.some((candidate) => candidate.id === task.id)
      );
      if (view) event(view, task, 'tool.finished');
    },
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
    record,
    framesReceived: () =>
      page.evaluate(() => (window as unknown as { helperFrames: string[] }).helperFrames),
    async pulse(times = 2) {
      for (let index = 0; index < times; index++) {
        const before = eventReads;
        this.emit('conversation.updated');
        await expect.poll(() => eventReads).toBeGreaterThan(before);
      }
    },
    emit(kind: string, data: unknown = null) {
      const view = [...views.values()].at(-1)!;
      return record(view, {
        seq: ++nextSeq,
        conversationId: view.conversation.id,
        taskId: null,
        kind,
        data,
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
    think(task: HelperTaskView, thought?: string) {
      const value = streams.get(task.id)!;
      if (thought) value.thought = thought;
      else delete value.thought;
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
function trackLibraryReads(page: Page) {
  const reads: string[] = [];
  page.on('request', (entry) => {
    if (new URL(entry.url()).pathname === '/api/library') reads.push(entry.url());
  });
  return reads;
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
  await expect(panel.getByText('대화를 불러오는 중이에요…', { exact: true })).toHaveCount(0);
  return panel;
}

async function setLocaleFromOtherTab(page: Page, other: Page, locale: 'ko' | 'en') {
  await other.evaluate((value) => localStorage.setItem('uimori:ui-language', value), locale);
  await expect(page.locator('html')).toHaveAttribute('lang', locale);
}

async function toggleHelperTone(page: Page) {
  const settings = page.getByRole('dialog', { name: '도우미 설정', exact: true });
  if (await settings.isVisible()) {
    await settings.getByRole('button', { name: '도우미 설정 닫기', exact: true }).click();
    return;
  }
  const panel = page.locator('#helper-panel');
  await panel.getByLabel('도우미 대화 관리', { exact: true }).click();
  await panel.getByRole('button', { name: '도우미 말투 설정', exact: true }).click();
}

test('HELPMESSAGE a failed answer save retains the exact draft across reload and cancel restores the saved answer', async ({
  page,
  request,
}) => {
  const chat = await create(request),
    state = await harness(page, 1);
  await page.goto(`/?chat=${chat.id}`);
  const panel = await open(page),
    saved = state.current().messages[1],
    answer = panel.locator(`[data-message-id="${saved.id}"]`),
    draft = '저장에 실패해도 남아야 할\n**응답 편집 초안**';
  await answer.getByLabel('메시지 메뉴', { exact: true }).click();
  await page.getByRole('button', { name: '응답 수정', exact: true }).click();
  await answer.getByLabel('응답 수정', { exact: true }).fill(draft);
  state.failNextMessageMutation();
  await answer.getByRole('button', { name: '응답 저장', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('서버 작업을 완료하지 못했어요. (503)');
  await expect(answer.getByLabel('응답 수정', { exact: true })).toHaveValue(draft);
  expect(saved.text).not.toBe(draft);
  await page.reload();
  await open(page);
  await answer.getByLabel('메시지 메뉴', { exact: true }).click();
  await page.getByRole('button', { name: '응답 수정', exact: true }).click();
  await expect(answer.getByLabel('응답 수정', { exact: true })).toHaveValue(draft);
  await answer.getByRole('button', { name: '취소', exact: true }).click();
  await expect(answer.locator('.helper-prose')).toHaveText(saved.text);
  expect(state.messageMutations).toHaveLength(1);
  expect(state.posts).toHaveLength(0);
});

test('HELPMESSAGE conflict review preserves request and response drafts in older history', async ({
  page,
  request,
}) => {
  const chat = await create(request),
    state = await harness(page, 55);
  await page.goto(`/?chat=${chat.id}`);
  const panel = await open(page),
    view = state.current();
  const other = await page.context().newPage();
  await other.goto('/');
  await panel.getByRole('button', { name: '이전 메시지 불러오기', exact: true }).click();
  for (const [index, role] of [
    [0, 'user'],
    [1, 'assistant'],
  ] as const) {
    const saved = view.messages[index];
    const article = panel.locator(`[data-message-id="${saved.id}"]`);
    await article
      .getByLabel(role === 'user' ? '요청 및 컨텍스트 메뉴' : '메시지 메뉴', { exact: true })
      .click();
    await page
      .getByRole('button', {
        name: role === 'user' ? '요청 수정' : '응답 수정',
        exact: true,
      })
      .click();
    const input = article.getByLabel(role === 'user' ? '요청 수정 내용' : '응답 수정', {
      exact: true,
    });
    const draft = `작성 중인 ${role} 초안`;
    const saveLabel = role === 'user' ? '입력 저장' : '응답 저장';
    await input.fill(draft);
    saved.text = `다른 화면에서 저장한 ${role}`;
    view.conversation.revision++;
    view.conversation.historyRevision = state.emit('messages.changed', {
      revision: view.conversation.revision,
      updatedMessage: { id: saved.id, text: saved.text },
    });
    await article.getByRole('button', { name: saveLabel, exact: true }).click();
    const dialog = page.locator('dialog[role="alertdialog"][open]');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(saved.text, { exact: true })).toBeVisible();
    const reviewedRevision = view.conversation.revision;
    const beforeLanguageChange = state.messageMutations.length;
    await setLocaleFromOtherTab(page, other, 'en');
    await expect(
      dialog.getByRole('button', { name: 'Keep current input', exact: true })
    ).toBeVisible();
    await expect(
      dialog.getByRole('button', {
        name: messages['helpers.continueMessageEdit'].en,
        exact: true,
      })
    ).toBeVisible();
    await expect(dialog.getByText(saved.text, { exact: true })).toBeVisible();
    expect(state.messageMutations).toHaveLength(beforeLanguageChange);
    expect(view.conversation.revision).toBe(reviewedRevision);
    await setLocaleFromOtherTab(page, other, 'ko');
    await dialog.getByRole('button', { name: '입력 유지하고 계속 편집', exact: true }).click();
    await expect(input).toHaveValue(draft);
    expect(saved.text).not.toBe(draft);
    await article.getByRole('button', { name: saveLabel, exact: true }).click();
    await expect(input).toHaveCount(0);
    expect(state.messageMutations.at(-1)?.expectedRevision).toBe(reviewedRevision);
    expect(saved.text).toBe(draft);
  }
  expect(state.messageMutations).toHaveLength(4);
  expect(state.posts).toHaveLength(0);
});

test('HELPMESSAGE local edit does not skip an unseen older message change', async ({
  page,
  request,
}) => {
  const chat = await create(request),
    state = await harness(page, 55);
  await page.goto(`/?chat=${chat.id}`);
  const panel = await open(page),
    view = state.current();
  await panel.getByRole('button', { name: '이전 메시지 불러오기', exact: true }).click();
  let releaseEvents = () => {};
  const heldEvents = new Promise<void>((resolve) => {
    releaseEvents = resolve;
  });
  await page.route('**/api/helper/conversations/*/events?*', async (route) => {
    await heldEvents;
    await route.fallback();
  });
  const old = view.messages[1],
    latest = view.messages.at(-1)!;
  const oldArticle = panel.locator(`[data-message-id="${old.id}"]`);
  await toggleHelperTone(page);
  await panel.getByLabel('도우미 말투', { exact: true }).fill('새 말투 초안');
  old.text = '다른 화면에서 저장한 오래된 응답';
  view.conversation.revision++;
  view.conversation.historyRevision = state.emit('messages.changed', {
    revision: view.conversation.revision,
    updatedMessage: { id: old.id, text: old.text },
  });
  await panel.getByRole('button', { name: '도우미 설정 저장', exact: true }).click();
  await expect(
    panel.getByRole('alert').filter({ hasText: '도우미 설정이 바뀌었어요.' })
  ).toBeVisible();
  await expect(panel.getByLabel('도우미 말투', { exact: true })).toHaveValue('새 말투 초안');
  await toggleHelperTone(page);
  await page
    .getByRole('alertdialog', { name: '도우미 설정', exact: true })
    .getByRole('button', { name: '변경 내용 버리고 닫기', exact: true })
    .click();
  const article = panel.locator(`[data-message-id="${latest.id}"]`);
  await article.getByLabel('메시지 메뉴', { exact: true }).click();
  await page.getByRole('button', { name: '응답 수정', exact: true }).click();
  await article.getByLabel('응답 수정', { exact: true }).fill('현재 화면에서 수정한 응답');
  await article.getByRole('button', { name: '응답 저장', exact: true }).click();
  await expect(article.locator('.helper-prose')).toHaveText('현재 화면에서 수정한 응답');
  await expect(oldArticle.locator('.helper-prose')).not.toHaveText(old.text);
  releaseEvents();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(oldArticle.locator('.helper-prose')).toHaveText(old.text);
});

test('HELPMESSAGE pair and following deletion discard loaded older messages while retaining task history', async ({
  page,
  request,
}) => {
  const chat = await create(request),
    state = await harness(page, 55);
  await page.goto(`/?chat=${chat.id}`);
  const panel = await open(page),
    view = state.current(),
    tasksBefore = JSON.stringify(view.tasks),
    removedPair = view.messages.slice(4, 6).map((message) => message.id),
    followingStart = view.messages[6].id;
  await panel.getByRole('button', { name: '이전 메시지 불러오기', exact: true }).click();
  await expect(panel.locator('.helper-message')).toHaveCount(110);
  const oldAnswer = panel.locator(`[data-message-id="${removedPair[1]}"]`);
  const changed = view.messages[5];
  changed.text = '다른 화면에서 고친 이전 응답';
  view.conversation.revision++;
  view.conversation.historyRevision = state.emit('messages.changed', {
    revision: view.conversation.revision,
    updatedMessage: { id: changed.id, text: changed.text },
  });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(oldAnswer.locator('.helper-prose')).toHaveText(changed.text);
  await oldAnswer.getByLabel('메시지 메뉴', { exact: true }).click();
  await page.getByRole('button', { name: '요청과 응답 삭제', exact: true }).click();
  const pairConfirmation = page.getByRole('alertdialog', { name: '요청과 응답 삭제', exact: true });
  await pairConfirmation.getByRole('button', { name: '요청과 응답 삭제', exact: true }).click();
  await expect(pairConfirmation).toBeHidden();
  for (const messageId of removedPair)
    await expect(panel.locator(`[data-message-id="${messageId}"]`)).toHaveCount(0);
  await expect(panel.locator('.helper-message')).toHaveCount(108);
  await panel.getByRole('button', { name: '도우미 닫기', exact: true }).click();
  await open(page);
  for (const messageId of removedPair)
    await expect(panel.locator(`[data-message-id="${messageId}"]`)).toHaveCount(0);
  const oldRequest = panel.locator(`[data-message-id="${followingStart}"]`);
  await oldRequest.getByLabel('요청 및 컨텍스트 메뉴', { exact: true }).click();
  await page.getByRole('button', { name: '여기부터 삭제', exact: true }).click();
  const followingConfirmation = page.getByRole('alertdialog', {
    name: '여기부터 삭제',
    exact: true,
  });
  await followingConfirmation.getByRole('button', { name: '여기부터 삭제', exact: true }).click();
  await expect(followingConfirmation).toBeHidden();
  await expect(panel.locator('.helper-message')).toHaveCount(4);
  await expect(panel.getByTestId('source-request')).toHaveText(['합성 요청 1', '합성 요청 2']);
  await panel.getByRole('button', { name: '도우미 닫기', exact: true }).click();
  await open(page);
  await expect(panel.locator('.helper-message')).toHaveCount(4);
  await page.reload();
  await open(page);
  await expect(panel.locator('.helper-message')).toHaveCount(4);
  await panel.getByRole('button', { name: '작업 기록', exact: true }).click();
  await expect(panel.getByTestId('helper-task-record')).toHaveCount(50);
  expect(JSON.stringify(view.tasks)).toBe(tasksBefore);
  expect(state.messageMutations.map(({ method, scope }) => ({ method, scope }))).toEqual([
    { method: 'DELETE', scope: 'pair' },
    { method: 'DELETE', scope: 'following' },
  ]);
  expect(state.posts).toHaveLength(0);
});

test('HELPSTEER adds instructions to the active task once after a lost acknowledgement and keeps ordinary requests queued', async ({
  page,
  request,
}) => {
  const chat = await create(request),
    state = await harness(page);
  await page.goto(`/?chat=${chat.id}`);
  let panel = await open(page);
  await panel.getByLabel('도우미에게 요청').fill('자료 전체를 살펴봐 주세요');
  await panel.getByRole('button', { name: '도우미 요청 보내기', exact: true }).click();
  await expect(panel.getByLabel('도우미에게 요청')).toHaveValue('');
  const task = state.current().tasks[0];
  const instructionText = '우선 설명문만 살펴봐 주세요';
  const stop = panel.locator('.helper-composer').getByRole('button', {
    name: '진행 중인 도우미 작업 취소',
    exact: true,
  });
  await expect(stop).toBeVisible();
  const emptyDraftStop = await stop.boundingBox();
  const queueSend = panel.getByRole('button', { name: '다음 요청', exact: true });
  await expect(queueSend).toBeDisabled();
  await panel.getByLabel('도우미에게 요청').fill(instructionText);
  await expect(stop).toHaveCount(1);
  await expect(stop).toBeEnabled();
  expect(await stop.boundingBox()).toEqual(emptyDraftStop);
  await expect(queueSend).toBeEnabled();
  const sendMode = panel.getByTestId('helper-running-mode');
  await expect(sendMode).toHaveAccessibleName('실행 중 전송 방식: 대기 요청');
  await sendMode.click();
  await expect(sendMode).toHaveAccessibleName('실행 중 전송 방식: 추가 지시');
  await expect(queueSend).toHaveCount(0);
  expect(await stop.boundingBox()).toEqual(emptyDraftStop);
  state.loseNext();
  await panel.getByRole('button', { name: '현재 작업에 추가', exact: true }).click();
  await expect(panel.getByRole('button', { name: '이전 요청 확인', exact: true })).toBeVisible();
  await expect(panel.getByLabel('도우미에게 요청')).toHaveValue(instructionText);
  await expect(stop).toBeVisible();
  await page.reload();
  panel = await open(page);
  await panel.getByRole('button', { name: '이전 요청 확인', exact: true }).click();
  await page
    .getByRole('dialog', { name: '도우미 요청 확인', exact: true })
    .getByRole('button', { name: '접수 확인 및 재시도' })
    .click();
  await expect(panel.locator('.helper-outbox')).toHaveCount(0);
  await expect.poll(() => state.steerPosts.length).toBe(2);
  expect(state.steerPosts[1]).toEqual(state.steerPosts[0]);
  await expect(panel.getByLabel('도우미에게 요청')).toHaveValue('');
  await expect(stop).toBeVisible();
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
  await panel.getByTestId('helper-running-mode').click();
  await panel.getByRole('button', { name: '다음 요청', exact: true }).click();
  await expect(panel.getByLabel('도우미에게 요청')).toHaveValue('');
  expect(state.posts).toHaveLength(2);
  expect(state.current().tasks).toHaveLength(2);
  expect(state.current().tasks[0]).toMatchObject({
    request: '그다음 첫 메시지를 검토해 주세요',
    status: 'queued',
  });
  expect(task.status).toBe('running');
});

test('HELPFOLLOWUP01 distinguishes pending steers and queued requests with configurable default mode and Alt+Enter override', async ({
  page,
  request,
}, info) => {
  const chat = await create(request),
    state = await harness(page);
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
  await page.goto(`/?chat=${chat.id}`);
  const panel = await open(page);
  const input = panel.getByLabel('도우미에게 요청');
  await input.fill('긴 자료 분석을 시작해 주세요');
  await input.press('Control+Enter');
  await expect(input).toHaveValue('');

  const sendMode = panel.getByTestId('helper-running-mode');
  await expect(sendMode).toBeVisible();
  await expect(sendMode).toHaveAccessibleName('실행 중 전송 방식: 대기 요청');

  await input.fill('중간에 어조만 차분하게 조정해 주세요');
  await input.press('Alt+Enter');
  await expect(input).toHaveValue('');
  await expect.poll(() => state.steerPosts.length).toBe(1);
  expect(state.posts).toHaveLength(1);

  await sendMode.click();
  await expect(sendMode).toHaveAccessibleName('실행 중 전송 방식: 추가 지시');
  expect(await page.evaluate(() => localStorage.getItem('uimori:helper-running-send'))).toBe(
    'steer'
  );

  await input.fill('다음 턴에서 목차도 정리해 주세요');
  await input.press('Alt+Enter');
  await expect(input).toHaveValue('');
  await expect.poll(() => state.posts.length).toBe(2);

  await input.fill('지금 진행 중인 작업에 예시를 한 줄 추가해 주세요');
  await input.press('Control+Enter');
  await expect(input).toHaveValue('');
  await expect.poll(() => state.steerPosts.length).toBe(2);

  const tray = panel.getByTestId('helper-followup-tray');
  await expect(tray).toBeVisible();
  await expect(tray.locator('[data-kind="steer"].helper-followup-item')).toHaveCount(2);
  await expect(tray.locator('[data-kind="queue"].helper-followup-item')).toHaveCount(1);
  await expect(tray).toContainText('다음 단계에 반영');
  await expect(tray).toContainText('대기 #1');
  await page.screenshot({ path: info.outputPath('helper-followup-tray.png') });

  await tray
    .locator('[data-kind="queue"].helper-followup-item')
    .getByRole('button', { name: '이 대기 요청 취소', exact: true })
    .click();
  await expect(tray.locator('[data-kind="queue"].helper-followup-item')).toHaveCount(0);
});

test('HELPSENDKEY desktop helper composer follows the app send-key setting and never sends during composition', async ({
  page,
  request,
}) => {
  const chat = await create(request),
    state = await harness(page);
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
  await page.goto(`/?chat=${chat.id}`);
  let panel = await open(page);
  let input = panel.getByLabel('도우미에게 요청');
  await expect(input).toHaveAttribute('placeholder', '도우미에게 요청하기 (Ctrl+Enter 보내기)');
  await input.fill('첫 줄');
  await input.press('Enter');
  await expect(input).toHaveValue('첫 줄\n');
  expect(state.posts).toHaveLength(0);
  await input.press('Control+Enter');
  await expect(input).toHaveValue('');
  expect(state.posts.map((post) => post.text)).toEqual(['첫 줄\n']);

  await page.evaluate(() => localStorage.setItem('uimori:enter-send', 'true'));
  await page.reload();
  panel = await open(page);
  input = panel.getByLabel('도우미에게 요청');
  await expect(input).toHaveAttribute('placeholder', '도우미에게 요청하기 (Enter 보내기)');
  await input.fill('한글 조합 중');
  await input.dispatchEvent('compositionstart');
  await input.press('Enter');
  await input.dispatchEvent('compositionend');
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229 });
  await expect(input).toHaveValue('한글 조합 중\n');
  expect(state.posts).toHaveLength(1);
  await input.press('Shift+Enter');
  await expect(input).toHaveValue('한글 조합 중\n\n');
  await input.press('Enter');
  await expect(input).toHaveValue('');
  expect(state.posts.map((post) => post.text)).toEqual(['첫 줄\n', '한글 조합 중\n\n']);
});

test('HELPUI12 helper settings event refreshes an open model editor without replacing its draft', async ({
  page,
  request,
}) => {
  const state = await harness(page);
  await page.goto('/');
  await navigationAction(page, '서재');
  const panel = await open(page);
  await panel.getByRole('button', { name: /^현재 도우미 모델/ }).click();
  const picker = page.getByRole('dialog', { name: '도우미 모델 선택', exact: true });
  await picker.getByRole('button', { name: '역할별 모델 설정', exact: true }).click();
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

  await expect(editor.getByRole('alert')).toContainText('역할별 모델 설정이 바뀌었어요.', {
    timeout: 15000,
  });
  await expect(draft).toHaveValue('9');
  await editor.getByRole('button', { name: '역할별 모델 설정 저장' }).click();
  const conflict = page.getByRole('alertdialog', {
    name: '역할별 모델 저장본 확인',
    exact: true,
  });
  await expect(conflict).toBeVisible();
  const saved = (await (await request.get('/api/model-workspace')).json()) as ModelWorkspace;
  expect(saved.revision).toBe(before.revision + 1);
  expect(saved.translationPolicy.maxCalls).toBe(12);
  await conflict.getByRole('button', { name: '현재 입력 유지', exact: true }).click();
  await expect(draft).toHaveValue('9');
});

async function helperModels(request: APIRequestContext) {
  const providerResponse = await request.post('/api/connections', {
    data: {
      title: `도우미 선택 합성 ${randomUUID()}`,
      protocol: 'fixture-sse-v1',
      endpoint: 'http://127.0.0.1:9/not-called',
      enabled: true,
    },
  });
  expect(providerResponse.ok()).toBe(true);
  const provider = (await providerResponse.json()) as { id: string };
  const models: ModelPreset[] = [];
  for (const suffix of ['A', 'B']) {
    const response = await request.post('/api/model-presets', {
      data: {
        title: `도우미 검색 모델 ${suffix} ${randomUUID()}`,
        connectionId: provider.id,
        modelId: `helper-picker-${suffix}`,
        maxOutputTokens: 1000,
        temperature: null,
      },
    });
    expect(response.ok()).toBe(true);
    models.push((await response.json()) as ModelPreset);
  }
  return models;
}

test('HELPMODEL rejected and uncertain helper changes require an explicit reread and never replay a write', async ({
  page,
  request,
}) => {
  const chat = await create(request);
  const models = await helperModels(request);
  await harness(page);
  await page.goto(`/?chat=${chat.id}`);
  const panel = await open(page);
  let writes = 0;
  await page.route('**/api/model-workspace', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    writes++;
    if (writes === 1)
      return route.fulfill({
        status: 409,
        json: { error: '설정이 다른 곳에서 바뀌었어요. 새로고침한 뒤 저장해 주세요.' },
      });
    await route.fetch();
    await route.abort('failed');
  });
  await panel.getByRole('button', { name: /^현재 도우미 모델:/ }).click();
  const picker = page.getByRole('dialog', { name: '도우미 모델 선택', exact: true });
  const choice = picker.getByRole('button', { name: new RegExp(models[0].title) });
  await choice.click();
  await expect(picker.getByRole('alert')).toBeVisible();
  await expect(choice).toBeDisabled();
  expect(writes).toBe(1);
  await picker.getByRole('button', { name: '다시 불러오기', exact: true }).click();
  await expect(choice).toBeEnabled();
  await choice.click();
  await expect(picker.getByRole('alert')).toBeVisible();
  await expect(choice).toBeDisabled();
  expect(writes).toBe(2);
  expect((await (await request.get('/api/model-workspace')).json()).helperModel).toEqual({
    id: models[0].id,
  });
  await picker.getByRole('button', { name: '다시 불러오기', exact: true }).click();
  await expect(choice).toHaveAttribute('aria-pressed', 'true');
  expect(writes).toBe(2);
});

test('HELPMODEL delayed acknowledgement preserves a newer confirmed model and the reopened picker', async ({
  page,
  request,
}) => {
  const chat = await create(request);
  const models = await helperModels(request);
  await harness(page);
  await page.goto(`/?chat=${chat.id}`);
  const panel = await open(page);
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let writes = 0;
  await page.route('**/api/model-workspace', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    writes++;
    const response = await route.fetch();
    await held;
    await route.fulfill({ response });
  });
  const trigger = panel.getByRole('button', { name: /^현재 도우미 모델:/ });
  await trigger.click();
  const picker = page.getByRole('dialog', { name: '도우미 모델 선택', exact: true });
  await picker.getByRole('button', { name: new RegExp(models[0].title) }).click();
  await expect
    .poll(async () => (await (await request.get('/api/model-workspace')).json()).helperModel?.id)
    .toBe(models[0].id);
  await picker.getByRole('button', { name: '도우미 모델 선택 닫기', exact: true }).click();
  const accepted = (await (await request.get('/api/model-workspace')).json()) as ModelWorkspace;
  const newer = await request.put('/api/model-workspace', {
    data: {
      expectedRevision: accepted.revision,
      routes: accepted.routes,
      translationPolicy: accepted.translationPolicy,
      helperModel: { id: models[1].id },
    },
  });
  expect(newer.ok()).toBe(true);
  await trigger.click();
  const current = picker.getByRole('button', { name: new RegExp(models[1].title) });
  await expect(current).toHaveAttribute('aria-pressed', 'true');
  await expect(trigger).toContainText(models[1].title);
  release();
  await expect(current).toBeEnabled();
  await expect(picker).toBeVisible();
  await expect(current).toHaveAttribute('aria-pressed', 'true');
  await expect(trigger).toContainText(models[1].title);
  expect(writes).toBe(1);
  expect((await (await request.get('/api/model-workspace')).json()).helperModel).toEqual({
    id: models[1].id,
  });
});

test('HELPMODEL acknowledged selection stays successful when the following settings refresh fails', async ({
  page,
  request,
}) => {
  const chat = await create(request);
  const models = await helperModels(request);
  await harness(page);
  await page.goto(`/?chat=${chat.id}`);
  const panel = await open(page);
  let failRefresh = false;
  let writes = 0;
  await page.route('**/api/prompt-workspace', async (route) => {
    if (failRefresh && route.request().method() === 'GET')
      return route.fulfill({ status: 503, json: { error: '합성 설정 새로고침 실패' } });
    return route.continue();
  });
  await page.route('**/api/model-workspace', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    writes++;
    const response = await route.fetch();
    failRefresh = true;
    await route.fulfill({ response });
  });
  await panel.getByRole('button', { name: /^현재 도우미 모델:/ }).click();
  const picker = page.getByRole('dialog', { name: '도우미 모델 선택', exact: true });
  await picker.getByRole('button', { name: new RegExp(models[0].title) }).click();
  await expect(picker).toBeHidden();
  await expect(panel.getByRole('button', { name: /^현재 도우미 모델:/ })).toContainText(
    models[0].title
  );
  const warning = panel.getByRole('alert').filter({ hasText: '도우미 모델은 변경했지만' });
  await expect(warning).toContainText('서버 작업을 완료하지 못했어요. (503)');
  expect(writes).toBe(1);
  expect((await (await request.get('/api/model-workspace')).json()).helperModel).toEqual({
    id: models[0].id,
  });
  failRefresh = false;
  await warning.getByRole('button', { name: '다시 불러오기', exact: true }).click();
  await expect(warning).toHaveCount(0);
  expect(writes).toBe(1);
});

test('HELPUI01 helper panel preserves separate input, reading position, tone drafts and Back behavior', async ({
  page,
  request,
}) => {
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
  const session = await panel.getByLabel('도우미 대화 선택', { exact: true }).inputValue();
  await panel.getByRole('button', { name: '도우미 크게 보기', exact: true }).click();
  await expect(panel).toHaveClass(/helper-expanded/u);
  await expect(panel.getByLabel('도우미 대화 선택', { exact: true })).toHaveValue(session);
  await expect(input).toHaveValue('도우미 입력 초안');
  await expect.poll(() => list.evaluate((node) => node.scrollTop)).toBe(before);
  await panel.getByRole('button', { name: chat.title, exact: true }).click();
  await expect(panel).not.toHaveClass(/helper-expanded/u);
  await expect.poll(() => list.evaluate((node) => node.scrollTop)).toBe(before);
  const url = page.url();
  await page.goBack();
  await expect(panel).toBeHidden();
  expect(page.url()).toBe(url);
  await open(page);
  await expect(input).toHaveValue('도우미 입력 초안');
  const readingPosition = await list.evaluate((node) => node.scrollTop);
  await toggleHelperTone(page);
  const settings = page.getByRole('dialog', { name: '도우미 설정', exact: true });
  await expect(settings).toBeVisible();
  const tone = settings.getByLabel('도우미 말투', { exact: true });
  const originalTone = await tone.inputValue();
  await tone.fill('설정 화면에서 남긴 말투 초안');
  await toggleHelperTone(page);
  const discard = page.getByRole('alertdialog', { name: '도우미 설정', exact: true });
  await expect(discard).toContainText('저장하지 않은 말투가 사라져요.');
  await discard.getByRole('button', { name: '계속 편집', exact: true }).click();
  await expect(tone).toHaveValue('설정 화면에서 남긴 말투 초안');
  await toggleHelperTone(page);
  await discard.getByRole('button', { name: '변경 내용 버리고 닫기', exact: true }).click();
  await expect(settings).toBeHidden();
  await expect(input).toHaveValue('도우미 입력 초안');
  await expect.poll(() => list.evaluate((node) => node.scrollTop)).toBe(readingPosition);
  await toggleHelperTone(page);
  await expect(tone).toHaveValue(originalTone);
});

test('HELPUI18 switching right panel tabs keeps the helper draft and reading position', async ({
  page,
  request,
}) => {
  const chat = await create(request);
  await harness(page, 20);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/?chat=${chat.id}`);
  const panel = await open(page);
  const input = panel.getByLabel('도우미에게 요청');
  await input.fill('탭을 오가도 남는 도우미 초안');
  const list = panel.locator('.helper-messages');
  await list.evaluate((node) => {
    node.scrollTop = 400;
  });
  const before = await list.evaluate((node) => node.scrollTop);
  expect(before).toBeGreaterThan(0);
  const outlineTab = panel.getByRole('tab', { name: '플롯', exact: true });
  await outlineTab.click();
  await expect(panel).toBeHidden();
  const outline = page.locator('#outline-panel');
  await expect(outline.getByRole('tab', { name: '플롯', exact: true })).toBeFocused();
  await expect(outline.getByRole('tab', { name: '플롯', exact: true })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await outline.getByRole('tab', { name: '플롯', exact: true }).press('ArrowLeft');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('tab', { name: '도우미', exact: true })).toBeFocused();
  await expect(input).toHaveValue('탭을 오가도 남는 도우미 초안');
  await expect.poll(() => list.evaluate((node) => node.scrollTop)).toBe(before);
  await expect(
    page.locator('.workspace-header').getByRole('button', { name: '도우미', exact: true })
  ).toHaveAttribute('aria-pressed', 'true');
});

test('HELPUI17 Back clears owned tone dialogs while retaining each session draft', async ({
  page,
  request,
}) => {
  const chat = await create(request);
  await harness(page, 2);
  await page.goto(`/?chat=${chat.id}`);
  const panel = await open(page);
  const picker = panel.getByLabel('도우미 대화 선택', { exact: true });
  const first = await picker.inputValue();
  await panel.getByRole('button', { name: '새 도우미 대화', exact: true }).click();
  await expect(picker).not.toHaveValue(first);
  const second = await picker.inputValue();
  await picker.selectOption(first);
  await panel.getByLabel('도우미에게 요청', { exact: true }).fill('말투 창을 닫아도 보존할 요청');
  await toggleHelperTone(page);
  const settings = page.getByRole('dialog', { name: '도우미 설정', exact: true });
  const tone = settings.getByLabel('도우미 말투', { exact: true });
  await tone.fill('첫 세션에서만 입력한 저장하지 않은 말투');
  await toggleHelperTone(page);
  const discard = page.getByRole('alertdialog', { name: '도우미 설정', exact: true });
  await expect(discard).toBeVisible();
  await page.goBack();
  await expect(panel).toBeHidden();
  await expect(settings).toBeHidden();
  await expect(discard).toBeHidden();
  await open(page);
  await picker.selectOption(second);
  await toggleHelperTone(page);
  await expect(discard).toBeHidden();
  await expect(tone).not.toHaveValue('첫 세션에서만 입력한 저장하지 않은 말투');
  await toggleHelperTone(page);
  await picker.selectOption(first);
  await expect(panel.getByLabel('도우미에게 요청', { exact: true })).toHaveValue(
    '말투 창을 닫아도 보존할 요청'
  );
  await toggleHelperTone(page);
  await expect(tone).toHaveValue('첫 세션에서만 입력한 저장하지 않은 말투');
});

test('HELPUI14 idle and hidden helper views pause reads and resume cursors, effects and drafts', async ({
  page,
  request,
}) => {
  const chat = await create(request);
  const state = await harness(page);
  const helperFetches = await trackPageFetches(
    page,
    /^\/api\/(?:helper|response-streams\/helper)\//u
  );
  await page.clock.install();
  await page.goto(`/?chat=${chat.id}`);
  const panel = await open(page);
  const input = panel.getByLabel('도우미에게 요청');
  const idleSessions = state.sessionReads;
  const idleEvents = state.eventReads;
  const idleFetches = await helperFetches.count();
  await page.clock.runFor(longestHelperPollDelay * 2);
  expect(await helperFetches.count()).toBe(idleFetches);
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
  const clock = panel.getByTestId('helper-current-activity').locator('.activity-elapsed').first();
  const closedTime = await clock.textContent();
  state.progress(task, '과 두 번째 조각', 13);
  const closedFetches = await helperFetches.count();
  await page.clock.runFor(longestHelperPollDelay);
  expect(await helperFetches.count()).toBe(closedFetches);
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
  const hiddenFetches = await helperFetches.count();
  await page.clock.runFor(longestHelperPollDelay);
  expect(await helperFetches.count()).toBe(hiddenFetches);
  expect(state.streamReads.get(task.id)).toBe(hiddenReads);
  expect(state.sessionReads).toBe(hiddenSessions);
  expect(state.eventReads).toBe(hiddenEvents);
  expect(await clock.textContent()).toBe(hiddenTime);

  const effectReads: string[] = [];
  page.on('request', (entry) => {
    const path = new URL(entry.url()).pathname;
    if (['/api/library', '/api/prompt-workspace', '/api/themes'].includes(path))
      effectReads.push(path);
  });
  state.complete(task);
  const themesChanged = await page.request.post('/api/test/live-frame', {
    data: { event: 'invalidate', data: { name: 'themes', seq: 0 } },
  });
  expect(themesChanged.ok()).toBe(true);
  for (const kind of ['settings.updated', 'illustration-preset.updated']) state.emit(kind);
  await expect
    .poll(() => state.framesReceived())
    .toEqual(expect.arrayContaining(['task.completed', 'settings.updated']));
  expect(effectReads).toEqual([]);
  await page.evaluate(() => {
    delete (document as unknown as { hidden?: boolean }).hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(panel.getByText('합성 완료 응답', { exact: true })).toBeVisible();
  await expect(input).toHaveValue('다시 열어도 남길 초안');
  await expect
    .poll(() => [...new Set(effectReads)].sort())
    .toEqual(['/api/library', '/api/prompt-workspace', '/api/themes']);
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
  await expect(panel.getByRole('button', { name: '이전 요청 확인', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: '도우미 요청 임시 저장' })).toHaveCount(0);
  expect(state.posts).toHaveLength(0);
  await input.fill('보내는 동안 남길 새 입력');
  await panel.getByRole('button', { name: '도우미 이전 요청 확인', exact: true }).click();
  const decision = page.getByRole('dialog', { name: '도우미 요청 임시 저장', exact: true });
  await expect(decision).toContainText('보내지 않았어요');
  await decision.getByRole('button', { name: '닫기', exact: true }).last().click();
  expect(state.posts).toHaveLength(0);
  await expect(input).toHaveValue('보내는 동안 남길 새 입력');
  await panel.getByRole('button', { name: '이전 요청 확인', exact: true }).click();
  await decision.getByRole('button', { name: '다시 임시 저장하고 보내기' }).click();
  await expect(decision).toBeHidden();
  await expect(panel.getByRole('button', { name: '이전 요청 확인', exact: true })).toBeEnabled();
  expect(state.posts).toHaveLength(0);
  await panel.getByRole('button', { name: '이전 요청 확인', exact: true }).click();
  await decision.getByRole('button', { name: '임시 저장 없이 보내기' }).click();
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
    await state.pulse(2);
    expect(state.eventReads).toBe(eventReads + 2);
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
  const firstTaskStatus = panel.locator(`.helper-task[data-task-id="${first.id}"]`);
  await firstTaskStatus.locator(':scope > details > summary').click();
  const viewsBeforeDiagnostics = state.viewReads,
    eventsBeforeDiagnostics = state.eventReads,
    framesBeforeDiagnostics = (await state.framesReceived()).length;
  const diagnostics = ['tool.finished', 'input.measured', 'progress', 'context.segment'];
  for (const kind of diagnostics) state.emit(kind);
  await expect
    .poll(async () => (await state.framesReceived()).slice(framesBeforeDiagnostics))
    .toEqual(diagnostics);
  await expect(panel.locator('.streaming-text')).toHaveText(`실제 공개 조각${continuation}`);
  first.usage = { ...first.usage, modelCalls: 2, inputTokens: 25 };
  state.emit('attempt.finished');
  state.emit('tool.finished');
  await expect(firstTaskStatus).toContainText('실행 요청 2회, 출력 10 토큰');
  expect(state.viewReads).toBe(viewsBeforeDiagnostics + 1);
  expect(state.eventReads).toBe(eventsBeforeDiagnostics + 1);
  await input.fill('뒤이어 처리할 작업');
  await panel.getByRole('button', { name: '다음 요청', exact: true }).click();
  const activity = panel.getByTestId('helper-current-activity');
  await expect(activity.locator('.activity-label')).toHaveText('처리 중이에요');
  await expect(activity.locator('.activity-count')).toHaveText('외 1개');
  await expect(firstTaskStatus.getByTestId('helper-task-activity')).toContainText('처리 중이에요');
  state.loseNext();
  await input.fill('접수 응답을 잃은 작업');
  await panel.getByRole('button', { name: '다음 요청', exact: true }).click();
  await expect(panel.getByRole('button', { name: '이전 요청 확인', exact: true })).toBeVisible();
  const key = state.posts.at(-1)!.requestKey;
  expect(state.current().tasks).toHaveLength(3);
  await page.reload();
  await open(page);
  await expect(panel.locator('.streaming-text')).toHaveText(`실제 공개 조각${continuation}`);
  await expect(panel.getByRole('button', { name: '이전 요청 확인', exact: true })).toBeVisible();
  await input.fill('접수 확인 중에도 보존할 새 입력');
  const postsBeforeConfirmation = state.posts.length;
  await panel.getByRole('button', { name: '이전 요청 확인', exact: true }).click();
  const decision = page.getByRole('dialog', { name: '도우미 요청 확인', exact: true });
  await expect(decision).toContainText('이전 요청의 접수 여부를 확인하지 못했어요.');
  await decision.getByRole('button', { name: '닫기', exact: true }).last().click();
  expect(state.posts).toHaveLength(postsBeforeConfirmation);
  await expect(input).toHaveValue('접수 확인 중에도 보존할 새 입력');
  await panel.getByRole('button', { name: '도우미 이전 요청 확인', exact: true }).click();
  await page
    .getByRole('dialog', { name: '도우미 요청 확인', exact: true })
    .getByRole('button', { name: '접수 확인 및 재시도' })
    .click();
  await expect(panel.getByRole('button', { name: '이전 요청 확인', exact: true })).toHaveCount(0);
  expect(state.posts.at(-1)!.requestKey).toBe(key);
  expect(state.current().tasks).toHaveLength(3);
  await expect(input).toHaveValue('접수 확인 중에도 보존할 새 입력');
  const libraryReads = trackLibraryReads(page);
  await state.complete(first);
  await expect(panel.getByText('합성 완료 응답', { exact: true })).toBeVisible();
  const completedStreamReads = state.streamReads.get(first.id);
  await state.pulse(2);
  expect(state.streamReads.get(first.id)).toBe(completedStreamReads);
  expect(state.eventStreamReads).toBe(0);
  await expect.poll(() => libraryReads.length).toBe(1);
  await state.pulse(1);
  expect(libraryReads).toHaveLength(1);
});

test('HELPUI03 archived artifact revisions and device drafts remain readable without writes', async ({
  page,
  request,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
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
  state.artifacts.set(artifact.id, [
    artifact,
    {
      ...artifact,
      revision: 2,
      origin: 'edit',
      request: '과거 수정 요청',
      text: '과거 편집 저장본',
    },
  ]);
  const draftKeys = [
    `helper-artifact-draft:${artifact.id}:1`,
    `helper-artifact-draft:${artifact.id}:2`,
  ];
  const draftTexts = ['내 장면 편집 초안', '다른 수정본의 편집 초안'];
  const recovery = [
    {
      key: `helper:helper-artifacts:${view.conversation.id}`,
      model: JSON.stringify(draftKeys),
    },
    ...draftKeys.map((key, index) => ({
      key: `helper:${key}`,
      model: JSON.stringify({ revision: index + 1, text: draftTexts[index] }),
    })),
  ];
  await page.evaluate(async (entries) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('uimori-editor-recovery', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('buffers');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction('buffers', 'readwrite');
        for (const entry of entries)
          transaction
            .objectStore('buffers')
            .put({ revision: null, model: entry.model, rawFields: {} }, entry.key);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
    } finally {
      database.close();
    }
  }, recovery);
  view.messages.at(-1)!.artifacts = [{ id: artifact.id, revision: 1 }];
  state.record(view, {
    seq: 1,
    conversationId: view.conversation.id,
    taskId: task.id,
    kind: 'artifact.saved',
    data: null,
  });
  await expect(panel.getByRole('region', { name: '보관된 가정 장면' })).toBeVisible({
    timeout: 15000,
  });
  await panel.getByRole('button', { name: '이전 메시지 불러오기' }).click();
  await expect(panel.getByText('합성 요청 1', { exact: true }).first()).toBeVisible();
  await panel.getByRole('button', { name: '작업 기록', exact: true }).click();
  await panel.getByRole('button', { name: '이전 작업 더 보기' }).click();
  await expect(panel.locator('.helper-task-history h2')).toHaveText('도우미 작업 기록');
  await expect(panel.locator('[data-testid="helper-task-record"]')).toHaveCount(55);
  await panel.getByRole('button', { name: '도우미 작업 기록 닫기', exact: true }).click();
  const card = panel.getByRole('region', { name: '보관된 가정 장면' });
  await expect(card.locator('.helper-prose').first()).toHaveText(artifact.text);
  await expect(card.getByRole('button', { name: '직접 편집', exact: true })).toHaveCount(0);
  await expect(card.getByRole('button', { name: '이 장면 수정 요청', exact: true })).toHaveCount(0);
  await expect(card.getByRole('textbox')).toHaveCount(0);
  await panel.getByLabel('도우미에게 요청').fill('별도로 유지할 요청 초안');
  await card.getByLabel('가정 장면 수정 번호').selectOption('2');
  await expect(card.locator('.helper-prose').first()).toHaveText('과거 편집 저장본');
  await card.getByText('장면 요청', { exact: true }).click();
  await expect(card.locator('.helper-artifact-request')).toContainText('과거 수정 요청');
  await card.getByRole('button', { name: '가정 장면 요청 복사', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe('과거 수정 요청');
  await card.getByRole('button', { name: '가정 장면 복사', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe('과거 편집 저장본');
  await card.getByLabel('가정 장면 수정 번호').selectOption('1');
  await expect(card.locator('.helper-prose').first()).toHaveText(artifact.text);
  await card.getByText('이 기기에 남은 편집 초안 2개', { exact: true }).click();
  for (const [index, text] of draftTexts.entries()) {
    const draft = card.getByRole('region', { name: `보관된 편집 초안 ${index + 1}`, exact: true });
    await expect(draft).toContainText(text);
    await draft.getByRole('button', { name: '가정 장면 초안 복사', exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(text);
  }
  expect(state.artifactWrites).toEqual([]);
  expect(state.artifacts.get(artifact.id)).toHaveLength(2);
  expect(view.messages.at(-1)!.artifacts).toEqual([{ id: artifact.id, revision: 1 }]);
  await expect(panel.getByLabel('도우미에게 요청')).toHaveValue('별도로 유지할 요청 초안');
  await panel.getByRole('button', { name: '새 도우미 대화' }).click();
  await expect(panel.locator('.helper-message')).toHaveCount(0);
  await expect(panel.getByLabel('도우미에게 요청')).toBeEnabled();
  await expect(panel.getByLabel('도우미에게 요청')).toHaveValue('');
  await panel.getByLabel('도우미에게 요청').fill('새 작업의 초안');
  await panel.getByLabel('도우미 대화 선택').selectOption(view.conversation.id);
  await expect(panel.getByLabel('도우미에게 요청')).toHaveValue('별도로 유지할 요청 초안');
  await panel.getByRole('button', { name: '작업 기록', exact: true }).click();
  await expect(panel.locator('[data-testid="helper-task-record"]')).toHaveCount(55);
  await panel.getByRole('button', { name: '도우미 작업 기록 닫기', exact: true }).click();

  await page.route(`**/api/helper/artifacts/${artifact.id}**`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({ status: 503, json: { error: 'SYNTHETIC_ARCHIVE_READ_FAILURE' } });
  });
  await page.reload();
  await navigationAction(page, '서재');
  const recoveredPanel = await open(page);
  await recoveredPanel.getByLabel('도우미 대화 선택').selectOption(view.conversation.id);
  const recoveredCard = recoveredPanel.getByRole('region', { name: '보관된 가정 장면' });
  await expect(recoveredCard).toContainText('서버 작업을 완료하지 못했어요. (503)');
  await recoveredCard.getByText('이 기기에 남은 편집 초안 2개', { exact: true }).click();
  for (const [index, text] of draftTexts.entries()) {
    const draft = recoveredCard.getByRole('region', {
      name: `보관된 편집 초안 ${index + 1}`,
      exact: true,
    });
    await expect(draft).toContainText(text);
    await draft.getByRole('button', { name: '가정 장면 초안 복사', exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(text);
  }
  const persisted = await page.evaluate(
    async (keys) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('uimori-editor-recovery', 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        return await Promise.all(
          keys.map(
            (key) =>
              new Promise<string>((resolve, reject) => {
                const request = database.transaction('buffers').objectStore('buffers').get(key);
                request.onsuccess = () => resolve(request.result?.model);
                request.onerror = () => reject(request.error);
              })
          )
        );
      } finally {
        database.close();
      }
    },
    recovery.map((entry) => entry.key)
  );
  expect(persisted).toEqual(recovery.map((entry) => entry.model));
  expect(state.artifactWrites).toEqual([]);
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
    panel.getByText(`선택한 원문: ${selectedText.length.toLocaleString()}자`, { exact: true })
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
  state.record(state.current(), {
    seq: 100,
    conversationId: failed.conversationId,
    taskId: failed.id,
    kind: 'task.failed',
    data: null,
  });
  await expect(panel.getByText('공개 응답이 없는 실패', { exact: true }).first()).toBeVisible();
  await expect.poll(() => state.streamReads.get(failed.id) ?? 0).toBe(1);
  await state.pulse(2);
  expect(state.streamReads.get(failed.id)).toBe(1);
  expect(
    ((await (await request.get(`/api/chats/${chat.id}`)).json()) as ChatDetail).sources
  ).toEqual(selectedSources);
});

test('HELPUI05 explicitly retries a saved edited request, preserves composer and hides historical failure after reload', async ({
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
  await expect(details.getByText('모델: 이전 시도의 도우미 모델', { exact: true })).toBeVisible();
  await panel.getByLabel('도우미에게 요청').fill('새 요청 작성 중');
  await panel.getByLabel('요청 및 컨텍스트 메뉴', { exact: true }).click();
  await page.getByRole('button', { name: '요청 수정', exact: true }).click();
  await panel.getByLabel('요청 수정 내용').fill('고친 요청');
  await panel.getByRole('button', { name: '입력 저장', exact: true }).click();
  await expect(panel.getByTestId('source-request')).toHaveText('고친 요청');
  expect(state.posts).toHaveLength(0);
  await expect(panel.getByLabel('도우미에게 요청')).toHaveValue('새 요청 작성 중');
  state.loseNext();
  await panel
    .getByRole('group', { name: '실패한 요청' })
    .getByRole('button', { name: '다시 시도', exact: true })
    .click();
  await expect(panel.getByRole('button', { name: '이전 요청 확인', exact: true })).toBeVisible();
  expect(state.posts[0].text).toBe('고친 요청');
  const key = state.posts.at(-1)!.requestKey;
  await page.reload();
  panel = await open(page);
  await expect(panel.getByRole('button', { name: '이전 요청 확인', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '이전 요청 확인', exact: true }).click();
  await page
    .getByRole('dialog', { name: '도우미 요청 확인', exact: true })
    .getByRole('button', { name: '접수 확인 및 재시도' })
    .click();
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
  await panel.getByRole('button', { name: '작업 기록', exact: true }).click();
  await expect(panel.locator('[data-testid="helper-task-record"]')).toHaveCount(2);
  await expect(
    panel.locator(`[data-testid="helper-task-record"][data-task-id="${failed.id}"]`)
  ).toContainText('이전 시도의 도우미 모델');
  await expect(
    panel.locator(`[data-testid="helper-task-record"][data-task-id="${retried.id}"]`)
  ).toContainText('재시도에 선택한 도우미 모델');
  await expect(panel.locator('.helper-task-history').getByText('SYNTHETIC_FAILURE')).toBeVisible();
});

test('HELPHISTORY task history rows show status, usage and one level of sections without hiding failures or exact text', async ({
  page,
  request,
  context,
}, info) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const chat = await create(request),
    state = await harness(page, 1);
  await page.goto(`/?chat=${chat.id}`);
  await open(page);
  const compaction = state.addFailed(state.current());
  compaction.error = 'HELPER_COMPACTION_REFUSED';
  const failed = state.addFailed(state.current());
  const fullRequest = `  첫 문장의 공백도 유지해 주세요.\n\n${'긴 한국어 요청을 접어 두고 필요한 부분을 확인해요. '.repeat(30)}\n마지막 줄의 공백도 유지해 주세요.  `;
  failed.request = fullRequest;
  failed.completedEffects = { count: 1, labels: ['다음 요청 옵션'] };
  failed.usage = { modelCalls: 2, inputTokens: 1200, outputTokens: 300, costUsd: 0.012 };
  state.results.set(failed.id, {
    results: [
      {
        eventSeq: 4,
        receiptId: 'history-receipt',
        operation: 'resource.patch',
        requestedTargets: 1,
        changedTargets: 1,
        targets: [{ kind: 'content', id: 'history-content', title: '등대지기 미라', revision: 2 }],
      },
    ],
    usage: {
      attempts: [
        {
          id: 'history-attempt',
          purpose: 'helper',
          status: 'completed',
          inputTokens: 1200,
          outputTokens: 300,
          costUsd: 0.012,
          cachedInputTokens: null,
          reasoningTokens: null,
          internalModelCalls: null,
        },
      ],
      toolExecutions: 3,
      latestInputEstimate: null,
    },
  });
  const read = (seq: number, name: string, target?: HelperActivityEvent['target']) => [
    { seq, kind: 'tool.started', callId: `c${seq}`, name, ...(target ? { target } : {}) },
    { seq: seq + 1, kind: 'tool.finished', callId: `c${seq}`, name, denied: false },
  ];
  state.activity(failed, [
    { seq: 1, kind: 'attempt.started', attemptId: 'helper', purpose: 'helper' },
    { seq: 2, kind: 'attempt.finished', attemptId: 'helper', status: 'tool_calls' },
    ...read(3, 'scene.read', { kind: 'scene', title: '등대의 밤' }),
    ...read(5, 'resource.read', { kind: 'content', title: '등대지기 미라' }),
    {
      seq: 7,
      kind: 'tool.finished',
      name: 'resource.patch',
      denied: true,
      error: 'SYNTHETIC_TOOL_FAILURE',
    },
  ]);
  for (const width of [MOBILE_WIDTH, DESKTOP_WIDTH]) {
    await page.setViewportSize({ width, height: 900 });
    await page.reload();
    const panel = await open(page);
    await panel.getByLabel('도우미에게 요청').fill('별도로 유지할 요청 초안');
    await panel.getByRole('button', { name: '작업 기록', exact: true }).click();
    const history = panel.locator('.helper-task-history');
    await expect(history).toHaveClass(/\bwide\b/u);
    await expect(history.locator('.activity-notification-items')).toHaveCount(0);
    const filters = history.getByRole('group', { name: '작업 상태로 거르기', exact: true });
    await expect(filters.getByRole('button')).toHaveText(['전체 3', '진행 중 0', '오류 2']);
    await expect(history.locator('.task-history-summary dt')).toHaveText([
      '작업',
      '토큰',
      '확인된 비용',
    ]);
    const record = history.locator(`[data-task-id="${failed.id}"]`);
    const requestText = record.locator('.task-request');
    await expect(record.locator('.task-status-badge')).toHaveText('실패');
    await expect(record.locator('.task-status-badge')).toHaveAttribute('data-tone', 'issue');
    await expect(requestText).toHaveAttribute('data-clamped', '');
    expect(await requestText.textContent()).toBe(fullRequest);
    expect(
      await requestText.evaluate(
        (node) => node.clientHeight <= Number.parseFloat(getComputedStyle(node).lineHeight) * 2 + 1
      )
    ).toBe(true);
    const meta = record.locator('.task-history-meta');
    await expect(meta).toContainText('예약 당시 도우미 모델');
    await expect(meta).toContainText('실행 요청 2회');
    await expect(meta).toContainText('1,500 토큰');
    await expect(meta).toContainText('US$0.01');
    await expect(record.getByText('SYNTHETIC_FAILURE', { exact: true })).toBeVisible();
    await expect(
      record.getByText('저장한 변경 1건, 다음 요청 옵션', { exact: true })
    ).toBeVisible();
    await expect(
      record
        .locator('.task-history-row-actions')
        .getByRole('button', { name: '대화에서 보기', exact: true })
    ).toBeVisible();
    const compactionRecord = history.locator(`[data-task-id="${compaction.id}"]`);
    await expect(compactionRecord).toContainText(messages['errors.HELPER_COMPACTION_REFUSED'].ko);
    await expect(compactionRecord).not.toContainText('HELPER_COMPACTION_REFUSED');
    const shortRecord = history
      .getByTestId('helper-task-record')
      .filter({ hasText: '합성 요청 1' });
    await expect(shortRecord.locator('.task-request')).toHaveText('합성 요청 1');
    if (visualReview)
      await page.screenshot({ path: info.outputPath(`helper-task-history-${width}.png`) });

    await record.getByRole('button', { name: '자세히 보기', exact: true }).click();
    const collapse = record.getByRole('button', { name: '접기', exact: true });
    await expect(collapse).toHaveAttribute('aria-expanded', 'true');
    await expect(requestText).not.toHaveAttribute('data-clamped');
    const sections = record.locator('.task-history-detail');
    await expect(sections.locator('.task-history-section-head > h3')).toHaveText([
      '결과와 변경',
      '단계',
      '호출과 비용',
      '원본 기록',
    ]);
    await expect(sections.locator('details')).toHaveCount(0);
    await expect(sections.getByText('등대지기 미라').first()).toBeVisible();
    const steps = sections.locator('.task-history-timeline > li');
    await expect(steps).toHaveCount(3);
    await expect(steps.nth(0)).toContainText('도구 사용을 요청했어요');
    await expect(steps.nth(1)).toContainText('자료 확인');
    await expect(steps.nth(1)).toContainText('장면 1개');
    await expect(steps.nth(1)).toContainText('등대의 밤');
    await expect(steps.nth(2)).toHaveAttribute('data-tone', 'issue');
    await expect(steps.nth(2)).toContainText('SYNTHETIC_TOOL_FAILURE');
    await expect(sections.locator('.task-history-timeline code')).toHaveCount(0);
    await expect(sections.locator('.task-history-timeline')).not.toContainText('resource.read');
    await expect(sections.locator('.helper-usage-rows [data-row="cost"]')).toContainText('비용');
    await expect(sections.locator('.task-history-raw')).toHaveCount(0);
    await sections.getByRole('button', { name: '원본 보기', exact: true }).click();
    await expect(sections.locator('.task-history-raw')).toContainText('"activity"');
    await expect(sections.locator('.task-history-raw')).toContainText('resource.patch');
    await sections.getByRole('button', { name: '복사', exact: true }).click();
    await expect
      .poll(
        async () => JSON.parse(await page.evaluate(() => navigator.clipboard.readText())).task.id
      )
      .toBe(failed.id);
    expect(
      await history.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)
    ).toBe(true);
    if (visualReview)
      await page.screenshot({ path: info.outputPath(`helper-task-history-detail-${width}.png`) });

    await requestText.evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    });
    await page.keyboard.press('Control+c');
    expect(
      (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/gu, '\n')
    ).toBe(fullRequest);
    await collapse.click();
    await expect(sections).toBeHidden();
    await expect(requestText).toHaveAttribute('data-clamped', '');
    await filters.getByRole('button', { name: /^오류/u }).click();
    await expect(history.getByTestId('helper-task-record')).toHaveCount(2);
    await panel.getByRole('button', { name: '도우미 작업 기록 닫기', exact: true }).click();
    await expect(panel.getByLabel('도우미에게 요청')).toHaveValue('별도로 유지할 요청 초안');
  }
  expect(state.posts).toHaveLength(0);
});

test('HELPUI06B a stopped task with recorded work offers to continue and sends a resume of that task', async ({
  page,
  request,
}) => {
  const chat = await create(request),
    state = await harness(page);
  await page.goto(`/?chat=${chat.id}`);
  await open(page);
  const failed = state.addFailed(state.current());
  failed.error = 'HTTP_429';
  failed.completedEffects = { count: 1, labels: ['채팅 제목 변경'] };
  failed.resumable = true;
  await page.reload();
  const panel = await open(page);
  const actions = panel.getByRole('group', { name: '실패한 요청' });
  await expect(actions.getByRole('button', { name: '다시 시도', exact: true })).toHaveCount(0);
  await actions.getByRole('button', { name: '이어서 하기', exact: true }).click();
  await expect.poll(() => state.posts.length).toBe(1);
  expect(state.posts[0]).toMatchObject({ retryOf: failed.id, resume: true });
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
    '변경 사항 1건을 저장했지만 응답을 완료하지 못했어요.'
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
  await expect(details.getByText('저장한 작업: 다음 요청 옵션')).toBeVisible();
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
  const picker = panel.getByLabel('도우미 대화 선택');
  const firstId = await picker.inputValue();
  await input.fill('첫 세션의 실행');
  await panel.getByRole('button', { name: '도우미 요청 보내기', exact: true }).click();
  await expect(input).toHaveValue('');
  const firstTask = state.views.get(firstId)!.tasks[0];
  await input.fill('첫 세션의 다음 초안');
  const release = state.holdNextStream(firstTask.id);
  try {
    await expect.poll(() => state.heldStreams.has(firstTask.id)).toBe(true);
    await panel.getByRole('button', { name: '새 도우미 대화', exact: true }).click();
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

test('HELPUI08 a thought summary shows while the model works and leaves when the call ends', async ({
  page,
  request,
}, info) => {
  const chat = await create(request),
    state = await harness(page);
  await page.goto(`/?chat=${chat.id}`);
  const panel = await open(page);
  await panel.getByLabel('도우미에게 요청').fill('생각 요약 표시 검사');
  await panel.getByRole('button', { name: '도우미 요청 보내기' }).click();
  await expect.poll(() => state.current().tasks.length).toBe(1);
  const task = state.current().tasks[0];
  const thought = panel.getByRole('status', { name: '생각 요약', exact: true });
  await expect(thought).toHaveCount(0);
  state.think(task, '**자료 확인**\n\n등장인물 설정을 읽고 있어요.');
  await expect(thought).toContainText('등장인물 설정을 읽고 있어요.');
  await expect(thought).not.toContainText('**');
  await page.screenshot({ path: info.outputPath('helper-thought-summary.png') });
  state.think(task);
  await expect(thought).toHaveCount(0);
  const text = '설정을 확인했어요.';
  state.progress(task, text, text.length);
  await expect(panel.locator('.streaming-text')).toHaveText(text);
  state.think(task, '다음 단계를 정리하고 있어요.');
  await expect(thought).toContainText('다음 단계를 정리하고 있어요.');
  await expect(panel.locator('.streaming-text')).toHaveText(text);
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
  await expect.poll(() => state.current().tasks.length).toBe(1);
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
  await state.pulse(2);
  expect(state.streamReads.get(task.id) ?? 0).toBe(0);
  await expect(panel.locator('.streaming-response')).toHaveCount(0);
  await expect(panel.getByTestId('helper-task-activity')).toContainText('처리 중');
  await setMode('stream');
  await expect(panel.locator('.streaming-text')).toHaveText('도구 실행 전 설명');
  await setMode('complete');
  const reads = state.streamReads.get(task.id);
  await expect(panel.locator('.streaming-response')).toHaveCount(0);
  await page.reload();
  await open(page);
  await state.pulse(2);
  expect(state.streamReads.get(task.id)).toBe(reads);
  expect(state.posts).toHaveLength(1);
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
  await page.reload();
  await open(page);
  await expect(panel.getByTestId('helper-completed-effects')).toContainText(
    '변경 사항 1건을 저장했지만'
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
  await expect(row).toContainText('취소됨');
  expect(state.streamReads.get(task.id) ?? 0).toBe(0);
  await row.locator('.partial-response > summary').click();
  await expect(row.locator('.streaming-text')).toHaveText('취소 직전 받은 내용');
  expect(state.streamReads.get(task.id)).toBe(1);
});

const resourceChange = (id: string, title: string): HelperChange => ({
  domain: 'resource',
  targetId: id,
  title,
  location: { kind: 'resource-field', path: ['description'] },
  action: 'update',
  diff: null,
  anchor: null,
});
const resourceUnit = (
  id: string,
  title: string,
  status: HelperRollbackUnit['status'] = 'restorable',
  reason?: HelperRollbackUnit['reason']
): HelperRollbackUnit => ({
  unit: `resource:content:${id}`,
  domain: 'resource',
  title,
  changeTargetIds: [id],
  status,
  ...(reason ? { reason } : {}),
  touches: { domain: 'resource', kind: 'content', id },
});
function rollbackFixture(task: HelperTaskView, chatId: string) {
  const sceneChange = (field: 'original' | 'translation'): HelperChange => ({
    domain: 'scene',
    targetId: `scene-2:${field}`,
    title: '등대지기의 밤',
    location: { kind: 'scene', scene: 2, field },
    action: 'update',
    diff: null,
    anchor: null,
  });
  const results: Partial<HelperTaskResultsView> = {
    changes: [
      resourceChange('bot-a', '하린'),
      sceneChange('original'),
      sceneChange('translation'),
      resourceChange('bot-b', '서윤'),
      {
        domain: 'settings',
        targetId: `chat.storyUi:${chatId}`,
        title: '등대지기의 밤',
        location: { kind: 'setting', setting: 'chat.storyUi' },
        action: 'update',
        diff: null,
        anchor: null,
      },
    ],
  };
  const rollback: HelperRollbackView = {
    taskId: task.id,
    blocked: null,
    units: [
      resourceUnit('bot-a', '하린'),
      {
        unit: 'scene:scene-2',
        domain: 'scene',
        title: '등대지기의 밤',
        changeTargetIds: ['scene-2:original', 'scene-2:translation'],
        status: 'restorable',
        touches: {
          domain: 'scene',
          chatId,
          sourceId: 'scene-2',
          fields: ['original', 'translation'],
        },
      },
      resourceUnit('bot-b', '서윤', 'changed-since', 'changed-after-task'),
      {
        unit: `settings:chat.storyUi:${chatId}`,
        domain: 'settings',
        title: '등대지기의 밤',
        changeTargetIds: [`chat.storyUi:${chatId}`],
        status: 'not-covered',
        reason: 'other-domain',
        touches: null,
      },
    ],
  };
  return { results, rollback };
}

test('HROLLBACK01 a whole-task rollback restores what it can and names what it leaves', async ({
  page,
  request,
}, info) => {
  const chat = await create(request),
    state = await harness(page, 1);
  await page.goto(`/?chat=${chat.id}`);
  await open(page);
  const task = state.current().tasks[0];
  const fixture = rollbackFixture(task, chat.id);
  state.results.set(task.id, fixture.results);
  state.rollbacks.set(task.id, fixture.rollback);
  const dialog = page.getByRole('alertdialog', { name: '도우미 변경 되돌리기', exact: true });
  for (const [width, height] of [
    [1440, 900],
    [412, 915],
  ] as const)
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
      await page.goto(`/?chat=${chat.id}`);
      const panel = await open(page);
      const results = panel.getByTestId('helper-task-results');
      await expect(
        results.locator('.helper-change', { hasText: '서윤' }).locator('.helper-rollback-status')
      ).toHaveText('작업 뒤에 바뀌어서 되돌릴 수 없어요.');
      await expect(
        results.getByText('설정, 채팅 전용 로어, 장면 이름 변경은 되돌리기 대상이 아니에요.')
      ).toHaveCount(1);
      await expect(results.locator('.helper-rollback-unit')).toHaveCount(2);
      await results.getByRole('button', { name: '이 작업의 변경 되돌리기', exact: true }).click();
      await expect(
        dialog.getByRole('region', { name: '되돌릴 대상' }).getByRole('listitem')
      ).toHaveText(['하린', '등대지기의 밤, 장면 2']);
      const kept = dialog.getByRole('region', { name: '그대로 둘 대상' }).getByRole('listitem');
      await expect(kept).toHaveCount(2);
      await expect(kept.nth(0)).toContainText('서윤');
      await expect(kept.nth(0)).toContainText('작업 뒤에 바뀌어서 되돌릴 수 없어요.');
      await expect(kept.nth(1)).toContainText('되돌리기 대상이 아니에요.');
      await expect(dialog.getByRole('note')).toContainText('번역 삽화 배치는 되돌리지 않아요.');
      await page.screenshot({
        path: info.outputPath(`rollback-preview-${width}-${colorScheme}.png`),
      });
      await dialog.getByRole('button', { name: '취소', exact: true }).click();
      await expect(dialog).toBeHidden();
    }
  expect(state.rollbackPosts).toEqual([]);
  const panel = page.locator('#helper-panel');
  const results = panel.getByTestId('helper-task-results');
  await results.getByRole('button', { name: '이 작업의 변경 되돌리기', exact: true }).click();
  await dialog.getByRole('button', { name: '변경 2개 되돌리기', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(state.rollbackPosts).toEqual([{}]);
  await expect(
    page.getByRole('status').filter({ hasText: '변경 2개를 되돌렸어요.' })
  ).toBeVisible();
  const restored = results.locator('.helper-rollback-status[data-status="restored"]');
  await expect(restored).toHaveCount(3);
  await expect(
    results.locator('.helper-change', { hasText: '서윤' }).locator('.helper-rollback-status')
  ).toHaveText('작업 뒤에 바뀌어서 되돌릴 수 없어요.');
  await expect(results.locator('.helper-rollback-unit')).toHaveCount(0);
  for (const [width, height] of [
    [1440, 900],
    [412, 915],
  ] as const)
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
      await page.goto(`/?chat=${chat.id}`);
      await open(page);
      await expect(restored).toHaveCount(3);
      await expect(
        results.getByRole('button', { name: '이 작업의 변경 되돌리기', exact: true })
      ).toHaveCount(0);
      await page.screenshot({
        path: info.outputPath(`rollback-cards-${width}-${colorScheme}.png`),
      });
    }
});

test('HROLLBACK02 one card rolls back alone and actions wait for a running task', async ({
  page,
  request,
}) => {
  const chat = await create(request),
    state = await harness(page, 1);
  await page.goto(`/?chat=${chat.id}`);
  await open(page);
  const first = state.current().tasks[0];
  const fixture = rollbackFixture(first, chat.id);
  state.results.set(first.id, fixture.results);
  state.rollbacks.set(first.id, fixture.rollback);
  await page.reload();
  const panel = await open(page);
  const results = panel.locator(
    `.helper-message.assistant[data-task-id="${first.id}"] [data-testid="helper-task-results"]`
  );
  await results.getByRole('button', { name: '하린 되돌리기', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: '도우미 변경 되돌리기', exact: true });
  await expect(dialog).toContainText('이 대상을 작업 전 상태로 되돌려요.');
  await expect(
    dialog.getByRole('region', { name: '되돌릴 대상' }).getByRole('listitem')
  ).toHaveText(['하린']);
  await dialog.getByRole('button', { name: '되돌리기', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(state.rollbackPosts).toEqual([{ unit: 'resource:content:bot-a' }]);
  await expect(
    results.locator('.helper-change', { hasText: '하린' }).locator('.helper-rollback-status')
  ).toHaveText('되돌렸어요');
  const scene = results.getByRole('button', {
    name: '등대지기의 밤, 장면 2 되돌리기',
    exact: true,
  });
  await expect(scene).toBeEnabled();
  await panel.getByLabel('도우미에게 요청').fill('다음 작업');
  await panel.getByRole('button', { name: '도우미 요청 보내기' }).click();
  await expect.poll(() => state.posts.length).toBe(1);
  await expect(scene).toBeDisabled();
  await expect(results.getByText('도우미 작업이 끝나면 되돌릴 수 있어요.')).toBeVisible();
  state.complete(state.current().tasks[0]);
  await expect(scene).toBeEnabled();
  await expect(results.getByText('도우미 작업이 끝나면 되돌릴 수 있어요.')).toHaveCount(0);
  expect(state.rollbackPosts).toHaveLength(1);

  state.loseRollback();
  await scene.click();
  await dialog.getByRole('button', { name: '되돌리기', exact: true }).click();
  await expect(dialog).toBeHidden();
  const unknown = results
    .getByRole('alert')
    .filter({ hasText: '되돌리기 결과를 확인하지 못했어요.' });
  await expect(unknown).toBeVisible();
  await expect(scene).toBeDisabled();
  expect(state.rollbackPosts).toHaveLength(2);
  await unknown.getByRole('button', { name: '결과 확인', exact: true }).click();
  await expect(unknown).toHaveCount(0);
  await expect(
    results
      .locator('.helper-change', { hasText: '원문' })
      .locator('.helper-rollback-status[data-status="restored"]')
  ).toBeVisible();
  await expect(scene).toHaveCount(0);
  expect(state.rollbackPosts).toHaveLength(2);
});

test('HROLLBACK04 a rollback refreshes other cards and each completion shows its notice', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
  const chat = await create(request),
    state = await harness(page, 2);
  await page.goto(`/?chat=${chat.id}`);
  await open(page);
  const [later, earlier] = state.current().tasks;
  const single = (task: HelperTaskView, ids: string[]) => {
    state.results.set(task.id, {
      changes: ids.map((id) => resourceChange(id, id === 'bot-a' ? '하린' : '서윤')),
    });
    state.rollbacks.set(task.id, {
      taskId: task.id,
      blocked: null,
      units: ids.map((id) => resourceUnit(id, id === 'bot-a' ? '하린' : '서윤')),
    });
  };
  single(earlier!, ['bot-a']);
  single(later!, ['bot-a', 'bot-b']);
  await page.reload();
  const panel = await open(page);
  const card = (task: HelperTaskView) =>
    panel.locator(
      `.helper-message.assistant[data-task-id="${task.id}"] [data-testid="helper-task-results"]`
    );
  await expect(card(earlier!).getByRole('button', { name: '하린 되돌리기' })).toBeEnabled();
  const dialog = page.getByRole('alertdialog', { name: '도우미 변경 되돌리기', exact: true });
  const notice = page.getByRole('status').filter({ hasText: '변경 1개를 되돌렸어요.' });
  await card(later!).getByRole('button', { name: '하린 되돌리기', exact: true }).click();
  state.rollbacks.set(earlier!.id, {
    taskId: earlier!.id,
    blocked: null,
    units: [resourceUnit('bot-a', '하린', 'changed-since', 'changed-after-task')],
  });
  await dialog.getByRole('button', { name: '되돌리기', exact: true }).click();
  await expect(notice).toBeVisible();
  await expect(
    card(earlier!).locator('.helper-change', { hasText: '하린' }).locator('.helper-rollback-status')
  ).toHaveText('작업 뒤에 바뀌어서 되돌릴 수 없어요.');
  await expect(card(earlier!).getByRole('button', { name: '하린 되돌리기' })).toHaveCount(0);
  await expect(notice).toHaveCount(0, { timeout: 8000 });
  await card(later!).getByRole('button', { name: '서윤 되돌리기', exact: true }).click();
  await dialog.getByRole('button', { name: '되돌리기', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(notice).toBeVisible();
});

test('HROLLBACK03 an unsaved editor draft blocks its unit and a clean editor shows the restored content', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 1000 });
  const original = `되돌릴 봇 ${randomUUID()}`;
  const created = await request.post('/api/content', {
    data: fixtureBotInput(original, 'Original source.'),
  });
  expect(created.ok()).toBe(true);
  const bot = await created.json();
  const changedTitle = `${original} 도우미 수정`;
  const changed = await request.put(`/api/content/${bot.id}`, {
    data: { ...fixtureBotInput(changedTitle, 'Original source.'), expectedRevision: bot.revision },
  });
  expect(changed.ok(), await changed.text()).toBe(true);
  const saved = await changed.json();
  const state = await harness(page, 1);
  const openEditor = async () => {
    if (page.url().startsWith('http'))
      await page.evaluate(() => localStorage.removeItem('uimori:workspace-panel'));
    await page.goto('/');
    await navigationAction(page, '서재');
    await page.getByRole('searchbox', { name: '서재 검색', exact: true }).fill(changedTitle);
    await page.getByRole('button', { name: `${changedTitle} 편집`, exact: true }).click();
    await expect(page.getByLabel(/^(봇|페르소나|모듈) 이름$/u)).toBeVisible();
  };
  const openEditorHelper = async () => {
    await page
      .getByRole('region', { name: '자료 상세', exact: true })
      .getByRole('button', { name: '도우미 열기', exact: true })
      .click();
    const panel = page.locator('#helper-panel');
    await expect(panel.getByLabel('도우미에게 요청')).toBeEnabled();
    return panel;
  };
  await openEditor();
  await openEditorHelper();
  const task = state.current().tasks[0];
  state.results.set(task.id, {
    changes: [resourceChange(bot.id, changedTitle), resourceChange('bot-other', '다른 자료')],
  });
  state.rollbacks.set(task.id, {
    taskId: task.id,
    blocked: null,
    units: [resourceUnit(bot.id, changedTitle), resourceUnit('bot-other', '다른 자료')],
  });
  state.onRollback(async (units) => {
    if (!units.some((unit) => unit.changeTargetIds.includes(bot.id))) return;
    const restored = await request.put(`/api/content/${bot.id}`, {
      data: {
        ...fixtureBotInput(original, 'Original source.'),
        expectedRevision: saved.revision,
      },
    });
    expect(restored.ok(), await restored.text()).toBe(true);
  });
  await openEditor();
  const draft = page.getByLabel(/^(봇|페르소나|모듈) 이름$/u);
  await draft.fill('지키려는 미저장 입력');
  const panel = await openEditorHelper();
  const results = panel.getByTestId('helper-task-results');
  const card = results.locator('.helper-change', { hasText: changedTitle });
  await expect(card.locator('.helper-rollback-status')).toHaveText(
    '열린 편집기에 저장하지 않은 입력이 있어 되돌리지 않아요. 저장하거나 취소한 뒤 되돌려 주세요.'
  );
  await expect(
    results.getByRole('button', { name: `${changedTitle} 되돌리기`, exact: true })
  ).toBeDisabled();
  await results.getByRole('button', { name: '이 작업의 변경 되돌리기', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: '도우미 변경 되돌리기', exact: true });
  await expect(
    dialog.getByRole('region', { name: '되돌릴 대상' }).getByRole('listitem')
  ).toHaveText(['다른 자료']);
  await expect(
    dialog.getByRole('region', { name: '그대로 둘 대상' }).getByRole('listitem')
  ).toContainText(changedTitle);
  await dialog.getByRole('button', { name: '변경 1개 되돌리기', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(state.rollbackPosts).toEqual([{ unit: 'resource:content:bot-other' }]);
  await expect(draft).toHaveValue('지키려는 미저장 입력');
  expect((await (await request.get(`/api/content/${bot.id}`)).json()).title).toBe(changedTitle);

  await draft.fill(changedTitle);
  const action = results.getByRole('button', { name: `${changedTitle} 되돌리기`, exact: true });
  await expect(action).toBeEnabled();
  await action.click();
  await dialog.getByRole('button', { name: '되돌리기', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(state.rollbackPosts).toHaveLength(2);
  await expect(draft).toHaveValue(original);
  await expect(card.locator('.helper-rollback-status')).toHaveText('되돌렸어요');
});

test('HPLAN01 plan mode sends a plan request, shows a bounded plan and carries it out', async ({
  page,
  request,
}, info) => {
  const chat = await create(request),
    state = await harness(page);
  await page.goto(`/?chat=${chat.id}`);
  const panel = await open(page);
  const modeChip = panel.locator('.helper-mode-chip');
  await expect(modeChip).toHaveAccessibleName('요청 방식: 바로 적용');
  await modeChip.click();
  await expect(modeChip).toHaveAccessibleName('요청 방식: 계획만');
  await panel.getByLabel('도우미에게 요청').fill('등장인물 소개를 다시 정리할 계획을 세워 주세요');
  await panel.getByRole('button', { name: '도우미 요청 보내기' }).click();
  await expect.poll(() => state.posts.length).toBe(1);
  expect(state.posts[0].mode).toBe('plan');
  const task = state.current().tasks[0];
  const row = panel.locator(`.helper-task[data-task-id="${task.id}"]`);
  await expect(row.locator('.helper-plan-badge')).toHaveText('계획');
  state.complete(task);
  state.current().messages.at(-1)!.text = Array.from(
    { length: 24 },
    (_, index) => `${index + 1}. 인물 ${index + 1}의 소개 문단을 읽고 말투와 관계를 정리해요.`
  ).join('\n');
  const plan = panel.getByTestId('helper-plan');
  await expect(plan).toBeVisible();
  const toggle = plan.getByRole('button', { name: '계획 모두 보기', exact: true });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  const prose = plan.locator('.helper-prose');
  const collapsed = await prose.evaluate((node) => node.clientHeight);
  expect(await prose.evaluate((node) => node.scrollHeight)).toBeGreaterThan(collapsed);
  for (const [width, height] of [
    [1440, 900],
    [412, 915],
  ] as const)
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
      await plan.scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath(`plan-card-${width}-${colorScheme}.png`) });
    }
  const fade = () => prose.evaluate((node) => getComputedStyle(node).maskImage);
  expect(await fade()).toContain('gradient');
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
  await toggle.click();
  await expect(plan.getByRole('button', { name: '계획 접기', exact: true })).toHaveAttribute(
    'aria-expanded',
    'true'
  );
  expect(await prose.evaluate((node) => node.scrollHeight - node.clientHeight)).toBeLessThan(2);
  expect(await fade()).toBe('none');
  await plan.getByRole('button', { name: '이 계획대로 진행', exact: true }).click();
  await expect.poll(() => state.posts.length).toBe(2);
  expect(state.posts[1].text).toBe('위 계획대로 진행해 주세요.');
  expect(state.posts[1].mode).toBeUndefined();
  await expect(modeChip).toHaveAccessibleName('요청 방식: 바로 적용');
  await expect(plan.getByRole('button', { name: '이 계획대로 진행', exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('mode-apply-desktop-dark.png') });
});

test('HPLAN02 Alt+M switches the request mode only while focus is in the helper', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
  const chat = await create(request);
  await harness(page);
  await page.goto(`/?chat=${chat.id}`);
  const panel = await open(page);
  const modeChip = panel.locator('.helper-mode-chip');
  const input = panel.getByLabel('도우미에게 요청');
  await input.fill('초안');
  await input.press('Alt+KeyM');
  await expect(modeChip).toHaveAccessibleName('요청 방식: 계획만');
  await expect(input).toHaveValue('초안');
  await input.press('Alt+KeyM');
  await expect(modeChip).toHaveAccessibleName('요청 방식: 바로 적용');
  await page.getByLabel('다음 장면 요청').focus();
  await page.keyboard.press('Alt+KeyM');
  await expect(modeChip).toHaveAccessibleName('요청 방식: 바로 적용');
});

test('HCONFIRM01 held operations are confirmed with an editable request, declined without one, or expired', async ({
  page,
  request,
}, info) => {
  const title = `삭제를 기다리는 봇 ${randomUUID()}`;
  const created = await request.post('/api/content', { data: fixtureBotInput(title) });
  expect(created.ok()).toBe(true);
  const bot = await created.json();
  const chat = await create(request),
    state = await harness(page, 1);
  await page.goto(`/?chat=${chat.id}`);
  await open(page);
  const task = state.current().tasks[0];
  const held = (
    id: string,
    operation: string,
    reason: 'delete' | 'bulk' | 'paid',
    targets: { kind: string; id: string }[],
    grantable = true
  ) => ({
    id,
    taskId: task.id,
    operation,
    reason,
    chatId: chat.id,
    targets,
    grantedBy: null,
    grantable,
  });
  state.results.set(task.id, {
    confirmations: [
      held('delete-bot', 'resource.delete', 'delete', [{ kind: 'content', id: bot.id }]),
      held('paid-scene', 'scene.request', 'paid', [{ kind: 'chat', id: chat.id }]),
      held('old-bulk', 'resource.patchMany', 'bulk', [{ kind: 'content', id: bot.id }], false),
    ],
  });
  const cards = () => page.locator('#helper-panel .helper-confirmation');
  for (const [width, height] of [
    [1440, 900],
    [412, 915],
  ] as const)
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
      await page.goto(`/?chat=${chat.id}`);
      await open(page);
      await expect(cards()).toHaveCount(3);
      await page.screenshot({
        path: info.outputPath(`confirmation-cards-${width}-${colorScheme}.png`),
      });
    }
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
  await page.goto(`/?chat=${chat.id}`);
  const panel = await open(page);
  const deletion = cards().filter({ hasText: '자료 삭제' });
  await expect(deletion).toContainText(title);
  await expect(deletion).toContainText('삭제하면 되돌릴 수 없어요.');
  const expired = cards().filter({ hasText: '여러 자료 한꺼번에 수정' });
  await expect(expired).toContainText('더 이상 확인할 수 없어요.');
  await expect(expired.getByRole('button')).toHaveCount(0);

  const paid = cards().filter({ hasText: '다음 장면 요청' });
  await expect(paid).toContainText(chat.title);
  await paid.getByRole('button', { name: '다음 장면 요청 거절', exact: true }).click();
  await expect(cards()).toHaveCount(2);
  await page.reload();
  await open(page);
  await expect(cards()).toHaveCount(2);
  expect(state.posts).toHaveLength(0);

  await deletion.getByRole('button', { name: '자료 삭제 확인', exact: true }).click();
  const input = panel.getByLabel('도우미에게 요청');
  const confirmedText = `보류한 작업을 확인했어요. 자료 삭제: ${title}. 그대로 진행해 주세요.`;
  await expect(input).toHaveValue(confirmedText);
  await expect(input).toBeFocused();
  await expect(panel.locator('.helper-confirmation-chip')).toHaveText('확인: 자료 삭제');
  await expect(deletion).toContainText('입력창에서 요청을 보내면 진행해요.');
  await expect(deletion.getByRole('button')).toHaveCount(0);
  expect(state.posts).toHaveLength(0);
  await input.press('End');
  await input.pressSequentially(' 끝나면 서재 목록도 정리해 주세요.');
  await panel.getByRole('button', { name: '도우미 요청 보내기' }).click();
  await expect.poll(() => state.posts.length).toBe(1);
  expect(state.posts[0].confirmations).toEqual(['delete-bot']);
  expect(state.posts[0].text).toBe(`${confirmedText} 끝나면 서재 목록도 정리해 주세요.`);
  await expect(panel.locator('.helper-confirmation-chip')).toHaveCount(0);
});

test('HCONFIRM02 declining a held call does not hide the same call held again in a later task', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
  const chat = await create(request),
    state = await harness(page, 1);
  await page.goto(`/?chat=${chat.id}`);
  await open(page);
  const earlier = state.current().tasks[0];
  const held = (taskId: string, grantable: boolean) => ({
    id: 'same-call',
    taskId,
    operation: 'scene.request',
    reason: 'paid' as const,
    chatId: chat.id,
    targets: [{ kind: 'chat', id: chat.id }],
    grantedBy: null,
    grantable,
  });
  state.results.set(earlier.id, { confirmations: [held(earlier.id, true)] });
  await page.reload();
  const panel = await open(page);
  const cards = () => panel.locator('.helper-confirmation');
  await cards().getByRole('button', { name: '다음 장면 요청 거절', exact: true }).click();
  await expect(cards()).toHaveCount(0);
  await panel.getByLabel('도우미에게 요청').fill('다음 장면을 써 주세요');
  await panel.getByRole('button', { name: '도우미 요청 보내기' }).click();
  await expect.poll(() => state.posts.length).toBe(1);
  const later = state.current().tasks[0];
  state.results.set(earlier.id, { confirmations: [held(earlier.id, false)] });
  state.results.set(later.id, { confirmations: [held(later.id, true)] });
  await state.complete(later);
  await page.reload();
  await open(page);
  await expect(
    cards().getByRole('button', { name: '다음 장면 요청 확인', exact: true })
  ).toBeVisible();
});

test('HCONFIRM03 confirming switches plan mode off and the held card shows the grant once the next task starts', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
  const chat = await create(request),
    state = await harness(page, 1);
  await page.goto(`/?chat=${chat.id}`);
  await open(page);
  const earlier = state.current().tasks[0];
  const held = (grantedBy: string | null) => ({
    id: 'held-call',
    taskId: earlier.id,
    operation: 'scene.request',
    reason: 'paid' as const,
    chatId: chat.id,
    targets: [{ kind: 'chat', id: chat.id }],
    grantedBy,
    grantable: grantedBy === null,
  });
  state.results.set(earlier.id, {
    get confirmations() {
      const granted = state.posts.some((post) => post.confirmations?.includes('held-call'));
      const later = state.current().tasks.find((task) => task.id !== earlier.id);
      return [held(granted && later ? later.id : null)];
    },
  });
  await page.reload();
  const panel = await open(page);
  const card = panel.locator('.helper-confirmation');
  const modeChip = panel.locator('.helper-mode-chip');
  await modeChip.click();
  await expect(modeChip).toHaveAccessibleName('요청 방식: 계획만');
  await card.getByRole('button', { name: '다음 장면 요청 확인', exact: true }).click();
  await expect(modeChip).toHaveAccessibleName('요청 방식: 바로 적용');
  await expect(panel.locator('.helper-confirmation-chip')).toHaveCount(1);
  await modeChip.click();
  await expect(modeChip).toHaveAccessibleName('요청 방식: 계획만');
  await expect(panel.locator('.helper-confirmation-chip')).toHaveCount(0);
  await expect(
    card.getByRole('button', { name: '다음 장면 요청 확인', exact: true })
  ).toBeVisible();
  await card.getByRole('button', { name: '다음 장면 요청 확인', exact: true }).click();
  await expect(modeChip).toHaveAccessibleName('요청 방식: 바로 적용');
  await panel.getByRole('button', { name: '도우미 요청 보내기' }).click();
  await expect.poll(() => state.posts.length).toBe(1);
  expect(state.posts[0].confirmations).toEqual(['held-call']);
  expect(state.posts[0].mode).toBeUndefined();
  const later = state.current().tasks[0];
  expect(later.id).not.toBe(earlier.id);
  await expect(card).toHaveAttribute('data-state', 'granted');
  await expect(card).toContainText('확인해서 진행했어요.');
});

test('HELPACTIVITY observed stages retain tool errors and cancellation', async ({
  page,
  request,
}) => {
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
  const row = panel.locator(`.helper-task[data-task-id="${task.id}"]`);
  await expect(panel.getByTestId('helper-current-activity').locator('.activity-label')).toHaveText(
    '대화 내용 정리 중이에요'
  );
  await expect(row.getByTestId('helper-task-activity')).toContainText('대화 내용 정리 중이에요');
  await row.getByTestId('helper-task-activity').locator(':scope > summary').click();
  const activity = row.getByTestId('helper-activity-details');
  await expect(activity.locator('.helper-activity-stages > li')).toHaveCount(4);
  const liveToggle = panel.getByTestId('helper-current-activity').getByRole('button', {
    name: '진행 과정',
    exact: true,
  });
  await expect(liveToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(panel.locator('.helper-current-activity-details')).toHaveCount(0);
  await liveToggle.click();
  await expect(liveToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(
    panel.locator('.helper-current-activity-details .helper-activity-stages > li')
  ).toHaveCount(4);
  await expect(activity.locator('[data-state="running"]')).toContainText('대화 내용 정리');
  await expect(
    activity.getByText('resource.patch: EDITOR_SAVE_REQUIRED', { exact: true })
  ).toBeVisible();
  const reads = activity.locator('.helper-activity-stage').filter({ hasText: 'resource.read' });
  await expect(reads.locator(':scope > summary')).toContainText('2회');
  await reads.locator(':scope > summary').click();
  await expect(activity.locator('code').filter({ hasText: /^resource\.read$/u })).toBeVisible();
  await expect(activity.locator('code').filter({ hasText: /^data\.search$/u })).toBeVisible();
  await row.getByRole('button', { name: '진행 중인 도우미 작업 취소', exact: true }).click();
  await expect(row.getByTestId('helper-task-activity').locator(':scope > summary')).toContainText(
    '취소됨'
  );
  await expect(panel.getByTestId('helper-current-activity')).toHaveCount(0);
  await expect(row.getByTestId('helper-task-activity')).not.toHaveAttribute('open');
  await row.getByTestId('helper-task-activity').locator(':scope > summary').click();
  await expect(activity.locator('[data-state="running"]')).toHaveCount(0);
  await expect(
    activity.getByText('resource.patch: EDITOR_SAVE_REQUIRED', { exact: true })
  ).toBeVisible();
});

test('HELPACTIVITY-READS consecutive reads fold into one row that expands to each call', async ({
  page,
  request,
}, info) => {
  const chat = await create(request),
    state = await harness(page);
  for (const [index, [width, height, colorScheme]] of (
    [
      [1440, 900, 'light'],
      [1440, 900, 'dark'],
      [412, 915, 'light'],
    ] as const
  ).entries()) {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await page.goto(`/?chat=${chat.id}`);
    const panel = await open(page);
    if (!state.posts.length) {
      await panel.getByLabel('도우미에게 요청').fill('장면과 자료를 읽고 고쳐 주세요');
      await panel.getByRole('button', { name: '도우미 요청 보내기' }).click();
      await expect.poll(() => state.posts.length).toBe(1);
    }
    const task = state.current().tasks[0];
    const read = (seq: number, name: string, target?: HelperActivityEvent['target']) => [
      { seq, kind: 'tool.started', callId: `c${seq}`, name, ...(target ? { target } : {}) },
      { seq: seq + 1, kind: 'tool.finished', callId: `c${seq}`, name, denied: false },
    ];
    state.activity(task, [
      { seq: 1, kind: 'attempt.started', attemptId: 'helper', purpose: 'helper' },
      { seq: 2, kind: 'attempt.finished', attemptId: 'helper', status: 'tool_calls' },
      ...read(3, 'scene.read', { kind: 'scene', title: '등대의 밤' }),
      ...read(5, 'scene.read', { kind: 'scene', title: '폭풍 전야' }),
      ...read(7, 'resource.read', { kind: 'content', title: '등대지기 미라' }),
      ...read(9, 'data.search'),
      {
        seq: 11,
        kind: 'tool.started',
        callId: 'c11',
        name: 'resource.patch',
        target: { kind: 'content', title: '등대지기 미라' },
      },
    ]);
    const liveToggle = panel.getByTestId('helper-current-activity').getByRole('button', {
      name: '진행 과정',
      exact: true,
    });
    await expect(liveToggle).toHaveAttribute('aria-expanded', index ? 'true' : 'false');
    if (!index) await liveToggle.click();
    const current = panel.locator('.helper-current-activity-details');
    const group = current.locator('.helper-activity-reads');
    await expect(group).toHaveCount(1);
    const summary = group.locator(':scope > summary');
    await expect(summary).toContainText('자료 확인');
    await expect(summary).toContainText('장면 2개');
    await expect(summary).toContainText('자료 1개');
    await expect(summary).toContainText('조회 1회');
    await expect(group).not.toHaveAttribute('open');
    await expect(
      current.locator('.helper-activity-stages > li[data-state="running"]')
    ).toContainText('등대지기 미라');
    await summary.click();
    await expect(group).toHaveAttribute('open');
    const calls = group.locator('.helper-activity-read-calls > li');
    await expect(calls).toHaveCount(4);
    await expect(calls.nth(0)).toContainText('등대의 밤');
    await expect(calls.nth(3).locator('code')).toHaveText('data.search');
    await page.screenshot({
      path: info.outputPath(`grouped-reads-${width}-${colorScheme}.png`),
    });
    const bar = panel.getByTestId('helper-current-activity');
    await expect(bar.locator('.activity-label')).toHaveText(
      '자료 및 설정 변경 중이에요 (등대지기 미라)'
    );
    await expect(bar.locator('.activity-elapsed').first()).toBeVisible();
    const row = panel.getByTestId('helper-task-activity');
    await expect(row.locator('.activity-elapsed')).toHaveCount(0);
    await expect(row.locator('.turn-activity-text')).toHaveCount(0);
  }
});

test('HELPACTIVITY-FOLLOW the live list keeps the newest step in view until the reader scrolls up', async ({
  page,
  request,
}, info) => {
  const chat = await create(request),
    state = await harness(page);
  await page.goto(`/?chat=${chat.id}`);
  const panel = await open(page);
  await panel.getByLabel('도우미에게 요청').fill('자료를 차례로 고쳐 주세요');
  await panel.getByRole('button', { name: '도우미 요청 보내기' }).click();
  await expect.poll(() => state.posts.length).toBe(1);
  const task = state.current().tasks[0];
  const rounds = (count: number): HelperActivityEvent[] =>
    Array.from({ length: count }, (_, index) => [
      { seq: index * 4 + 1, kind: 'attempt.started', attemptId: `a${index}`, purpose: 'helper' },
      {
        seq: index * 4 + 2,
        kind: 'attempt.finished',
        attemptId: `a${index}`,
        status: 'tool_calls',
      },
      { seq: index * 4 + 3, kind: 'tool.started', callId: `c${index}`, name: 'resource.patch' },
      { seq: index * 4 + 4, kind: 'tool.finished', callId: `c${index}`, name: 'resource.patch' },
    ]).flat();
  const waiting = (calls: number): HelperActivityEvent[] => [
    ...rounds(calls - 1),
    { seq: calls * 4, kind: 'attempt.started', attemptId: 'now', purpose: 'helper' },
  ];
  state.activity(task, waiting(9));
  const bar = panel.getByTestId('helper-current-activity').locator('.activity-label');
  await expect(bar).toHaveText('모델의 응답을 기다리고 있어요 (9번째 호출)');
  await panel
    .getByTestId('helper-current-activity')
    .getByRole('button', { name: '진행 과정', exact: true })
    .click();
  const list = panel.locator('.helper-current-activity-details');
  const running = list.locator('.helper-activity-stages > li[data-state="running"]');
  await expect(running).toBeInViewport();
  await expect(running).toContainText('모델 호출');
  await page.screenshot({ path: info.outputPath('live-list-follows.png') });
  await list.evaluate((node) => {
    node.scrollTop = 0;
  });
  state.activity(task, [
    ...waiting(9),
    { seq: 37, kind: 'attempt.finished', attemptId: 'now', status: 'error' },
    {
      seq: 38,
      kind: 'provider.retry',
      retry: { attempt: 1, attempts: 3, delayMs: 5_000, code: 'HTTP_429' },
    },
  ]);
  await expect(bar).toHaveText('프로바이더의 요청 한도에 걸려 5초 뒤에 다시 시도해요 (1/3)');
  await expect(running).toContainText('다시 시도 대기');
  expect(await list.evaluate((node) => node.scrollTop)).toBe(0);
  await running.locator('summary').click();
  await expect(running.locator('.helper-activity-records')).toHaveText(
    '프로바이더의 요청 한도에 걸려 5초 뒤에 다시 시도해요 (1/3)'
  );
  const failed = list.locator('.helper-activity-stages > li[data-state="issue"]');
  await failed.locator('summary').click();
  await expect(failed.locator('.helper-activity-records')).toHaveText('오류로 끝났어요');
  await page.screenshot({ path: info.outputPath('retry-wait-open.png') });
});

test('HELPMENTION01 typing @ opens target suggestions, inserts a reference chip, and sends structured references', async ({
  page,
  request,
}, info) => {
  const chat = await create(request);
  const state = await harness(page);
  const referenceCandidates = [
    { kind: 'scene', id: 'scene-ref-1', chatId: chat.id, sceneNumber: 1, title: '등대의 밤' },
    { kind: 'outline', id: 'outline-ref-1', chatId: chat.id, title: '폭풍 전야' },
    { kind: 'content', id: 'bot-ref-1', role: 'bot', title: '등대지기 미라' },
  ];
  await page.route('**/api/helper/conversations/*/references*', async (route) => {
    const q = new URL(route.request().url()).searchParams.get('q')?.trim() ?? '';
    const filtered = referenceCandidates.filter(
      (item) =>
        !q || item.title.includes(q) || (item.sceneNumber && `장면 ${item.sceneNumber}`.includes(q))
    );
    await route.fulfill({ json: filtered });
  });
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
  await page.goto(`/?chat=${chat.id}`);
  const panel = await open(page);
  const input = panel.getByLabel('도우미에게 요청');
  await input.click();
  await input.type('@등대');

  const menu = panel.getByTestId('helper-mention-menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('option')).toHaveCount(2);
  await page.screenshot({ path: info.outputPath('helper-mention-menu.png') });

  await input.press('ArrowDown');
  await input.press('Enter');
  await expect(menu).toHaveCount(0);
  await expect(input).toHaveValue('@등대지기 미라 ');
  const chip = panel.getByTestId('helper-mention-chip');
  await expect(chip).toHaveCount(1);
  await expect(chip).toContainText('등대지기 미라');

  await input.type('성격을 검토해 주세요');
  await input.press('Control+Enter');
  await expect(input).toHaveValue('');
  await expect(chip).toHaveCount(0);
  expect(state.posts).toHaveLength(1);
  expect((state.posts[0] as { references?: unknown }).references).toEqual([
    { kind: 'content', id: 'bot-ref-1' },
  ]);
});

test('HELPASK01 question cards display selectable options, send the chosen reply, and settle after a later turn', async ({
  page,
  request,
}, info) => {
  const chat = await create(request);
  const state = await harness(page);
  await page.setViewportSize({ width: DESKTOP_WIDTH, height: 900 });
  await page.goto(`/?chat=${chat.id}`);
  const panel = await open(page);
  const input = panel.getByLabel('도우미에게 요청');
  await input.fill('이 장면의 문체를 고쳐 주세요');
  await input.press('Control+Enter');
  await expect(input).toHaveValue('');

  const firstTask = state.current().tasks[0]!;
  state.results.set(firstTask.id, {
    question: {
      id: 'q-1',
      question: '어떤 어조로 고칠까요?',
      allowFreeform: true,
      options: [
        { label: '담백하게', description: '문장을 간결하게 줄이고 사실을 또렷하게 써요.' },
        { label: '서정적으로', description: '분위기와 여운을 살려 다듬어요.' },
        { label: '대화 중심', description: '지문을 줄이고 대사의 리듬을 높여요.' },
      ],
    },
  });
  state.complete(firstTask);

  const card = panel.getByTestId('helper-question-card');
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('data-state', 'open');
  await expect(card).toContainText('어떤 어조로 고칠까요?');
  await expect(card).toContainText('선택지를 누르거나 아래 입력창에 직접 답을 보내세요.');
  await page.screenshot({ path: info.outputPath('helper-question-card.png') });

  await card.getByRole('button', { name: /서정적으로/ }).click();
  await expect.poll(() => state.posts.length).toBe(2);
  expect(state.posts[1]!.text).toBe('서정적으로');
  await expect(card).toHaveAttribute('data-state', 'answered');
  await expect(card).toContainText('이후 대화에서 응답했어요.');
  await expect(card.getByRole('button', { name: /담백하게/ })).toBeDisabled();
});
