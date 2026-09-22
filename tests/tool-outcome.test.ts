import { expect, test } from 'vitest';
import { createToolCorrectionPolicy } from '../core/tool-outcome.js';
import { executeTool } from '../core/provider.js';
import { syntheticResources } from './fixtures/resources.js';
import { MAIN_READ_TOOLS } from '../core/read-tools.js';
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
    executeTool(run, { callId: 'a', name: 'knowledge.read', args: { ids: [id] } });
  for (const id of ['private', 'missing'])
    expect(read(id)).toMatchObject({
      denied: false,
      result: { items: [{ denied: true, error: { code: 'RESOURCE_UNAVAILABLE' } }] },
    });
  expect(JSON.stringify(read('private'))).not.toContain('CANARY');
  const denied = executeTool(run, { callId: 'a', name: 'shell', args: {} });
  expect(createToolCorrectionPolicy()(denied, {})).toBe('denied');
});
test('recoverable feedback stays available to the owning loop budget; unclassified failures stay terminal', () => {
  const event: ToolEvent = {
    callId: 'a',
    name: 'knowledge.search',
    args: {},
    result: { code: 'INVALID_ARGUMENTS' },
    denied: true,
    errorKind: 'recoverable',
  };
  const policy = createToolCorrectionPolicy();
  for (const limit of [101, 102, 103, 104]) expect(policy(event, { limit })).toBe('continue');
  const repeated = createToolCorrectionPolicy();
  expect(repeated(event, { limit: 101, query: 'a' })).toBe('continue');
  expect(repeated(event, { query: 'a', limit: 101 })).toBe('continue');
  expect(createToolCorrectionPolicy()({ ...event, errorKind: undefined }, {})).toBe('denied');
});

test('knowledge search splits whitespace and matches every term independently', () => {
  const run = structuredClone(snapshot);
  run.resources = [
    {
      id: 'harbor',
      chatId: run.chatId,
      kind: 'lore',
      revision: 1,
      title: 'Harbor',
      description: '',
      text: 'The silver lantern marks the northern pier.',
    },
  ];
  for (const query of ['pier lantern', 'LANTERN\t\n pier', '  silver   pier  ']) {
    expect(
      executeTool(run, {
        callId: 'terms',
        name: 'knowledge.search',
        args: { query },
      })
    ).toMatchObject({ denied: false, result: { total: 1, items: [{ id: 'harbor' }] } });
  }
  expect(
    executeTool(run, {
      callId: 'missing',
      name: 'knowledge.search',
      args: { query: 'silver absent' },
    })
  ).toMatchObject({ denied: false, result: { total: 0 } });
});
