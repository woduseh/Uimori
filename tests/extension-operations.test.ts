import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { Store } from '../server/store.js';
import { createFixtureChat } from './fixtures/chat.js';
import type {
  ExtensionOperationCommand,
  ExtensionOperationSnapshot,
} from '../core/extension-operation.js';
import type { ProviderResult, WireRecord } from '../core/transport.js';
import {
  cancelExtensionOperation,
  claimExtensionOperation,
  createExtensionOperation,
  extensionOperation,
  extensionOperationViews,
  finishExtensionOperationAttempt,
  finishExtensionOperationInTransaction,
  queuedExtensionOperations,
  settleExtensionOperationUsage,
  startExtensionOperationAttempt,
} from '../server/extension-operations.js';

const owned: { store: Store; directory: string }[] = [];
afterEach(() => {
  for (const { store, directory } of owned.splice(0)) {
    store.close();
    const within = relative(tmpdir(), directory);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !within.startsWith('uimori-extension-operation-')
    )
      throw new Error('Unsafe cleanup');
    rmSync(directory, { recursive: true, force: true });
  }
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-extension-operation-'));
  const store = new Store(join(directory, 'synthetic.sqlite'));
  owned.push({ store, directory });
  const chat = createFixtureChat(store, 'Synthetic extension operation');
  const snapshot: ExtensionOperationSnapshot = {
    version: 1,
    scope: {
      chatId: chat.id,
      branchId: store.product.branches(chat.id)[0].id,
      attachmentInstanceId: 'fixture-instance',
      packageId: 'fixture-owner',
      packageRevision: 1,
      behaviorRevision: 1,
      schemaVersion: 1,
    },
    stateRevision: 0,
    state: { n: 0 },
    runtime: {},
    guard: 'fixture-guard',
    profile: store.product.snapshot(chat.id, 'inspect'),
    settings: { ...chat.settings, maxCalls: 1 },
    sourceRevision: null,
    sourceHash: null,
  };
  const command: ExtensionOperationCommand = {
    actionId: 'generate',
    input: null,
    expectedStateRevision: 0,
    expectedSourceHash: null,
    idempotencyKey: 'first',
  };
  return { store, snapshot, command };
}
const wire: WireRecord = {
  connectionId: 'fixture-connection',
  modelId: 'fixture-model',
  protocol: 'fixture-sse-v1',
  role: 'state',
  method: 'POST',
  url: 'http://127.0.0.1:9',
  headers: {},
  body: {},
  bodySha256: '0'.repeat(64),
  stablePrefixSha256: '0'.repeat(64),
};
const usage = { modelCalls: 1, inputTokens: 3, outputTokens: 2, costUsd: null };
const result: ProviderResult = {
  status: 'completed',
  text: 'synthetic',
  toolCalls: [],
  refusal: null,
  error: null,
  usage: { inputTokens: 3, outputTokens: 2, costUsd: null, raw: null, priceRevision: null },
  opaqueState: null,
};

test('durable idempotency rejects changed commands and concurrent actions, independently from prose runs', () => {
  const { store, command, snapshot } = fixture();
  const first = createExtensionOperation(store, command, snapshot);
  expect(createExtensionOperation(store, command, snapshot)).toMatchObject({
    reused: true,
    operation: { id: first.operation.id },
  });
  expect(() => createExtensionOperation(store, { ...command, input: 1 }, snapshot)).toThrow(
    'BEHAVIOR_IDEMPOTENCY_CONFLICT'
  );
  expect(() =>
    createExtensionOperation(store, { ...command, idempotencyKey: 'second' }, snapshot)
  ).toThrow('EXTENSION_OPERATION_ACTIVE');
  expect(store.db.prepare('SELECT count(*) AS n FROM runs').get()!.n).toBe(0);
  cancelExtensionOperation(store, first.operation.id);
  expect(createExtensionOperation(store, command, snapshot).operation.status).toBe('cancelled');
  expect(
    createExtensionOperation(store, { ...command, idempotencyKey: 'second' }, snapshot).reused
  ).toBe(false);
});

test('attempt budget is durable and owner bound; cancellation closes adoption but retains late provider settlement', () => {
  const { store, command, snapshot } = fixture();
  const op = createExtensionOperation(store, command, snapshot).operation;
  const claimed = claimExtensionOperation(store, op.id, 'worker')!;
  expect(claimExtensionOperation(store, op.id, 'other')).toBeNull();
  expect(() => startExtensionOperationAttempt(store, { ...claimed, generation: 0 }, wire)).toThrow(
    'EXTENSION_OPERATION_NOT_ACTIVE'
  );
  const attempt = startExtensionOperationAttempt(store, claimed, wire);
  expect(() => startExtensionOperationAttempt(store, claimed, wire)).toThrow(
    'MODEL_CALL_BUDGET_EXHAUSTED'
  );
  expect(extensionOperationViews(store, op.chatId)[0].usage).toEqual({
    modelCalls: 1,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
  });
  cancelExtensionOperation(store, op.id);
  expect(
    store.transaction(() =>
      finishExtensionOperationInTransaction(store, claimed, 'completed', null, usage, null)
    )
  ).toBe(false);
  expect(() => finishExtensionOperationAttempt(store, 'other', attempt, result)).toThrow(
    'EXTENSION_ATTEMPT_OWNER_MISMATCH'
  );
  finishExtensionOperationAttempt(store, op.id, attempt, result);
  settleExtensionOperationUsage(store, op.id, usage);
  settleExtensionOperationUsage(store, op.id, { ...usage, inputTokens: 999 });
  expect(extensionOperation(store, op.id)).toMatchObject({
    status: 'cancelled',
    owner: null,
    result: null,
    usage,
  });
  expect(
    store.db.prepare('SELECT status,input_tokens FROM attempts WHERE id=?').get(attempt)
  ).toEqual({ status: 'completed', input_tokens: 3 });
});

test('completion and its caller effects roll back together; completed results project no host metadata', () => {
  const { store, command, snapshot } = fixture();
  const claimed = claimExtensionOperation(
    store,
    createExtensionOperation(store, command, snapshot).operation.id,
    'worker'
  )!;
  const output = {
    state: { n: 1 },
    result: 'done',
    programHash: 'a'.repeat(64),
    engine: 'fixture',
  };
  expect(() =>
    store.transaction(() => {
      finishExtensionOperationInTransaction(
        store,
        claimed,
        'completed',
        output,
        { ...usage, modelCalls: 0 },
        null
      );
      throw new Error('rollback');
    })
  ).toThrow('rollback');
  expect(extensionOperation(store, claimed.id).status).toBe('running');
  store.transaction(() =>
    finishExtensionOperationInTransaction(
      store,
      claimed,
      'completed',
      output,
      { ...usage, modelCalls: 0 },
      null
    )
  );
  expect(extensionOperationViews(store, claimed.chatId)[0]).toMatchObject({ hasResult: true });
  expect(extensionOperationViews(store, claimed.chatId)[0].result).toBeUndefined();
  expect(extensionOperation(store, claimed.id).result).toEqual(output);
  expect(cancelExtensionOperation(store, claimed.id).status).toBe('completed');
});

test('restart interrupts queued and running operations and never makes uncertain attempts executable', () => {
  const { store, command, snapshot } = fixture();
  const running = claimExtensionOperation(
    store,
    createExtensionOperation(store, command, snapshot).operation.id,
    'worker'
  )!;
  const attempt = startExtensionOperationAttempt(store, running, wire);
  const queued = createExtensionOperation(store, command, {
    ...snapshot,
    scope: { ...snapshot.scope, attachmentInstanceId: 'second-instance' },
  }).operation;
  store.recover();
  expect(queuedExtensionOperations(store)).toEqual([]);
  for (const op of [running, queued])
    expect(extensionOperation(store, op.id)).toMatchObject({
      status: 'interrupted',
      owner: null,
      generation: op.generation + 1,
    });
  expect(store.db.prepare('SELECT status FROM attempts WHERE id=?').get(attempt)!.status).toBe(
    'interrupted'
  );
  expect(claimExtensionOperation(store, running.id, 'new-worker')).toBeNull();
  expect(createExtensionOperation(store, command, snapshot)).toMatchObject({
    reused: true,
    operation: { status: 'interrupted' },
  });
});
