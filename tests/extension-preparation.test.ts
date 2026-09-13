import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, type Run } from '../server/store.js';
import { createFixtureChat } from './fixtures/chat.js';
import type { ContentPackage } from '../core/content-package.js';
import type { Content } from '../core/product.js';
import type { RunSnapshot } from '../core/types.js';
import { EXTENSION_PROGRAM_API } from '../core/extension-program.js';
import { behaviorDetail } from '../server/package-behavior-host.js';
import {
  prepareAutomaticRunBehavior,
  preparedBehaviorSnapshot,
  runBehaviorProgress,
  skipAutomaticRunBehavior,
} from '../server/package-behavior-run.js';
import { readerRuns } from '../server/reader.js';
import { forkChat } from '../server/chat-fork.js';
import { exportChatBackup, importChatBackup } from '../server/chat-backup.js';
import * as extensionRuntime from '../server/extension-runtime.js';
import { freezeReservationSnapshot } from '../server/reservation-snapshot.js';

const owned: { store: Store; dir: string }[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const { store, dir } of owned.splice(0).reverse()) {
    store.close();
    const inside = relative(resolve(tmpdir()), resolve(dir));
    if (
      isAbsolute(inside) ||
      inside.startsWith('..') ||
      !inside.startsWith('uimori-extension-preparation-')
    )
      throw new Error('Unsafe test cleanup');
    rmSync(dir, { recursive: true, force: true });
  }
});

function database() {
  const dir = mkdtempSync(join(tmpdir(), 'uimori-extension-preparation-'));
  const store = new Store(join(dir, 'test.sqlite'));
  owned.push({ store, dir });
  return store;
}

function definition(programSource?: string): ContentPackage {
  return {
    version: 1,
    id: 'extension-preparation-fixture',
    revision: 1,
    title: 'Synthetic automatic extension',
    description: 'Deferred preparation fixture',
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
          id: 'static-before',
          triggers: ['before-turn'],
          automaticInput: {},
          inputSchema: { type: 'record', properties: {} },
          effects: [
            {
              path: ['count'],
              value: { op: 'add', args: [{ context: ['state', 'count'] }, 1] },
            },
          ],
          result: { context: ['nextState', 'count'] },
        },
        {
          id: 'program-middle',
          triggers: ['before-turn'],
          automaticInput: { factor: 3 },
          inputSchema: {
            type: 'record',
            properties: { factor: { type: 'number', min: 1, max: 10, integer: true } },
          },
          effects: [],
          program: {
            api: EXTENSION_PROGRAM_API,
            source:
              programSource ??
              'return {state: {count: api.state.count * api.input.factor}, result: {count: api.state.count * api.input.factor}};',
          },
        },
        {
          id: 'static-after',
          triggers: ['before-turn'],
          automaticInput: {},
          inputSchema: { type: 'record', properties: {} },
          effects: [
            {
              path: ['count'],
              value: { op: 'add', args: [{ context: ['state', 'count'] }, 4] },
            },
          ],
          result: { context: ['nextState', 'count'] },
        },
      ],
      outputParsers: [],
    },
  };
}

function fixture(programSource?: string) {
  const store = database();
  const pkg = definition(programSource);
  const content = store.product.content({
    kind: 'bot',
    title: pkg.title,
    description: pkg.description,
    text: pkg.body,
    loading: 'pinned',
    relatedIds: [],
    package: pkg,
  }) as Content;
  const chat = createFixtureChat(store, 'Synthetic deferred preparation', 'calm', {
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
    request: 'Write after automatic preparation.',
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

function finish(f: Fixture, run: Run, text = 'Synthetic prose after preparation.') {
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

function skipBody(f: Fixture, run: Run, key: string = randomUUID()) {
  return {
    chatId: f.chat.id,
    branchId: f.branchId,
    expectedRevision: run.parentRevision,
    idempotencyKey: key,
  };
}

test('admission and read-only preview defer all automatic actions without executing code', () => {
  const f = fixture();
  const execute = vi.spyOn(extensionRuntime, 'executeExtensionProgram');
  const run = admit(f);
  const snapshot = structuredClone(run.snapshot);

  expect(run.snapshot.behaviorExecution).toMatchObject({
    deferredAutomatic: true,
    baseStates: [{ stateRevision: 0, state: { count: 0 } }],
    automaticResults: [],
  });
  expect(runBehaviorProgress(f.store, run.id)).toMatchObject({
    entries: [],
    states: [{ stateRevision: 0, state: { count: 0 } }],
    preparation: { status: 'pending', completed: 0, total: 3 },
  });
  expect(current(f)).toMatchObject({ stateRevision: 0, state: { count: 0 } });
  expect(() => preparedBehaviorSnapshot(f.store, run.id)).toThrow('BEHAVIOR_PREPARATION_PENDING');
  expect(f.store.run(run.id).snapshot).toEqual(snapshot);
  expect(execute).not.toHaveBeenCalled();
  const resumed = freezeReservationSnapshot(f.store, snapshot, { purpose: 'resume-state' });
  expect(resumed).toEqual(snapshot);
  expect(resumed.promptCompilation).toBeUndefined();
  expect(execute).not.toHaveBeenCalled();
});

test('the whole static and code cohort stages in declaration order and commits with source only', async () => {
  const f = fixture();
  const run = start(f);
  const reserved = structuredClone(run.snapshot);
  const request = run.request;
  await prepareAutomaticRunBehavior(f.store, run.id);

  const progress = runBehaviorProgress(f.store, run.id)!;
  expect(progress.preparation).toEqual({ status: 'ready', completed: 3, total: 3 });
  expect(progress.entries.map((entry) => entry.actionId)).toEqual([
    'static-before',
    'program-middle',
    'static-after',
  ]);
  expect(progress.entries.map((entry) => entry.result)).toEqual([1, { count: 3 }, 7]);
  expect(progress.entries[1].program).toMatchObject({
    api: EXTENSION_PROGRAM_API,
    engine: expect.any(String),
    state: { count: 3 },
    result: { count: 3 },
  });
  expect(preparedBehaviorSnapshot(f.store, run.id).packageStates![0]).toMatchObject({
    stateRevision: 3,
    state: { count: 7 },
  });
  expect(current(f)).toMatchObject({ stateRevision: 0, state: { count: 0 } });
  expect(f.store.run(run.id)).toMatchObject({ request, snapshot: reserved });
  expect(readerRuns(f.store, f.chat.id)[0].packagePreparation).toEqual({
    status: 'ready',
    completed: 3,
    total: 3,
  });

  finish(f, run);
  expect(current(f)).toMatchObject({ stateRevision: 3, state: { count: 7 } });
  expect(f.store.run(run.id)).toMatchObject({ request, snapshot: reserved });
});

test('a denied skip changes nothing, while an accepted skip closes late adoption idempotently', async () => {
  const f = fixture();
  const run = start(f);
  let release!: (
    value: Awaited<ReturnType<typeof extensionRuntime.executeExtensionProgram>>
  ) => void;
  const execute = vi
    .spyOn(extensionRuntime, 'executeExtensionProgram')
    .mockImplementation(() => new Promise((resolve) => (release = resolve)));
  const pending = prepareAutomaticRunBehavior(f.store, run.id);
  expect(execute).toHaveBeenCalledTimes(1);

  expect(() =>
    skipAutomaticRunBehavior(f.store, run.id, {
      ...skipBody(f, run),
      branchId: 'unowned-branch',
    })
  ).toThrow('BEHAVIOR_PREPARATION_OWNER_MISMATCH');
  expect(runBehaviorProgress(f.store, run.id)!.preparation?.status).toBe('running');
  const body = skipBody(f, run, 'skip-preparation-once');
  expect(skipAutomaticRunBehavior(f.store, run.id, body)).toMatchObject({
    skipped: true,
    preparation: { status: 'skipped', completed: 1, total: 3 },
  });
  expect(skipAutomaticRunBehavior(f.store, run.id, body)).toMatchObject({ skipped: true });
  await pending;
  // Skipping resumes the caller before an uncooperative operation returns its late result.
  release({ state: { count: 3 }, result: { count: 3 }, engine: 'test-gate-v1' });
  await Promise.resolve();

  expect(execute).toHaveBeenCalledTimes(1);
  expect(runBehaviorProgress(f.store, run.id)).toMatchObject({
    entries: [],
    states: [{ stateRevision: 0, state: { count: 0 } }],
    preparation: { status: 'skipped', completed: 1, total: 3 },
  });
  expect(current(f)).toMatchObject({ stateRevision: 0, state: { count: 0 } });
  expect(readerRuns(f.store, f.chat.id)[0].packagePreparation).toEqual({
    status: 'skipped',
    completed: 1,
    total: 3,
    code: 'BEHAVIOR_PREPARATION_SKIPPED',
  });
});

test('cancellation during guest execution discards the prefix and cannot restart execution', async () => {
  const f = fixture();
  const run = start(f);
  const controller = new AbortController();
  let release!: (
    value: Awaited<ReturnType<typeof extensionRuntime.executeExtensionProgram>>
  ) => void;
  const execute = vi
    .spyOn(extensionRuntime, 'executeExtensionProgram')
    .mockImplementation(() => new Promise((resolve) => (release = resolve)));
  const pending = prepareAutomaticRunBehavior(f.store, run.id, controller.signal);
  expect(execute).toHaveBeenCalledTimes(1);
  controller.abort();
  release({ state: { count: 3 }, result: { count: 3 }, engine: 'test-gate-v1' });

  await expect(pending).rejects.toThrow('BEHAVIOR_RUN_CANCELLED');
  expect(runBehaviorProgress(f.store, run.id)).toMatchObject({
    entries: [],
    states: [{ stateRevision: 0, state: { count: 0 } }],
    preparation: { status: 'failed', code: 'BEHAVIOR_RUN_CANCELLED' },
  });
  await prepareAutomaticRunBehavior(f.store, run.id);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(current(f)).toMatchObject({ stateRevision: 0, state: { count: 0 } });
});

test('a guest failure discards a successful prefix and prose continues with immutable inputs', async () => {
  const f = fixture('throw new Error("PRIVATE_PREPARATION_FAILURE");');
  const run = start(f);
  const reserved = structuredClone(run.snapshot);
  await prepareAutomaticRunBehavior(f.store, run.id);

  expect(runBehaviorProgress(f.store, run.id)).toMatchObject({
    entries: [],
    states: [{ stateRevision: 0, state: { count: 0 } }],
    preparation: {
      status: 'failed',
      completed: 1,
      total: 3,
      code: 'BEHAVIOR_PROGRAM_FAILED',
    },
  });
  expect(JSON.stringify(runBehaviorProgress(f.store, run.id))).not.toContain(
    'PRIVATE_PREPARATION_FAILURE'
  );
  expect(preparedBehaviorSnapshot(f.store, run.id)).toMatchObject({
    request: reserved.request,
    packageStates: [],
    packageBehaviorUnavailable: [
      expect.objectContaining({ stage: 'preparation', code: 'BEHAVIOR_PROGRAM_FAILED' }),
    ],
  });
  expect(readerRuns(f.store, f.chat.id)[0].packagePreparation).toEqual({
    status: 'failed',
    completed: 1,
    total: 3,
    code: 'BEHAVIOR_PROGRAM_FAILED',
  });
  const source = finish(f, run, 'Prose continued without the optional preparation.');
  expect(source.text).toBe('Prose continued without the optional preparation.');
  expect(current(f)).toMatchObject({ stateRevision: 0, state: { count: 0 } });
  expect(f.store.run(run.id).snapshot).toEqual(reserved);
});

test('fork, archive and chat backup preserve preparation receipts without guest replay', async () => {
  const f = fixture();
  const run = start(f);
  await prepareAutomaticRunBehavior(f.store, run.id);
  const source = finish(f, run, 'Source with automatic program preparation.');
  const originalProgress = runBehaviorProgress(f.store, run.id)!;
  const execute = vi.spyOn(extensionRuntime, 'executeExtensionProgram');

  const fork = forkChat(f.store, f.chat.id, {
    fromRevision: source.id,
    title: 'Synthetic preparation fork',
    idempotencyKey: randomUUID(),
  });
  const forkRun = f.store.run(f.store.source(fork.headRevision!).runId);
  expect(runBehaviorProgress(f.store, forkRun.id)?.entries).toEqual(originalProgress.entries);
  expect(runBehaviorProgress(f.store, forkRun.id)?.preparation).toEqual(
    originalProgress.preparation
  );

  const archive = f.store.product.export();
  const restored = database();
  expect(restored.product.import(archive)).toEqual({ restored: true, chats: 2 });
  expect(runBehaviorProgress(restored, run.id)).toEqual(originalProgress);

  const copied = database();
  const backup = importChatBackup(copied, {
    backup: exportChatBackup(f.store, f.chat.id),
    idempotencyKey: randomUUID(),
  });
  const copiedRun = copied.run(copied.source(backup.chat.headRevision!).runId);
  expect(runBehaviorProgress(copied, copiedRun.id)?.entries).toEqual(originalProgress.entries);
  expect(runBehaviorProgress(copied, copiedRun.id)?.preparation).toEqual(
    originalProgress.preparation
  );
  expect(behaviorDetail(copied, backup.chat.id).instances[0]).toMatchObject({
    stateRevision: 3,
    state: { count: 7 },
  });
  expect(execute).not.toHaveBeenCalled();
});
