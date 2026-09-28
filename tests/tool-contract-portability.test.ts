import { expect, test } from 'vitest';
import { MAIN_READ_TOOLS } from '../core/read-tools.js';
import { HELPER_APP_TOOLS, HELPER_GATEWAY_TOOLS } from '../server/helper-app-tools.js';
import { HELPER_DATA_TOOLS } from '../server/helper-data-tools.js';
import type { Json } from '../core/transport.js';

const record = (value: Json) => value as Record<string, Json>;
const keysDeep = (value: Json): string[] => {
  if (Array.isArray(value)) return value.flatMap(keysDeep);
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => [key, ...keysDeep(child)]);
};

test('provider-facing tool roots stay portable and canonical', () => {
  const tools = [...MAIN_READ_TOOLS, ...HELPER_DATA_TOOLS, ...HELPER_GATEWAY_TOOLS];
  for (const tool of tools) {
    const schema = record(tool.inputSchema);
    expect(schema.type, tool.name).toBe('object');
    expect(schema, tool.name).not.toHaveProperty('oneOf');
    expect(schema, tool.name).not.toHaveProperty('anyOf');
    expect(schema, tool.name).not.toHaveProperty('allOf');
  }

  const knowledge = record(
    MAIN_READ_TOOLS.find((tool) => tool.name === 'knowledge.read')!.inputSchema
  );
  expect(knowledge.required).toEqual(['ids']);
  expect(record(knowledge.properties)).toHaveProperty('ids');
  expect(record(knowledge.properties)).not.toHaveProperty('id');

  const story = record(MAIN_READ_TOOLS.find((tool) => tool.name === 'story.read')!.inputSchema);
  expect(story.required).toEqual(['sceneNumber']);
  expect(record(story.properties)).not.toHaveProperty('id');

  const data = record(HELPER_DATA_TOOLS.find((tool) => tool.name === 'data.read')!.inputSchema);
  expect(data.required).toEqual(['refs']);
  expect(record(data.properties)).not.toHaveProperty('ref');
});

test('helper app mutations keep operation identity host-owned', () => {
  for (const tool of HELPER_APP_TOOLS)
    expect(keysDeep(tool.inputSchema), tool.name).not.toContain('operationId');
});
