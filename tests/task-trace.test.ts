import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { sumTraceCosts, traceCallKind } from '../core/task-trace.js';
import type { ProviderResult, WireRecord } from '../core/transport.js';
import type { HelperActivity } from '../core/helper-activity.js';
import {
  releaseCompletedJobInputs,
  releaseCompletedRunInputs,
} from '../server/execution-retention.js';
import { HELPER_APP_TOOLS, HELPER_GATEWAY_TOOLS } from '../server/helper-app-tools.js';
import { HELPER_SHELL_TOOL } from '../server/helper-data-tools.js';
import { GEMINI_HELPER_SEARCH_TOOL } from '../server/helper-web-search-tool.js';
import { HelperWorkspace } from '../server/helper-workspace.js';
import { readerRuns } from '../server/reader.js';
import { Store } from '../server/store.js';
import { chatTraceCalls, helperTaskCosts, helperTraceCalls } from '../server/task-trace.js';
import { helperActivityStages, helperToolKind } from '../web/helper-activity.js';
import { createFixtureChat } from './fixtures/chat.js';
import { completedSource } from './fixtures/illustration.js';
import { createTestDirectory } from './fixtures/test-directory.js';

const wire = (role: string, extra: Partial<WireRecord> = {}) =>
  ({
    role,
    connectionId: 'synthetic',
    modelId: `${role}-model`,
    protocol: 'anthropic-messages-v1',
    ...extra,
  }) as WireRecord;

const result = (
  status: ProviderResult['status'],
  usage: { input: number; output: number; raw?: unknown; costUsd?: number | null }
): ProviderResult => ({
  status,
  text: '',
  toolCalls: [],
  refusal: null,
  error: null,
  opaqueState: null,
  usage: {
    inputTokens: usage.input,
    outputTokens: usage.output,
    costUsd: usage.costUsd ?? null,
    raw: (usage.raw ?? null) as never,
    priceRevision: null,
  },
  timing: { firstByteMs: 420 },
});

function fixture() {
  const directory = createTestDirectory('uimori-task-trace-');
  const store = new Store(join(directory.directory, 'app.sqlite'));
  return {
    store,
    close() {
      store.close();
      directory.remove();
    },
  };
}

function attempt(
  store: Store,
  chatId: string,
  owner: { runId?: string; jobId?: string },
  request: WireRecord,
  outcome: ProviderResult,
  estimate: { usd: number | null; startedAt: string }
) {
  const id = store.product.startAttempt(chatId, owner.runId ?? null, owner.jobId ?? null, request);
  store.product.finishAttempt(id, outcome);
  store.db
    .prepare(
      "UPDATE attempts SET started_at=?,estimated_usd=?,estimated_subtotal_usd=?,estimate_status=CASE WHEN ? IS NULL THEN 'unavailable' ELSE 'estimated' END WHERE id=?"
    )
    .run(estimate.startedAt, estimate.usd, estimate.usd ?? 0, estimate.usd, id);
  return id;
}

function translationJob(store: Store, chatId: string, sourceId: string) {
  const id = randomUUID();
  const time = new Date().toISOString();
  store.db
    .prepare(
      "INSERT INTO jobs(id,chat_id,source_revision,source_hash,kind,status,revision,input,created_at,updated_at) VALUES(?,?,?,?,'translation','completed',?,'{}',?,?)"
    )
    .run(id, chatId, sourceId, store.source(sourceId).hash, Date.now(), time, time);
  return id;
}

function sceneWithCalls(store: Store) {
  const chat = createFixtureChat(store, 'Synthetic trace chat');
  const parent = completedSource(store, chat.id);
  const current = store.chat(chat.id);
  const request = 'Synthetic traced scene';
  const run = store.createRun(
    chat.id,
    {
      request,
      expectedRevision: current.headRevision,
      expectedSettingsRevision: current.settingsRevision,
      idempotencyKey: randomUUID(),
    },
    (selected) => ({
      chatId: chat.id,
      parentRevision: selected.headRevision,
      settingsRevision: selected.settingsRevision,
      settings: selected.settings,
      request,
      history: store.history(selected.headRevision),
      profile: store.product.snapshot(chat.id),
      resources: store.product.resources(chat.id, store.product.snapshot(chat.id)),
    })
  ).run;
  store.startRun(run.id);
  const inputTranslation = attempt(
    store,
    chat.id,
    {},
    wire('translation'),
    result('completed', { input: 300, output: 40 }),
    { usd: 0.0001, startedAt: '2026-11-25T09:59:00.000Z' }
  );
  store.db
    .prepare("UPDATE attempts SET usage_kind='input-translation' WHERE id=?")
    .run(inputTranslation);
  const first = attempt(
    store,
    chat.id,
    { runId: run.id },
    wire('main'),
    result('tool_calls', {
      input: 20_000,
      output: 300,
      raw: { input_tokens: 8000, cache_read_input_tokens: 12_000, output_tokens: 300 },
    }),
    { usd: 0.12, startedAt: '2026-11-25T10:00:00.000Z' }
  );
  store.db.prepare('INSERT INTO execution_tool_diagnostics(run_id,origin,data) VALUES(?,?,?)').run(
    run.id,
    'writer',
    JSON.stringify({
      state: 'finished',
      name: 'knowledge.read',
      providedResultChars: 11_023,
      elapsedMs: 60,
      denied: false,
      startedAt: '2026-11-25T10:00:05.000Z',
      finishedAt: '2026-11-25T10:00:05.060Z',
    })
  );
  const second = attempt(
    store,
    chat.id,
    { runId: run.id },
    wire('main'),
    result('completed', { input: 31_000, output: 2_400 }),
    { usd: 0.2, startedAt: '2026-11-25T10:00:06.000Z' }
  );
  const judgment = attempt(
    store,
    chat.id,
    { runId: run.id },
    wire('main', { judgment: { kind: 'main-refusal', inputHash: 'synthetic' } }),
    result('completed', { input: 900, output: 4 }),
    { usd: 0.0007, startedAt: '2026-11-25T10:00:40.000Z' }
  );
  const title = attempt(
    store,
    chat.id,
    { runId: run.id },
    wire('title'),
    result('completed', { input: 400, output: 12 }),
    { usd: 0.0002, startedAt: '2026-11-25T10:00:41.000Z' }
  );
  const source = store.completeRun(run.id, 'A lantern dimmed over the harbor.', {
    modelCalls: 4,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
  });
  const sceneJob = translationJob(store, chat.id, source.id);
  const translation = attempt(
    store,
    chat.id,
    { jobId: sceneJob },
    wire('translation'),
    result('completed', { input: 4_000, output: 3_900 }),
    { usd: 0.03, startedAt: '2026-11-25T10:01:00.000Z' }
  );
  const translationCheck = attempt(
    store,
    chat.id,
    { jobId: sceneJob },
    wire('translation', { judgment: { kind: 'translation-refusal', inputHash: 'synthetic' } }),
    result('completed', { input: 1_200, output: 3 }),
    { usd: null, startedAt: '2026-11-25T10:01:30.000Z' }
  );
  const parentJob = translationJob(store, chat.id, parent.id);
  const parentTranslation = attempt(
    store,
    chat.id,
    { jobId: parentJob },
    wire('translation'),
    result('completed', { input: 3_000, output: 2_900 }),
    { usd: 0.02, startedAt: '2026-11-25T09:58:00.000Z' }
  );
  releaseCompletedRunInputs(store.db, run.id);
  releaseCompletedJobInputs(store.db, sceneJob);
  return {
    chat,
    run,
    parent,
    ids: {
      inputTranslation,
      first,
      second,
      judgment,
      title,
      translation,
      translationCheck,
      parentTranslation,
    },
  };
}

test('a scene record holds its run calls and the jobs of the revision it produced, after release', () => {
  const { store, close } = fixture();
  try {
    const { chat, run, parent, ids } = sceneWithCalls(store);
    const calls = chatTraceCalls(store, chat.id);
    const scene = calls.filter((call) => call.sceneRunId === run.id);
    expect(scene.map((call) => [call.id, call.kind, call.owner])).toEqual([
      [ids.first, 'writing', 'run'],
      [ids.second, 'writing', 'run'],
      [ids.judgment, 'refusal-judgment', 'run'],
      [ids.title, 'chat-title', 'run'],
      [ids.translation, 'scene-translation', 'job'],
      [ids.translationCheck, 'translation-judgment', 'job'],
    ]);
    const byId = new Map(calls.map((call) => [call.id, call]));
    expect(byId.get(ids.first)).toMatchObject({
      status: 'tool_calls',
      cachedInputTokens: 12_000,
      firstByteMs: 420,
      tools: [{ name: 'knowledge.read', resultChars: 11_023, elapsedMs: 60, failed: false }],
    });
    expect(byId.get(ids.first)?.elapsedMs).toEqual(expect.any(Number));
    expect(byId.get(ids.second)?.tools).toEqual([]);
    expect(byId.get(ids.parentTranslation)?.sceneRunId).toBe(parent.runId);
    expect(byId.get(ids.inputTranslation)).toMatchObject({
      kind: 'input-translation',
      owner: 'chat',
      sceneRunId: null,
    });
    const released = store.db
      .prepare('SELECT request FROM attempts WHERE id=?')
      .get(ids.judgment) as { request: string };
    expect(JSON.parse(released.request)).toMatchObject({
      detailsOmitted: true,
      judgment: { kind: 'main-refusal' },
    });
  } finally {
    close();
  }
});

test('the scene summary is the sum of its rows and the text cost keeps the run calls without the title', () => {
  const { store, close } = fixture();
  try {
    const { chat, run, ids } = sceneWithCalls(store);
    const listed = readerRuns(store, chat.id).find((item) => item.id === run.id)!;
    const rows = chatTraceCalls(store, chat.id).filter((call) => call.sceneRunId === run.id);
    expect(listed.sceneCost).toEqual(sumTraceCosts(rows));
    expect(listed.sceneCost).toMatchObject({ usd: null, unknownCount: 1, attemptCount: 6 });
    expect(listed.sceneCost?.subtotalUsd).toBeCloseTo(0.12 + 0.2 + 0.0007 + 0.0002 + 0.03, 10);
    expect(listed.estimatedCost).toMatchObject({ unknownCount: 0, attemptCount: 3 });
    expect(listed.estimatedCost?.usd).toBeCloseTo(0.12 + 0.2 + 0.0007, 10);
    expect(rows.some((row) => row.id === ids.title)).toBe(true);
  } finally {
    close();
  }
});

test('stored fields classify each call, and a released judgment without its kind stays generic', () => {
  const kind = (usageKind: string | null, role: string, judgmentKind: string | null = null) =>
    traceCallKind({ usageKind, role, judgmentKind, diagnosticPurpose: null });
  expect(kind('judgment', 'main', 'main-refusal')).toBe('refusal-judgment');
  expect(kind('judgment', 'main', 'lore-selection')).toBe('lore-selection');
  expect(kind('judgment', 'translation', 'translation-refusal')).toBe('translation-judgment');
  expect(kind('judgment', 'image', 'image-selection')).toBe('image-judgment');
  expect(kind('judgment', 'main')).toBe('judgment');
  expect(
    traceCallKind({
      usageKind: 'judgment',
      role: 'translation',
      judgmentKind: null,
      diagnosticPurpose: 'codex-content-preflight',
    })
  ).toBe('content-precheck');
  expect(kind('image', 'illustration')).toBe('illustration');
  expect(kind('image', 'image')).toBe('image-placement');
  expect(kind('input-translation', 'translation')).toBe('input-translation');
  expect(kind('unclassified', 'title')).toBe('chat-title');
  expect(kind('unclassified', 'unknown-role')).toBe('other');
});

test('a helper task prices each call by its reported cost before its estimate', () => {
  const { store, close } = fixture();
  try {
    const workspace = new HelperWorkspace(store);
    const conversation = workspace.open({ kind: 'library', workId: 'trace-cost' });
    const connection = store.product.connection({
      title: 'Synthetic trace',
      protocol: 'fixture-sse-v1',
      endpoint: 'http://127.0.0.1:9',
      enabled: true,
    });
    const model = store.product.model({
      title: 'Synthetic trace',
      connectionId: connection.id,
      modelId: 'fixture-helper',
      temperature: null,
      maxOutputTokens: 1024,
    });
    const task = workspace.enqueue(conversation.id, 'trace-cost', '단가 갱신', {
      scope: conversation.scope,
      model: store.product.modelSnapshot(model.id),
      history: [],
      persona: '',
      limits: { totalCalls: 24, helperCalls: 12 },
    });
    const call = (costUsd: number | null, usd: number | null, startedAt: string) => {
      const id = attempt(
        store,
        null as never,
        {},
        wire('helper'),
        result('completed', { input: 100, output: 10, costUsd }),
        { usd, startedAt }
      );
      store.db
        .prepare(
          "INSERT INTO helper_task_attempts(task_id,attempt_id,purpose,segment) VALUES(?,?,'helper',0)"
        )
        .run(task.id, id);
      return id;
    };
    const first = call(0.01, 0.5, '2026-11-25T10:00:00.000Z');
    call(null, 0.002, '2026-11-25T10:00:02.000Z');
    workspace.event(conversation.id, task.id, 'attempt.started', { id: first, purpose: 'helper' });
    workspace.event(conversation.id, task.id, 'tool.finished', {
      name: 'model.pricing.update',
      providedResultChars: 240,
      elapsedMs: 35,
      denied: false,
    });
    const costs = helperTaskCosts(store, [task.id]).get(task.id)!;
    expect(costs).toMatchObject({ unknownCount: 0, attemptCount: 2 });
    expect(costs.usd).toBeCloseTo(0.012, 10);
    expect(helperTraceCalls(store, task.id)[0].tools).toEqual([
      { name: 'model.pricing.update', resultChars: 240, elapsedMs: 35, failed: false },
    ]);
    expect(workspace.taskSummary(task.id)?.estimatedCost).toEqual(costs);
  } finally {
    close();
  }
});

test('every registered helper tool names a step kind instead of the generic fallback', () => {
  const names = [
    ...HELPER_APP_TOOLS,
    ...HELPER_GATEWAY_TOOLS,
    HELPER_SHELL_TOOL,
    GEMINI_HELPER_SEARCH_TOOL,
  ].map((tool) => tool.name);
  expect(names.filter((name) => !helperToolKind(name))).toEqual([]);
});

test('the helper timeline numbers model calls and names the tool that ran', () => {
  const activity: HelperActivity = {
    taskId: 'task',
    status: 'completed',
    hasEarlier: false,
    helperCalls: 2,
    events: [
      { seq: 1, kind: 'attempt.started', attemptId: 'a', purpose: 'helper' },
      { seq: 2, kind: 'attempt.finished', attemptId: 'a', status: 'tool_calls', elapsedMs: 1800 },
      { seq: 3, kind: 'tool.started', name: 'model.pricing.update', callId: 'c1' },
      {
        seq: 4,
        kind: 'tool.finished',
        name: 'model.pricing.update',
        callId: 'c1',
        elapsedMs: 35,
        resultChars: 240,
      },
      { seq: 5, kind: 'tool.finished', name: 'future.tool', callId: 'c2' },
      { seq: 6, kind: 'attempt.started', attemptId: 'b', purpose: 'helper' },
      { seq: 7, kind: 'attempt.finished', attemptId: 'b', status: 'completed' },
    ],
  };
  const stages = helperActivityStages(activity);
  expect(stages.map((stage) => stage.label)).toEqual([
    '모델 호출 1',
    '모델 설정 변경',
    'future.tool',
    '모델 호출 2',
  ]);
  expect(stages[0]).toMatchObject({ call: 1, elapsedMs: 1800, state: 'completed' });
  expect(stages[1]).toMatchObject({
    tool: 'model.pricing.update',
    elapsedMs: 35,
    resultChars: 240,
  });
});
