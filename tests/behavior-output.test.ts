import { describe, expect, it } from 'vitest';
import { projectBehaviorOutputs } from '../core/behavior-output.js';
import type { PackageBehavior } from '../core/package-behavior.js';

function definition(): PackageBehavior {
  return {
    revision: 1,
    schemaVersion: 1,
    stateSchema: {
      type: 'record',
      properties: {
        count: { type: 'number', min: 0, max: 10, integer: true },
        seen: { type: 'boolean' },
      },
    },
    initialState: { count: 0, seen: false },
    actions: [],
    outputParsers: [
      {
        id: 'count',
        format: 'json',
        fields: [{ path: ['count'], from: ['count'], valueType: 'number' }],
      },
      {
        id: 'seen',
        when: { op: 'typedEqual', args: [{ context: ['state', 'count'] }, 0] },
        format: 'json',
        fields: [{ path: ['seen'], from: ['seen'], valueType: 'boolean' }],
      },
    ],
  };
}

describe('pure behavior output projection', () => {
  it('evaluates conditions against the original state and applies enabled parsers sequentially', () => {
    const behavior = definition();
    const state = { count: 0, seen: false };
    const projected = projectBehaviorOutputs(
      behavior,
      ['count', 'seen'],
      state,
      JSON.stringify({ count: 2, seen: true }),
      {}
    );
    expect(projected).toEqual({ count: 2, seen: true });
    expect(state).toEqual({ count: 0, seen: false });
    (projected as { count: number }).count = 9;
    expect(state).toEqual({ count: 0, seen: false });
  });

  it('keeps the store error contract for selected IDs and overlapping parser paths', () => {
    const behavior = definition();
    expect(() => projectBehaviorOutputs(behavior, [], behavior.initialState, '{}')).toThrow(
      'BEHAVIOR_PARSER_IDS'
    );
    expect(() =>
      projectBehaviorOutputs(behavior, ['missing'], behavior.initialState, '{}')
    ).toThrow('BEHAVIOR_PARSER_UNKNOWN');
    expect(() =>
      projectBehaviorOutputs(behavior, ['count', 'count'], behavior.initialState, '{}')
    ).toThrow('BEHAVIOR_PARSER_IDS');
    behavior.outputParsers[1].fields[0].path = ['count'];
    expect(() =>
      projectBehaviorOutputs(behavior, ['count', 'seen'], behavior.initialState, '{}')
    ).toThrow('BEHAVIOR_OVERLAPPING_PARSERS');
  });
});
