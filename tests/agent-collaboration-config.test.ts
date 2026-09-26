import { describe, expect, test, vi } from 'vitest';
import {
  AgentCollaborationError,
  createAgentCollaboration,
  createAgentDefinition,
  validateAgentCollaboration,
  type AgentCollaboration,
  type AgentDefinition,
} from '../core/agent-collaboration.js';

function config(agent: Partial<AgentDefinition> = {}): AgentCollaboration {
  return {
    ...createAgentCollaboration(),
    enabled: true,
    agents: [{ ...createAgentDefinition('custom', 'reviewer'), ...agent }],
  };
}

function rejects(value: unknown, code?: string): void {
  let error: unknown;
  try {
    validateAgentCollaboration(value);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(AgentCollaborationError);
  if (code)
    expect(error).toMatchObject({
      name: 'AgentCollaborationError',
      code: `AGENT_COLLABORATION_${code}`,
      message: `AGENT_COLLABORATION_${code}`,
    });
}

describe('collaboration defaults and editable templates', () => {
  test('starts disabled with independent mutable arrays', () => {
    const first = createAgentCollaboration();
    expect(first).toEqual({
      enabled: false,
      sharedInstructions: '',
      sharedControls: [],
      maxCalls: 3,
      agents: [],
    });
    expect(validateAgentCollaboration(first)).toEqual(first);
    first.sharedControls.push('style');
    first.agents.push(createAgentDefinition('custom', 'first'));
    expect(createAgentCollaboration().sharedControls).toEqual([]);
    expect(createAgentCollaboration().agents).toEqual([]);
  });

  test.each(['character', 'lore', 'custom'] as const)('%s is editable and reads only', (kind) => {
    const agent = createAgentDefinition(kind, 'my-agent_1');
    expect(agent).toMatchObject({
      id: 'my-agent_1',
      model: null,
      trigger: 'on-demand',
      maxCalls: 2,
    });
    expect(agent.title).toMatch(/[가-힣]/u);
    expect(agent.description).toMatch(/[가-힣]/u);
    expect(agent.tools.length).toBeGreaterThan(0);
    expect(
      agent.tools.every((scope) => ['knowledge', 'skills', 'notes', 'story'].includes(scope))
    ).toBe(true);
    agent.title = '직접 편집한 이름';
    agent.instructions = '직접 작성한 지침';
    agent.tools.push('skills');
    expect(validateAgentCollaboration(config(agent)).agents[0]).toEqual(agent);
    expect(createAgentDefinition(kind, 'second').tools).not.toContain('skills');
  });
});

describe('collaboration limits and references', () => {
  test('disabled settings preserve unfinished values but still reject malformed data', () => {
    rejects({ ...createAgentCollaboration(), enabled: true }, 'AGENTS_REQUIRED');
    expect(validateAgentCollaboration({ ...config(), enabled: false }).agents).toHaveLength(1);
    const draft = {
      ...config({ title: '', instructions: '', maxCalls: 0 }),
      enabled: false,
      maxCalls: 0,
      sharedControls: ['deleted-option'],
    };
    expect(validateAgentCollaboration(draft, [])).toEqual(draft);
    expect(() => validateAgentCollaboration({ ...draft, enabled: true }, [])).toThrow(
      'AGENT_COLLABORATION_UNKNOWN_CONTROL'
    );
    rejects({ ...draft, enabled: true, sharedControls: [] }, 'INVALID_TEXT');
    rejects({ ...config({ maxCalls: Number.NaN }), enabled: false }, 'INVALID_LIMIT');
    rejects({ ...createAgentCollaboration(), enabled: 'false' }, 'INVALID_ENABLED');
  });

  test('accepts six agents and enforces shared and individual ceilings independently', () => {
    const value = {
      ...config(),
      maxCalls: 1,
      agents: Array.from({ length: 6 }, (_, index) => ({
        ...createAgentDefinition('custom', `agent-${index}`),
        maxCalls: 6,
      })),
    };
    expect(validateAgentCollaboration(value)).toEqual(value);
    rejects({ ...value, agents: [...value.agents, createAgentDefinition('custom', 'seventh')] });
    rejects({ ...value, agents: [value.agents[0], value.agents[0]] }, 'DUPLICATE_AGENT_ID');
  });

  test.each([
    ['total maxCalls', 1, 12, (value: unknown) => ({ ...config(), maxCalls: value })],
    [
      'agent maxCalls',
      1,
      6,
      (value: unknown) => ({ ...config(), agents: [{ ...config().agents[0], maxCalls: value }] }),
    ],
  ] as const)('%s requires integers within inclusive limits', (_label, min, max, make) => {
    for (const value of [min, max]) expect(validateAgentCollaboration(make(value))).toBeDefined();
    for (const value of [min - 1, max + 1, min + 0.5, NaN, Infinity, -Infinity, String(min), null])
      rejects(make(value), 'INVALID_LIMIT');
  });

  test.each([
    ['title', 1],
    ['description', 0],
    ['instructions', 1],
    ['sharedInstructions', 0],
  ] as const)('%s preserves long text without a separate character limit', (field, min) => {
    const make = (value: unknown) =>
      field === 'sharedInstructions'
        ? { ...config(), [field]: value }
        : { ...config(), agents: [{ ...config().agents[0], [field]: value }] };
    for (const value of ['가'.repeat(min), '가'.repeat(60_001), ' \r\n가\n '])
      expect(validateAgentCollaboration(make(value))).toEqual(make(value));
    for (const value of [null, 1, undefined]) rejects(make(value), 'INVALID_TEXT');
    if (min > 0) rejects(make(''), 'INVALID_TEXT');
  });

  test('legacy output character settings load without converting their value into tokens', () => {
    for (const maxOutputChars of [0, 500, 6000, 20_000]) {
      const legacy = config({ maxOutputChars });
      expect(validateAgentCollaboration(legacy)).toEqual(config());
      expect(legacy.agents[0].maxOutputChars).toBe(maxOutputChars);
    }
    for (const value of [-1, 1.5, NaN, '6000', null])
      rejects(
        { ...config(), agents: [{ ...config().agents[0], maxOutputChars: value }] },
        'INVALID_LIMIT'
      );
  });

  test('agent IDs use bounded ASCII lowercase names and reject unsafe names', () => {
    for (const id of ['a', 'a0_-', `a${'b'.repeat(63)}`])
      expect(validateAgentCollaboration(config({ id })).agents[0].id).toBe(id);
    for (const id of [
      '',
      'A',
      '1a',
      '_a',
      '-a',
      'a.b',
      'a:b',
      '가',
      'a\n',
      'a b',
      'a'.repeat(65),
      '__proto__',
      'constructor',
      'prototype',
    ]) {
      rejects(config({ id }), 'INVALID_AGENT_ID');
      expect(() => createAgentDefinition('custom', id)).toThrow(AgentCollaborationError);
    }
  });

  test('shared controls accept native keys and host aliases, enforce uniqueness and optionally check existence', () => {
    const sharedControls = [
      'Style.Mode:1',
      '_private',
      '한글 옵션',
      'risu-toggle:__proto__',
      'a'.repeat(1500),
    ];
    const value = { ...config(), sharedControls };
    expect(validateAgentCollaboration(value)).toEqual(value);
    expect(validateAgentCollaboration(value, sharedControls)).toEqual(value);
    expect(() => validateAgentCollaboration(value, [])).toThrow(
      'AGENT_COLLABORATION_UNKNOWN_CONTROL'
    );
    expect(() => validateAgentCollaboration(value, [sharedControls[0]])).toThrow(
      'AGENT_COLLABORATION_UNKNOWN_CONTROL'
    );
    const maximum = Array.from({ length: 64 }, (_, index) => `control-${index}`);
    expect(
      validateAgentCollaboration({ ...config(), sharedControls: maximum }).sharedControls
    ).toEqual(maximum);
    rejects({ ...config(), sharedControls: [...maximum, 'extra'] });
    rejects({ ...config(), sharedControls: ['same', 'same'] }, 'DUPLICATE_CONTROL');
    for (const id of ['', 'a'.repeat(1501), 'a\n', '__proto__', 'constructor', 'prototype', 1])
      rejects({ ...config(), sharedControls: [id] }, 'INVALID_CONTROL_ID');
  });

  test('supports both triggers, every read scope, no tools and explicit or inherited models', () => {
    for (const trigger of ['before', 'on-demand'] as const) {
      const value = config({
        trigger,
        tools: ['knowledge', 'skills', 'notes', 'story'],
        model: { id: 'Model.Preset:1' },
      });
      expect(validateAgentCollaboration(value)).toEqual(value);
    }
    expect(validateAgentCollaboration(config({ tools: [], model: null })).agents[0].tools).toEqual(
      []
    );
    rejects(
      { ...config(), agents: [{ ...config().agents[0], trigger: 'after' }] },
      'INVALID_TRIGGER'
    );
    rejects(config({ tools: ['story', 'story'] }), 'DUPLICATE_TOOL');
    for (const scope of ['write', 'terminal', 'constructor', 'STORY', null, { name: 'story' }])
      rejects({ ...config(), agents: [{ ...config().agents[0], tools: [scope] }] }, 'INVALID_TOOL');
    for (const id of ['', '  ', '__proto__', 'constructor', 'prototype', 1, null])
      rejects(
        { ...config(), agents: [{ ...config().agents[0], model: { id } }] },
        'INVALID_MODEL_ID'
      );
    rejects(
      { ...config(), agents: [{ ...config().agents[0], model: 'model-id' }] },
      'INVALID_FIELDS'
    );
  });
});

describe('strict JSON validation and detached output', () => {
  const nestedCases = () => {
    const value = config({ model: { id: 'model-1' } });
    return [
      { object: value, wrap: (object: unknown) => object },
      { object: value.agents[0], wrap: (object: unknown) => ({ ...value, agents: [object] }) },
      {
        object: value.agents[0].model!,
        wrap: (object: unknown) => ({ ...value, agents: [{ ...value.agents[0], model: object }] }),
      },
    ];
  };

  test('rejects missing fields, unknown fields and unsafe keys at every object level', () => {
    for (const { object, wrap } of nestedCases()) {
      for (const key of Object.keys(object)) {
        const missing: Record<string, unknown> = { ...object };
        delete missing[key];
        rejects(wrap(missing), 'INVALID_FIELDS');
      }
      for (const key of ['unexpected', '__proto__', 'constructor', 'prototype'])
        rejects(wrap({ ...object, [key]: 'unexpected' }), 'INVALID_FIELDS');
      rejects(wrap({ ...object, [Symbol('hidden')]: true }), 'INVALID_FIELDS');
      rejects(
        wrap(Object.defineProperty({ ...object }, 'hidden', { value: true })),
        'INVALID_FIELDS'
      );
      rejects(wrap(Object.create(object)), 'INVALID_FIELDS');
      rejects(wrap(Object.assign(Object.create({ inherited: true }), object)), 'INVALID_FIELDS');
    }
  });

  test('does not execute accessors or toJSON hooks', () => {
    const getter = vi.fn(() => {
      throw Error('GETTER_EXECUTED');
    });
    for (const { object, wrap } of nestedCases()) {
      const key = Object.keys(object)[0];
      rejects(
        wrap(Object.defineProperty({ ...object }, key, { enumerable: true, get: getter })),
        'INVALID_FIELDS'
      );
      rejects(wrap({ ...object, toJSON: getter }), 'INVALID_FIELDS');
    }
    const agents = [config().agents[0]];
    Object.defineProperty(agents, '0', { enumerable: true, get: getter });
    rejects({ ...config(), agents }, 'INVALID_LIST');
    expect(getter).not.toHaveBeenCalled();
  });

  test('rejects sparse arrays, added array properties, inherited arrays and non-JSON values', () => {
    for (const value of [null, undefined, [], true, 1, 'config', new Date(), new Map()])
      rejects(value);
    for (const field of ['agents', 'sharedControls', 'tools'] as const) {
      const wrap = (value: unknown) =>
        field === 'tools'
          ? { ...config(), agents: [{ ...config().agents[0], tools: value }] }
          : { ...config(), [field]: value };
      for (const value of [
        undefined,
        null,
        {},
        new Array(1),
        Object.assign([], { extra: true }),
        Object.assign([], { [Symbol('hidden')]: true }),
        Object.setPrototypeOf([], {}),
      ])
        rejects(wrap(value), 'INVALID_LIST');
    }
    const cyclic = config();
    rejects({ ...cyclic, agents: [cyclic] }, 'INVALID_FIELDS');
  });

  test('clones frozen or null-prototype records and every mutable nested container', () => {
    const agent = Object.freeze({
      ...createAgentDefinition('character', 'reader'),
      model: Object.freeze({ id: 'model-1' }),
      tools: Object.freeze(['knowledge', 'story']),
    });
    const value = Object.freeze(
      Object.assign(Object.create(null), {
        ...createAgentCollaboration(),
        enabled: true,
        sharedInstructions: '\r\n공유 지침\n',
        sharedControls: Object.freeze(['style']),
        agents: Object.freeze([agent]),
      })
    );
    const result = validateAgentCollaboration(value, ['style']);
    expect(result).toEqual(value);
    expect(result).not.toBe(value);
    expect(result.agents).not.toBe(value.agents);
    expect(result.agents[0]).not.toBe(agent);
    expect(result.agents[0].model).not.toBe(agent.model);
    expect(result.agents[0].tools).not.toBe(agent.tools);
    expect(result.sharedControls).not.toBe(value.sharedControls);
    result.sharedControls.push('another');
    result.agents[0].tools.push('notes');
    result.agents[0].model!.id = 'another-model';
    result.agents[0].instructions = '수정';
    result.agents.push(createAgentDefinition('custom', 'new'));
    expect(value.sharedControls).toEqual(['style']);
    expect(value.agents).toHaveLength(1);
    expect(agent.model.id).toBe('model-1');
    expect(agent.tools).toEqual(['knowledge', 'story']);
    expect(agent.instructions).not.toBe('수정');
    expect(JSON.parse(JSON.stringify(validateAgentCollaboration(value)))).toEqual(value);
  });
});
