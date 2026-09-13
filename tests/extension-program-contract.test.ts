import { DatabaseSync } from 'node:sqlite';
import { validatePackageStarts } from '../core/package-start.js';
import { describe, expect, it } from 'vitest';
import {
  EXTENSION_PROGRAM_API,
  EXTENSION_PROGRAM_MAX_SOURCE_CHARS,
  validateExtensionProgram,
  validateExtensionProgramResult,
} from '../core/extension-program.js';
import {
  evaluateBehaviorAction,
  validatePackageBehavior,
  type PackageBehavior,
} from '../core/package-behavior.js';
import {
  behaviorPayloadHash,
  PackageBehaviorStore,
  type BehaviorScope,
} from '../server/package-behavior-store.js';

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
  return {
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
        inputSchema: {
          type: 'record',
          properties: { amount: { type: 'number', min: 1, max: 10, integer: true } },
        },
        effects: [],
        program: {
          api: EXTENSION_PROGRAM_API,
          source:
            'return { state: { count: api.state.count + api.input.amount }, result: { ok: true } };',
        },
      },
    ],
    outputParsers: [],
  };
}

function database() {
  const db = new DatabaseSync(':memory:');
  const store = new PackageBehaviorStore(db, () => 'source');
  store.init();
  return { db, store };
}

describe('bounded extension state program contract', () => {
  it('accepts only the versioned, bounded function-body contract and exact JSON result shape', () => {
    expect(validateExtensionProgram(definition().actions[0].program)).toEqual(
      definition().actions[0].program
    );
    const readable = {
      ...definition().actions[0].program!,
      capabilities: ['materials.read.self'],
    };
    expect(validateExtensionProgram(readable)).toEqual(readable);
    const allCapabilities = {
      ...definition().actions[0].program!,
      capabilities: ['materials.read.self', 'model.generate', 'response.read.current'],
    };
    expect(validateExtensionProgram(allCapabilities)).toEqual(allCapabilities);
    for (const capabilities of [
      ['network'],
      ['materials.read.self', 'materials.read.self'],
      'materials.read.self',
      [undefined],
      null,
    ])
      expect(() => validateExtensionProgram({ ...readable, capabilities })).toThrow(
        'BEHAVIOR_PROGRAM_CAPABILITIES'
      );
    for (const program of [
      { api: 'uimori-state-action-v2', source: 'return null;' },
      { api: EXTENSION_PROGRAM_API, source: '' },
      { api: EXTENSION_PROGRAM_API, source: 'x'.repeat(EXTENSION_PROGRAM_MAX_SOURCE_CHARS + 1) },
      { api: EXTENSION_PROGRAM_API, source: 'return null;', extra: true },
    ])
      expect(() => validateExtensionProgram(program)).toThrow();

    expect(validateExtensionProgramResult({ state: { count: 1 }, result: { ok: true } })).toEqual({
      state: { count: 1 },
      result: { ok: true },
    });
    for (const result of [
      { state: { count: 1 } },
      { state: { count: 1 }, result: null, extra: true },
      { state: { count: 1 }, result: 'x'.repeat(8_001) },
      { state: { count: 1 }, result: undefined },
    ])
      expect(() => validateExtensionProgramResult(result)).toThrow();
  });

  it('allows explicit program triggers and validates automatic input without mixed effects', () => {
    expect(validatePackageBehavior(definition())).toEqual(definition());
    const disabled = definition();
    disabled.actions[0].triggers = [];
    expect(validatePackageBehavior(disabled).actions[0].triggers).toEqual([]);
    const model = definition();
    model.actions[0].triggers = ['user', 'model'];
    expect(validatePackageBehavior(model).actions[0].triggers).toEqual(['user', 'model']);
    const automatic = definition();
    automatic.actions[0].triggers = ['before-turn'];
    automatic.actions[0].automaticInput = { amount: 1 };
    expect(validatePackageBehavior(automatic)).toEqual(automatic);
    const afterTurn = definition();
    afterTurn.actions[0].triggers = ['after-turn'];
    afterTurn.actions[0].automaticInput = { amount: 1 };
    expect(validatePackageBehavior(afterTurn)).toEqual(afterTurn);
    const declarativeAfterTurn = definition();
    delete declarativeAfterTurn.actions[0].program;
    declarativeAfterTurn.actions[0].triggers = ['after-turn'];
    expect(() => validatePackageBehavior(declarativeAfterTurn)).toThrow(
      'BEHAVIOR_AFTER_TURN_PROGRAM_REQUIRED'
    );
    expect(() =>
      validatePackageStarts(
        [
          {
            id: 'opening',
            title: 'Opening',
            mode: 'authored',
            text: 'Hello',
            initialAction: { actionId: 'increment', input: { literal: { amount: 1 } } },
          },
        ],
        { controls: [], behavior: definition() }
      )
    ).toThrow('PACKAGE_START_PROGRAM_ACTION_UNSUPPORTED');
    for (const change of [
      { effects: [{ path: ['count'], value: 1 }] },
      { result: { context: ['state'] } },
      { draws: [] },
      { automaticInput: { amount: 1 } },
      { triggers: ['before-turn'] },
    ]) {
      const b = definition();
      Object.assign(b.actions[0], change);
      expect(() => validatePackageBehavior(b)).toThrow();
    }
    expect(() =>
      evaluateBehaviorAction(definition(), definition().actions[0], { count: 0 }, { amount: 1 }, {})
    ).toThrow('BEHAVIOR_PROGRAM_REQUIRES_HOST');
  });

  it('commits only a hash-bound host result and journals the receipt for exact replay', () => {
    const { db, store } = database();
    try {
      const behavior = validatePackageBehavior(definition());
      const action = behavior.actions[0];
      const command = {
        actionId: action.id,
        input: { amount: 2 },
        expectedStateRevision: 0,
        expectedSourceHash: 'source',
        idempotencyKey: 'program-1',
      };
      expect(store.preview(scope, behavior, command)).toMatchObject({
        allowed: true,
        requiresDraw: false,
      });
      expect(store.preview(scope, behavior, command)).not.toHaveProperty('projectedState');
      expect(() => store.executeInTransaction(scope, behavior, command)).toThrow(
        'BEHAVIOR_PROGRAM_REQUIRES_EXECUTION'
      );

      const resolved = {
        programHash: behaviorPayloadHash(action.program),
        engine: 'synthetic-isolate-v1',
        state: { count: 2 },
        result: { ok: true },
      };
      const first = store.executeInTransaction(scope, behavior, command, {}, resolved);
      expect(first).toMatchObject({
        stateRevision: 1,
        state: { count: 2 },
        actionResult: { ok: true },
      });
      expect(store.executeInTransaction(scope, behavior, command, {}, resolved)).toEqual(first);
      const row = db.prepare('SELECT payload FROM package_behavior_journal').get() as {
        payload: string;
      };
      expect(JSON.parse(row.payload).program).toEqual({ api: EXTENSION_PROGRAM_API, ...resolved });

      expect(() =>
        store.executeInTransaction(scope, behavior, command, {}, { ...resolved, engine: 'other' })
      ).toThrow('BEHAVIOR_IDEMPOTENCY_CONFLICT');
    } finally {
      db.close();
    }
  });

  it('rejects forged hashes, invalid state, oversized results and receipts on declarative actions', () => {
    for (const resolved of [
      {
        programHash: '0'.repeat(64),
        engine: 'synthetic-isolate-v1',
        state: { count: 1 },
        result: null,
      },
      {
        programHash: behaviorPayloadHash(definition().actions[0].program),
        engine: 'synthetic-isolate-v1',
        state: { count: 11 },
        result: null,
      },
      {
        programHash: behaviorPayloadHash(definition().actions[0].program),
        engine: 'synthetic-isolate-v1',
        state: { count: 1 },
        result: 'x'.repeat(8_001),
      },
    ]) {
      const { db, store } = database();
      try {
        expect(() =>
          store.executeInTransaction(
            scope,
            definition(),
            {
              actionId: 'increment',
              input: { amount: 1 },
              expectedStateRevision: 0,
              expectedSourceHash: 'source',
              idempotencyKey: 'invalid',
            },
            {},
            resolved
          )
        ).toThrow();
        expect(store.journal(scope)).toEqual([]);
      } finally {
        db.close();
      }
    }

    const declarative = definition();
    delete declarative.actions[0].program;
    declarative.actions[0].effects = [{ path: ['count'], value: 1 }];
    const { db, store } = database();
    try {
      expect(() =>
        store.executeInTransaction(
          scope,
          declarative,
          {
            actionId: 'increment',
            input: { amount: 1 },
            expectedStateRevision: 0,
            expectedSourceHash: 'source',
            idempotencyKey: 'unexpected',
          },
          {},
          {
            programHash: '0'.repeat(64),
            engine: 'synthetic-isolate-v1',
            state: { count: 1 },
            result: null,
          }
        )
      ).toThrow('BEHAVIOR_PROGRAM_RESULT_UNEXPECTED');
    } finally {
      db.close();
    }
  });
});
