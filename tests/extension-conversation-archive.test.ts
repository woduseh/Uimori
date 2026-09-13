import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { RunSnapshot } from '../core/types.js';
import { exportChatBackup, importChatBackup } from '../server/chat-backup.js';
import { forkChat } from '../server/chat-fork.js';
import {
  captureExtensionConversation,
  extensionConversationViewHash,
  resolveExtensionConversation,
} from '../server/extension-conversation.js';
import { mapForkSnapshot, validateRunSnapshot } from '../server/snapshot-archive.js';
import { Store } from '../server/store.js';
import { createFixtureChat, fixtureBotInput } from './fixtures/chat.js';
import type { ExtensionOperationSnapshot } from '../core/extension-operation.js';
import {
  createExtensionOperation,
  claimExtensionOperation,
  finishExtensionOperationInTransaction,
} from '../server/extension-operations.js';
import { behaviorPayloadHash } from '../server/package-behavior-store.js';

const owned: { store: Store; directory: string }[] = [];
afterEach(() => {
  for (const { store, directory } of owned.splice(0)) {
    store.close();
    const within = relative(tmpdir(), directory);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !within.startsWith('uimori-conversation-archive-')
    )
      throw new Error('Unsafe test cleanup');
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-conversation-archive-'));
  const store = new Store(join(directory, 'test.sqlite'));
  owned.push({ store, directory });
  const chat = createFixtureChat(store, 'Conversation archive');
  store.settings(chat.id, chat.settingsRevision, {
    ...chat.settings,
    translation: false,
    status: false,
  });
  const create = (request: string, capture = false) => {
    const current = store.chat(chat.id);
    const profile = store.product.snapshot(chat.id);
    const run = store.createRun(
      chat.id,
      {
        request,
        expectedRevision: current.headRevision,
        expectedSettingsRevision: current.settingsRevision,
        idempotencyKey: randomUUID(),
      },
      (admitted) => ({
        chatId: chat.id,
        branchId: `main:${chat.id}`,
        parentRevision: admitted.headRevision,
        settingsRevision: admitted.settingsRevision,
        settings: admitted.settings,
        request,
        history: store.history(admitted.headRevision),
        resources: store.product.resources(chat.id, profile),
        profile,
      })
    ).run;
    if (capture) {
      const snapshot = store.run(run.id).snapshot;
      snapshot.extensionConversation = captureExtensionConversation(store, snapshot, {
        admissionRunId: run.id,
      });
      store.db
        .prepare('UPDATE runs SET snapshot=? WHERE id=?')
        .run(JSON.stringify(snapshot), run.id);
    }
    store.startRun(run.id);
    return store.run(run.id);
  };
  const complete = (request: string, text: string, capture = false) => {
    const run = create(request, capture);
    store.completeRun(
      run.id,
      text,
      { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
      run.snapshot.settings
    );
    return store.run(run.id);
  };
  const first = complete('First request', 'First response');
  const failed = create('Failed request');
  store.finishRun(failed.id, 'failed', 'synthetic failure', 'Retained partial');
  const final = complete('Final request', 'Final response', true);
  return { store, chat, first, failed, final, create, complete };
}

test('conversation archive validates order, body hash, admission and ownership without reconstructing old snapshots', () => {
  const { store, first, final } = fixture();
  expect(() => validateRunSnapshot(store, final.snapshot, final.id)).not.toThrow();
  expect(first.snapshot.extensionConversation).toBeUndefined();
  const view = resolveExtensionConversation(
    store,
    final.snapshot,
    final.snapshot.extensionConversation
  );
  expect(view).toEqual([
    { role: 'user', text: 'First request' },
    { role: 'assistant', text: 'First response' },
    { role: 'user', text: 'Failed request' },
    { role: 'assistant', text: 'Retained partial' },
  ]);
  for (const corrupt of [
    (snapshot: RunSnapshot) => {
      snapshot.extensionConversation!.messages.reverse();
    },
    (snapshot: RunSnapshot) => {
      snapshot.extensionConversation!.messages[0].hash = '0'.repeat(64);
    },
    (snapshot: RunSnapshot) => {
      snapshot.extensionConversation!.admissionRunId = first.id;
    },
    (snapshot: RunSnapshot) => {
      snapshot.extensionConversation!.branchId = 'another-branch';
    },
    (snapshot: RunSnapshot) => {
      snapshot.extensionConversation!.messages.splice(0, 2);
    },
    (snapshot: RunSnapshot) => {
      Object.assign(snapshot.extensionConversation!.messages[0], {
        text: 'Unexpected duplicated body',
      });
    },
  ]) {
    const snapshot = structuredClone(final.snapshot);
    corrupt(snapshot);
    expect(() => validateRunSnapshot(store, snapshot, final.id)).toThrow();
  }
});

test('fork remap preserves evidence and rejects absent failed-request dependencies', () => {
  const { first, failed, final } = fixture();
  const snapshot = structuredClone(final.snapshot);
  snapshot.chatId = 'destination';
  snapshot.branchId = 'main:destination';
  snapshot.parentRevision = 'destination-source';
  const sources = new Map([[first.sourceRevision!, 'destination-source']]);
  const runs = new Map([
    [first.id, 'first-copy'],
    [failed.id, 'failed-copy'],
    [final.id, 'final-copy'],
  ]);
  const originalHashes = snapshot.extensionConversation!.messages.map((ref) => ref.hash);
  mapForkSnapshot(snapshot, sources, runs);
  expect(snapshot.extensionConversation).toMatchObject({
    chatId: 'destination',
    branchId: 'main:destination',
    parentRevision: 'destination-source',
    admissionRunId: 'final-copy',
  });
  expect(snapshot.extensionConversation!.messages.map((ref) => ref.hash)).toEqual(originalHashes);
  runs.delete(failed.id);
  expect(() => mapForkSnapshot(structuredClone(final.snapshot), sources, runs)).toThrow(
    'fork run dependency'
  );
});

test('backup retains failed requests and partials, remaps admission, and leaves old snapshots absent', () => {
  const { store, chat, final } = fixture();
  const before = extensionConversationViewHash(
    resolveExtensionConversation(store, final.snapshot, final.snapshot.extensionConversation)
  );
  const backup = exportChatBackup(store, chat.id);
  const restored = importChatBackup(store, { backup, idempotencyKey: 'conversation-copy' });
  const rows = store.db.prepare('SELECT id FROM runs WHERE chat_id=?').all(restored.chat.id);
  expect(rows).toHaveLength(3);
  const copied = rows
    .map((row) => store.run(String(row.id)))
    .find((run) => run.request === 'Final request')!;
  expect(copied.snapshot.extensionConversation!.admissionRunId).toBe(copied.id);
  expect(
    copied.snapshot.extensionConversation!.messages.every((ref) => ref.runId !== final.id)
  ).toBe(true);
  const after = extensionConversationViewHash(
    resolveExtensionConversation(store, copied.snapshot, copied.snapshot.extensionConversation)
  );
  expect(after).toBe(before);
  expect(
    rows
      .map((row) => store.run(String(row.id)))
      .filter((run) => run.snapshot.extensionConversation === undefined)
  ).toHaveLength(2);
});

test('fork carries frozen conversation dependencies beyond completed source ancestry', () => {
  const { store, chat, final } = fixture();
  const forked = forkChat(store, chat.id, {
    fromRevision: final.sourceRevision,
    idempotencyKey: 'conversation-fork',
  });
  const copied = store.run(store.source(forked.headRevision!).runId);
  expect(
    resolveExtensionConversation(store, copied.snapshot, copied.snapshot.extensionConversation)
  ).toEqual(
    resolveExtensionConversation(store, final.snapshot, final.snapshot.extensionConversation)
  );
  expect(
    store.db.prepare('SELECT COUNT(*) n FROM attempts WHERE chat_id=?').get(forked.id)!.n
  ).toBe(0);
  const backup = exportChatBackup(store, forked.id);
  expect(() => importChatBackup(store, { backup, idempotencyKey: 'fork-backup' })).not.toThrow();
});

test.each(['failed', 'completed'] as const)(
  'operation conversation receipts retain captured permission and reject missing grants or changed view hash (%s)',
  (status) => {
    const directory = mkdtempSync(join(tmpdir(), 'uimori-conversation-archive-'));
    const store = new Store(join(directory, 'test.sqlite'));
    owned.push({ store, directory });
    const input = fixtureBotInput();
    input.package.behavior = {
      revision: 1,
      schemaVersion: 1,
      mode: 'authoritative',
      stateSchema: { type: 'record', properties: {} },
      initialState: {},
      actions: [
        {
          id: 'read',
          triggers: ['user'],
          inputSchema: { type: 'record', properties: {} },
          effects: [],
          program: {
            api: 'uimori-state-action-v1',
            capabilities: ['conversation.read'],
            source: 'throw new Error("restore must not execute");',
          },
        },
      ],
      outputParsers: [],
    };
    const bot = store.product.content(input);
    const chat = store.createChat('Operation conversation', 'calm', { botId: bot.id });
    const profile = store.product.snapshot(chat.id);
    const ref = profile.packageAttachments![0];
    const instanceId = `${ref.id}:${ref.role}`;
    profile.extensionGrants = {
      [instanceId]: { packageRevision: ref.revision, capabilities: ['conversation.read'] },
    };
    const snapshot: ExtensionOperationSnapshot = {
      version: 1,
      scope: {
        chatId: chat.id,
        branchId: `main:${chat.id}`,
        attachmentInstanceId: instanceId,
        packageId: ref.id,
        packageRevision: ref.revision,
        behaviorRevision: 1,
        schemaVersion: 1,
      },
      stateRevision: 0,
      state: {},
      runtime: {},
      guard: 'a'.repeat(64),
      profile,
      settings: chat.settings,
      sourceRevision: null,
      sourceHash: null,
      extensionConversation: captureExtensionConversation(store, {
        chatId: chat.id,
        branchId: `main:${chat.id}`,
        parentRevision: null,
        history: [],
      }),
    };
    const command = {
      actionId: 'read',
      input: {},
      expectedStateRevision: 0,
      expectedSourceHash: null,
      idempotencyKey: 'read-conversation',
    };
    const operation = createExtensionOperation(store, command, snapshot).operation;
    const claimed = claimExtensionOperation(store, operation.id, 'synthetic-owner')!;
    const result = {
      state: {},
      result: null,
      engine: 'synthetic',
      programHash: behaviorPayloadHash(input.package.behavior.actions[0].program),
      conversation: { viewHash: extensionConversationViewHash([]) },
    };
    store.transaction(() => {
      if (status === 'completed')
        store.behavior.executeInTransaction(
          snapshot.scope,
          input.package.behavior!,
          command,
          snapshot.runtime,
          result
        );
      finishExtensionOperationInTransaction(
        store,
        claimed,
        status,
        result,
        { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
        status === 'completed' ? null : 'Synthetic failure after read'
      );
    });
    const backup = exportChatBackup(store, chat.id);
    const restored = importChatBackup(store, { backup, idempotencyKey: 'operation-copy' });
    const row = store.db
      .prepare('SELECT snapshot,result FROM package_extension_operations WHERE chat_id=?')
      .get(restored.chat.id)!;
    const saved = JSON.parse(String(row.snapshot));
    expect(saved.extensionConversation.chatId).toBe(restored.chat.id);
    expect(saved.extensionConversation.branchId).toBe(`main:${restored.chat.id}`);
    expect(JSON.parse(String(row.result)).conversation).toEqual(result.conversation);
    expect(store.product.profile(restored.chat.id).extensionGrants).toBeUndefined();
    const noGrant = structuredClone(backup);
    const record = noGrant.records.extensionOperations[0] as Record<string, any>;
    delete record.snapshot.profile.extensionGrants;
    expect(() =>
      importChatBackup(store, { backup: noGrant, idempotencyKey: 'missing-grant' })
    ).toThrow();
    const changed = structuredClone(backup);
    (changed.records.extensionOperations[0] as Record<string, any>).result.conversation.viewHash =
      '0'.repeat(64);
    expect(() =>
      importChatBackup(store, { backup: changed, idempotencyKey: 'changed-conversation' })
    ).toThrow();
    expect(store.db.prepare('SELECT COUNT(*) n FROM attempts').get()!.n).toBe(0);
    if (status === 'completed') {
      const missingOwner = structuredClone(backup);
      missingOwner.records.extensionOperations = [];
      expect(() =>
        importChatBackup(store, { backup: missingOwner, idempotencyKey: 'missing-ui-owner' })
      ).toThrow(/program receipt/);
    }
  }
);

test('fork preserves retry ordering without copying superseded request bodies and stays ordered after backup', () => {
  const { store, chat, create, complete } = fixture();
  const hidden = create('Retried request');
  store.finishRun(hidden.id, 'failed', 'synthetic');
  const later = create('Later visible failed request');
  store.finishRun(later.id, 'failed', 'synthetic');
  const retry = store.retryRun(hidden.id, 'retry-hidden').run;
  store.startRun(retry.id);
  store.finishRun(retry.id, 'failed', 'synthetic');
  const final = complete('Read reordered history', 'Reordered response', true);
  const before = resolveExtensionConversation(
    store,
    final.snapshot,
    final.snapshot.extensionConversation
  );
  const forked = forkChat(store, chat.id, {
    fromRevision: final.sourceRevision,
    idempotencyKey: 'retry-order-fork',
  });
  expect(
    store.db
      .prepare(
        "SELECT COUNT(*) n FROM runs WHERE chat_id=? AND json_extract(snapshot,'$.forkedFrom.runId')=?"
      )
      .get(forked.id, hidden.id)!.n
  ).toBe(0);
  const copied = store.run(store.source(forked.headRevision!).runId);
  expect(copied.snapshot.forkedFrom!.requestOrder).toBeLessThan(0);
  expect(
    resolveExtensionConversation(store, copied.snapshot, copied.snapshot.extensionConversation)
  ).toEqual(before);
  const backup = exportChatBackup(store, forked.id);
  const restored = importChatBackup(store, { backup, idempotencyKey: 'retry-order-backup' });
  const restoredRun = store.run(store.source(restored.chat.headRevision!).runId);
  expect(
    resolveExtensionConversation(
      store,
      restoredRun.snapshot,
      restoredRun.snapshot.extensionConversation
    )
  ).toEqual(before);
});
