import { writeNote } from './fixtures/notes.js';
import { createFixtureChat } from './fixtures/chat.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Store } from '../server/store.js';
import {
  validateStoryArchive,
  normalizeStoryArchiveRow,
  copyStoryFork,
} from '../server/story-archive.js';
import { forkChat } from '../server/chat-fork.js';
import { runStoryJob } from '../server/story-runner.js';
import { storyDependencyKey, storyTables } from '../server/story-store.js';
import { sourceHash as memoryHash } from '../core/source-history.js';
import type { RunSnapshot } from '../core/types.js';

type Row = Record<string, any>;
const owned: { directory: string; store: Store }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const item of owned.splice(0).reverse()) {
    item.store.close();
    const path = resolve(item.directory);
    const within = relative(resolve(tmpdir()), path);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(path).startsWith('uimori-story-archive-')
    )
      throw new Error('Unsafe test cleanup');
    await rm(path, { recursive: true, force: true });
  }
});
async function database() {
  const directory = await mkdtemp(join(tmpdir(), 'uimori-story-archive-'));
  const store = new Store(join(directory, 'fixture.sqlite'));
  owned.push({ directory, store });
  return store;
}
const all = (store: Store, table: string): Row[] =>
  store.db.prepare(`SELECT * FROM ${table}`).all() as Row[];
function configure(store: Store, chatId: string) {
  const chat = store.chat(chatId);
  store.settings(chatId, chat.settingsRevision, {
    ...chat.settings,
    translation: false,
    status: false,
  });
  return store.story.saveConfig(chatId, {
    expectedRevision: 0,
    stateModel: null,
    module: {
      id: 'coins',
      name: 'Synthetic coins',
      mode: 'authoritative',
      fields: { coins: { type: 'number', initial: 10, min: 0, max: 100 } },
      rules: { spend: { field: 'coins', delta: -3 } },
    },
  });
}
function completeSource(store: Store, chatId: string, text: string, branchId?: string) {
  const chat = store.chat(chatId);
  const branch = store.product.branch(chatId, branchId);
  const request = 'Synthetic archive fixture';
  const { run } = store.createRun(
    chatId,
    {
      request,
      expectedRevision: branch.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
      ...(branchId ? { branchId } : {}),
    },
    (current) =>
      ({
        chatId,
        parentRevision: current.headRevision,
        settingsRevision: current.settingsRevision,
        settings: current.settings,
        request,
        history: store.history(current.headRevision),
        resources: [],
      }) satisfies RunSnapshot
  );
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
async function finish(store: Store) {
  for (const id of store.story.queued()) {
    const job = store.story.claim(id, 'fixture-worker');
    if (!job) continue;
    const result = await runStoryJob(store.story.bundle(id), {
      signal: new AbortController().signal,
      approvedOrigins: [],
      authorize: (value) => value,
      onInput: () => {},
      onToolEvent: () => {},
      onAttemptStart: () => {
        throw new Error('No provider calls');
      },
      onAttemptFinish: () => {},
    });
    expect(result.status).toBe('completed');
    store.story.finish(id, job.generation, 'fixture-worker', result);
  }
}
async function prepared() {
  const store = await database();
  const chat = createFixtureChat(store, 'Synthetic story');
  configure(store, chat.id);
  const first = completeSource(store, chat.id, '[[event:spend]] The moon is blue.');
  await finish(store);
  const second = completeSource(store, chat.id, 'Mira remembers the harbor.');
  await finish(store);
  return { store, chat, first, second };
}
function fork(store: Store, chatId: string, fromRevision: string) {
  const copy = forkChat(store, chatId, {
    fromRevision,
    title: 'Copied fixture',
    idempotencyKey: randomUUID(),
  });
  if (!all(store, 'story_configs').some((row) => row.chat_id === copy.id)) {
    const sources = new Map<string, string>();
    const runs = new Map<string, string>();
    for (const row of all(store, 'runs').filter((row) => row.chat_id === copy.id)) {
      const origin = (JSON.parse(row.snapshot) as RunSnapshot).forkedFrom!;
      sources.set(origin.sourceRevision, row.source_revision);
      runs.set(origin.runId, row.id);
    }
    store.transaction(() => copyStoryFork(store, chatId, copy.id, sources, runs));
  }
  return copy;
}

describe('M2 archive graph and selected-ancestry fork with actual isolated file SQLite', () => {
  test('standalone writing snapshots reuse the source, state, notes and configuration revision validators', async () => {
    const { store, chat, second } = await prepared();
    const note = writeNote(store, chat.id, { text: 'The moon is blue.', author: 'user' });
    const original = store.run(second.runId).snapshot;
    const snapshot = store.story.prepareRunInTransaction({
      ...structuredClone(original),
      parentRevision: second.id,
      history: store.history(second.id),
      executionPurpose: 'artifact',
    });
    const validateSnapshot = validateStoryArchive(store);
    expect(() => validateSnapshot(snapshot)).not.toThrow();
    expect(snapshot.story?.notes[0].id).toBe(note.id);
    const changedNote = structuredClone(snapshot);
    changedNote.story!.notes[0].text = 'A forged correction.';
    changedNote.story!.notes[0].declaration.text = 'A forged correction.';
    expect(() => validateSnapshot(changedNote)).toThrow('snapshot note differs from stored entry');
    const changedState = structuredClone(snapshot);
    changedState.story!.state!.values.coins = 99;
    expect(() => validateSnapshot(changedState)).toThrow('parent state snapshot mismatch');
    const changedConfig = structuredClone(snapshot);
    changedConfig.story!.config.module!.name = 'A forged module revision.';
    expect(() => validateSnapshot(changedConfig)).toThrow('snapshot configuration mismatch');
  });
  test('S03 R03 completed state is recomputed; immutable snapshots and historical edited sources remain valid', async () => {
    const { store, first } = await prepared();
    expect(() => validateStoryArchive(store)).not.toThrow();
    const before = all(store, 'story_states').map((row) => row.body);
    store.editSource(first.id, {
      text: 'Edited later, without changing prior snapshots.',
      expectedRevision: 0,
    });
    expect(
      all(store, 'story_jobs')
        .filter((row) => row.source_revision === first.id)
        .every((row) => row.status === 'stale')
    ).toBe(true);
    expect(() => validateStoryArchive(store)).not.toThrow();
    expect(all(store, 'story_states').map((row) => row.body)).toEqual(before);
  });

  test('S03 R03 poisoned state, config, source identity, immutable dependency and memory evidence reject with rollback', async () => {
    const { store, first } = await prepared();
    const state = all(store, 'story_states')[0];
    const job = all(store, 'story_jobs').find((row) => row.kind === 'state')!;
    writeNote(store, first.chatId, { text: 'Synthetic correction', author: 'user' });
    const memory = all(store, 'author_notes')[0];
    const attacks: (() => void)[] = [
      () => {
        const body = JSON.parse(state.body);
        body.values.coins = 99;
        store.db
          .prepare('UPDATE story_states SET body=? WHERE id=?')
          .run(JSON.stringify(body), state.id);
      },
      () => {
        const body = JSON.parse(all(store, 'story_configs')[0].body);
        body.revision = 99;
        store.db.prepare('UPDATE story_configs SET body=?').run(JSON.stringify(body));
      },
      () => {
        store.db
          .prepare('UPDATE story_jobs SET source_hash=? WHERE id=?')
          .run(memoryHash('invented'), job.id);
      },
      () => {
        const snapshot = JSON.parse(job.snapshot);
        snapshot.story.state.values.coins = 80;
        store.db
          .prepare('UPDATE story_jobs SET snapshot=? WHERE id=?')
          .run(JSON.stringify(snapshot), job.id);
      },
      () => {
        const snapshot = JSON.parse(job.snapshot);
        snapshot.resources = [
          {
            id: 'forged',
            chatId: first.chatId,
            kind: 'lore',
            revision: 1,
            text: 'Forged allowed reference',
          },
        ];
        store.db
          .prepare('UPDATE story_jobs SET snapshot=? WHERE id=?')
          .run(JSON.stringify(snapshot), job.id);
      },
      () => {
        const entry = JSON.parse(memory.entry);
        entry.atHash = memoryHash('invented');
        store.db
          .prepare('UPDATE author_notes SET entry=? WHERE id=?')
          .run(JSON.stringify(entry), memory.id);
      },
    ];
    for (const attack of attacks) {
      const before = JSON.stringify(storyTables.map((table) => all(store, table)));
      expect(() =>
        store.transaction(() => {
          attack();
          validateStoryArchive(store);
        })
      ).toThrow();
      expect(JSON.stringify(storyTables.map((table) => all(store, table)))).toBe(before);
    }
  });

  test('S03 retcon ownership, ancestry and cycles reject without altering authored text', async () => {
    const { store, chat } = await prepared();
    const other = createFixtureChat(store, 'Other');
    const old = writeNote(store, chat.id, {
      text: 'Original authored declaration',
      author: 'fixture',
    });
    const replacement = writeNote(
      store,
      chat.id,
      { text: 'Changed authored declaration', author: 'fixture' },
      old.id
    );
    const foreign = writeNote(store, other.id, {
      text: 'Other chat',
      author: 'fixture',
    });
    expect(() => validateStoryArchive(store)).not.toThrow();
    expect(() =>
      store.transaction(() => {
        store.db
          .prepare('UPDATE author_notes SET replaces_id=? WHERE id=?')
          .run(foreign.id, replacement.id);
        validateStoryArchive(store);
      })
    ).toThrow();
    expect(() =>
      store.transaction(() => {
        store.db
          .prepare('UPDATE author_notes SET replaces_id=? WHERE id=?')
          .run(replacement.id, old.id);
        validateStoryArchive(store);
      })
    ).toThrow('cycle');
    expect(
      JSON.parse(all(store, 'author_notes').find((row) => row.id === old.id)!.entry).text
    ).toBe(old.text);
  });

  test('S03 restore normalization disables nested connections, strips provider continuation and never queues uncertain jobs', async () => {
    const snapshot = {
      profile: {
        models: {
          main: { connection: { enabled: true, credentialEnv: 'NARRATIVE_PROVIDER_PRIVATE' } },
        },
      },
      story: {
        models: {
          state: {
            connection: { enabled: true, credentialEnv: 'NARRATIVE_PROVIDER_PRIVATE' },
            opaqueState: { secret: 'OPAQUE_CANARY' },
          },
        },
      },
      opaqueState: { secret: 'OPAQUE_CANARY' },
      history: [{ revision: 'r', text: 'credentialEnv remains ordinary prose.' }],
    };
    const row: Row = {
      status: 'running',
      owner: 'old-worker',
      snapshot: JSON.stringify(snapshot),
      result: JSON.stringify({ operations: [], opaqueState: { secret: 'OPAQUE_CANARY' } }),
      inputs: JSON.stringify([
        {
          source: { text: 'Original prose' },
          opaqueState: 'OPAQUE_CANARY',
          results: [
            {
              result: {
                text: 'Read prose',
                continuation: { offset: 10 },
                opaqueState: 'OPAQUE_CANARY',
              },
            },
          ],
        },
      ]),
      tool_events: JSON.stringify([
        {
          result: {
            text: 'Read prose',
            continuation: { offset: 10 },
            opaqueState: 'OPAQUE_CANARY',
          },
        },
      ]),
    };
    normalizeStoryArchiveRow('story_jobs', row);
    expect(row).toMatchObject({ status: 'interrupted', owner: null });
    expect(JSON.stringify(row)).not.toContain('OPAQUE_CANARY');
    expect(row.snapshot).not.toContain('NARRATIVE_PROVIDER_PRIVATE');
    const restored = JSON.parse(row.snapshot);
    expect(restored.story.models.state.connection.enabled).toBe(false);
    expect(restored.profile.models.main.connection.enabled).toBe(false);
    expect(restored.history[0].text).toBe(snapshot.history[0].text);
    expect(JSON.parse(row.tool_events)[0].result.continuation).toEqual({ offset: 10 });
    expect(JSON.parse(row.inputs)[0].source.text).toBe('Original prose');
    const run: Row = { status: 'waiting_for_state', snapshot: JSON.stringify(snapshot) };
    normalizeStoryArchiveRow('runs', run);
    expect(run.status).toBe('interrupted');
    const completed: Row = {
      status: 'stale',
      owner: null,
      snapshot: JSON.stringify(snapshot),
      result: JSON.stringify({ operations: [] }),
      error: 'Historical diagnostic',
    };
    normalizeStoryArchiveRow('story_jobs', completed);
    expect(completed.error).toBe('Historical diagnostic');
    expect(completed.status).toBe('stale');
  });

  test('S03 restored model snapshots remain independent of later settings and reject mismatched connection identities', async () => {
    const store = await database();
    const chat = createFixtureChat(store, 'Model snapshot fixture');
    configure(store, chat.id);
    const connection = store.product.connection({
      title: 'Never called',
      protocol: 'fixture-sse-v1',
      endpoint: 'http://127.0.0.1:43819/turn',
      enabled: true,
      credentialEnv: 'NARRATIVE_PROVIDER_SYNTHETIC',
    });
    const model = store.product.model({
      title: 'Immutable model',
      connectionId: connection.id,
      modelId: 'fixture-immutable',
      maxOutputTokens: 1024,
      temperature: null,
    });
    const config = store.story.config(chat.id);
    store.story.saveConfig(chat.id, {
      expectedRevision: config.revision,
      module: config.module,
      stateModel: { id: model.id },
    });
    completeSource(store, chat.id, 'Unfinished requests must not replay.');
    store.product.model(
      {
        title: 'Edited latest model',
        connectionId: connection.id,
        modelId: 'fixture-latest',
        maxOutputTokens: 2048,
        temperature: null,
        expectedRevision: model.revision,
      },
      model.id
    );
    store.product.connection(
      {
        title: 'Edited latest connection',
        protocol: connection.protocol,
        endpoint: 'http://127.0.0.1:43820/turn',
        enabled: true,
        expectedRevision: connection.revision,
      },
      connection.id
    );
    store.transaction(() => {
      for (const table of ['runs', 'story_jobs'])
        for (const row of all(store, table)) {
          normalizeStoryArchiveRow(table, row);
          if (table === 'runs')
            store.db
              .prepare('UPDATE runs SET snapshot=?,status=?,error=? WHERE id=?')
              .run(row.snapshot, row.status, row.error, row.id);
          else
            store.db
              .prepare('UPDATE story_jobs SET snapshot=?,status=?,owner=?,error=? WHERE id=?')
              .run(row.snapshot, row.status, row.owner, row.error, row.id);
        }
      validateStoryArchive(store);
    });
    expect(store.story.queued()).toEqual([]);
    const job = all(store, 'story_jobs').find((row) => row.kind === 'state')!;
    expect(job.snapshot).not.toContain('NARRATIVE_PROVIDER_SYNTHETIC');
    expect(() =>
      store.transaction(() => {
        const snapshot = JSON.parse(job.snapshot);
        snapshot.story.models.state.connectionId = 'another-connection';
        store.db
          .prepare('UPDATE story_jobs SET snapshot=? WHERE id=?')
          .run(JSON.stringify(snapshot), job.id);
        validateStoryArchive(store);
      })
    ).toThrow();
    expect(() =>
      store.transaction(() => {
        const row = all(store, 'story_configs')[0];
        const body = JSON.parse(row.body);
        body.stateModel = { id: 'invented-model' };
        store.db
          .prepare('UPDATE story_configs SET body=? WHERE chat_id=? AND revision=?')
          .run(JSON.stringify(body), row.chat_id, row.revision);
        validateStoryArchive(store);
      })
    ).toThrow();
  });

  test('S03 R03 fork remaps source/state/memory identities and dependency keys, preserves prose, and copies no attempts', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('External calls forbidden'));
    const { store, chat, second } = await prepared();
    const before = Object.fromEntries(
      storyTables.map((table) => [
        table,
        all(store, table).filter((row) => row.chat_id === chat.id),
      ])
    );
    const copy = fork(store, chat.id, second.id);
    expect(() => validateStoryArchive(store)).not.toThrow();
    expect(
      Object.fromEntries(
        storyTables.map((table) => [
          table,
          all(store, table).filter((row) => row.chat_id === chat.id),
        ])
      )
    ).toEqual(before);
    const copiedJobs = all(store, 'story_jobs').filter((row) => row.chat_id === copy.id);
    expect(copiedJobs).toHaveLength(2);
    expect(all(store, 'attempts').filter((row) => row.chat_id === copy.id)).toHaveLength(0);
    for (const row of copiedJobs) {
      const snapshot = JSON.parse(row.snapshot);
      expect(snapshot.chatId).toBe(copy.id);
      expect(row.inputs).toBe('[]');
      expect(row.tool_events).toBe('[]');
      expect(row.dependency_key).toBe(
        storyDependencyKey(row.kind, { id: row.source_revision, hash: row.source_hash }, snapshot)
      );
      expect(snapshot.story.state.id).not.toContain(chat.id);
      expect(row.owner).toBeNull();
    }
    expect(store.history(copy.headRevision).map((item) => item.text)).toEqual(
      store.history(second.id).map((item) => item.text)
    );
    expect(store.story.detail(copy.id).state?.values).toEqual({ coins: 7 });
    expect(store.story.detail(copy.id).notes).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('R03 fork excludes sibling retcons and preserves only selected ancestry', async () => {
    const { store, chat, first, second } = await prepared();
    const declaration = writeNote(store, chat.id, {
      text: 'A declaration anchored after the selected source.',
      author: 'fixture',
    });
    const copy = fork(store, chat.id, first.id);
    expect(store.history(copy.headRevision)).toHaveLength(1);
    expect(
      all(store, 'author_notes')
        .filter((row) => row.chat_id === copy.id)
        .some((row) => JSON.parse(row.entry).text === declaration.text)
    ).toBe(false);
    expect(all(store, 'story_jobs').filter((row) => row.chat_id === copy.id)).toHaveLength(1);
    expect(
      all(store, 'story_jobs')
        .filter((row) => row.chat_id === copy.id)
        .every((row) => row.source_hash !== second.hash)
    ).toBe(true);
    expect(() => validateStoryArchive(store)).not.toThrow();
  });

  test('S03 fork omits unresolved artifacts and reports exclusions while retaining the original source', async () => {
    const { store, chat, first, second } = await prepared();
    const firstStateJob = all(store, 'story_jobs').find(
      (row) => row.kind === 'state' && row.source_revision === first.id
    )!;
    store.db.prepare("UPDATE story_jobs SET status='stale' WHERE id=?").run(firstStateJob.id);
    const copy = fork(store, chat.id, second.id);
    expect(all(store, 'story_states').filter((row) => row.chat_id === copy.id)).toHaveLength(0);
    expect(
      store.events(copy.id, 0).some((event) => (event as Row).kind === 'story.fork.excluded')
    ).toBe(true);
    expect(store.source(first.id).text).toBe(first.text);
    expect(store.source(second.id).text).toBe(second.text);
    expect(
      all(store, 'story_jobs')
        .filter((row) => row.chat_id === copy.id)
        .every((row) => row.status === 'completed')
    ).toBe(true);
    expect(() => validateStoryArchive(store)).not.toThrow();
  });
});
