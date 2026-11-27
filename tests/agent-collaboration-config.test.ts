import { describe, expect, test } from 'vitest';
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

describe('JSON validation and detached output', () => {
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
    }
  });
});

test('a template created with a label keeps that title and description and the rest of the template', () => {
  const label = { title: 'Custom collaborator', description: 'Choose the angle yourself.' };
  const agent = createAgentDefinition('lore', 'lore', label);
  expect(agent).toMatchObject({ ...label, tools: ['knowledge', 'notes', 'story'] });
  expect(agent.instructions).toBe(createAgentDefinition('lore', 'lore').instructions);
  expect(() => validateAgentCollaboration({ ...config(), agents: [agent] })).not.toThrow();
});
