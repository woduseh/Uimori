import { randomUUID } from 'node:crypto';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import type { Chat } from '../../core/types.js';
import type {
  HelperConversation,
  HelperEvent,
  HelperMessage,
  HelperMessageMutation,
  HelperScope,
  HelperRollbackUnit,
  HelperRollbackView,
  HelperTaskResultsView,
} from '../../core/helper.js';
import type { ResponseStreamPage } from '../../core/response-stream.js';
import type { HelperTaskView } from '../../web/useHelperConversation.js';
import { postFixtureChat } from './chat.js';
import { openHelper } from '../ui-navigation.js';

const usage = { modelCalls: 1, inputTokens: 10, outputTokens: 10, costUsd: null };
type Conversation = HelperConversation & { title: string };
type View = {
  conversation: Conversation;
  messages: HelperMessage[];
  tasks: HelperTaskView[];
  events: HelperEvent[];
};

export async function routeSyntheticHelper(page: Page, seedCount = 0) {
  const views = new Map<string, View>();
  const receipts = new Map<string, HelperTaskView>();
  const streams = new Map<string, ResponseStreamPage>();
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
  const streamHolds = new Map<string, Promise<void>>();
  const heldStreams = new Set<string>();
  let nextSeq = 0,
    loseNext = false;
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
  await page.route('**/api/response-streams/helper/**', async (route) => {
    const url = new URL(route.request().url()),
      taskId = url.pathname.split('/')[4];
    if (url.pathname.endsWith('/events'))
      return route.fulfill({ status: 400, json: { error: 'UI must use cursor HTTP batches' } });
    const after = Number(url.searchParams.get('after') ?? 0);
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
  });
  await page.route('**/api/helper/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    const body = request.method() === 'GET' ? null : request.postDataJSON();
    if (path === '/api/helper/conversations' && request.method() === 'GET') {
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
            events: [],
            hasEarlier: false,
            helperCalls: 0,
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
    results,
    rollbacks,
    rollbackPosts,
    onRollback(handler: (units: HelperRollbackUnit[]) => Promise<void>) {
      onRollback = handler;
    },
    loseRollback: () => {
      loseRollback = true;
    },
    heldStreams,
    holdNextStream(taskId: string) {
      let release = () => {};
      streamHolds.set(taskId, new Promise<void>((resolve) => (release = resolve)));
      return release;
    },
    loseNext: () => {
      loseNext = true;
    },
    current: () => [...views.values()].at(-1)!,
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
export async function createHelperChat(request: APIRequestContext) {
  const response = await postFixtureChat(request, {
    data: { title: `도우미 합성 ${randomUUID()}` },
  });
  expect(response.ok()).toBe(true);
  return response.json() as Promise<Chat>;
}
export async function openHelperPanel(page: Page) {
  await openHelper(page);
  const panel = page.locator('#helper-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByLabel('도우미에게 요청')).toBeEnabled();
  await expect(panel.getByText('대화를 불러오는 중이에요…', { exact: true })).toHaveCount(0);
  return panel;
}
