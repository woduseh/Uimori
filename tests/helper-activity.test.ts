import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { HelperActivity } from '../core/helper-activity.js';
import { readHelperActivity } from '../server/helper-activity.js';
import { HelperWorkspace } from '../server/helper-workspace.js';
import { releaseCompletedHelperInputs } from '../server/execution-retention.js';
import { Store } from '../server/store.js';
import { helperActivityStages, helperActivitySummary } from '../web/helper-activity.js';
import { createTestDirectory } from './fixtures/test-directory.js';
import { fixtureBotInput } from './fixtures/chat.js';
import type { Content } from '../core/product.js';

function activityTask(workId: string) {
  const directory = createTestDirectory('uimori-helper-activity-');
  const store = new Store(join(directory.directory, 'app.sqlite'));
  const workspace = new HelperWorkspace(store);
  const conversation = workspace.open({ kind: 'library', workId });
  const connection = store.product.connection({
    title: 'Synthetic activity',
    protocol: 'fixture-sse-v1',
    endpoint: 'http://127.0.0.1:9',
    enabled: true,
  });
  const model = store.product.model({
    title: 'Synthetic activity',
    connectionId: connection.id,
    modelId: 'fixture-helper',
    temperature: null,
    maxOutputTokens: 1024,
  });
  const task = workspace.enqueue(conversation.id, 'activity', '자료 확인', {
    scope: conversation.scope,
    model: store.product.modelSnapshot(model.id),
    history: [],
    persona: '',
    limits: { totalCalls: 24, helperCalls: 12 },
  });
  return {
    store,
    workspace,
    conversation,
    task,
    close() {
      store.close();
      directory.remove();
    },
  };
}

test('helper activity projects bounded diagnostics and keeps denied tools visible after retention', () => {
  const { store, workspace, conversation, task, close } = activityTask('activity-test');
  try {
    workspace.event(conversation.id, task.id, 'attempt.started', {
      id: 'native',
      purpose: 'helper',
    });
    for (let index = 0; index < 81; index++)
      workspace.event(conversation.id, task.id, 'tool.finished', {
        name: 'resource.read',
        denied: false,
        result: { manuscript: 'PRIVATE_RESULT_BODY' },
      });
    workspace.event(conversation.id, task.id, 'tool.finished', {
      name: 'data.exec',
      denied: false,
      status: 'failed',
      result: { exitCode: 7, output: 'PRIVATE_SHELL_OUTPUT' },
    });
    workspace.event(conversation.id, task.id, 'tool.finished', {
      name: 'resource.patch',
      denied: true,
      errorKind: 'recoverable',
      errorCode: 'EDITOR_SAVE_REQUIRED',
      result: { code: 'EDITOR_SAVE_REQUIRED', model: 'PRIVATE_DRAFT' },
    });
    workspace.event(conversation.id, task.id, 'progress', { text: '가'.repeat(1005) });
    const activity = readHelperActivity(store, task.id);
    expect(activity.events).toHaveLength(80);
    expect(activity.hasEarlier).toBe(true);
    expect(activity.events.at(-2)).toMatchObject({
      name: 'resource.patch',
      denied: true,
      error: 'EDITOR_SAVE_REQUIRED',
    });
    expect(
      helperActivityStages(activity).find((stage) => stage.events[0].name === 'data.exec')
    ).toMatchObject({ state: 'issue', events: [{ denied: false, status: 'failed' }] });
    expect(activity.events.at(-1)).toMatchObject({ text: '가'.repeat(1000), textTruncated: true });
    expect(JSON.stringify(activity)).not.toContain('PRIVATE_');
    expect(activity.events[0].seq).toBeLessThan(activity.events.at(-1)!.seq);
    expect(() => readHelperActivity(store, 'missing')).toThrow('도우미 작업을 찾을 수 없어요.');

    store.db.prepare("UPDATE helper_tasks SET status='completed' WHERE id=?").run(task.id);
    releaseCompletedHelperInputs(store.db, task.id);
    const retained = readHelperActivity(store, task.id);
    expect(retained.status).toBe('completed');
    expect(
      helperActivityStages(retained).find((stage) => stage.events[0].name === 'data.exec')
    ).toMatchObject({ state: 'issue', events: [{ denied: false, status: 'failed' }] });
    expect(retained.events.at(-2)).toMatchObject({
      name: 'resource.patch',
      denied: true,
      error: 'EDITOR_SAVE_REQUIRED',
    });
    workspace.event(conversation.id, task.id, 'attempt.finished', {
      id: 'native',
      status: 'error',
    });
    const truncated = readHelperActivity(store, task.id);
    expect(truncated.events).toHaveLength(80);
    expect(truncated.events.some((event) => event.kind === 'attempt.started')).toBe(false);
    expect(helperActivityStages(truncated).at(-1)).toMatchObject({
      state: 'issue',
      events: [{ kind: 'attempt.finished', status: 'error' }],
    });
  } finally {
    close();
  }
});

test('helper stages keep each call apart and report observed progress', () => {
  const activity: HelperActivity = {
    taskId: 'task',
    status: 'running',
    hasEarlier: false,
    helperCalls: 1,
    events: [
      { seq: 1, kind: 'attempt.started', attemptId: 'first', purpose: 'helper' },
      { seq: 2, kind: 'attempt.finished', attemptId: 'first', status: 'tool_calls' },
      { seq: 3, kind: 'tool.finished', name: 'resource.read', denied: false },
      { seq: 4, kind: 'tool.finished', name: 'data.search', denied: false },
      { seq: 5, kind: 'tool.finished', name: 'resource.patch' },
      { seq: 6, kind: 'tool.finished', name: 'resource.patch' },
      { seq: 7, kind: 'tool.finished', name: 'resource.patch', denied: true, error: 'CONFLICT' },
      { seq: 8, kind: 'attempt.started', attemptId: 'context', purpose: 'context' },
    ],
  };
  const stages = helperActivityStages(activity);
  expect(stages.flatMap((stage) => stage.events)).toEqual(activity.events);
  expect(stages).toMatchObject([
    { state: 'completed', events: [{ seq: 1 }, { seq: 2 }] },
    { state: 'completed', events: [{ seq: 3 }] },
    { state: 'completed', events: [{ seq: 4 }] },
    { state: 'completed', events: [{ seq: 5 }] },
    { state: 'completed', events: [{ seq: 6 }] },
    { state: 'issue', events: [{ error: 'CONFLICT' }] },
    { state: 'running' },
  ]);
  expect(helperActivitySummary(activity)).toBe('대화 내용 정리 중이에요');
  expect(
    helperActivitySummary({ ...activity, events: activity.events.slice(0, -1) })
  ).toBeUndefined();
  for (const status of ['cancelled', 'failed', 'completed'] as const) {
    const settled = { ...activity, status };
    expect(helperActivitySummary(settled)).toBeUndefined();
    expect(helperActivityStages(settled).some((stage) => stage.state === 'running')).toBe(false);
    expect(helperActivityStages(settled).find((stage) => stage.state === 'issue')).toBeDefined();
  }
});

test('live tool starts carry a resolved target and never the argument preview, before or after retention', () => {
  const { store, workspace, conversation, task, close } = activityTask('activity-target');
  try {
    const bot = store.product.content(fixtureBotInput('등대지기 미라')) as Content;
    const started = (callId: string, name: string, target: unknown) =>
      workspace.event(conversation.id, task.id, 'tool.started', {
        callId,
        name,
        target,
        argsPreview: `PRIVATE_ARGS_${callId}`,
      });
    started('read', 'resource.read', { kind: 'content', id: bot.id });
    workspace.event(conversation.id, task.id, 'tool.finished', {
      callId: 'read',
      name: 'resource.read',
      denied: false,
      result: { text: 'PRIVATE_RESULT' },
    });
    started('scene', 'scene.patch', { kind: 'scene', id: 'deleted-scene' });
    started('many', 'resource.patchMany', { count: 3 });
    const live = readHelperActivity(store, task.id);
    expect(live.events.find((event) => event.callId === 'read')).toMatchObject({
      kind: 'tool.started',
      target: { kind: 'content', title: '등대지기 미라' },
    });
    expect(
      live.events.find((event) => event.callId === 'scene' && event.kind === 'tool.started')?.target
    ).toBeUndefined();
    expect(JSON.stringify(live)).not.toContain('PRIVATE_');
    expect(helperActivityStages(live)).toMatchObject([
      {
        label: '자료 확인',
        target: '등대지기 미라',
        state: 'completed',
        events: [{ kind: 'tool.finished' }],
      },
      { label: '장면 수정', target: undefined, state: 'running' },
      { label: '자료 및 설정 변경', target: '대상 3개', state: 'running' },
    ]);

    store.db.prepare("UPDATE helper_tasks SET status='completed' WHERE id=?").run(task.id);
    releaseCompletedHelperInputs(store.db, task.id);
    const finished = readHelperActivity(store, task.id);
    expect(JSON.stringify(finished)).not.toContain('PRIVATE_');
    expect(finished.events.every((event) => !('argsPreview' in event))).toBe(true);
    expect(helperActivityStages(finished)).toMatchObject([
      { target: '등대지기 미라', state: 'completed' },
      { state: 'stopped' },
      { state: 'stopped' },
    ]);
  } finally {
    close();
  }
});

test('activity counts helper calls beyond the event window and projects a retry wait without an error', () => {
  const { store, workspace, conversation, task, close } = activityTask('activity-retry');
  try {
    for (let index = 0; index < 45; index++) {
      workspace.event(conversation.id, task.id, 'attempt.started', {
        id: `call-${index}`,
        purpose: 'helper',
      });
      workspace.event(conversation.id, task.id, 'attempt.finished', {
        id: `call-${index}`,
        status: 'tool_calls',
      });
    }
    workspace.event(conversation.id, task.id, 'attempt.started', {
      id: 'summary',
      purpose: 'context',
    });
    workspace.event(conversation.id, task.id, 'provider.retry', {
      attempt: 1,
      attempts: 3,
      delayMs: 5_000,
      code: 'HTTP_429',
    });
    const activity = readHelperActivity(store, task.id);
    expect(activity.hasEarlier).toBe(true);
    expect(activity.helperCalls).toBe(45);
    const wait = activity.events.at(-1)!;
    expect(wait).toMatchObject({
      kind: 'provider.retry',
      retry: { attempt: 1, attempts: 3, delayMs: 5_000, code: 'HTTP_429' },
    });
    expect(wait.error).toBeUndefined();
  } finally {
    close();
  }
});
