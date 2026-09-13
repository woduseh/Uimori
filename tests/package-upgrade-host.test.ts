import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { Store } from '../server/store.js';
import { fixtureBotInput, createFixtureChat } from './fixtures/chat.js';
import type { Content } from '../core/product.js';
import type { PackageBehavior } from '../core/package-behavior.js';
import { packageInstanceId } from '../core/execution-context.js';
import {
  applyBehaviorUpgrade,
  behaviorDetail,
  previewBehaviorUpgrade,
  freezePackageStates,
  performBehaviorAction,
} from '../server/package-behavior-host.js';
import * as runtime from '../server/extension-runtime.js';
import { EXTENSION_PROGRAM_API } from '../core/extension-program.js';
import { exportChatBackup, importChatBackup } from '../server/chat-backup.js';
import { forkChat } from '../server/chat-fork.js';

const stores: Store[] = [];
const directories: string[] = [];
function finishSyntheticSource(store: Store, chatId: string) {
  const chat = store.chat(chatId),
    branch = store.product.branch(chatId),
    profile = store.product.snapshot(chatId);
  const snapshot = freezePackageStates(
    store,
    {
      chatId,
      branchId: branch.id,
      parentRevision: branch.headRevision,
      settingsRevision: chat.settingsRevision,
      settings: chat.settings,
      request: 'Synthetic upgrade source',
      history: store.history(branch.headRevision),
      resources: store.product.resources(chatId, profile),
      profile,
    },
    true
  );
  const { run } = store.createRun(
    chatId,
    {
      request: snapshot.request,
      expectedRevision: branch.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      branchId: branch.id,
      idempotencyKey: 'synthetic-source',
    },
    () => snapshot
  );
  expect(store.startRun(run.id)).toBe(true);
  const source = store.completeRun(
    run.id,
    'Synthetic upgraded source.',
    { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    run.snapshot.settings
  );
  return { run: store.run(run.id), source };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const dir of directories.splice(0)) {
    const inside = relative(resolve(tmpdir()), resolve(dir));
    if (isAbsolute(inside) || inside.startsWith('..') || !inside.startsWith('uimori-upgrade-host-'))
      throw new Error('Unsafe test cleanup');
    rmSync(dir, { recursive: true, force: true });
  }
});
function database() {
  const dir = mkdtempSync(join(tmpdir(), 'uimori-upgrade-host-'));
  directories.push(dir);
  const store = new Store(join(dir, 'test.sqlite'));
  stores.push(store);
  return store;
}
function fixture(program = false, withDraw = false) {
  const store = database();
  const behavior: PackageBehavior = {
    revision: 1,
    schemaVersion: 1,
    stateSchema: { type: 'record', properties: { count: { type: 'number', min: 0, max: 100 } } },
    initialState: { count: 8 },
    actions: withDraw
      ? [
          {
            id: 'draw',
            inputSchema: { type: 'record', properties: {} },
            effects: [],
            draws: [{ id: 'die', type: 'integer', min: 1, max: 6 }],
          },
        ]
      : [],
    outputParsers: [],
  };
  const input = fixtureBotInput();
  input.package.behavior = behavior;
  const content = store.product.content(input) as Content;
  const chat = createFixtureChat(store, 'Upgrade fixture', 'calm', { botId: content.id });
  const branchId = `main:${chat.id}`;
  const instanceId = packageInstanceId({ id: content.id, revision: content.revision, role: 'bot' });
  store.behavior.ensure(
    {
      chatId: chat.id,
      branchId,
      attachmentInstanceId: instanceId,
      packageId: content.id,
      packageRevision: content.revision,
      behaviorRevision: 1,
      schemaVersion: 1,
    },
    behavior
  );
  if (withDraw)
    performBehaviorAction(store, chat.id, branchId, instanceId, {
      actionId: 'draw',
      input: {},
      expectedStateRevision: 0,
      expectedSourceHash: null,
      idempotencyKey: 'historical-draw',
    });
  const next = {
    ...behavior,
    revision: 2,
    ...(program
      ? {
          migration: {
            api: EXTENSION_PROGRAM_API,
            source: 'return {state: {count: api.state.count + 1}, result: null};',
          },
        }
      : {}),
  };
  store.product.content(
    { ...input, expectedRevision: content.revision, package: { ...input.package, behavior: next } },
    content.id
  );
  const detail = behaviorDetail(store, chat.id);
  const command = {
    mode: program ? ('program' as const) : ('preserve' as const),
    expectedPackageRevision: detail.instances[0].packageRevision,
    expectedStateRevision: detail.instances[0].stateRevision,
    expectedSourceHash: null,
  };
  return { store, chatId: chat.id, branchId, instanceId, command };
}
test('GET does not execute migration; preview is read-only and durable replay needs no candidate', async () => {
  const f = fixture(true);
  const worker = vi.spyOn(runtime, 'executeExtensionProgram').mockResolvedValue({
    state: { count: 9 },
    result: null,
    engine: runtime.EXTENSION_RUNTIME_ENGINE,
  });
  expect(behaviorDetail(f.store, f.chatId).instances[0].upgrade).toEqual({
    canPreserve: true,
    canTransform: true,
  });
  expect(worker).not.toHaveBeenCalled();
  const preview = await previewBehaviorUpgrade(
    f.store,
    f.chatId,
    f.branchId,
    f.instanceId,
    f.command
  );
  expect(preview).toMatchObject({ before: { count: 8 }, after: { count: 9 }, drawsCleared: true });
  expect(behaviorDetail(f.store, f.chatId).instances[0]).toMatchObject({
    state: { count: 8 },
    stateRevision: 0,
  });
  const command = { ...f.command, previewId: preview.previewId, idempotencyKey: 'upgrade' };
  expect(
    applyBehaviorUpgrade(f.store, f.chatId, f.branchId, f.instanceId, command).instances[0]
  ).toMatchObject({ state: { count: 9 }, stateRevision: 1, status: 'ready' });
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 700_000);
  expect(
    applyBehaviorUpgrade(f.store, f.chatId, f.branchId, f.instanceId, command).instances[0]
      .stateRevision
  ).toBe(1);
  expect(worker).toHaveBeenCalledTimes(1);
  expect(() =>
    applyBehaviorUpgrade(f.store, f.chatId, f.branchId, f.instanceId, {
      ...command,
      mode: 'preserve',
    })
  ).toThrow('BEHAVIOR_IDEMPOTENCY_CONFLICT');
  expect(behaviorDetail(f.store, f.chatId).instances[0].lastAction).toBeUndefined();
});
test('candidate cannot cross profile settings changes, forged token, or unrelated stale head', async () => {
  const f = fixture();
  const preview = await previewBehaviorUpgrade(
    f.store,
    f.chatId,
    f.branchId,
    f.instanceId,
    f.command
  );
  const command = { ...f.command, previewId: preview.previewId, idempotencyKey: 'upgrade' };
  expect(() =>
    applyBehaviorUpgrade(f.store, f.chatId, f.branchId, f.instanceId, {
      ...command,
      previewId: 'forged',
    })
  ).toThrow('BEHAVIOR_UPGRADE_PREVIEW_EXPIRED');
  f.store.db
    .prepare('UPDATE chats SET settings_revision=settings_revision+1 WHERE id=?')
    .run(f.chatId);
  expect(() => applyBehaviorUpgrade(f.store, f.chatId, f.branchId, f.instanceId, command)).toThrow(
    'BEHAVIOR_PROGRAM_CONTEXT_CHANGED'
  );
  f.store.db
    .prepare('INSERT INTO package_behavior_heads VALUES(?,?,?,?,?,?,?)')
    .run(
      f.chatId,
      f.branchId,
      f.instanceId,
      '[]',
      'stale',
      'BEHAVIOR_SOURCE_DEPENDENCY_CHANGED',
      '{}'
    );
  expect(behaviorDetail(f.store, f.chatId).instances[0].upgrade).toBeUndefined();
  await expect(
    previewBehaviorUpgrade(f.store, f.chatId, f.branchId, f.instanceId, f.command)
  ).rejects.toThrow('BEHAVIOR_SOURCE_DEPENDENCY_CHANGED');
});
test('late preview result and aborted previews do not become applicable', async () => {
  const f = fixture(true);
  vi.spyOn(runtime, 'executeExtensionProgram').mockImplementation(async () => {
    f.store.db
      .prepare('UPDATE chats SET settings_revision=settings_revision+1 WHERE id=?')
      .run(f.chatId);
    return { state: { count: 9 }, result: null, engine: runtime.EXTENSION_RUNTIME_ENGINE };
  });
  await expect(
    previewBehaviorUpgrade(f.store, f.chatId, f.branchId, f.instanceId, f.command)
  ).rejects.toThrow('BEHAVIOR_PROGRAM_CONTEXT_CHANGED');
  const abort = new AbortController();
  abort.abort();
  await expect(
    previewBehaviorUpgrade(f.store, f.chatId, f.branchId, f.instanceId, f.command, abort.signal)
  ).rejects.toThrow('EXTENSION_CANCELLED');
  expect(behaviorDetail(f.store, f.chatId).instances[0].stateRevision).toBe(0);
});

test('real migration, source fork and chat backup preserve old draw and upgrade receipts without reexecution', async () => {
  const f = fixture(true, true);
  const execute = vi.spyOn(runtime, 'executeExtensionProgram');
  const preview = await previewBehaviorUpgrade(
    f.store,
    f.chatId,
    f.branchId,
    f.instanceId,
    f.command
  );
  expect(preview).toMatchObject({
    before: { count: 8 },
    after: { count: 9 },
    from: { packageRevision: 1 },
    to: { packageRevision: 2 },
  });
  applyBehaviorUpgrade(f.store, f.chatId, f.branchId, f.instanceId, {
    ...f.command,
    previewId: preview.previewId,
    idempotencyKey: 'real-upgrade',
  });
  const completed = finishSyntheticSource(f.store, f.chatId);
  expect(completed.run.snapshot.packageStates?.[0]).toMatchObject({
    state: { count: 9 },
    stateRevision: 2,
    draws: {},
  });
  const fork = forkChat(f.store, f.chatId, {
    fromRevision: completed.source.id,
    title: 'Upgrade fork',
    idempotencyKey: 'upgrade-fork',
  });
  expect(behaviorDetail(f.store, fork.id).instances[0]).toMatchObject({
    state: { count: 9 },
    status: 'ready',
  });
  expect(
    f.store.run(f.store.source(f.store.chat(fork.id).headRevision!).runId).snapshot
      .packageStates?.[0]?.draws
  ).toEqual({});
  const backup = exportChatBackup(f.store, f.chatId);
  const beforeRows = backup.records.behaviorJournal;
  expect(beforeRows).toHaveLength(2);
  const originalUpgrade = beforeRows
    .map((row) => row.payload as Record<string, any>)
    .find((row) => row.provenance === 'explicit-upgrade');
  if (!originalUpgrade) throw new Error('Missing original upgrade receipt');
  expect(originalUpgrade).toMatchObject({
    previousScope: { packageRevision: 1, behaviorRevision: 1 },
    scope: { packageRevision: 2, behaviorRevision: 2 },
    program: { state: { count: 9 }, engine: runtime.EXTENSION_RUNTIME_ENGINE },
  });
  execute.mockClear();
  const target = database();
  const restored = importChatBackup(target, { backup, idempotencyKey: 'restore-upgrade' }).chat;
  const current = behaviorDetail(target, restored.id).instances[0];
  expect(current).toMatchObject({ state: { count: 9 }, stateRevision: 2, status: 'ready' });
  expect(current.upgrade).toBeUndefined();
  const reexported = exportChatBackup(target, restored.id);
  const restoredPayloads = reexported.records.behaviorJournal.map(
    (row) => row.payload as Record<string, any>
  );
  const restoredUpgrade = restoredPayloads.find((row) => row.provenance === 'explicit-upgrade');
  if (!restoredUpgrade) throw new Error('Missing restored upgrade receipt');
  expect(restoredUpgrade.program).toEqual(originalUpgrade.program);
  expect(restoredUpgrade.previousScope).toMatchObject({
    chatId: restored.id,
    packageRevision: 1,
    behaviorRevision: 1,
  });
  expect(restoredUpgrade.scope).toMatchObject({
    chatId: restored.id,
    packageRevision: 2,
    behaviorRevision: 2,
  });
  expect(
    reexported.records.behaviorJournal.map((row) => (row.result as Record<string, any>).draws)
  ).toEqual(beforeRows.map((row) => (row.result as Record<string, any>).draws));
  expect(
    reexported.records.turns.map(
      (row) => (row.snapshot as Record<string, any>).packageStates?.[0]?.draws
    )
  ).toEqual([{}]);
  const usable = performBehaviorAction(target, restored.id, undefined, current.instanceId, {
    actionId: 'draw',
    input: {},
    expectedStateRevision: 2,
    expectedSourceHash: behaviorDetail(target, restored.id).sourceHash,
    idempotencyKey: 'restored-action',
  });
  expect(usable.instances[0]).toMatchObject({
    stateRevision: 3,
    state: { count: 9 },
    status: 'ready',
  });
  expect(execute).not.toHaveBeenCalled();
});
