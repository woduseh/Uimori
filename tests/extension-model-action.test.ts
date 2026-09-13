import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, type Run } from '../server/store.js';
import { createFixtureChat } from './fixtures/chat.js';
import type { ContentPackage } from '../core/content-package.js';
import type { Content, Connection, ModelPreset } from '../core/product.js';
import type { RunSnapshot } from '../core/types.js';
import { EXTENSION_PROGRAM_API } from '../core/extension-program.js';
import { behaviorPayloadHash } from '../server/package-behavior-store.js';
import { behaviorDetail } from '../server/package-behavior-host.js';
import { executeRunBehaviorTool, runBehaviorProgress } from '../server/package-behavior-run.js';
import { listBehaviorTools } from '../core/package-behavior-tools.js';
import { forkChat } from '../server/chat-fork.js';
import { exportChatBackup, importChatBackup } from '../server/chat-backup.js';
import * as extensionRuntime from '../server/extension-runtime.js';
import { runMain } from '../server/model-runner.js';
import { updateTestProfile } from './fixtures/model-workspace.js';
import { loopbackProvider, writeSse } from './fixtures/loopback-provider.js';

const owned: { store: Store; dir: string }[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const { store, dir } of owned.splice(0).reverse()) {
    store.close();
    const inside = relative(resolve(tmpdir()), resolve(dir));
    if (
      isAbsolute(inside) ||
      inside.startsWith('..') ||
      !inside.startsWith('uimori-extension-model-')
    )
      throw new Error('Unsafe test cleanup');
    rmSync(dir, { recursive: true, force: true });
  }
});

function database() {
  const dir = mkdtempSync(join(tmpdir(), 'uimori-extension-model-'));
  const store = new Store(join(dir, 'test.sqlite'));
  owned.push({ store, dir });
  return store;
}

function definition(): ContentPackage {
  return {
    version: 1,
    id: 'extension-model-fixture',
    revision: 1,
    title: 'Synthetic model extension',
    description: 'Isolated model action fixture',
    body: 'Synthetic only.',
    lore: [],
    controls: [],
    transforms: [],
    instructions: [],
    behavior: {
      revision: 1,
      schemaVersion: 1,
      mode: 'authoritative',
      stateSchema: {
        type: 'record',
        properties: { count: { type: 'number', min: 0, max: 10_000, integer: true } },
      },
      initialState: { count: 0 },
      actions: [
        {
          id: 'compute',
          triggers: ['model'],
          inputSchema: {
            type: 'record',
            properties: { amount: { type: 'number', min: 1, max: 100, integer: true } },
          },
          effects: [],
          program: {
            api: EXTENSION_PROGRAM_API,
            source:
              "let delta = 0; for (let step = 1; step <= api.input.amount; step++) delta += step; return {state: {count: api.state.count + delta}, result: {applied: true, delta, scope: Object.keys(api).sort().join(',')}};",
          },
        },
        {
          id: 'guest-throws',
          triggers: ['model'],
          inputSchema: { type: 'record', properties: {} },
          effects: [],
          program: {
            api: EXTENSION_PROGRAM_API,
            source: 'throw new Error("PRIVATE_MODEL_GUEST_TEXT");',
          },
        },
        {
          id: 'ordinary',
          triggers: ['model'],
          inputSchema: {
            type: 'record',
            properties: { amount: { type: 'number', min: 1, max: 100, integer: true } },
          },
          effects: [
            {
              path: ['count'],
              value: {
                op: 'add',
                args: [{ context: ['state', 'count'] }, { context: ['input', 'amount'] }],
              },
            },
          ],
          result: { context: ['nextState', 'count'] },
        },
      ],
      outputParsers: [],
    },
  };
}

function fixture() {
  const store = database();
  const pkg = definition();
  const content = store.product.content({
    kind: 'bot',
    title: pkg.title,
    description: pkg.description,
    text: pkg.body,
    loading: 'pinned',
    relatedIds: [],
    package: pkg,
  }) as Content;
  const chat = createFixtureChat(store, 'Synthetic model extension', 'calm', {
    botId: content.id,
  });
  return {
    store,
    pkg,
    content,
    chat,
    instanceId: `${content.id}:bot`,
    branchId: `main:${chat.id}`,
  };
}

type Fixture = ReturnType<typeof fixture>;

function admit(f: Fixture) {
  const chat = f.store.chat(f.chat.id);
  const profile = f.store.product.snapshot(chat.id);
  const snapshot: RunSnapshot = {
    chatId: chat.id,
    branchId: f.branchId,
    parentRevision: chat.headRevision,
    settingsRevision: chat.settingsRevision,
    settings: chat.settings,
    request: 'Write the next synthetic scene.',
    history: f.store.history(chat.headRevision),
    profile,
    resources: f.store.product.resources(chat.id, profile),
  };
  return f.store.createRun(
    chat.id,
    {
      request: snapshot.request,
      expectedRevision: snapshot.parentRevision,
      expectedSettingsRevision: snapshot.settingsRevision,
      branchId: f.branchId,
      idempotencyKey: randomUUID(),
    },
    () => snapshot
  ).run;
}

function start(f: Fixture, run = admit(f)) {
  expect(f.store.startRun(run.id)).toBe(true);
  return f.store.run(run.id);
}

function binding(run: Run, actionId: string) {
  return listBehaviorTools(run.snapshot).find((item) => item.actionId === actionId)!;
}

function invoke(
  f: Fixture,
  run: Run,
  actionId: string,
  args: Record<string, unknown>,
  callId: string = randomUUID(),
  signal?: AbortSignal
) {
  const selected = binding(run, actionId);
  return executeRunBehaviorTool(
    f.store,
    run.id,
    selected,
    { callId, name: selected.tool.name, args },
    signal
  );
}

function finish(f: Fixture, run: Run, text = 'Synthetic final prose.') {
  return f.store.completeRun(
    run.id,
    text,
    { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    run.snapshot.settings
  );
}

function current(f: Fixture) {
  return behaviorDetail(f.store, f.chat.id).instances[0];
}

test('a real model program stages frozen state and commits it only with final prose', async () => {
  const f = fixture();
  const run = start(f);
  const originalRequest = run.request;
  const originalSnapshotRequest = run.snapshot.request;
  const frozenAction = run.snapshot.profile!.packages![0].behavior!.actions.find(
    (action) => action.id === 'compute'
  )!;
  const event = await invoke(f, run, 'compute', { amount: 4 }, 'real-worker');

  expect(event).toMatchObject({
    callId: 'real-worker',
    denied: false,
    result: { applied: true, delta: 10, scope: 'input,state' },
  });
  expect(current(f)).toMatchObject({ stateRevision: 0, state: { count: 0 } });
  const progress = runBehaviorProgress(f.store, run.id)!;
  expect(progress.states[0]).toMatchObject({ stateRevision: 1, state: { count: 10 } });
  expect(progress.entries[0]).toMatchObject({
    actionId: 'compute',
    input: { amount: 4 },
    before: { stateRevision: 0, state: { count: 0 } },
    after: { stateRevision: 1, state: { count: 10 } },
    result: { applied: true, delta: 10, scope: 'input,state' },
    program: {
      api: EXTENSION_PROGRAM_API,
      programHash: behaviorPayloadHash(frozenAction.program),
      engine: expect.any(String),
      state: { count: 10 },
      result: { applied: true, delta: 10, scope: 'input,state' },
    },
  });
  expect(f.store.run(run.id)).toMatchObject({
    request: originalRequest,
    snapshot: { request: originalSnapshotRequest },
  });

  const source = finish(f, run);
  expect(source.text).toBe('Synthetic final prose.');
  expect(current(f)).toMatchObject({ stateRevision: 1, state: { count: 10 } });
  expect(f.store.run(run.id)).toMatchObject({
    request: originalRequest,
    snapshot: { request: originalSnapshotRequest },
  });
});

test('matching concurrent and repeated calls execute once while changed input is denied', async () => {
  const f = fixture();
  const run = start(f);
  let release!: (
    value: Awaited<ReturnType<typeof extensionRuntime.executeExtensionProgram>>
  ) => void;
  const execute = vi
    .spyOn(extensionRuntime, 'executeExtensionProgram')
    .mockImplementation(() => new Promise((resolve) => (release = resolve)));

  const first = invoke(f, run, 'compute', { amount: 2 }, 'call-one');
  const second = invoke(f, run, 'compute', { amount: 2 }, 'call-two');
  expect(execute).toHaveBeenCalledTimes(1);
  release({
    state: { count: 3 },
    result: { applied: true, delta: 3 },
    engine: 'test-gate-v1',
  });
  await expect(Promise.all([first, second])).resolves.toMatchObject([
    { callId: 'call-one', denied: false, result: { applied: true, delta: 3 } },
    { callId: 'call-two', denied: false, result: { applied: true, delta: 3 } },
  ]);
  expect(runBehaviorProgress(f.store, run.id)!.entries).toHaveLength(1);

  await expect(invoke(f, run, 'compute', { amount: 2 }, 'call-three')).resolves.toMatchObject({
    callId: 'call-three',
    denied: false,
    result: { applied: true, delta: 3 },
  });
  expect(execute).toHaveBeenCalledTimes(1);
  await expect(invoke(f, run, 'compute', { amount: 3 }, 'changed-input')).resolves.toMatchObject({
    callId: 'changed-input',
    denied: true,
    result: { code: 'BEHAVIOR_OPPORTUNITY_INPUT_CHANGED' },
  });
  expect(runBehaviorProgress(f.store, run.id)!.entries).toHaveLength(1);
  expect(current(f)).toMatchObject({ stateRevision: 0, state: { count: 0 } });
});

test('a guest failure is generic and does not block prose or another model action', async () => {
  const f = fixture();
  const run = start(f);
  const failed = await invoke(f, run, 'guest-throws', {}, 'guest-failure');
  expect(failed).toMatchObject({
    callId: 'guest-failure',
    denied: true,
    result: {
      code: 'BEHAVIOR_PROGRAM_FAILED',
      unavailable: true,
      continueWithoutAction: true,
    },
  });
  expect(JSON.stringify(failed)).not.toContain('PRIVATE_MODEL_GUEST_TEXT');
  expect(runBehaviorProgress(f.store, run.id)!.entries).toHaveLength(0);

  const ordinary = await invoke(f, run, 'ordinary', { amount: 7 }, 'ordinary-after-failure');
  expect(ordinary).toMatchObject({ denied: false, result: 7 });
  expect(current(f)).toMatchObject({ stateRevision: 0, state: { count: 0 } });
  const source = finish(f, run, 'The model continued after the optional tool failure.');
  expect(source.text).toBe('The model continued after the optional tool failure.');
  expect(current(f)).toMatchObject({ stateRevision: 1, state: { count: 7 } });
});

test('cancellation while guest code is pending adopts no entry or live state', async () => {
  const f = fixture();
  const run = start(f);
  const controller = new AbortController();
  let release!: (
    value: Awaited<ReturnType<typeof extensionRuntime.executeExtensionProgram>>
  ) => void;
  vi.spyOn(extensionRuntime, 'executeExtensionProgram').mockImplementation(
    () => new Promise((resolve) => (release = resolve))
  );
  const pending = invoke(f, run, 'compute', { amount: 2 }, 'cancelled-call', controller.signal);
  controller.abort();
  release({
    state: { count: 3 },
    result: { applied: true, delta: 3 },
    engine: 'test-gate-v1',
  });

  await expect(pending).rejects.toThrow('BEHAVIOR_RUN_CANCELLED');
  expect(runBehaviorProgress(f.store, run.id)!.entries).toHaveLength(0);
  expect(current(f)).toMatchObject({ stateRevision: 0, state: { count: 0 } });
});

test('a source edit while guest code is pending invalidates ownership before adoption', async () => {
  const f = fixture();
  const seedRun = start(f);
  const seed = finish(f, seedRun, 'Original source dependency.');
  const run = start(f);
  let release!: (
    value: Awaited<ReturnType<typeof extensionRuntime.executeExtensionProgram>>
  ) => void;
  vi.spyOn(extensionRuntime, 'executeExtensionProgram').mockImplementation(
    () => new Promise((resolve) => (release = resolve))
  );
  const pending = invoke(f, run, 'compute', { amount: 2 }, 'source-race');
  f.store.editSource(seed.id, { text: 'Edited source dependency.', expectedRevision: 0 });
  release({
    state: { count: 3 },
    result: { applied: true, delta: 3 },
    engine: 'test-gate-v1',
  });

  await expect(pending).rejects.toThrow('BEHAVIOR_SOURCE_DEPENDENCY_CHANGED');
  expect(runBehaviorProgress(f.store, run.id)!.entries).toHaveLength(0);
  expect(current(f)).toMatchObject({ stateRevision: 0, state: { count: 0 } });
});

test('fork, archive and chat backup preserve receipts without executing guest code', async () => {
  const f = fixture();
  const run = start(f);
  expect((await invoke(f, run, 'compute', { amount: 3 }, 'preserved-program')).denied).toBe(false);
  const source = finish(f, run, 'Source with a committed program receipt.');
  const originalEntry = runBehaviorProgress(f.store, run.id)!.entries[0];
  const execute = vi.spyOn(extensionRuntime, 'executeExtensionProgram');

  const fork = forkChat(f.store, f.chat.id, {
    fromRevision: source.id,
    title: 'Synthetic program fork',
    idempotencyKey: randomUUID(),
  });
  const forkRun = f.store.run(f.store.source(fork.headRevision!).runId);
  expect(runBehaviorProgress(f.store, forkRun.id)!.entries[0].program).toEqual(
    originalEntry.program
  );
  expect(behaviorDetail(f.store, fork.id).instances[0]).toMatchObject({
    stateRevision: 1,
    state: { count: 6 },
  });

  const archive = f.store.product.export();
  const restored = database();
  expect(restored.product.import(archive)).toEqual({ restored: true, chats: 2 });
  expect(runBehaviorProgress(restored, run.id)!.entries[0].program).toEqual(originalEntry.program);

  const copied = database();
  const backup = importChatBackup(copied, {
    backup: exportChatBackup(f.store, f.chat.id),
    idempotencyKey: randomUUID(),
  });
  const copiedRun = copied.run(copied.source(backup.chat.headRevision!).runId);
  expect(runBehaviorProgress(copied, copiedRun.id)!.entries[0].program).toEqual(
    originalEntry.program
  );
  expect(behaviorDetail(copied, backup.chat.id).instances[0]).toMatchObject({
    stateRevision: 1,
    state: { count: 6 },
  });
  expect(execute).not.toHaveBeenCalled();
  const changed = structuredClone(archive);
  const opportunity = changed.tables.package_behavior_opportunities[0];
  const body = JSON.parse(opportunity.body);
  body.entries[0].program.programHash = '0'.repeat(64);
  opportunity.body = JSON.stringify(body);
  const rejected = database();
  expect(() => rejected.product.import(changed)).toThrow('program receipt');
  expect(rejected.db.prepare('SELECT count(*) AS n FROM chats').get()).toEqual({ n: 0 });
  expect(execute).not.toHaveBeenCalled();
});

for (const actionId of ['compute', 'guest-throws'])
  test(`the main provider flow continues prose after ${actionId}`, async () => {
    const f = fixture();
    let calls = 0;
    let toolName = '';
    const provider = await loopbackProvider(async (_request, response) => {
      calls++;
      await writeSse(
        response,
        calls === 1
          ? [
              {
                type: 'tool_delta',
                index: 0,
                id: 'fixture-program-call',
                name: toolName,
                argumentsDelta: actionId === 'compute' ? '{"amount":3}' : '{}',
              },
              { type: 'usage', inputTokens: 10, outputTokens: 2, costUsd: null },
              { type: 'done', reason: 'tool_calls' },
            ]
          : [
              {
                type: 'text_delta',
                delta: 'The synthetic model continued with the computed result.',
              },
              { type: 'usage', inputTokens: 15, outputTokens: 8, costUsd: null },
              { type: 'done', reason: 'stop' },
            ]
      );
    });
    try {
      const connection = f.store.product.connection({
        title: 'Synthetic extension provider',
        protocol: 'fixture-sse-v1',
        endpoint: provider.endpoint,
        enabled: true,
      }) as Connection;
      const model = f.store.product.model({
        title: 'Synthetic model',
        connectionId: connection.id,
        modelId: 'fixture-state-program',
        maxOutputTokens: 100,
        temperature: null,
      }) as ModelPreset;
      const profile = f.store.product.profile(f.chat.id);
      updateTestProfile(f.store.product, f.chat.id, {
        expectedRevision: profile.revision,
        attachments: profile.attachments,
        routes: { ...profile.routes, main: { id: model.id } },
        image: false,
      });
      const run = start(f);
      toolName = binding(run, actionId).tool.name;
      const result = await runMain(run.snapshot, {
        signal: new AbortController().signal,
        approvedOrigins: [provider.origin],
        authorize: (connection) => f.store.product.authorize(connection),
        onInput: (input) => f.store.input(run.id, input),
        onToolEvent: (event) => f.store.tool(run.id, event),
        onBehaviorTool: (binding, action) =>
          executeRunBehaviorTool(f.store, run.id, binding, action),
        onAttemptStart: (wire) => f.store.product.startAttempt(f.chat.id, run.id, null, wire),
        onAttemptFinish: (id, response) => {
          f.store.product.finishAttempt(id, response);
        },
      });
      expect(result).toMatchObject({
        status: 'completed',
        text: 'The synthetic model continued with the computed result.',
      });
      expect(calls).toBe(2);
      expect(provider.requests[1].body).toContain(
        actionId === 'compute' ? 'applied' : 'continueWithoutAction'
      );
      expect(provider.requests[1].body).not.toContain('PRIVATE_MODEL_GUEST_TEXT');
      expect(current(f).state).toEqual({ count: 0 });
      f.store.completeRun(run.id, result.text, result.usage, run.snapshot.settings);
      expect(current(f).state).toEqual({ count: actionId === 'compute' ? 6 : 0 });
      expect(f.store.run(run.id).request).toBe(run.request);
    } finally {
      await provider.close();
    }
  });
