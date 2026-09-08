import { expect, test } from 'vitest';
import { createToolCorrectionPolicy } from '../core/tool-outcome.js';
import { executeTool, syntheticResources } from '../core/provider.js';
import { MAIN_READ_TOOLS } from '../server/main-request.js';
import type { RunSnapshot, ToolEvent } from '../core/types.js';

const snapshot: RunSnapshot = {
  chatId: 'chat-a',
  parentRevision: null,
  settingsRevision: 1,
  settings: { mode: 'research', preset: 'calm', translation: false, status: false, maxCalls: 8 },
  request: 'Synthetic',
  history: [],
  resources: syntheticResources('chat-a'),
};
test('search schema and execution agree at boundaries and reject extra fields', () => {
  const schema = MAIN_READ_TOOLS.find((tool) => tool.name === 'knowledge.search')!
    .inputSchema as any;
  expect(schema.properties.limit).toMatchObject({ minimum: 1, maximum: 100 });
  expect(schema.properties.query.maxLength).toBe(512);
  for (const [limit, denied] of [
    [0, true],
    [1, false],
    [100, false],
    [101, true],
  ] as const)
    expect(
      executeTool(snapshot, { callId: 'a', name: 'knowledge.search', args: { limit } }).denied
    ).toBe(denied);
  expect(
    executeTool(snapshot, { callId: 'a', name: 'knowledge.search', args: { extra: true } })
  ).toMatchObject({ denied: true, errorKind: 'recoverable' });
});
test('missing and private resources retain identical safe failure, unapproved tools stay terminal', () => {
  const run = structuredClone(snapshot);
  run.resources.push({
    id: 'private',
    chatId: 'elsewhere',
    kind: 'lore',
    revision: 1,
    title: 'Secret',
    description: 'Secret',
    text: 'CANARY',
  });
  const read = (id: string) =>
    executeTool(run, { callId: 'a', name: 'knowledge.read', args: { id } });
  expect(read('private')).toEqual(read('missing'));
  expect(JSON.stringify(read('private'))).not.toContain('CANARY');
  const denied = executeTool(run, { callId: 'a', name: 'shell', args: {} });
  expect(createToolCorrectionPolicy()(denied, {})).toBe('denied');
});
test('total corrections are bounded and key ordering does not evade repetition detection', () => {
  const event: ToolEvent = {
    callId: 'a',
    name: 'knowledge.search',
    args: {},
    result: { code: 'INVALID_ARGUMENTS' },
    denied: true,
    errorKind: 'recoverable',
  };
  const policy = createToolCorrectionPolicy();
  for (const limit of [101, 102, 103]) expect(policy(event, { limit })).toBe('continue');
  expect(policy(event, { limit: 104 })).toBe('exhausted');
  const repeated = createToolCorrectionPolicy();
  expect(repeated(event, { limit: 101, query: 'a' })).toBe('continue');
  expect(repeated(event, { query: 'a', limit: 101 })).toBe('exhausted');
  expect(createToolCorrectionPolicy()({ ...event, errorKind: undefined }, {})).toBe('denied');
});
