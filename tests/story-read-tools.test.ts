import { afterEach, describe, expect, test } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { STORY_READ_TOOLS } from '../core/story-read-tools.js';
import { executeStoryRead, STORY_READ_NAMES } from '../core/story-context.js';
import { sourceHash } from '../core/source-history.js';
import type { RunSnapshot } from '../core/types.js';
import { MAIN_READ_TOOLS } from '../core/read-tools.js';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

function fixture() {
  const history = [
    { revision: 'start', text: 'The keeper lit the lamp.' },
    { revision: 'middle', text: 'A copper tower overlooks the harbor.' },
    { revision: 'latest', text: 'The wind shifted.' },
  ].map((source) => ({ ...source, contentHash: sourceHash(source.text) }));
  const snapshot: RunSnapshot = {
    chatId: 'chat',
    parentRevision: 'latest',
    settingsRevision: 1,
    settings: { status: false, maxCalls: 8 },
    request: 'Synthetic read-only contract check.',
    resources: [],
    history,
  };
  const app = Fastify({ ajv: { customOptions: { coerceTypes: false, removeAdditional: false } } });
  apps.push(app);
  for (const tool of STORY_READ_TOOLS)
    app.post<{ Body: Record<string, unknown> }>(
      `/${tool.name}`,
      { schema: { body: tool.inputSchema } },
      (request) =>
        executeStoryRead(snapshot, { callId: 'read', name: tool.name, args: request.body })
    );
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await app.inject({ method: 'POST', url: `/${name}`, payload: args });
    return {
      status: response.statusCode,
      event: response.statusCode === 200 ? response.json() : null,
    };
  };
  return { call, snapshot, history };
}

describe('compact story read contract', () => {
  test('main exposes one browse/search tool and one scene-number read tool with portable root schemas', () => {
    expect(STORY_READ_TOOLS.map((tool) => tool.name)).toEqual(['story.search', 'story.read']);
    expect(STORY_READ_NAMES).toEqual(['story.search', 'story.read']);
    expect(MAIN_READ_TOOLS.filter((tool) => STORY_READ_NAMES.includes(tool.name))).toEqual(
      STORY_READ_TOOLS
    );
    for (const tool of STORY_READ_TOOLS) {
      expect(tool.inputSchema).toMatchObject({ type: 'object' });
      for (const key of ['oneOf', 'anyOf', 'allOf'])
        expect(tool.inputSchema).not.toHaveProperty(key);
    }
    expect(STORY_READ_TOOLS.find((tool) => tool.name === 'story.read')!.inputSchema).toMatchObject({
      required: ['sceneNumber'],
      properties: { sceneNumber: { type: 'integer', minimum: 1 } },
    });
  });

  test('story.search lists when query is absent or blank and searches when it is present', async () => {
    const { call, history } = fixture();
    for (const args of [
      { offset: 1, limit: 1 },
      { query: '', offset: 1, limit: 1 },
    ]) {
      const page = await call('story.search', args);
      expect(page.status).toBe(200);
      expect(page.event).toMatchObject({
        denied: false,
        result: {
          total: 3,
          nextOffset: 2,
          results: [{ sceneNumber: 2, revision: 'middle', hash: history[1].contentHash }],
        },
      });
    }
    const search = await call('story.search', { query: 'COPPER harbor' });
    expect(search.status).toBe(200);
    expect(search.event.result.results).toMatchObject([
      { sceneNumber: 2, source: { revision: 'middle', hash: history[1].contentHash } },
    ]);
  });

  test('story.read accepts only a valid sceneNumber and returns exact provenance', async () => {
    const { call, history } = fixture();
    const read = await call('story.read', { sceneNumber: 2 });
    expect(read.status).toBe(200);
    expect(read.event).toMatchObject({
      denied: false,
      result: {
        sceneNumber: 2,
        text: history[1].text,
        source: { revision: 'middle', hash: history[1].contentHash },
      },
    });
    for (const args of [
      {},
      { id: 'middle' },
      { sceneNumber: 0 },
      { sceneNumber: 1.5 },
      { sceneNumber: '2' },
      { sceneNumber: 2, id: 'middle' },
      { sceneNumber: 2, limit: 16001 },
    ])
      expect((await call('story.read', args)).status).toBe(400);
    const outside = await call('story.read', { sceneNumber: 4 });
    expect(outside.status).toBe(200);
    expect(outside.event).toMatchObject({
      denied: true,
      result: { code: 'RESOURCE_UNAVAILABLE' },
    });
  });

  test('retired story/list and note read tools are no longer executable', () => {
    const { snapshot } = fixture();
    for (const name of ['story.list', 'notes.list', 'notes.read'])
      expect(executeStoryRead(snapshot, { callId: 'old', name, args: {} })).toMatchObject({
        denied: true,
        result: { code: 'TOOL_NOT_ALLOWED' },
      });
  });
});
