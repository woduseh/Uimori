import { createFixtureChat, fixtureBotInput } from './fixtures/chat.js';
import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { backup } from 'node:sqlite';
import { Store } from '../server/store.js';
import { Controls } from '../server/controls.js';
import { auxiliaryBridge } from '../server/auxiliary-bridge.js';
import { runAuxiliaryJob } from '../server/product-auxiliary.js';
import { translationReferences } from '../server/translation-context.js';
import { translationReader } from '../core/translation-context.js';
import { executeTool } from '../core/provider.js';
import type { RunSnapshot, ToolEvent } from '../core/types.js';
import type { Connection, ModelPreset } from '../core/product.js';
import { loopbackProvider, writeSse } from './fixtures/loopback-provider.js';

const owned: { store: Store; dir: string }[] = [];
const servers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of servers.splice(0)) await close();
  for (const { store, dir } of owned.splice(0)) {
    store.close();
    const path = relative(resolve(tmpdir()), resolve(dir));
    if (
      isAbsolute(path) ||
      path.startsWith('..') ||
      !path.startsWith('uimori-translation-context-')
    )
      throw Error('Unsafe cleanup');
    rmSync(dir, { recursive: true, force: true });
  }
});
function database() {
  const dir = mkdtempSync(join(tmpdir(), 'uimori-translation-context-'));
  const store = new Store(join(dir, 'test.sqlite'));
  owned.push({ store, dir });
  return store;
}
function source(
  store: Store,
  chatId: string,
  text = 'Mira spoke softly to Captain Arlen.',
  branchId?: string
) {
  const chat = store.chat(chatId);
  const head = store.product.branch(chatId, branchId).headRevision;
  const run = store.createRun(
    chatId,
    {
      request: 'Synthetic scene',
      expectedRevision: head,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
      ...(branchId ? { branchId } : {}),
    },
    (c) => ({
      chatId,
      parentRevision: head,
      settingsRevision: c.settingsRevision,
      settings: { ...c.settings, maxCalls: 8 },
      request: 'Synthetic scene',
      history: store.history(head),
      profile: store.product.snapshot(chatId),
      resources: store.product.resources(chatId, store.product.snapshot(chatId)),
    })
  ).run;
  store.startRun(run.id);
  return store.source(
    store.completeRun(
      run.id,
      text,
      { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
      run.snapshot.settings
    ).id
  );
}
function configure(store: Store, chatId: string, endpoint: string) {
  const connection = store.product.connection({
    title: 'Synthetic loopback',
    protocol: 'fixture-sse-v1',
    endpoint,
    enabled: true,
  }) as Connection;
  const model = store.product.model({
    title: 'Synthetic translator',
    connectionId: connection.id,
    modelId: 'fixture-translation',
    maxOutputTokens: 4000,
    temperature: null,
  }) as ModelPreset;
  const prior = store.product.profile(chatId);
  store.product.updateProfile(chatId, {
    expectedRevision: prior.revision,
    attachments: prior.attachments,
    personaReference: prior.personaReference,
    routes: { ...prior.routes, translation: { id: model.id } },
    image: false,
  });
}
async function execute(store: Store, id: string, origin: string, events: ToolEvent[] = []) {
  const signal = new AbortController().signal;
  return runAuxiliaryJob(auxiliaryBridge(store, new Controls(), signal), id, 'context-owner', {
    signal,
    approvedOrigins: [origin],
    authorize: (c) => store.product.authorize(c),
    onAttemptStart: (w) => store.product.startAttempt(store.job(id).chatId, null, id, w),
    onAttemptFinish: (id, r) => store.product.finishAttempt(id, r),
    onToolEvent: (_id, e) => {
      events.push(e);
    },
  });
}
const call = (name: string, args: Record<string, unknown>, callId = name) => ({
  callId,
  name,
  args,
});

test('SQLite scopes prior wording to frozen ancestry/hash and excludes future, siblings, foreign chats and edited originals', () => {
  const store = database();
  const chat = createFixtureChat(store, 'synthetic');
  const first = source(store, chat.id);
  const wording = store.editTranslation(first.id, {
    text: '앨런 선장, 기다려.',
    expectedRevision: 0,
    expectedSourceHash: first.hash,
  });
  const target = source(store, chat.id);
  const snapshot = store.run(target.runId).snapshot;
  const future = source(store, chat.id);
  store.editTranslation(future.id, {
    text: 'FUTURE',
    expectedRevision: 0,
    expectedSourceHash: future.hash,
  });
  const foreign = source(store, createFixtureChat(store, 'other').id);
  store.editTranslation(foreign.id, {
    text: 'FOREIGN',
    expectedRevision: 0,
    expectedSourceHash: foreign.hash,
  });
  const refs = translationReferences(store, snapshot);
  expect(refs.map((r) => r.id)).toEqual([wording.id]);
  const read = translationReader(snapshot, [
    ...refs,
    {
      id: 'sibling',
      revision: 1,
      sourceRevision: 'sibling',
      sourceHash: first.hash,
      text: 'SIBLING',
      manual: false,
    },
  ]);
  expect(read(call('translation.search', { query: '' })).result).toMatchObject({ total: 1 });
  expect(read(call('translation.read', { id: wording.id })).result).toMatchObject({
    text: '앨런 선장, 기다려.',
    source: { sourceRevision: first.id, sourceHash: first.hash, use: 'wording-reference-only' },
  });
  for (const id of [future.id, foreign.id, 'sibling'])
    expect(read(call('translation.read', { id })).denied).toBe(true);
  store.editSource(first.id, { text: 'Changed facts.', expectedRevision: 0 });
  expect(translationReferences(store, snapshot)).toEqual([]);
  expect(
    executeTool(snapshot, call('story.read', { id: first.id }), undefined, 'translation').result
  ).toMatchObject({ text: first.text, source: { hash: first.hash } });
});

test('HTTP tool discovery/read reaches older-than-two source, typed authored memory and previous wording; SQLite attempts remain explicit', async () => {
  const store = database();
  const chat = createFixtureChat(store, 'synthetic');
  const first = source(store, chat.id, 'Captain Arlen asked Mira to use his title.');
  const wording = store.editTranslation(first.id, {
    text: '앨런 선장이라고 불러 줘.',
    expectedRevision: 0,
    expectedSourceHash: first.hash,
  });
  const canon = store.story.memory.authored(chat.id, {
    text: 'Captain Arlen is addressed as 앨런 선장. Mira speaks informally.',
    author: 'synthetic-author',
  });
  source(store, chat.id, 'The lamps glowed.');
  source(store, chat.id, 'The waves rose.');
  const events: ToolEvent[] = [];
  const server = await loopbackProvider(async (req, res) => {
    const wire = JSON.parse(req.body);
    const results = wire.input.results;
    if (results.length === 0) {
      expect(wire.input.source.context.previousSources.map((s: any) => s.revision)).not.toContain(
        first.id
      );
      expect(JSON.stringify(wire)).not.toContain('앨런 선장이라고 불러 줘.');
      await writeSse(res, [
        {
          type: 'tool_delta',
          index: 0,
          id: 's',
          name: 'story.search',
          argumentsDelta: JSON.stringify({ query: 'Captain' }),
        },
        {
          type: 'tool_delta',
          index: 1,
          id: 'm',
          name: 'memory.search',
          argumentsDelta: JSON.stringify({ query: 'Captain' }),
        },
        {
          type: 'tool_delta',
          index: 2,
          id: 't',
          name: 'translation.search',
          argumentsDelta: JSON.stringify({ query: 'Captain' }),
        },
        { type: 'done', reason: 'tool_calls' },
      ]);
      return;
    }
    if (results.length === 3) {
      expect(results[0].result.results[0].source.revision).toBe(first.id);
      expect(results[1].result.results[0].kind).toBe('author-canon');
      expect(results[2].result.items[0].id).toBe(wording.id);
      await writeSse(res, [
        {
          type: 'tool_delta',
          index: 0,
          id: 'sr',
          name: 'story.read',
          argumentsDelta: JSON.stringify({ id: first.id }),
        },
        {
          type: 'tool_delta',
          index: 1,
          id: 'mr',
          name: 'memory.read',
          argumentsDelta: JSON.stringify({ id: canon.id }),
        },
        {
          type: 'tool_delta',
          index: 2,
          id: 'tr',
          name: 'translation.read',
          argumentsDelta: JSON.stringify({ id: wording.id }),
        },
        { type: 'done', reason: 'tool_calls' },
      ]);
      return;
    }
    expect(results[5].result.text).toBe('앨런 선장이라고 불러 줘.');
    expect(results[4].result.entry.kind).toBe('author-canon');
    const p = wire.input.source;
    await writeSse(res, [
      {
        type: 'text_delta',
        delta: JSON.stringify({
          sourceRevision: p.sourceRevision,
          sourceHash: p.sourceHash,
          chunkId: p.chunkId,
          segments: p.blocks.map((b: any) => ({
            anchors: [b.anchor],
            text: '앨런 선장, 잠깐 기다려.',
          })),
        }),
      },
      { type: 'done', reason: 'stop' },
    ]);
  });
  servers.push(server.close);
  configure(store, chat.id, server.endpoint);
  const target = source(store, chat.id);
  expect(
    store
      .detail(chat.id)
      .jobs.filter((j) => j.sourceRevision === target.id && j.kind === 'translation')
  ).toHaveLength(0);
  const job = store.requestTranslation(target.id);
  const started = performance.now();
  const outcome = await execute(store, job.id, server.origin, events);
  const elapsedMs = performance.now() - started;
  expect(outcome?.status).toBe('completed');
  expect(server.requests).toHaveLength(3);
  expect(events).toHaveLength(6);
  expect(store.product.attempts(chat.id)).toHaveLength(3);
  expect(store.product.chunks(job.id)[0].attempt).toBe(1);
  expect(store.requestTranslation(target.id).status).toBe('completed');
  const output = 'output/playwright/translation-context-20260907';
  mkdirSync(output, { recursive: true });
  writeFileSync(
    join(output, 'measurement.json'),
    JSON.stringify(
      {
        synthetic: true,
        externalCalls: 0,
        requests: 3,
        toolEvents: 6,
        resultBytes: events.reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e)), 0),
        elapsedMs,
        qualityEvaluated: false,
      },
      null,
      2
    )
  );
  await backup(store.db, join(output, 'evidence.sqlite'));
  writeFileSync(join(output, 'tool-events.json'), JSON.stringify(events, null, 2));
});

test('translation tools support empty memory with disabled indexing, bounded paging and immutable wording', () => {
  const snapshot: RunSnapshot = {
    chatId: 'chat',
    parentRevision: 'a',
    history: [{ revision: 'a', text: 'Captain speaks.' }],
    settingsRevision: 1,
    settings: { preset: 'calm', mode: 'direct', translation: true, status: false, maxCalls: 8 },
    request: '',
    resources: [],
  };
  expect(
    executeTool(snapshot, call('story.search', { query: 'Captain' }), undefined, 'translation')
      .denied
  ).toBe(false);
  expect(
    executeTool(snapshot, call('memory.search', { query: 'absent' }), undefined, 'translation')
      .result
  ).toMatchObject({ total: 0 });
  expect(
    executeTool(snapshot, call('story.read', { id: 'future' }), undefined, 'translation').denied
  ).toBe(true);
  expect(executeTool(snapshot, call('story.read', { id: 'a' }), undefined, 'image').denied).toBe(
    true
  );
  const store = database();
  const chat = createFixtureChat(store, 'paging');
  const first = source(store, chat.id);
  store.editTranslation(first.id, {
    text: '가'.repeat(9000),
    expectedRevision: 0,
    expectedSourceHash: first.hash,
  });
  const target = source(store, chat.id);
  const fixed = store.run(target.runId).snapshot;
  const refs = translationReferences(store, fixed);
  const read = translationReader(fixed, refs);
  refs[0].text = 'later';
  expect(read(call('translation.read', { id: refs[0].id })).result).toMatchObject({
    text: '가'.repeat(4096),
    nextOffset: 4096,
  });
  expect(read(call('translation.search', { query: 'absent' })).result).toMatchObject({
    total: 0,
    nextOffset: null,
  });
  for (const args of [
    { id: refs[0].id, limit: 4097 },
    { id: refs[0].id, offset: -1 },
    { id: refs[0].id, unexpected: true },
  ])
    expect(read(call('translation.read', args)).denied).toBe(true);
});

test.each(['denied', 'budget', 'empty'] as const)(
  'HTTP %s tool result preserves bounded execution and durable chunk status',
  async (mode) => {
    const store = database();
    const chat = createFixtureChat(store, mode);
    const first = source(store, chat.id, 'A'.repeat(16000));
    let count = 0;
    const server = await loopbackProvider(async (req, res) => {
      count++;
      const wire = JSON.parse(req.body);
      if (count === 1) {
        const actions =
          mode === 'budget'
            ? Array.from({ length: 7 }, (_, i) => ({
                type: 'tool_delta',
                index: i,
                id: `r${i}`,
                name: 'story.read',
                argumentsDelta: JSON.stringify({ id: first.id, limit: 16000 }),
              }))
            : [
                {
                  type: 'tool_delta',
                  index: 0,
                  id: 'r',
                  name: mode === 'empty' ? 'translation.search' : 'story.read',
                  argumentsDelta: JSON.stringify(
                    mode === 'empty' ? { query: 'absent' } : { id: 'foreign' }
                  ),
                },
              ];
        await writeSse(res, [...actions, { type: 'done', reason: 'tool_calls' }]);
        return;
      }
      const p = wire.input.source;
      expect(wire.input.results[0].result.total).toBe(0);
      await writeSse(res, [
        {
          type: 'text_delta',
          delta: JSON.stringify({
            sourceRevision: p.sourceRevision,
            sourceHash: p.sourceHash,
            chunkId: p.chunkId,
            segments: p.blocks.map((b: any) => ({ anchors: [b.anchor], text: '조용히 기다렸다.' })),
          }),
        },
        { type: 'done', reason: 'stop' },
      ]);
    });
    servers.push(server.close);
    configure(store, chat.id, server.endpoint);
    const target = source(store, chat.id);
    const job = store.requestTranslation(target.id);
    const outcome = await execute(store, job.id, server.origin);
    expect(outcome?.status).toBe(mode === 'empty' ? 'completed' : 'failed');
    expect(count).toBe(mode === 'empty' ? 2 : 1);
    expect(store.product.chunks(job.id)[0].attempt).toBe(1);
    if (mode === 'budget') expect(outcome?.error).toBe('TOOL_CONTEXT_BUDGET_EXHAUSTED');
  }
);

test('translation searches and reads frozen bot/persona/modules even when absent from the lore catalog', () => {
  const store = database();
  const contents = ['bot', 'persona', 'canon', 'glossary'].map(
    (kind) =>
      store.product.content(
        kind === 'bot'
          ? fixtureBotInput('bot', 'bot: Mira addresses Captain Arlen informally.')
          : {
              kind: kind === 'persona' ? 'persona' : 'module',
              title: kind,
              description: 'Synthetic relationship',
              text:
                kind === 'glossary'
                  ? 'Arlen = 앨런 선장'
                  : `${kind}: Mira addresses Captain Arlen informally.`,
              loading: 'pinned',
              relatedIds: [],
            }
      ) as { id: string; revision: number }
  );
  const chat = createFixtureChat(store, 'roles', 'calm', { botId: contents[0].id });
  const prior = store.product.profile(chat.id);
  store.product.updateProfile(chat.id, {
    expectedRevision: prior.revision,
    attachments: contents.slice(1).map(({ id, revision }) => ({ id, revision })),
    personaReference: prior.personaReference,
    routes: prior.routes,
    image: false,
  });
  const target = source(store, chat.id);
  const fixed = store.run(target.runId).snapshot;
  const botResource = fixed.resources.find((entry) => entry.sourceKind === 'bot')!;
  for (let i = 0; i < contents.length; i++) {
    const entry = contents[i];
    const event = executeTool(
      fixed,
      call('knowledge.read', { id: i === 0 ? botResource.id : entry.id }),
      undefined,
      'translation'
    );
    expect(event.denied).toBe(false);
    expect(event.result).toMatchObject({
      source: {
        id: i === 0 ? botResource.id : entry.id,
        revision: 1,
        sourceKind: ['bot', 'persona', 'module', 'module'][i],
      },
    });
  }
  expect(
    executeTool(fixed, call('knowledge.search', { query: 'Mira' }), undefined, 'translation').result
  ).toMatchObject({ total: 3 });
  expect(
    executeTool(fixed, call('knowledge.read', { id: contents[1].id }), undefined, 'main').denied
  ).toBe(true);
});
