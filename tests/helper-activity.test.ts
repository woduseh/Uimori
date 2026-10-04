import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { HelperActivity } from '../core/helper-activity.js';
import { readHelperActivity } from '../server/helper-activity.js';
import { HelperWorkspace } from '../server/helper-workspace.js';
import { releaseCompletedHelperInputs } from '../server/execution-retention.js';
import { Store } from '../server/store.js';
import { helperActivityStages, helperActivitySummary } from '../web/helper-activity.js';
import { createTestDirectory } from './fixtures/test-directory.js';

test('helper activity projects bounded diagnostics and keeps denied tools visible after retention', () => {
  const directory = createTestDirectory('uimori-helper-activity-');
  const store = new Store(join(directory.directory, 'app.sqlite'));
  try {
    const workspace = new HelperWorkspace(store);
    const conversation = workspace.open({ kind: 'library', workId: 'activity-test' });
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
      limits: { totalCalls: 24, helperCalls: 12, artifacts: 1 },
    });
    for (let index = 0; index < 81; index++)
      workspace.event(conversation.id, task.id, 'tool.finished', {
        name: 'resource.read',
        denied: false,
        result: { manuscript: 'PRIVATE_RESULT_BODY' },
      });
    workspace.event(conversation.id, task.id, 'tool.finished', {
      name: 'resource.patch',
      denied: true,
      errorKind: 'recoverable',
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
    expect(activity.events.at(-1)).toMatchObject({ text: '가'.repeat(1000), textTruncated: true });
    expect(JSON.stringify(activity)).not.toContain('PRIVATE_');
    expect(activity.events[0].seq).toBeLessThan(activity.events.at(-1)!.seq);
    expect(() => readHelperActivity(store, 'missing')).toThrow('도우미 작업을 찾을 수 없어요.');

    store.db.prepare("UPDATE helper_tasks SET status='completed' WHERE id=?").run(task.id);
    releaseCompletedHelperInputs(store.db, task.id);
    const retained = readHelperActivity(store, task.id);
    expect(retained.status).toBe('completed');
    expect(retained.events.at(-2)).toMatchObject({
      name: 'resource.patch',
      denied: true,
      error: 'recoverable',
    });
    expect(helperActivityStages(retained).find((stage) => stage.state === 'issue')).toMatchObject({
      label: '자료·설정 변경',
    });
  } finally {
    store.close();
    directory.remove();
  }
});

test('helper stages group observed reads and keep failed edits separate without inventing progress', () => {
  const activity: HelperActivity = {
    taskId: 'task',
    status: 'running',
    hasEarlier: false,
    events: [
      { seq: 1, kind: 'attempt.started', attemptId: 'first', purpose: 'helper' },
      { seq: 2, kind: 'attempt.finished', attemptId: 'first', status: 'tool_calls' },
      { seq: 3, kind: 'tool.finished', name: 'resource.read', denied: false },
      { seq: 4, kind: 'tool.finished', name: 'data.search', denied: false },
      { seq: 5, kind: 'tool.finished', name: 'resource.patch', denied: true, error: 'CONFLICT' },
      { seq: 6, kind: 'attempt.started', attemptId: 'context', purpose: 'context' },
    ],
  };
  expect(helperActivityStages(activity)).toMatchObject([
    { label: '요청 처리', state: 'completed', events: [{ seq: 1 }, { seq: 2 }] },
    { label: '자료 확인', state: 'completed', events: [{ seq: 3 }, { seq: 4 }] },
    { label: '자료·설정 변경', state: 'issue', events: [{ error: 'CONFLICT' }] },
    { label: '대화 내용 정리', state: 'running' },
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
