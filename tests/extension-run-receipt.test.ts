import { DatabaseSync } from 'node:sqlite';
import { describe, expect, test } from 'vitest';
import { EXTENSION_PROGRAM_API } from '../core/extension-program.js';
import { validatePackageBehavior, type PackageBehavior } from '../core/package-behavior.js';
import { validateExtensionProgramReceipt } from '../server/extension-program-receipt.js';
import {
  behaviorPayloadHash,
  PackageBehaviorStore,
  type BehaviorScope,
} from '../server/package-behavior-store.js';
import type { RunBehaviorEntry } from '../server/package-behavior-run.js';

const scope: BehaviorScope = {
  chatId: 'chat',
  branchId: 'branch',
  attachmentInstanceId: 'package:module',
  packageId: 'package',
  packageRevision: 1,
  behaviorRevision: 1,
  schemaVersion: 1,
};

function definition(): PackageBehavior {
  return validatePackageBehavior({
    revision: 1,
    schemaVersion: 1,
    stateSchema: {
      type: 'record',
      properties: { count: { type: 'number', min: 0, max: 10, integer: true } },
    },
    initialState: { count: 0 },
    actions: [
      {
        id: 'increment',
        triggers: ['model'],
        inputSchema: {
          type: 'record',
          properties: { amount: { type: 'number', min: 1, max: 10, integer: true } },
        },
        effects: [],
        program: {
          api: EXTENSION_PROGRAM_API,
          source: 'return {state:{count:api.state.count+api.input.amount},result:{ok:true}};',
        },
      },
    ],
    outputParsers: [],
  });
}

function receipt(behavior = definition()) {
  return {
    api: EXTENSION_PROGRAM_API,
    programHash: behaviorPayloadHash(behavior.actions[0].program),
    engine: 'synthetic-isolate-v1',
    state: { count: 1 },
    result: { ok: true },
  };
}

function entry(behavior = definition()): RunBehaviorEntry {
  const before = {
    instanceId: scope.attachmentInstanceId,
    packageId: scope.packageId,
    packageRevision: scope.packageRevision,
    role: 'module',
    behaviorRevision: scope.behaviorRevision,
    schemaVersion: scope.schemaVersion,
    stateRevision: 0,
    state: { count: 0 },
    draws: {},
  };
  return {
    instanceId: scope.attachmentInstanceId,
    actionId: 'increment',
    trigger: 'model',
    input: { amount: 1 },
    before,
    after: { ...before, stateRevision: 1, state: { count: 1 } },
    result: { ok: true },
    draws: {},
    drawSeed: null,
    hostRuntime: {},
    program: receipt(behavior),
  };
}

describe('model-triggered extension program receipts', () => {
  test('validates the exact bounded receipt against the frozen action and entry', () => {
    const behavior = definition();
    expect(
      validateExtensionProgramReceipt(receipt(behavior), {
        programHash: behaviorPayloadHash(behavior.actions[0].program),
        stateSchema: behavior.stateSchema,
        state: { count: 1 },
        result: { ok: true },
      })
    ).toEqual(receipt(behavior));

    for (const forged of [
      { ...receipt(behavior), extra: true },
      { ...receipt(behavior), programHash: '0'.repeat(64) },
      { ...receipt(behavior), engine: '' },
      { ...receipt(behavior), state: { count: 11 } },
      { ...receipt(behavior), result: { ok: false } },
    ])
      expect(() =>
        validateExtensionProgramReceipt(forged, {
          programHash: behaviorPayloadHash(behavior.actions[0].program),
          stateSchema: behavior.stateSchema,
          state: { count: 1 },
          result: { ok: true },
        })
      ).toThrow();
  });

  test('commits the bound receipt without evaluating guest source and persists it in the journal', () => {
    const behavior = definition(),
      db = new DatabaseSync(':memory:'),
      store = new PackageBehaviorStore(db, () => 'source');
    try {
      store.init();
      expect(
        store.commitRunActionInTransaction(scope, behavior, entry(behavior), 'source', 'run:key')
      ).toMatchObject({ stateRevision: 1, state: { count: 1 }, actionResult: { ok: true } });
      const row = db.prepare('SELECT payload FROM package_behavior_journal').get() as {
        payload: string;
      };
      expect(JSON.parse(row.payload).program).toEqual(receipt(behavior));
    } finally {
      db.close();
    }
  });

  test.each([
    ['missing', undefined],
    ['wrong action hash', { ...receipt(), programHash: '0'.repeat(64) }],
    ['changed state', { ...receipt(), state: { count: 2 } }],
    ['changed result', { ...receipt(), result: { ok: false } }],
  ])('rejects a %s receipt before changing state', (_name, program) => {
    const behavior = definition(),
      db = new DatabaseSync(':memory:'),
      store = new PackageBehaviorStore(db, () => 'source'),
      value = entry(behavior);
    try {
      store.init();
      value.program = program;
      expect(() =>
        store.commitRunActionInTransaction(scope, behavior, value, 'source', 'run:key')
      ).toThrow();
      expect(store.read(scope, behavior)).toMatchObject({ stateRevision: 0, state: { count: 0 } });
      expect(store.journal(scope)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test.each([
    [
      'invalid input',
      (_behavior: PackageBehavior, value: RunBehaviorEntry) => {
        value.input = { amount: 11 };
      },
    ],
    [
      'disabled condition',
      (behavior: PackageBehavior) => {
        behavior.actions[0].when = false;
      },
    ],
  ])('rejects %s before accepting a valid program receipt', (_name, change) => {
    const behavior = definition(),
      db = new DatabaseSync(':memory:'),
      store = new PackageBehaviorStore(db, () => 'source'),
      value = entry(behavior);
    try {
      store.init();
      change(behavior, value);
      expect(() =>
        store.commitRunActionInTransaction(scope, behavior, value, 'source', 'run:key')
      ).toThrow();
      expect(store.read(scope, behavior)).toMatchObject({ stateRevision: 0, state: { count: 0 } });
      expect(store.journal(scope)).toEqual([]);
    } finally {
      db.close();
    }
  });
});
