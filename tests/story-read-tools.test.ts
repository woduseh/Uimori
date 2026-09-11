import { afterEach, describe, expect, test } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { STORY_READ_TOOLS } from '../core/story-read-tools.js';
import { executeStoryRead, STORY_READ_NAMES } from '../core/story-context.js';
import { executeTool } from '../core/provider.js';
import { createToolCorrectionPolicy } from '../core/tool-outcome.js';
import { sourceHash } from '../core/source-history.js';
import { defaultStoryConfig } from '../core/story.js';
import type { RunSnapshot } from '../core/types.js';
import { MAIN_READ_TOOLS } from '../server/main-request.js';

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
  const note = {
    id: 'author-note',
    chatId: 'chat',
    atRevision: 'middle',
    atHash: history[1].contentHash,
    kind: 'author-note' as const,
    text: 'The keeper calls the harbor home.',
    declaration: { author: 'user', text: 'The keeper calls the harbor home.' },
  };
  const snapshot: RunSnapshot = {
    chatId: 'chat',
    parentRevision: 'latest',
    settingsRevision: 1,
    settings: { preset: 'calm', mode: 'direct', translation: false, status: false, maxCalls: 8 },
    request: 'Synthetic read-only contract check.',
    resources: [],
    history,
    story: {
      config: defaultStoryConfig(),
      state: null,
      waiting: false,
      lineageHash: 'synthetic',
      canonHash: sourceHash('[]'),
      models: {},
      notes: [note],
    },
  };
  // Compile the advertised JSON Schema with the application's real validator, without a DB,
  // listening socket, provider, argument coercion, or silently removed unknown properties.
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
    return { status: response.statusCode, event: response.json() };
  };
  return { call, snapshot, history, note };
}

describe('shared story read schemas and execution', () => {
  test('main exposes every shared source and note tool without a divergent schema', () => {
    expect(STORY_READ_TOOLS.map((tool) => tool.name)).toEqual(STORY_READ_NAMES);
    expect(MAIN_READ_TOOLS.filter((tool) => STORY_READ_NAMES.includes(tool.name))).toEqual(
      STORY_READ_TOOLS
    );
  });

  test('listing and searching discover stable scene numbers that can be read directly', async () => {
    const { call, snapshot, history } = fixture();
    const before = structuredClone(snapshot);
    const page = await call('story.list', { offset: 1, limit: 1 });
    expect(page.status).toBe(200);
    expect(page.event.denied).toBe(false);
    expect(page.event.result).toMatchObject({
      total: 3,
      nextOffset: 2,
      results: [{ sceneNumber: 2, revision: 'middle', hash: history[1].contentHash }],
    });
    const search = await call('story.search', { query: 'COPPER harbor' });
    expect(search.status).toBe(200);
    expect(search.event.result.results).toHaveLength(1);
    expect(search.event.result.results[0].sceneNumber).toBe(2);
    for (const args of [{ sceneNumber: 2 }, { id: 'middle' }, { id: 'middle', sceneNumber: 2 }]) {
      const read = await call('story.read', args);
      expect(read.status).toBe(200);
      expect(read.event.denied).toBe(false);
      expect(read.event.result).toMatchObject({
        sceneNumber: 2,
        text: history[1].text,
        source: { revision: 'middle', hash: history[1].contentHash },
      });
      expect(read.event.result.sceneScope).toEqual(page.event.result.sceneScope);
    }
    expect(snapshot).toEqual(before);
  });

  test('notes list accepts omitted or empty queries and exact note reads retain attribution', async () => {
    const { call, note } = fixture();
    for (const args of [{}, { query: '' }, { query: 'harbor' }]) {
      const listed = await call('notes.list', args);
      expect(listed.status).toBe(200);
      expect(listed.event.denied).toBe(false);
      expect(listed.event.result.results).toMatchObject([{ id: note.id, author: 'user' }]);
    }
    const read = await call('notes.read', { id: note.id, offset: 0, limit: 10 });
    expect(read.status).toBe(200);
    expect(read.event.result).toMatchObject({
      kind: 'author-note',
      author: 'user',
      text: note.text.slice(0, 10),
      atRevision: note.atRevision,
      atHash: note.atHash,
      nextOffset: 10,
    });
  });

  test('advertised schemas reject blank story searches and invalid lookup shapes', async () => {
    const { call } = fixture();
    for (const args of [{}, { query: '' }, { query: ' \n ' }])
      expect((await call('story.search', args)).status).toBe(400);
    for (const args of [{}, { sceneNumber: 0 }, { sceneNumber: 1.5 }, { sceneNumber: '2' }])
      expect((await call('story.read', args)).status).toBe(400);
    expect((await call('story.list', { query: '' })).status).toBe(400);
    expect((await call('story.list', { limit: 101 })).status).toBe(400);
    expect((await call('notes.read', { sceneNumber: 1 })).status).toBe(400);
    expect((await call('notes.read', { id: 'author-note', limit: 16001 })).status).toBe(400);
  });

  test('schema-valid identifiers still obey exact ancestry and matching identity checks', async () => {
    const { call, snapshot } = fixture();
    const before = structuredClone(snapshot);
    for (const [name, args] of [
      ['story.read', { id: 'other-branch' }],
      ['story.read', { sceneNumber: 4 }],
      ['story.read', { id: 'start', sceneNumber: 2 }],
      ['notes.read', { id: 'another-chat-note' }],
    ] as const) {
      const denied = await call(name, args);
      expect(denied.status).toBe(200);
      expect(denied.event.denied).toBe(true);
      expect(denied.event.result).not.toHaveProperty('text');
    }
    expect(snapshot).toEqual(before);
  });

  test('blank model searches can be corrected while source-integrity failures remain terminal', () => {
    const { snapshot } = fixture();
    const correction = createToolCorrectionPolicy();
    const read = (name: string, args: Record<string, unknown>) =>
      executeTool(snapshot, { callId: 'read', name, args }, undefined, 'translation');
    const badQuery = read('story.search', { query: ' \n ' });
    expect(badQuery).toMatchObject({
      denied: true,
      errorKind: 'recoverable',
      result: { code: 'INVALID_ARGUMENTS' },
    });
    expect(correction(badQuery, { query: ' \n ' })).toBe('continue');
    for (const [name, args] of [
      ['story.list', {}],
      ['story.search', { query: 'copper' }],
    ] as const) {
      const corrected = read(name, args);
      expect(corrected.denied).toBe(false);
      expect(correction(corrected, args)).toBe('continue');
    }
    snapshot.history[1].contentHash = sourceHash('Different original');
    const corrupt = read('story.read', { sceneNumber: 2 });
    expect(corrupt).toMatchObject({ denied: true, result: { code: 'RESOURCE_UNAVAILABLE' } });
    expect(corrupt.errorKind).toBeUndefined();
    expect(correction(corrupt, { sceneNumber: 2 })).toBe('denied');
  });
});
