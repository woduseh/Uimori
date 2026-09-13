import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, relative, resolve, isAbsolute, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.js';
import { createFixtureChat, fixtureBotInput } from './fixtures/chat.js';
import type { Content } from '../core/product.js';
import type { PackageBehavior } from '../core/package-behavior.js';
import { EXTENSION_PROGRAM_API } from '../core/extension-program.js';
import {
  PackageBehaviorStore,
  behaviorPayloadHash,
  type BehaviorScope,
  type BehaviorUpgradeCommand,
} from '../server/package-behavior-store.js';

const databases: DatabaseSync[] = [];
const stores: { store: Store; path: string }[] = [];
function database() {
  const path = mkdtempSync(join(tmpdir(), 'uimori-behavior-upgrade-'));
  const store = new Store(join(path, 'test.sqlite'));
  stores.push({ store, path });
  return store;
}
function transaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const { store, path } of stores.splice(0).reverse()) {
    store.close();
    const rel = relative(resolve(tmpdir()), resolve(path));
    if (
      isAbsolute(rel) ||
      rel.startsWith('..') ||
      !basename(path).startsWith('uimori-behavior-upgrade-')
    )
      throw new Error('Unsafe test cleanup');
    rmSync(path, { recursive: true, force: true });
  }
});
function fixture() {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  const store = new PackageBehaviorStore(db, () => null);
  store.init();
  const behavior: PackageBehavior = {
    revision: 1,
    schemaVersion: 1,
    stateSchema: { type: 'record', properties: { count: { type: 'number', min: 0, max: 100 } } },
    initialState: { count: 8 },
    actions: [],
    outputParsers: [],
  };
  const before: BehaviorScope = {
    chatId: 'chat',
    branchId: 'branch',
    attachmentInstanceId: 'pkg:module',
    packageId: 'pkg',
    packageRevision: 1,
    behaviorRevision: 1,
    schemaVersion: 1,
  };
  store.ensure(before, behavior);
  const scope = { ...before, packageRevision: 2, behaviorRevision: 2 };
  const target = { ...behavior, revision: 2, initialState: { count: 0 } };
  const command: BehaviorUpgradeCommand = {
    mode: 'preserve',
    expectedPackageRevision: 2,
    expectedStateRevision: 0,
    expectedSourceHash: null,
    idempotencyKey: 'upgrade',
    previewId: 'preview',
  };
  const apply = (cmd = command, definition = target) =>
    transaction(db, () => store.upgradeInTransaction(scope, definition, cmd));
  return { db, store, before, scope, target, command, apply };
}

describe('explicit behavior definition upgrades', () => {
  it.each(['preserve', 'program'] as const)(
    'roundtrips %s transitions and rejects forged transition receipts atomically',
    (mode) => {
      const f = fixture();
      const store = database();
      const chat = createFixtureChat(store, 'synthetic upgrade', 'calm');
      const input = fixtureBotInput('synthetic upgrade definition');
      input.package.behavior = { ...f.target, revision: 1 };
      const content = store.product.content(input) as Content;
      const before: BehaviorScope = {
        ...f.before,
        chatId: chat.id,
        branchId: `main:${chat.id}`,
        packageId: content.id,
        attachmentInstanceId: `${content.id}:bot`,
      };
      store.behavior.ensure(before, content.package!.behavior!);
      const target: PackageBehavior = {
        ...f.target,
        ...(mode === 'program'
          ? {
              migration: {
                api: EXTENSION_PROGRAM_API,
                source: 'throw new Error("never run in archive");',
              },
            }
          : {}),
      };
      const latest = store.product.content(
        {
          ...input,
          package: { ...content.package!, behavior: target },
          expectedRevision: content.revision,
        },
        content.id
      ) as Content;
      const scope = { ...before, packageRevision: latest.revision, behaviorRevision: 2 };
      const command = { ...f.command, mode };
      store.transaction(() =>
        store.behavior.upgradeInTransaction(
          scope,
          target,
          command,
          mode === 'program'
            ? {
                programHash: behaviorPayloadHash(target.migration),
                engine: 'synthetic-receipt',
                state: { count: 9 },
                result: null,
              }
            : undefined
        )
      );
      const archive = store.product.export();
      const destination = database();
      expect(destination.product.import(archive)).toMatchObject({ restored: true });
      expect(destination.behavior.storedState(scope)).toEqual(store.behavior.storedState(scope));
      for (const tamper of [
        'previousScope',
        'state',
        'mode',
        'extra',
        'programHash',
        'variables',
      ]) {
        const forged = structuredClone(archive);
        const row = forged.tables.package_behavior_journal.find(
          (r) => JSON.parse(String(r.result)).provenance === 'explicit-upgrade'
        )!;
        const payload = JSON.parse(String(row.payload));
        const result = JSON.parse(String(row.result));
        if (tamper === 'previousScope') payload.previousScope.packageRevision = 999;
        if (tamper === 'state') result.beforeState = { count: 'invalid' };
        if (tamper === 'mode') payload.mode = 'automatic';
        if (tamper === 'extra') payload.actionId = 'unrelated';
        if (tamper === 'programHash')
          payload.program = { ...(payload.program ?? {}), programHash: '0'.repeat(64) };
        if (tamper === 'variables')
          payload.program = {
            ...(payload.program ?? {}),
            variables: {
              beforeRevision: 0,
              beforeHash: behaviorPayloadHash({ revision: 0, values: {} }),
              changes: {},
            },
          };
        row.payload = JSON.stringify(payload);
        row.payload_hash = behaviorPayloadHash(payload);
        row.result = JSON.stringify(result);
        const empty = database();
        expect(() => empty.product.import(forged)).toThrow();
        expect(empty.chats()).toEqual([]);
      }
    }
  );
  it('preserves the current value and old definition receipt with exactly-once replay', () => {
    const f = fixture();
    const receipt = f.apply();
    expect(receipt).toMatchObject({
      state: { count: 8 },
      beforeState: { count: 8 },
      stateRevision: 1,
      provenance: 'explicit-upgrade',
      draws: {},
      drawSeed: null,
    });
    expect(f.store.read(f.scope, f.target).state).toEqual({ count: 8 });
    const payload = JSON.parse(
      String(f.db.prepare('SELECT payload FROM package_behavior_journal').get()!.payload)
    );
    expect(payload.previousScope).toEqual(f.before);
    expect(f.apply()).toEqual(receipt);
    expect(f.store.journal(f.scope)).toHaveLength(1);
    for (const change of [
      { previewId: 'another' },
      { mode: 'program' as const },
      { expectedStateRevision: 1 },
    ])
      expect(() => f.apply({ ...f.command, ...change })).toThrow('IDEMPOTENCY_CONFLICT');
  });

  it('rejects stale revisions, source changes, schema incompatibility and missing state without mutation', () => {
    const f = fixture();
    for (const change of [
      { expectedPackageRevision: 3 },
      { expectedStateRevision: 1 },
      { expectedSourceHash: 'changed' },
    ])
      expect(() => f.apply({ ...f.command, ...change })).toThrow();
    expect(() =>
      f.apply(f.command, {
        ...f.target,
        stateSchema: { type: 'record', properties: { count: { type: 'number', min: 0, max: 3 } } },
      })
    ).toThrow();
    expect(() =>
      transaction(f.db, () =>
        f.store.upgradeInTransaction(
          { ...f.scope, attachmentInstanceId: 'absent' },
          f.target,
          f.command
        )
      )
    ).toThrow('STATE_REQUIRED');
    expect(f.store.storedState(f.before)).toMatchObject({ state: { count: 8 }, stateRevision: 0 });
    expect(f.store.journal(f.before)).toEqual([]);
  });

  it('adopts only a matching host program receipt and replays without supplying execution again', () => {
    const f = fixture();
    const target: PackageBehavior = {
      ...f.target,
      stateSchema: { type: 'record', properties: { label: { type: 'string', maxLength: 20 } } },
      initialState: { label: '' },
      migration: {
        api: EXTENSION_PROGRAM_API,
        source: 'throw new Error("must never run in commit");',
      },
    };
    const command: BehaviorUpgradeCommand = { ...f.command, mode: 'program' };
    const resolved = {
      programHash: behaviorPayloadHash(target.migration),
      engine: 'synthetic-receipt',
      state: { label: '8' },
      result: 'converted',
    };
    expect(() =>
      transaction(f.db, () => f.store.upgradeInTransaction(f.scope, target, command))
    ).toThrow('REQUIRES_EXECUTION');
    expect(() =>
      transaction(f.db, () =>
        f.store.upgradeInTransaction(f.scope, target, command, {
          ...resolved,
          programHash: '0'.repeat(64),
        })
      )
    ).toThrow('RECEIPT_HASH');
    expect(f.store.storedState(f.before)!.state).toEqual({ count: 8 });
    const receipt = transaction(f.db, () =>
      f.store.upgradeInTransaction(f.scope, target, command, resolved)
    );
    expect(receipt).toMatchObject({
      beforeState: { count: 8 },
      state: { label: '8' },
      actionResult: 'converted',
      stateRevision: 1,
    });
    expect(transaction(f.db, () => f.store.upgradeInTransaction(f.scope, target, command))).toEqual(
      receipt
    );
  });

  it('rolls back an adopted transition when the enclosing host transaction fails', () => {
    const f = fixture();
    expect(() =>
      transaction(f.db, () => {
        f.store.upgradeInTransaction(f.scope, f.target, f.command);
        throw new Error('host failure');
      })
    ).toThrow('host failure');
    expect(f.store.storedState(f.before)).toMatchObject({
      state: { count: 8 },
      stateRevision: 0,
      packageRevision: 1,
    });
    expect(f.store.journal(f.before)).toEqual([]);
  });
});
