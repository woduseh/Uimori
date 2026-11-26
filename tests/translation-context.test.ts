import { modelWorkspace, updateModelWorkspace } from '../server/prompt-workspace.js';
import { readRunSnapshot } from '../server/run-projections.js';
import { nativeContent } from './fixtures/native-content.js';
import { writeNote } from './fixtures/notes.js';
import { updateTestProfile } from './fixtures/model-workspace.js';
import { createFixtureChat, fixtureBotInput } from './fixtures/chat.js';
import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { Controls } from '../server/controls.js';
import { auxiliaryBridge } from '../server/auxiliary-bridge.js';
import { runAuxiliaryJob } from '../server/product-auxiliary.js';
import { captureTranslationReferences } from '../server/translation-context.js';
import { translationReader } from '../core/translation-context.js';
import { translationInput } from '../core/auxiliary.js';
import { executeTool, knowledgeReadResults } from '../core/provider.js';
import type { RunSnapshot, ToolEvent } from '../core/types.js';
import type { Connection, ModelPreset } from '../core/product.js';
import { loopbackProvider, writeSse } from './fixtures/loopback-provider.js';
import { translationFixtureSlot } from './fixtures/translation-job.js';

const owned: { store: Store; dir: string }[] = [];
function translationReferences(store: Store, snapshot: RunSnapshot) {
  using captured = captureTranslationReferences(store, snapshot);
  return captured.load();
}
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
function source(store: Store, chatId: string, text = 'Mira spoke softly to Captain Arlen.') {
  const chat = store.chat(chatId);
  const head = chat.headRevision;
  const run = store.createRun(
    chatId,
    {
      request: 'Synthetic scene',
      expectedRevision: head,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
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
    store.completeRun(run.id, text, {
      modelCalls: 0,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
    }).id
  );
}
function configure(store: Store, chatId: string, endpoint: string) {
  const settings = modelWorkspace(store);
  updateModelWorkspace(store, {
    expectedRevision: settings.revision,
    routes: settings.routes,
    translationPolicy: {
      ...settings.translationPolicy,
      judgment: { ...settings.translationPolicy.judgment, enabled: false },
    },
  });
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
  updateTestProfile(store.product, chatId, {
    expectedRevision: prior.revision,

    routes: { ...prior.routes, translation: { id: model.id } },
    image: false,
  });
}
async function execute(store: Store, id: string, _origin: string, events: ToolEvent[] = []) {
  const signal = new AbortController().signal;
  return runAuxiliaryJob(auxiliaryBridge(store, new Controls(), signal), id, 'context-owner', {
    signal,

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
  const snapshot = readRunSnapshot(store, target.runId);
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
  const listed = read(call('translation.search', {})).result;
  expect(listed).toMatchObject({ total: 1 });
  expect(read(call('translation.search', { query: '' })).result).toEqual(listed);
  expect(read(call('translation.search', { query: null })).denied).toBe(true);
  expect(read(call('translation.read', { id: wording.id })).result).toMatchObject({
    text: '앨런 선장, 기다려.',
    source: { sourceRevision: first.id, sourceHash: first.hash, use: 'wording-reference-only' },
  });
  for (const id of [future.id, foreign.id, 'sibling'])
    expect(read(call('translation.read', { id })).denied).toBe(true);
  store.editSource(first.id, { text: 'Changed facts.', expectedRevision: 0 });
  expect(translationReferences(store, snapshot)).toEqual([]);
  const firstSceneNumber = snapshot.history.findIndex((item) => item.revision === first.id) + 1;
  expect(firstSceneNumber).toBeGreaterThan(0);
  expect(
    executeTool(
      snapshot,
      call('story.read', { sceneNumber: firstSceneNumber }),
      undefined,
      'translation'
    ).result
  ).toMatchObject({ text: first.text, source: { hash: first.hash } });
});

test('SQLite wording references keep the latest edited source and completed wording without changing retained execution inputs', () => {
  const store = database();
  const chat = createFixtureChat(store, 'edited wording');
  const original = source(store, chat.id);
  const edited = store.editSource(original.id, {
    text: 'Mira asked Captain Arlen to stay.',
    expectedRevision: 0,
  });
  const previous = store.editTranslation(edited.id, {
    text: '앨런 선장, 머물러 줘.',
    expectedRevision: 0,
    expectedSourceHash: edited.hash,
  });
  const wording = store.editTranslation(edited.id, {
    text: '앨런 선장, 여기 있어 줘.',
    expectedRevision: previous.revision!,
    expectedSourceHash: edited.hash,
  });
  const retainedInput = {
    translationGuide: {
      botId: 'synthetic-bot',
      botTitle: 'Synthetic bot',
      botRevision: 1,
      instructions: 'Preserve relationships. '.repeat(800),
      terms: Array.from({ length: 50 }, (_, index) => ({
        source: `Name ${index}`,
        target: `이름 ${index}`,
        note: 'Use only for this character. '.repeat(50),
      })),
    },
  };
  const storedInput = JSON.stringify(retainedInput);
  store.db.prepare('UPDATE jobs SET input=? WHERE id=?').run(storedInput, wording.id);
  const target = source(store, chat.id);
  const snapshot = readRunSnapshot(store, target.runId);
  const beforeChanges = store.db.prepare('SELECT total_changes() AS count').get();

  expect(translationReferences(store, snapshot)).toEqual([
    {
      id: wording.id,
      revision: wording.revision,
      sourceRevision: edited.id,
      sourceHash: edited.hash,
      text: '앨런 선장, 여기 있어 줘.',
      manual: true,
    },
  ]);
  expect(store.db.prepare('SELECT total_changes() AS count').get()).toEqual(beforeChanges);
  expect(store.db.prepare('SELECT input FROM jobs WHERE id=?').get(wording.id)?.input).toBe(
    storedInput
  );
  expect(store.job(wording.id).input).toEqual(retainedInput);
});

test('overlapping readers retain their captured wording when later edits prune its stored result', () => {
  const store = database();
  const chat = createFixtureChat(store, 'wording under revision');
  const first = source(store, chat.id);
  const edit = (text: string, expectedRevision: number) =>
    store.editTranslation(first.id, { text, expectedRevision, expectedSourceHash: first.hash });
  const original = edit('original wording', 0);
  const target = source(store, chat.id);
  const snapshot = readRunSnapshot(store, target.runId);
  const earlier = captureTranslationReferences(store, snapshot);
  using overlap = captureTranslationReferences(store, snapshot);
  earlier[Symbol.dispose]();
  const later = edit('revised wording', original.revision!);
  using afterEdit = captureTranslationReferences(store, snapshot);
  edit('newest wording', later.revision!);
  expect(
    store.db.prepare('SELECT job_id FROM job_results WHERE job_id=?').get(original.id)
  ).toBeUndefined();
  expect(overlap.load(original.id)).toMatchObject([{ text: 'original wording', id: original.id }]);
  expect(overlap.load(later.id)).toEqual([]);
  expect(afterEdit.load()).toMatchObject([{ text: 'revised wording', id: later.id }]);
});

test('HTTP retrieval reaches older sources and previous wording while authored notes arrive directly in source-time context', async () => {
  const store = database();
  const chat = createFixtureChat(store, 'synthetic');
  const first = source(store, chat.id, 'Captain Arlen asked Mira to use his title.');
  const wording = store.editTranslation(first.id, {
    text: '앨런 선장이라고 불러 줘.',
    expectedRevision: 0,
    expectedSourceHash: first.hash,
  });
  const canon = writeNote(store, chat.id, {
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
      const context = JSON.parse(translationFixtureSlot(wire, 'context'));
      expect(context.previousSources.map((s: any) => s.revision)).not.toContain(first.id);
      expect(JSON.stringify(wire)).toContain(canon.text);
      expect(JSON.stringify(wire)).not.toContain('앨런 선장이라고 불러 줘.');
      expect(wire.stable.tools.map((tool: any) => tool.name)).not.toContain('notes.read');
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
          id: 't',
          name: 'translation.search',
          argumentsDelta: JSON.stringify({ query: 'Captain' }),
        },
        { type: 'done', reason: 'tool_calls' },
      ]);
      return;
    }
    if (results.length === 2) {
      expect(results[0].result.results[0].source.revision).toBe(first.id);
      expect(results[1].result.items[0].id).toBe(wording.id);
      await writeSse(res, [
        {
          type: 'tool_delta',
          index: 0,
          id: 'sr',
          name: 'story.read',
          argumentsDelta: JSON.stringify({
            sceneNumber: results[0].result.results[0].sceneNumber,
          }),
        },
        {
          type: 'tool_delta',
          index: 1,
          id: 'tr',
          name: 'translation.read',
          argumentsDelta: JSON.stringify({ id: wording.id }),
        },
        { type: 'done', reason: 'tool_calls' },
      ]);
      return;
    }
    expect(results[3].result.text).toBe('앨런 선장이라고 불러 줘.');
    await writeSse(res, [
      { type: 'text_delta', delta: '앨런 선장, 잠깐 기다려.' },
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
  const outcome = await execute(store, job.id, server.origin, events);
  expect(outcome?.status, JSON.stringify({ outcome, events })).toBe('completed');
  expect(server.requests).toHaveLength(3);
  expect(events).toHaveLength(4);
  expect(store.product.attempts(chat.id)).toHaveLength(3);
  expect(store.job(job.id).result?.text).toBe('앨런 선장, 잠깐 기다려.');
  expect(store.requestTranslation(target.id).status).toBe('completed');
});

test.each(['missing-scene', 'budget'] as const)(
  'HTTP %s tool result preserves bounded execution and durable job status',
  async (mode) => {
    const store = database();
    const chat = createFixtureChat(store, mode);
    source(store, chat.id, 'A'.repeat(16000));
    source(store, chat.id, 'A later scene.');
    source(store, chat.id, 'The scene before the target.');
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
                argumentsDelta: JSON.stringify({ sceneNumber: 1, limit: 16000 }),
              }))
            : [
                {
                  type: 'tool_delta',
                  index: 0,
                  id: 'r',
                  name: 'story.read',
                  argumentsDelta: JSON.stringify({ sceneNumber: 999 }),
                },
              ];
        await writeSse(res, [...actions, { type: 'done', reason: 'tool_calls' }]);
        return;
      }
      if (mode === 'budget') {
        expect(wire.input.results).toHaveLength(7);
        expect(Buffer.byteLength(JSON.stringify(wire.input.results), 'utf8')).toBeGreaterThan(
          96000
        );
        for (const event of wire.input.results)
          expect(event).toMatchObject({ denied: false, result: { text: 'A'.repeat(16000) } });
      } else
        expect(wire.input.results[0]).toMatchObject({
          denied: true,
          errorKind: 'recoverable',
          result: { code: 'RESOURCE_UNAVAILABLE' },
        });
      await writeSse(res, [
        {
          type: 'text_delta',
          delta: '조용히 기다렸다.',
        },
        { type: 'done', reason: 'stop' },
      ]);
    });
    servers.push(server.close);
    configure(store, chat.id, server.endpoint);
    const target = source(store, chat.id);
    const job = store.requestTranslation(target.id);
    const outcome = await execute(store, job.id, server.origin);
    expect(outcome?.status).toBe('completed');
    expect(count).toBe(2);
    expect(store.job(job.id).result?.text).toBe('조용히 기다렸다.');
  }
);

test('translation lists the compiled references its reads execute against, not stale snapshot copies', () => {
  const store = database();
  const bot = store.product.content({
    ...fixtureBotInput('Mira', 'Mira keeps watch.'),
    package: nativeContent(
      {
        name: 'Mira',
        description: 'Mira keeps watch.',
        character_book: {
          entries: [{ keys: ['harbor'], content: 'The harbor key is brass.', comment: 'Key' }],
        },
      },
      { id: 'stale-lore' }
    ),
  }) as { id: string };
  const chat = createFixtureChat(store, 'stale', { botId: bot.id });
  const target = source(store, chat.id);
  const fixed = readRunSnapshot(store, target.runId);
  const lore = fixed.resources.find((item) => item.id.includes(':lore:'))!;
  lore.title = 'STALE_SNAPSHOT_TITLE';
  const input = translationInput(
    { id: target.id, chatId: chat.id, text: target.text, hash: target.hash },
    {
      revision: target.id,
      bot: null,
      persona: null,
      references: [],
      scene: '',
      previousSources: [],
      instructionRevision: 'synthetic',
      modelPresetRevision: 'synthetic',
    },
    fixed
  );
  expect(input.catalog.map((item) => [item.id, item.title])).toEqual([[lore.id, 'Key']]);
  expect(
    executeTool(fixed, call('knowledge.read', { ids: [lore.id] }), undefined, 'translation').denied
  ).toBe(false);
});

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
              package: nativeContent(
                {
                  name: kind,
                  creator_notes: 'Synthetic relationship',
                  description:
                    kind === 'glossary'
                      ? 'Arlen = 앨런 선장'
                      : `${kind}: Mira addresses Captain Arlen informally.`,
                },
                {},
                kind === 'persona' ? 'persona' : 'module'
              ),
            }
      ) as { id: string; revision: number }
  );
  const chat = createFixtureChat(store, 'roles', { botId: contents[0].id });
  const prior = store.product.profile(chat.id);
  updateTestProfile(store.product, chat.id, {
    expectedRevision: prior.revision,
    packageAttachments: [
      ...prior.packageAttachments!,
      ...contents.slice(1).map(({ id, revision }, index) => ({
        id,
        revision,
        role: index === 0 ? 'persona' : 'module',
      })),
    ],

    routes: prior.routes,
    image: false,
  });
  const target = source(store, chat.id);
  const fixed = readRunSnapshot(store, target.runId);
  for (let i = 0; i < contents.length; i++) {
    const entry = contents[i];
    const resourceId = `package:${entry.id}:${['bot', 'persona', 'module', 'module'][i]}:body`;
    const event = executeTool(
      fixed,
      call('knowledge.read', { ids: [resourceId] }),
      undefined,
      'translation'
    );
    expect(event.denied).toBe(false);
    expect(knowledgeReadResults(event)[0]).toMatchObject({
      source: {
        id: resourceId,
        revision: 1,
        sourceKind: ['bot', 'persona', 'module', 'module'][i],
      },
    });
  }
  expect(
    executeTool(fixed, call('knowledge.search', { query: 'Mira' }), undefined, 'translation').result
  ).toMatchObject({ total: 3 });
  expect(
    executeTool(
      fixed,
      call('knowledge.read', { ids: [`package:${contents[1].id}:persona:body`] }),
      undefined,
      'main'
    ).denied
  ).toBe(false);
});
