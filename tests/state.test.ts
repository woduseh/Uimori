import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  initialState,
  reduceStateProposal,
  validateStateModule,
  validateStateProposal,
  validateStateValues,
  type StateModule,
  type StateProposal,
} from '../core/state.js';

const text = '🌙 Mira spent three coins and entered the harbor. The gate was open.';
const source = {
  revision: 'source-a',
  hash: createHash('sha256').update(text).digest('hex'),
  text,
};
const evidence = (quote: string) => ({
  start: text.indexOf(quote),
  end: text.indexOf(quote) + quote.length,
  quote,
});
const module = (): StateModule => ({
  id: 'journey',
  revision: 1,
  name: 'Synthetic journey',
  mode: 'authoritative',
  fields: {
    coins: {
      type: 'number',
      initial: 10,
      min: 0,
      max: 100,
      description: 'Available coins; spend-three deducts exactly 3.',
    },
    location: { type: 'enum', initial: 'road', values: ['road', 'harbor', 'unknown'] },
    note: { type: 'text', initial: '', maxLength: 80 },
    gateOpen: { type: 'boolean', initial: false },
  },
  rules: { 'spend-three': { field: 'coins', delta: -3 } },
});
const proposal = (): StateProposal => ({
  sourceRevision: source.revision,
  sourceHash: source.hash,
  moduleRevision: 1,
  operations: [
    { id: 'spend', kind: 'event', event: 'spend-three', evidence: evidence('spent three coins') },
    {
      id: 'move',
      kind: 'set',
      field: 'location',
      value: 'harbor',
      evidence: evidence('entered the harbor'),
    },
    {
      id: 'gate',
      kind: 'set',
      field: 'gateOpen',
      value: true,
      evidence: evidence('The gate was open'),
    },
  ],
});

describe('M2 deterministic state validation (synthetic evidence; no semantic quality claim)', () => {
  test('S01 versioned event mapping calculates 10 minus 3 as 7 and preserves all inputs', () => {
    const definition = module();
    const previous = initialState(definition);
    const input = proposal();
    const before = JSON.stringify({ definition, previous, input, source });
    const result = reduceStateProposal(definition, previous, input, source);
    expect(result).toEqual({
      values: { coins: 7, location: 'harbor', note: '', gateOpen: true },
      canonical: true,
    });
    expect(reduceStateProposal(definition, previous, input, source)).toEqual(result);
    expect(JSON.stringify({ definition, previous, input, source })).toBe(before);
    const validated = validateStateModule(definition);
    validated.rules['spend-three'].delta = -99;
    expect(definition.rules['spend-three'].delta).toBe(-3);
  });

  test('S01 annotation results are never canonical; continuity is distinct from authoritative', () => {
    const definition = module();
    definition.mode = 'annotation';
    expect(
      reduceStateProposal(definition, initialState(definition), proposal(), source).canonical
    ).toBe(false);
    definition.mode = 'continuity';
    expect(
      reduceStateProposal(definition, initialState(definition), proposal(), source).canonical
    ).toBe(true);
    expect(validateStateModule(definition).mode).toBe('continuity');
  });

  test('S01 exact UTF16 source spans accept whole astral characters and reject invented text and split pairs', () => {
    const input = proposal();
    input.operations = [
      { id: 'moon', kind: 'set', field: 'note', value: 'moon visible', evidence: evidence('🌙') },
    ];
    expect(validateStateProposal(input, module(), source).operations[0].evidence).toEqual({
      start: 0,
      end: 2,
      quote: '🌙',
    });
    for (const invalid of [
      { start: 0, end: 1, quote: text[0] },
      { start: 1, end: 2, quote: text[1] },
      { start: -1, end: 2, quote: '🌙' },
      { start: 0.5, end: 2, quote: '🌙' },
      { start: 0, end: 2, quote: 'sun' },
      { start: 0, end: text.length + 1, quote: text },
    ]) {
      input.operations[0].evidence = invalid;
      expect(() => validateStateProposal(input, module(), source)).toThrow(/STATE_EVIDENCE/);
    }
  });

  test('S01 nonnumeric sets enforce field allowlist, enums, boolean type, text bounds and forbid numeric assignments', () => {
    const input = proposal();
    for (const [field, value] of [
      ['coins', 7],
      ['unknown', true],
      ['location', 'invented'],
      ['gateOpen', 'true'],
      ['note', 'x'.repeat(81)],
    ]) {
      const invalid = {
        ...input,
        operations: [
          { id: 'set', kind: 'set', field, value, evidence: evidence('entered the harbor') },
        ],
      };
      expect(() => validateStateProposal(invalid, module(), source)).toThrow(/STATE_/);
    }
  });

  test('S01 unknown keys and provider-invented deltas cannot override module rules', () => {
    const input = proposal();
    expect(() => validateStateProposal({ ...input, canonical: true }, module(), source)).toThrow(
      'STATE_FIELDS_INVALID'
    );
    expect(() =>
      validateStateProposal(
        { ...input, operations: [{ ...input.operations[0], delta: 100 }] },
        module(),
        source
      )
    ).toThrow('STATE_FIELDS_INVALID');
    expect(() =>
      validateStateProposal(
        { ...input, operations: [{ ...input.operations[0], event: 'gain-million' }] },
        module(),
        source
      )
    ).toThrow('STATE_EVENT_UNKNOWN');
    expect(() =>
      validateStateProposal(
        {
          ...input,
          operations: [
            {
              ...input.operations[0],
              evidence: { ...input.operations[0].evidence, sourceRevision: 'other' },
            },
          ],
        },
        module(),
        source
      )
    ).toThrow('STATE_FIELDS_INVALID');
  });

  test('S03 source revision/hash mismatch or corrupted source fails without rewriting previous values', () => {
    const definition = module();
    const previous = initialState(definition);
    const before = { ...previous };
    for (const input of [
      { ...proposal(), sourceRevision: 'sibling' },
      { ...proposal(), sourceHash: '0'.repeat(64) },
    ]) {
      expect(() => reduceStateProposal(definition, previous, input, source)).toThrow(
        'STATE_SOURCE_MISMATCH'
      );
    }
    expect(() =>
      reduceStateProposal(definition, previous, proposal(), { ...source, text: `${text} altered` })
    ).toThrow('STATE_SOURCE_IDENTITY_INVALID');
    expect(previous).toEqual(before);
  });

  test('S03 changed rule revision invalidates proposals; duplicate operation IDs reject retries inside one proposal', () => {
    const definition = module();
    definition.revision = 2;
    expect(() => validateStateProposal(proposal(), definition, source)).toThrow(
      'STATE_RULE_REVISION_MISMATCH'
    );
    const input = proposal();
    input.operations.push({ ...input.operations[0] });
    expect(() => validateStateProposal(input, module(), source)).toThrow(
      'STATE_DUPLICATE_OPERATION'
    );
  });

  test('S01 S03 the same numeric evidence cannot charge twice under different operation IDs or aliased event names', () => {
    const definition = module();
    definition.rules['alias-spend'] = { field: 'coins', delta: -3 };
    const previous = initialState(definition);
    const before = { ...previous };
    for (const event of ['spend-three', 'alias-spend']) {
      const input = proposal();
      input.operations.push({
        id: 'different-opaque-id',
        kind: 'event',
        event,
        evidence: evidence('spent three coins'),
      });
      expect(() => reduceStateProposal(definition, previous, input, source)).toThrow(
        'STATE_EVIDENCE_REUSED'
      );
      expect(previous).toEqual(before);
    }
    const repeatedSet = proposal();
    repeatedSet.operations.push({
      id: 'another-set-id',
      kind: 'set',
      field: 'location',
      value: 'harbor',
      evidence: evidence('entered the harbor'),
    });
    expect(() => validateStateProposal(repeatedSet, definition, source)).toThrow(
      'STATE_EVIDENCE_REUSED'
    );
  });

  test('S01 two disjoint same-event purchases are legitimate and each deducts exactly once', () => {
    const narrative = 'Mira spent three coins. Later she spent three coins.';
    const current = {
      revision: 'two-purchases',
      text: narrative,
      hash: createHash('sha256').update(narrative).digest('hex'),
    };
    const quote = 'spent three coins';
    const first = narrative.indexOf(quote);
    const second = narrative.lastIndexOf(quote);
    const input: StateProposal = {
      sourceRevision: current.revision,
      sourceHash: current.hash,
      moduleRevision: 1,
      operations: [first, second].map((start, index) => ({
        id: `purchase-${index}`,
        kind: 'event',
        event: 'spend-three',
        evidence: { start, end: start + quote.length, quote },
      })),
    };
    expect(reduceStateProposal(module(), initialState(module()), input, current).values.coins).toBe(
      4
    );
  });

  test('S01 overlapping evidence for the same numeric field fails even with a different rule delta, while different fields may share evidence', () => {
    const definition = module();
    definition.rules['other-spend'] = { field: 'coins', delta: -1 };
    const input = proposal();
    input.operations.push({
      id: 'wider-span',
      kind: 'event',
      event: 'other-spend',
      evidence: evidence('Mira spent three coins'),
    });
    const previous = initialState(definition);
    expect(() => reduceStateProposal(definition, previous, input, source)).toThrow(
      'STATE_EVIDENCE_REUSED'
    );
    expect(previous).toEqual(initialState(definition));
    definition.fields.purchases = { type: 'number', initial: 0, min: 0, max: 10 };
    definition.rules['count-purchase'] = { field: 'purchases', delta: 1 };
    input.operations.pop();
    input.operations.push({
      id: 'count-same-purchase',
      kind: 'event',
      event: 'count-purchase',
      evidence: evidence('spent three coins'),
    });
    expect(
      reduceStateProposal(definition, initialState(definition), input, source).values
    ).toMatchObject({ coins: 7, purchases: 1 });
  });

  test('S03 out-of-range or overflowing reduction rejects all effects instead of clamping or partial mutation', () => {
    const definition = module();
    const previous = { ...initialState(definition), coins: 2 };
    const input = proposal();
    input.operations.reverse();
    expect(() => reduceStateProposal(definition, previous, input, source)).toThrow(
      'STATE_VALUE_OUT_OF_RANGE'
    );
    expect(previous).toEqual({ coins: 2, location: 'road', note: '', gateOpen: false });
    definition.fields.coins = { type: 'number', initial: 1e308, min: 0, max: Number.MAX_VALUE };
    definition.rules['spend-three'].delta = 1e308;
    expect(() =>
      reduceStateProposal(definition, initialState(definition), proposal(), source)
    ).toThrow('STATE_NUMBER_INVALID');
  });

  test('S03 invalid modules reject nonfinite numbers, invalid rules, bounds and undeclared metadata', () => {
    const variants: unknown[] = [
      { ...module(), revision: 0 },
      { ...module(), extra: true },
      { ...module(), fields: { coins: { type: 'number', initial: NaN, min: 0, max: 100 } } },
      { ...module(), fields: { coins: { type: 'number', initial: 10, min: 20, max: 0 } } },
      { ...module(), rules: { spend: { field: 'coins', delta: Infinity } } },
      { ...module(), rules: { spend: { field: 'missing', delta: -3 } } },
      { ...module(), rules: { spend: { field: 'location', delta: -3 } } },
      { ...module(), rules: { spend: { field: 'coins', delta: 0 } } },
      {
        ...module(),
        fields: { location: { type: 'enum', initial: 'road', values: ['road', 'road'] } },
        rules: {},
      },
    ];
    for (const input of variants) expect(() => validateStateModule(input)).toThrow(/STATE_/);
  });

  test('S03 dangerous prototype names, inherited definitions, symbols and getters fail closed', () => {
    const definition = module();
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const fields = JSON.parse(`{"${key}":{"type":"boolean","initial":false}}`);
      expect(() => validateStateModule({ ...definition, fields, rules: {} })).toThrow(
        'STATE_KEY_INVALID'
      );
    }
    expect(() =>
      validateStateModule(Object.assign(Object.create({ inherited: true }), definition))
    ).toThrow('STATE_OBJECT_INVALID');
    expect(() => validateStateModule({ ...definition, [Symbol('hidden')]: true })).toThrow(
      'STATE_KEY_INVALID'
    );
    let invoked = false;
    const input = { ...definition };
    Object.defineProperty(input, 'name', {
      enumerable: true,
      get: () => {
        invoked = true;
        return 'bad';
      },
    });
    expect(() => validateStateModule(input)).toThrow('STATE_KEY_INVALID');
    expect(invoked).toBe(false);
  });

  test('S03 pre-state is complete and typed; absent proposals fail while empty valid changes preserve state', () => {
    const definition = module();
    const previous = initialState(definition);
    expect(() => validateStateValues(definition, { coins: 10 })).toThrow('STATE_FIELDS_INVALID');
    expect(() => validateStateValues(definition, { ...previous, coins: NaN })).toThrow(
      'STATE_NUMBER_INVALID'
    );
    expect(() => reduceStateProposal(definition, previous, null, source)).toThrow(
      'STATE_OBJECT_INVALID'
    );
    expect(
      reduceStateProposal(definition, previous, { ...proposal(), operations: [] }, source).values
    ).toEqual(previous);
  });
});
