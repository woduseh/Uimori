import { createHash } from 'node:crypto';
import {
  startExtensionOperationAttempt,
  cancelExtensionOperation,
} from '../server/extension-operations.js';
import type { WireRecord } from '../core/transport.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { Store } from '../server/store.js';
import { fixtureBotInput } from './fixtures/chat.js';
import {
  createExtensionOperation,
  claimExtensionOperation,
  finishExtensionOperationInTransaction,
} from '../server/extension-operations.js';
import { exportChatBackup, importChatBackup } from '../server/chat-backup.js';
import { decodeChatBackup } from '../server/chat-backup-codec.js';
import { behaviorPayloadHash } from '../server/package-behavior-store.js';
import { chatDeletionImpact, deleteChat } from '../server/chat-deletion.js';
import type { ExtensionOperationSnapshot } from '../core/extension-operation.js';

const stores: { store: Store; directory: string }[] = [];
afterEach(() => {
  for (const { store, directory } of stores.splice(0)) {
    store.close();
    const within = relative(tmpdir(), directory);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !within.startsWith('uimori-operation-archive-')
    )
      throw new Error('Unsafe cleanup');
    rmSync(directory, { recursive: true, force: true });
  }
});
function database() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-operation-archive-'));
  const store = new Store(join(directory, 'test.sqlite'));
  stores.push({ store, directory });
  return store;
}
function fixture() {
  const store = database(),
    input = fixtureBotInput();
  input.package.behavior = {
    revision: 1,
    schemaVersion: 1,
    mode: 'authoritative',
    stateSchema: { type: 'record', properties: { n: { type: 'number', min: 0, max: 10 } } },
    initialState: { n: 0 },
    actions: [
      {
        id: 'change',
        triggers: ['user'],
        inputSchema: { type: 'record', properties: {} },
        effects: [],
        program: {
          api: 'uimori-state-action-v1',
          capabilities: ['model.generate'],
          source: 'throw new Error("archive must never execute");',
        },
      },
    ],
    outputParsers: [],
  };
  const bot = store.product.content(input),
    chat = store.createChat('archive fixture', 'calm', { botId: bot.id });
  const profile = store.product.snapshot(chat.id, 'inspect'),
    ref = profile.packageAttachments![0],
    pkg = profile.packages!.find((p) => p.id === ref.id)!;
  const snapshot: ExtensionOperationSnapshot = {
    version: 1,
    scope: {
      chatId: chat.id,
      branchId: `main:${chat.id}`,
      attachmentInstanceId: `${ref.id}:${ref.role}`,
      packageId: ref.id,
      packageRevision: ref.revision,
      behaviorRevision: 1,
      schemaVersion: 1,
    },
    stateRevision: 0,
    state: { n: 0 },
    runtime: { authored: { chatId: chat.id } },
    guard: 'a'.repeat(64),
    profile,
    settings: chat.settings,
    sourceRevision: null,
    sourceHash: null,
  };
  const command = {
    actionId: 'change',
    input: {},
    expectedStateRevision: 0,
    expectedSourceHash: null,
    idempotencyKey: 'archive-command',
  };
  const operation = createExtensionOperation(store, command, snapshot).operation;
  return { store, chat, snapshot, command, operation, pkg };
}

test('unfinished operation backup restores new ownership once and never replays authored code', () => {
  const { store, chat, operation, snapshot } = fixture();
  const backup = exportChatBackup(store, chat.id);
  expect(backup.records.extensionOperations).toHaveLength(1);
  const restored = importChatBackup(store, { backup, idempotencyKey: 'test' });
  const rows = store.db
    .prepare('SELECT * FROM package_extension_operations WHERE chat_id=?')
    .all(restored.chat.id);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    status: 'interrupted',
    owner: null,
    generation: 1,
    result: null,
    usage: null,
  });
  expect(rows[0].id).not.toBe(operation.id);
  const frozen = JSON.parse(String(rows[0].snapshot));
  expect(frozen.scope.chatId).toBe(restored.chat.id);
  expect(frozen.profile.chatId).toBe(restored.chat.id);
  expect(frozen.runtime).toEqual(snapshot.runtime);
  expect(frozen.guard).toBe(snapshot.guard);
  expect(store.db.prepare('SELECT count(*) AS n FROM attempts').get()!.n).toBe(0);
});

test('completed operation and ui journal round trip together; forged result is rejected', () => {
  const { store, chat, operation, snapshot, command, pkg } = fixture();
  const claimed = claimExtensionOperation(store, operation.id, 'test-owner')!;
  const result = {
    state: { n: 1 },
    result: 'done',
    engine: 'synthetic',
    programHash: behaviorPayloadHash(pkg.behavior!.actions[0].program),
  };
  store.transaction(() => {
    store.behavior.executeInTransaction(
      snapshot.scope,
      pkg.behavior!,
      command,
      snapshot.runtime,
      result
    );
    finishExtensionOperationInTransaction(
      store,
      claimed,
      'completed',
      result,
      { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
      null
    );
  });
  const backup = exportChatBackup(store, chat.id);
  expect(importChatBackup(store, { backup, idempotencyKey: 'test' }).chat.id).not.toBe(chat.id);
  const forged = structuredClone(backup);
  (forged.records.extensionOperations[0].result as { state: { n: number } }).state.n = 2;
  expect(() => importChatBackup(store, { backup: forged, idempotencyKey: 'forged' })).toThrow(
    /journal/
  );
});

test('only the two newly added backup collections may be absent, and request hashes are checked', () => {
  const { store, chat } = fixture();
  const backup = exportChatBackup(store, chat.id);
  const old = structuredClone(backup);
  delete old.records.extensionOperations;
  delete old.records.extensionOperationAttempts;
  expect(decodeChatBackup(old).tables.package_extension_operations).toEqual([]);
  delete old.records.turns;
  expect(() => decodeChatBackup(old)).toThrow('CHAT_BACKUP_INVALID_COLLECTION');
  backup.records.extensionOperations[0].requestHash = 'b'.repeat(64);
  expect(() => importChatBackup(store, { backup, idempotencyKey: 'test' })).toThrow(/request hash/);
});

test('active operations block chat deletion; idle operation history is removed', () => {
  const { store, chat } = fixture();
  expect(() => deleteChat(store, chat.id, chatDeletionImpact(store, chat.id).request)).toThrow(
    /진행/
  );
  store.db.prepare("UPDATE package_extension_operations SET status='interrupted'").run();
  deleteChat(store, chat.id, chatDeletionImpact(store, chat.id).request);
  expect(store.db.prepare('SELECT count(*) AS n FROM package_extension_operations').get()!.n).toBe(
    0
  );
});

test('uncertain standalone attempt keeps its wire request and exact operation owner across backup', () => {
  const { store, chat, operation, snapshot } = fixture();
  const connection = store.product.connection({
    title: 'Synthetic connection',
    protocol: 'fixture-sse-v1',
    endpoint: 'http://127.0.0.1:9',
    enabled: true,
  });
  const model = store.product.model({
    title: 'Synthetic model',
    connectionId: connection.id,
    modelId: 'synthetic',
    maxOutputTokens: 100,
    temperature: 0.3,
  });
  snapshot.profile.extensionModel = store.product.modelSnapshot(model.id, undefined, false);
  snapshot.profile.extensionGrants = {
    [snapshot.scope.attachmentInstanceId]: {
      packageRevision: snapshot.scope.packageRevision,
      capabilities: ['model.generate'],
    },
  };
  store.db
    .prepare('UPDATE package_extension_operations SET snapshot=? WHERE id=?')
    .run(JSON.stringify(snapshot), operation.id);
  const claimed = claimExtensionOperation(store, operation.id, 'worker')!;
  const wire: WireRecord = {
    connectionId: connection.id,
    modelId: 'synthetic',
    protocol: 'fixture-sse-v1',
    role: 'state',
    method: 'POST',
    url: 'http://127.0.0.1:9',
    headers: {},
    body: { authored: chat.id },
    bodySha256: createHash('sha256')
      .update(JSON.stringify({ authored: chat.id }))
      .digest('hex'),
    stablePrefixSha256: 'a'.repeat(64),
    extensionAction: {
      instanceId: snapshot.scope.attachmentInstanceId,
      actionId: 'change',
      packageId: snapshot.scope.packageId,
      packageRevision: snapshot.scope.packageRevision,
      trigger: 'user',
    },
  };
  startExtensionOperationAttempt(store, claimed, wire);
  const backup = exportChatBackup(store, chat.id);
  const restored = importChatBackup(store, { backup, idempotencyKey: 'with-attempt' });
  const attempt = store.db.prepare('SELECT * FROM attempts WHERE chat_id=?').get(restored.chat.id)!;
  expect(attempt.status).toBe('interrupted');
  expect(JSON.parse(String(attempt.request))).toEqual(wire);
  expect(
    store.db
      .prepare('SELECT count(*) AS n FROM package_extension_operation_attempts WHERE attempt_id=?')
      .get(attempt.id)!.n
  ).toBe(1);
  const malformed = structuredClone(backup);
  malformed.records.extensionOperationAttempts[0].callIndex = 2;
  expect(() => importChatBackup(store, { backup: malformed, idempotencyKey: 'bad-index' })).toThrow(
    /call index/
  );
  cancelExtensionOperation(store, operation.id);
  store.db.prepare("UPDATE attempts SET status='interrupted' WHERE chat_id=?").run(chat.id);
  deleteChat(store, chat.id, chatDeletionImpact(store, chat.id).request);
  expect(
    store.db.prepare('SELECT count(*) AS n FROM attempts WHERE chat_id=?').get(chat.id)!.n
  ).toBe(0);
});

test.each([1, 11])(
  'failed computation state %i survives archive and backup without adoption',
  (n) => {
    const { store, chat, operation, pkg } = fixture();
    const claimed = claimExtensionOperation(store, operation.id, 'worker')!;
    const result = {
      state: { n },
      result: 'calculated before adoption failed',
      programHash: behaviorPayloadHash(pkg.behavior!.actions[0].program),
      engine: 'synthetic',
    };
    store.transaction(() =>
      finishExtensionOperationInTransaction(
        store,
        claimed,
        'failed',
        result,
        { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
        'BEHAVIOR_STATE_CONFLICT'
      )
    );
    const archive = store.product.export(),
      destination = database();
    destination.product.import(archive);
    expect(
      JSON.parse(
        String(
          destination.db
            .prepare('SELECT result FROM package_extension_operations WHERE id=?')
            .get(operation.id)!.result
        )
      )
    ).toEqual(result);
    const backup = exportChatBackup(store, chat.id),
      restored = importChatBackup(store, { backup, idempotencyKey: 'failed-result' });
    const saved = store.db
      .prepare('SELECT status,result FROM package_extension_operations WHERE chat_id=?')
      .get(restored.chat.id)!;
    expect(saved.status).toBe('failed');
    expect(JSON.parse(String(saved.result))).toEqual(result);
    expect(
      store.db
        .prepare('SELECT count(*) AS n FROM package_behavior_journal WHERE chat_id=?')
        .get(restored.chat.id)!.n
    ).toBe(0);
    expect(
      store.db
        .prepare('SELECT count(*) AS n FROM package_behavior_states WHERE chat_id=?')
        .get(restored.chat.id)!.n
    ).toBe(0);
    const forged = structuredClone(backup);
    (forged.records.extensionOperations[0].result as { programHash: string }).programHash =
      'b'.repeat(64);
    expect(() =>
      importChatBackup(store, { backup: forged, idempotencyKey: 'invalid-failed-result' })
    ).toThrow('Archive data or references invalid');
  }
);

test('an operation cannot claim failure while its ui action journal records adoption', () => {
  const { store, chat, operation, snapshot, command, pkg } = fixture();
  const claimed = claimExtensionOperation(store, operation.id, 'worker')!;
  const result = {
    state: { n: 1 },
    result: 'adopted',
    programHash: behaviorPayloadHash(pkg.behavior!.actions[0].program),
    engine: 'synthetic',
  };
  store.transaction(() => {
    store.behavior.executeInTransaction(
      snapshot.scope,
      pkg.behavior!,
      command,
      snapshot.runtime,
      result
    );
    finishExtensionOperationInTransaction(
      store,
      claimed,
      'failed',
      result,
      { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
      'forged failure'
    );
  });
  expect(() => exportChatBackup(store, chat.id)).toThrow('uncompleted operation adopted');
});
