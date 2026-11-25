import { expect, test } from 'vitest';
import { mainShellTool } from '../core/main-shell.js';
import { providerToolNames } from '../core/provider-tool-names.js';
import { MAIN_READ_TOOLS } from '../core/read-tools.js';
import {
  HELPER_APP_TOOLS,
  HELPER_GATEWAY_TOOLS,
  HELPER_OPERATION_AREAS,
  helperGatewayTools,
} from '../server/helper-app-tools.js';
import { HELPER_DATA_TOOLS, HELPER_SHELL_TOOL } from '../server/helper-data-tools.js';
import type { Json } from '../core/transport.js';

const record = (value: Json) => value as Record<string, Json>;
const keysDeep = (value: Json): string[] => {
  if (Array.isArray(value)) return value.flatMap(keysDeep);
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => [key, ...keysDeep(child)]);
};

test('provider-facing tool roots stay portable and canonical', () => {
  const tools = [...MAIN_READ_TOOLS, HELPER_SHELL_TOOL, ...HELPER_GATEWAY_TOOLS];
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

test('writer read and helper tools describe each top-level argument', () => {
  const tools = [
    mainShellTool(true),
    ...MAIN_READ_TOOLS,
    HELPER_SHELL_TOOL,
    ...HELPER_GATEWAY_TOOLS,
    ...HELPER_APP_TOOLS,
  ];
  for (const tool of tools)
    for (const [name, property] of Object.entries(record(record(tool.inputSchema).properties)))
      expect(record(property).description, `${tool.name}.${name}`).toEqual(expect.any(String));
});

test('unambiguous provider aliases survive reordering and colliding tools get distinct names', () => {
  expect(providerToolNames(['data.exec', 'knowledge.read'])).toEqual([
    'data_exec',
    'knowledge_read',
  ]);
  expect(providerToolNames(['knowledge.read', 'data.exec'])).toEqual([
    'knowledge_read',
    'data_exec',
  ]);
  expect(providerToolNames(['knowledge.read', 'knowledge_read'])).toEqual([
    'knowledge_read',
    'knowledge_read_2',
  ]);
});

test('the helper gateway lists every available operation under a described area', () => {
  const areas = new Set(HELPER_OPERATION_AREAS.map(([area]) => area));
  const [catalog] = HELPER_GATEWAY_TOOLS;
  for (const tool of HELPER_APP_TOOLS)
    expect(areas.has(tool.name.slice(0, tool.name.indexOf('.'))), tool.name).toBe(true);
  for (const [area, purpose] of HELPER_OPERATION_AREAS) {
    if (area === 'story') continue;
    const operations = HELPER_APP_TOOLS.filter((tool) => tool.name.startsWith(`${area}.`)).map(
      (tool) => tool.name.slice(area.length + 1)
    );
    expect(catalog.description).toContain(`${area} (${purpose}): ${operations.join(', ')}`);
  }
  expect(catalog.description).not.toContain('story (');
  const [review] = helperGatewayTools(true);
  expect(review.description).toContain('outline (plot outline and writing plans): read;');
  expect(review.description).toContain('story (frozen story history of this task): search, read');
  expect(review.description).not.toContain('patch');
});
