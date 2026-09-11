import { afterEach, describe, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Store, HttpError } from '../server/store.js';
import { createFixtureChat } from './fixtures/chat.js';
import { exportChatTranscript, importChatTranscript } from '../server/chat-transcript.js';
import {
  CHAT_TRANSCRIPT_FORMAT,
  CHAT_TRANSCRIPT_LIMITS,
  validateChatTranscript,
} from '../core/chat-transcript.js';
import { editTranslation, successfulTranslation } from '../server/source-editing.js';
import { forkChat } from '../server/chat-fork.js';
import { createApp } from '../server/app.js';
import type { Content } from '../core/product.js';
import type { RunSnapshot } from '../core/types.js';

const owned: { directory: string; store: Store }[] = [];
afterEach(async () => {
  for (const item of owned.splice(0)) {
    item.store.close();
    const target = resolve(item.directory);
    const within = relative(resolve(tmpdir()), target);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(target).startsWith('Uimori transcript tests ')
    )
      throw new Error('Refusing cleanup outside owned test directory');
    await rm(target, { recursive: true, force: true });
  }
});
async function database() {
  const directory = await mkdtemp(join(tmpdir(), 'Uimori transcript tests '));
  const store = new Store(join(directory, 'story.sqlite'));
  owned.push({ directory, store });
  return store;
}
/** A completed turn the normal way: run → running → source, with synthetic usage. */
function turn(store: Store, chatId: string, request: string, value: string) {
  const chat = store.chat(chatId);
  const profile = store.product.snapshot(chatId);
  const branch = store.product.branch(chatId);
  const run = store.createRun(
    chatId,
    {
      request,
      expectedRevision: branch.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
    (current) =>
      ({
        chatId,
        parentRevision: current.headRevision,
        settingsRevision: current.settingsRevision,
        settings: current.settings,
        request,
        history: store.history(current.headRevision),
        resources: store.product.resources(chatId, profile),
        profile,
      }) satisfies RunSnapshot
  ).run;
  store.startRun(run.id);
  return store.source(
    store.completeRun(
      run.id,
      value,
      { modelCalls: 2, inputTokens: 50, outputTokens: 80, costUsd: 0.02 },
      run.snapshot.settings
    ).id
  );
}
function authoredChat(store: Store) {
  const chat = createFixtureChat(store, 'Original story');
  const glossary = store.product.content({
    kind: 'module',
    title: 'Glossary',
    description: 'Synthetic test data',
    text: 'terms',
    loading: 'pinned',
    relatedIds: [],
  }) as Content;
  const profile = store.product.profile(chat.id);
  store.product.updateProfile(chat.id, {
    expectedRevision: profile.revision,
    attachments: [{ id: glossary.id, revision: glossary.revision }],
    packageAttachments: profile.packageAttachments,
    image: profile.image,
  });
  const first = turn(store, chat.id, 'Open the story', 'Scene one.');
  editTranslation(store, first.id, {
    text: '첫 장면.',
    expectedRevision: 0,
    expectedSourceHash: first.hash,
  });
  store.story.notes.write(chat.id, {
    text: 'Keep the narrator formal.',
    author: 'user',
    branchId: `main:${chat.id}`,
    expectedRevision: 0,
    expectedHeadRevision: first.id,
    idempotencyKey: 'note-1',
  });
  const second = turn(store, chat.id, 'Continue', 'Scene two.');
  return { chat, glossary, first, second };
}
const requests = (store: Store, chatId: string) =>
  store
    .history(store.chat(chatId).headRevision)
    .map((item) => store.run(store.source(item.revision).runId).request);

describe('chat transcript export and import', () => {
  test('the largest editable source and full chat title round trip without truncation', async () => {
    const store = await database();
    const { chat, first } = authoredChat(store);
    const text = '가'.repeat(CHAT_TRANSCRIPT_LIMITS.text);
    store.editSource(first.id, { text, expectedRevision: 0 });
    store.db.prepare('UPDATE chats SET title=? WHERE id=?').run('제'.repeat(200), chat.id);
    const exported = exportChatTranscript(store, chat.id);
    expect(validateChatTranscript(exported)).toEqual(exported);
    const imported = importChatTranscript(store, { transcript: exported, idempotencyKey: 'large' });
    expect(imported.chat.title).toBe(exported.title);
    expect(exportChatTranscript(store, imported.chat.id).entries).toEqual(exported.entries);
    const fresh = await database();
    expect(fresh.product.import(store.product.export()).restored).toBe(true);
    expect(exportChatTranscript(fresh, imported.chat.id).entries).toEqual(exported.entries);
  });

  test('authored import storage grows with sources and preserves ancestry after edits and archive restore', async () => {
    const store = await database();
    const { chat } = authoredChat(store);
    const base = exportChatTranscript(store, chat.id);
    const measurements: number[] = [];
    for (const count of [100, 200]) {
      const transcript = {
        ...base,
        notes: [],
        entries: Array.from({ length: count }, (_, index) => ({
          request: `Synthetic ${index}`,
          text: `${index} ${'long authored prose '.repeat(50)}`,
          translation: null,
        })),
      };
      const imported = importChatTranscript(store, {
        transcript,
        idempotencyKey: `linear-${count}`,
      });
      const stored = store.db
        .prepare('SELECT SUM(length(snapshot)) AS n FROM runs WHERE chat_id=?')
        .get(imported.chat.id) as { n: number };
      measurements.push(stored.n);
      const history = store.history(imported.chat.headRevision);
      expect(history.map((item) => item.text)).toEqual(
        transcript.entries.map((entry) => entry.text)
      );
      const first = store.source(history[0].revision);
      store.editSource(first.id, { text: 'Changed after import', expectedRevision: 0 });
      expect(store.sourceOriginal(first.id).text).toBe(transcript.entries[0].text);
      expect(store.source(first.id).text).toBe('Changed after import');
      expect(
        store.db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE chat_id=?').get(imported.chat.id)
      ).toEqual({ n: 0 });
      const fork = forkChat(store, imported.chat.id, {
        fromRevision: history[1].revision,
        idempotencyKey: `linear-fork-${count}`,
      });
      expect(store.history(fork.headRevision).map((item) => item.text)).toEqual([
        'Changed after import',
        transcript.entries[1].text,
      ]);
    }
    expect(measurements[1]).toBeLessThan(measurements[0] * 2.2);
    const fresh = await database();
    expect(fresh.product.import(store.product.export()).restored).toBe(true);
  });

  test('a transcript carries authored history only and imports as a new chat with the same reading', async () => {
    const store = await database();
    const { chat, glossary, first } = authoredChat(store);
    const transcript = exportChatTranscript(store, chat.id);
    expect(transcript.format).toBe(CHAT_TRANSCRIPT_FORMAT);
    expect(transcript.title).toBe('Original story');
    expect(transcript.entries).toEqual([
      { request: 'Open the story', text: 'Scene one.', translation: '첫 장면.' },
      { request: 'Continue', text: 'Scene two.', translation: null },
    ]);
    expect(transcript.notes).toEqual([
      { text: 'Keep the narrator formal.', author: 'user', atIndex: 0 },
    ]);
    expect(transcript.attachments).toEqual([{ id: glossary.id, revision: glossary.revision }]);
    expect(transcript.packageAttachments.map((item) => item.role)).toEqual(['bot']);
    expect(JSON.stringify(transcript)).not.toMatch(/snapshot|usage|attempt|runId/);
    expect(validateChatTranscript(JSON.parse(JSON.stringify(transcript)))).toEqual(transcript);

    const imported = importChatTranscript(store, { transcript, idempotencyKey: 'import-1' });
    expect(imported.created).toBe(true);
    expect(imported.skippedAttachments).toEqual([]);
    const id = imported.chat.id;
    expect(id).not.toBe(chat.id);
    const history = store.history(store.chat(id).headRevision);
    expect(history.map((item) => item.text)).toEqual(['Scene one.', 'Scene two.']);
    expect(requests(store, id)).toEqual(['Open the story', 'Continue']);
    for (const [index, item] of history.entries()) {
      const run = store.run(store.source(item.revision).runId);
      expect(run.status).toBe('completed');
      expect(run.usage.modelCalls).toBe(0);
      expect(run.snapshot.transcriptImport).toEqual({ index, storage: 'source-only-v1' });
      expect(run.snapshot.history).toEqual([]);
      expect(run.snapshot.promptCompilation).toBeUndefined();
    }
    expect(store.validateHistory(history, store.chat(id).headRevision)).toBe(true);
    const copiedFirst = store.source(history[0].revision);
    expect(copiedFirst.hash).toBe(first.hash);
    expect(successfulTranslation(store, copiedFirst)?.result?.text).toBe('첫 장면.');
    expect(successfulTranslation(store, store.source(history[1].revision))).toBeNull();
    const notes = store.story.notes.entries(
      store.story.notes.scope(id, store.chat(id).headRevision)
    );
    expect(notes.map((note) => [note.text, note.atRevision])).toEqual([
      ['Keep the narrator formal.', history[0].revision],
    ]);
    const profile = store.product.profile(id);
    expect(profile.attachments).toEqual([{ id: glossary.id, revision: glossary.revision }]);
    expect(profile.packageAttachments?.map((item) => item.role)).toEqual(['bot']);
    expect(
      store.db
        .prepare("SELECT COUNT(*) AS n FROM jobs WHERE chat_id=? AND kind<>'translation'")
        .get(id)
    ).toEqual({ n: 0 });

    // The imported chat reads back as the same transcript and still forks like any chat.
    const again = exportChatTranscript(store, id);
    expect({ ...again, exportedAt: transcript.exportedAt, title: transcript.title }).toEqual(
      transcript
    );
    const fork = forkChat(store, id, {
      fromRevision: history[1].revision,
      idempotencyKey: 'fork-1',
    });
    expect(store.history(store.chat(fork.id).headRevision).map((item) => item.text)).toEqual([
      'Scene one.',
      'Scene two.',
    ]);
  });

  test('a replayed import key returns the same chat and missing library references are reported', async () => {
    const store = await database();
    const { chat } = authoredChat(store);
    const transcript = exportChatTranscript(store, chat.id);
    const first = importChatTranscript(store, { transcript, idempotencyKey: 'same-key' });
    const replay = importChatTranscript(store, { transcript, idempotencyKey: 'same-key' });
    expect(replay).toEqual({ chat: first.chat, created: false, skippedAttachments: [] });
    // The original and one imported copy; the replay created nothing.
    expect(store.chats().filter((item) => item.title === 'Original story')).toHaveLength(2);

    const withUnknown = {
      ...transcript,
      attachments: [{ id: 'missing-module', revision: 3 }],
    };
    const partial = importChatTranscript(store, {
      transcript: withUnknown,
      title: 'Restored',
      idempotencyKey: 'partial',
    });
    expect(partial.chat.title).toBe('Restored');
    expect(partial.skippedAttachments).toEqual([{ id: 'missing-module', revision: 3 }]);
    expect(store.product.profile(partial.chat.id).attachments).toEqual([]);

    const withoutBot = { ...transcript, packageAttachments: [] };
    expect(() =>
      importChatTranscript(store, { transcript: withoutBot, idempotencyKey: 'no-bot' })
    ).toThrow(new HttpError(400, 'CHAT_TRANSCRIPT_BOT_REQUIRED'));
  });

  test('foreign formats, other versions and unknown fields are rejected before any write', async () => {
    const store = await database();
    const { chat } = authoredChat(store);
    const transcript = exportChatTranscript(store, chat.id);
    const before = store.chats().length;
    const cases: [unknown, string][] = [
      [{ ...transcript, format: 'narrative-archive' }, 'CHAT_TRANSCRIPT_INVALID_FORMAT'],
      [{ ...transcript, version: 2 }, 'CHAT_TRANSCRIPT_UNSUPPORTED_VERSION'],
      [{ ...transcript, runs: [] }, 'CHAT_TRANSCRIPT_UNKNOWN_FIELD'],
      [
        { ...transcript, entries: [{ request: 'x', text: '   ', translation: null }] },
        'CHAT_TRANSCRIPT_INVALID_TEXT',
      ],
      [
        { ...transcript, notes: [{ text: 'n', author: 'u', atIndex: 5 }] },
        'CHAT_TRANSCRIPT_INVALID_NOTE_ANCHOR',
      ],
    ];
    for (const [value, code] of cases)
      expect(() =>
        importChatTranscript(store, { transcript: value, idempotencyKey: code })
      ).toThrow(new HttpError(400, code));
    expect(store.chats().length).toBe(before);
  });
});

test('the transcript routes download the file and create the chat over HTTP', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'Uimori transcript tests '));
  const app = await createApp({
    dbPath: join(directory, 'story.sqlite'),
    buildId: 'transcript-synthetic',
    instanceId: randomUUID(),
    testMode: true,
  });
  await app.ready();
  try {
    const { chat } = authoredChat(app.store);
    const headers = { host: '127.0.0.1', 'content-type': 'application/json' };
    const exported = await app.inject({
      method: 'GET',
      url: `/api/chats/${chat.id}/transcript`,
      headers,
    });
    expect(exported.statusCode, exported.body).toBe(200);
    expect(exported.headers['content-disposition']).toContain('chat-transcript.json');
    const transcript = exported.json();
    expect(transcript.format).toBe(CHAT_TRANSCRIPT_FORMAT);
    const imported = await app.inject({
      method: 'POST',
      url: '/api/chats/import-transcript',
      headers,
      payload: JSON.stringify({ transcript, idempotencyKey: 'http-1' }),
    });
    expect(imported.statusCode, imported.body).toBe(200);
    const result = imported.json();
    expect(result.created).toBe(true);
    expect(requests(app.store, result.chat.id)).toEqual(['Open the story', 'Continue']);
    const rejected = await app.inject({
      method: 'POST',
      url: '/api/chats/import-transcript',
      headers,
      payload: JSON.stringify({ transcript: { format: 'other' }, idempotencyKey: 'http-2' }),
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error).toBe('CHAT_TRANSCRIPT_INVALID_FORMAT');
  } finally {
    await app.close();
    // The directory is this test's own mkdtemp result under the owned prefix.
    await rm(directory, { recursive: true, force: true });
  }
});
