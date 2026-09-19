import { writeNote } from './fixtures/notes.js';
import { createFixtureChat } from './fixtures/chat.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Store } from '../server/store.js';
import { validateStoryArchive, normalizeStoryArchiveRow } from '../server/story-archive.js';
import { forkChat } from '../server/chat-fork.js';
import { storyTables } from '../server/story-store.js';
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
async function prepared() {
  const store = await database();
  const chat = createFixtureChat(store, 'Synthetic story');
  configure(store, chat.id);
  const first = completeSource(store, chat.id, '[[event:spend]] The moon is blue.');
  const second = completeSource(store, chat.id, 'Mira remembers the harbor.');
  return { store, chat, first, second };
}
function fork(store: Store, chatId: string, fromRevision: string) {
  const copy = forkChat(store, chatId, {
    fromRevision,
    title: 'Copied fixture',
    idempotencyKey: randomUUID(),
  });
  return copy;
}

describe('M2 archive graph and selected-ancestry fork with actual isolated file SQLite', () => {
  test('standalone writing snapshots validate immutable source ancestry and note evidence', async () => {
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
    const changedLineage = structuredClone(snapshot);
    changedLineage.story!.lineageHash = memoryHash('forged ancestry');
    expect(() => validateSnapshot(changedLineage)).toThrow('snapshot lineage mismatch');
    const changedCanon = structuredClone(snapshot);
    changedCanon.story!.canonHash = memoryHash('forged notes');
    expect(() => validateSnapshot(changedCanon)).toThrow('snapshot note hash mismatch');
  });
  test('S03 historical edited sources retain their immutable note anchors and snapshots', async () => {
    const { store, chat, first, second } = await prepared();
    const note = writeNote(store, chat.id, { text: 'The moon is blue.', author: 'fixture' });
    const frozen = structuredClone(store.run(second.runId).snapshot);
    expect(() => validateStoryArchive(store)).not.toThrow();
    store.editSource(first.id, {
      text: 'Edited later, without changing prior snapshots.',
      expectedRevision: 0,
    });
    expect(store.source(first.id).text).toBe('Edited later, without changing prior snapshots.');
    expect(store.sourceAtHash(first.id, first.hash).text).toBe(first.text);
    expect(store.run(second.runId).snapshot).toEqual(frozen);
    expect(store.story.detail(chat.id).notes).toEqual([note]);
    expect(() => validateStoryArchive(store)).not.toThrow();
  });

  test('S03 forged note identity, source anchor and command evidence reject with rollback', async () => {
    const { store, chat, first } = await prepared();
    writeNote(store, chat.id, { text: 'Synthetic correction', author: 'user' });
    const memory = all(store, 'author_notes')[0];
    const attacks: (() => void)[] = [
      () => {
        const entry = JSON.parse(memory.entry);
        entry.id = 'invented-note';
        store.db
          .prepare('UPDATE author_notes SET entry=? WHERE id=?')
          .run(JSON.stringify(entry), memory.id);
      },
      () => {
        const entry = JSON.parse(memory.entry);
        entry.atHash = memoryHash('invented');
        store.db
          .prepare('UPDATE author_notes SET entry=? WHERE id=?')
          .run(JSON.stringify(entry), memory.id);
      },
      () => {
        const entry = JSON.parse(memory.entry);
        entry.atRevision = first.id;
        store.db
          .prepare('UPDATE author_notes SET entry=? WHERE id=?')
          .run(JSON.stringify(entry), memory.id);
      },
      () => {
        const receipt = all(store, 'author_note_commands')[0];
        const result = JSON.parse(receipt.result);
        result.note.text = 'Forged command result';
        store.db
          .prepare('UPDATE author_note_commands SET result=? WHERE chat_id=?')
          .run(JSON.stringify(result), chat.id);
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

  test('S03 restore normalization disables model connections without changing prose or replaying uncertain context work', () => {
    const snapshot = {
      profile: {
        models: {
          main: {
            connection: {
              enabled: true,
              credentialEnv: 'UIMORI_PROVIDER_PRIVATE',
              catalogCredentialEnv: 'UIMORI_PROVIDER_PRIVATE_LIST',
            },
            opaqueState: { secret: 'OPAQUE_CANARY' },
          },
        },
        contextModel: { connection: { enabled: true, credentialEnv: 'UIMORI_PROVIDER_PRIVATE' } },
      },
      opaqueState: { secret: 'OPAQUE_CANARY' },
      history: [{ revision: 'r', text: 'credentialEnv remains ordinary prose.' }],
    };
    const row: Row = { status: 'running', snapshot: JSON.stringify(snapshot) };
    normalizeStoryArchiveRow('context_jobs', row);
    expect(row.status).toBe('interrupted');
    expect(row.error).toContain('explicit retry required');
    expect(JSON.stringify(row)).not.toContain('OPAQUE_CANARY');
    expect(row.snapshot).not.toContain('UIMORI_PROVIDER_PRIVATE');
    const restored = JSON.parse(row.snapshot);
    expect(restored.profile.models.main.connection).toEqual({ enabled: false });
    expect(restored.profile.contextModel.connection).toEqual({ enabled: false });
    expect(restored.history).toEqual(snapshot.history);
    const completed: Row = {
      status: 'completed',
      snapshot: JSON.stringify(snapshot),
      checkpoint: JSON.stringify({ summary: 'Original story events' }),
      error: 'Historical diagnostic',
    };
    normalizeStoryArchiveRow('context_jobs', completed);
    expect(completed.status).toBe('completed');
    expect(completed.error).toBe('Historical diagnostic');
    expect(JSON.parse(completed.checkpoint)).toEqual({ summary: 'Original story events' });
  });

  test('S03 frozen author notes remain independent of later corrections', async () => {
    const { store, chat, second } = await prepared();
    const note = writeNote(store, chat.id, { text: 'The moon is blue.', author: 'fixture' });
    const snapshot = store.story.prepareRunInTransaction({
      ...store.run(second.runId).snapshot,
      parentRevision: second.id,
      history: store.history(second.id),
    });
    const frozen = structuredClone(snapshot);
    const replacement = writeNote(
      store,
      chat.id,
      { text: 'The moon is green.', author: 'fixture' },
      note.id
    );
    expect(snapshot).toEqual(frozen);
    expect(snapshot.story!.notes[0].text).toBe(note.text);
    expect(store.story.detail(chat.id).notes).toEqual([replacement]);
    expect(() => validateStoryArchive(store)(snapshot)).not.toThrow();
  });

  test('S03 R03 fork remaps note and source identities, preserves prose, and copies no attempts', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('External calls forbidden'));
    const { store, chat, second } = await prepared();
    const note = writeNote(store, chat.id, {
      text: 'Mira remembers the harbor.',
      author: 'fixture',
    });
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
    expect(all(store, 'attempts').filter((row) => row.chat_id === copy.id)).toHaveLength(0);
    const copiedNotes = store.story.detail(copy.id).notes;
    expect(copiedNotes).toHaveLength(1);
    expect(copiedNotes[0]).toMatchObject({
      chatId: copy.id,
      text: note.text,
      atRevision: copy.headRevision,
    });
    expect(copiedNotes[0].id).not.toBe(note.id);
    expect(copiedNotes[0].atHash).toBe(note.atHash);
    expect(store.history(copy.headRevision).map((item) => item.text)).toEqual(
      store.history(second.id).map((item) => item.text)
    );
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
    expect(all(store, 'runs').filter((row) => row.chat_id === copy.id)).toHaveLength(1);
    expect(store.history(copy.headRevision).every((item) => item.text !== second.text)).toBe(true);
    expect(() => validateStoryArchive(store)).not.toThrow();
  });

  test('S03 fork retains both original sources without scheduling new background work', async () => {
    const { store, chat, first, second } = await prepared();
    const copy = fork(store, chat.id, second.id);
    expect(store.source(first.id).text).toBe(first.text);
    expect(store.source(second.id).text).toBe(second.text);
    expect(all(store, 'context_jobs').filter((row) => row.chat_id === copy.id)).toEqual([]);
    expect(
      all(store, 'runs')
        .filter((row) => row.chat_id === copy.id)
        .every((row) => row.status === 'completed')
    ).toBe(true);
    expect(() => validateStoryArchive(store)).not.toThrow();
  });
});
