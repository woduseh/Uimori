import { legacyChatBackupFixture } from './fixtures/legacy-backup.js';
import { readStoredRunSnapshot } from '../server/run-projections.js';
import { afterEach, describe, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { HttpError } from '../server/request-validation.js';
import { createFixtureChat } from './fixtures/chat.js';
import { exportChatTranscript, importChatTranscript } from '../server/chat-transcript.js';
import { importChatBackup } from '../server/chat-backup.js';
import { CHAT_TRANSCRIPT_FORMAT, validateChatTranscript } from '../core/chat-transcript.js';
import { editTranslation } from '../server/source-editing.js';
import { successfulTranslation } from '../server/translation-artifacts.js';
import { forkChat } from '../server/chat-fork.js';
import { createApp } from '../server/app.js';
import type { Content } from '../core/product.js';
import type { RunSnapshot } from '../core/types.js';
import { exportManuscript, manuscriptExportMetadata } from '../server/manuscript-export.js';
import { readerDetail } from '../server/reader.js';
import { deleteLibraryItem } from '../server/library-deletion.js';
import { softDeleteLibraryItem } from './fixtures/soft-delete.js';
import { nativeContent } from './fixtures/native-content.js';
import { nativePrompt } from './fixtures/native-prompt.js';
import { ChatOptionsStore } from '../server/chat-options.js';

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
function turn(store: Store, chatId: string, request: string, value: string) {
  const chat = store.chat(chatId);
  const profile = store.product.snapshot(chatId);
  const run = store.createRun(
    chatId,
    {
      request,
      expectedRevision: chat.headRevision,
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
    store.completeRun(run.id, value, {
      modelCalls: 2,
      inputTokens: 50,
      outputTokens: 80,
      costUsd: 0.02,
    }).id
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
    packageAttachments: [
      ...profile.packageAttachments!,
      { id: glossary.id, revision: glossary.revision, role: 'module' },
    ],
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
    expectedRevision: 0,
    expectedHeadRevision: first.id,
    idempotencyKey: 'note-1',
  });
  const second = turn(store, chat.id, 'Continue', 'Scene two.');
  return { chat, glossary, first, second };
}
function pinFixedPrompt(store: Store, chatId: string) {
  const prompt = store.product.promptPreset({
    title: 'Pinned prompt',
    role: 'main',
    program: nativePrompt('Write', { customPromptTemplateToggle: 'tone=Tone=text' }),
  }) as { id: string; revision: number };
  const profile = store.product.profile(chatId);
  store.product.updateProfile(chatId, {
    expectedRevision: profile.revision,
    image: profile.image,
    pinned: { mainPromptPresetId: prompt.id },
  });
  const options = new ChatOptionsStore(store);
  const state = options.get(chatId);
  options.fixed(
    chatId,
    {
      expectedRevision: state.revision,
      binding: state.binding,
      values: { tone: 'bold' },
      operationId: 'fix-tone',
    },
    'pin-fixed-prompt'
  );
  return prompt;
}
const requests = (store: Store, chatId: string) =>
  store
    .history(store.chat(chatId).headRevision)
    .map((item) => store.run(store.source(item.revision).runId).request);

describe('Markdown manuscript export', () => {
  test('exports only current edited source text for the chosen scene range', async () => {
    const store = await database();
    const { chat, first, second } = authoredChat(store);
    store.editSource(first.id, {
      expectedRevision: 0,
      text: '<p>Edited scene.</p>\nStatus: ready',
    });
    const body = { mode: 'source' as const, expectedHeadRevision: second.id };
    expect(exportManuscript(store, chat.id, body)).toEqual({
      title: 'Original story',
      range: '',
      markdown: '<p>Edited scene.</p>\nStatus: ready\n\nScene two.\n',
    });
    const selected = exportManuscript(store, chat.id, { ...body, fromScene: 2, toScene: 2 });
    expect(selected.markdown).toBe('Scene two.\n');
    expect(selected).toMatchObject({ title: 'Original story', range: '-2-2' });
    expect(selected.markdown).not.toMatch(/Continue|Keep the narrator|modelCalls|request/);
    expect(() => exportManuscript(store, chat.id, { ...body, fromScene: 2, toScene: 1 })).toThrow(
      'MANUSCRIPT_RANGE_INVALID'
    );
    expect(() => exportManuscript(store, chat.id, { ...body, fromScene: 3 })).toThrow(
      'MANUSCRIPT_RANGE_INVALID'
    );
    expect(() => exportManuscript(store, chat.id, { ...body, fromScene: '1' })).toThrow(
      'MANUSCRIPT_RANGE_INVALID'
    );
    expect(() =>
      exportManuscript(store, chat.id, { ...body, expectedHeadRevision: first.id, fromScene: '1' })
    ).toThrow('MANUSCRIPT_RANGE_CHANGED');
  });

  test('saved translations must match each current source and never fall back to source', async () => {
    const store = await database();
    const { chat, first, second } = authoredChat(store);
    const body = { mode: 'translation' as const, expectedHeadRevision: second.id };
    expect(() => exportManuscript(store, chat.id, body)).toThrow(
      expect.objectContaining({
        code: 'MANUSCRIPT_TRANSLATION_MISSING',
        params: { scenes: '2', total: 1 },
      })
    );
    expect(exportManuscript(store, chat.id, { ...body, fromScene: 1, toScene: 1 }).markdown).toBe(
      '첫 장면.\n'
    );
    editTranslation(store, second.id, {
      text: '둘째 장면.',
      expectedRevision: 0,
      expectedSourceHash: second.hash,
    });
    expect(exportManuscript(store, chat.id, body).markdown).toBe('첫 장면.\n\n둘째 장면.\n');
    store.editSource(first.id, { expectedRevision: 0, text: 'Changed source.' });
    expect(() => exportManuscript(store, chat.id, body)).toThrow(
      expect.objectContaining({
        code: 'MANUSCRIPT_TRANSLATION_MISSING',
        params: { scenes: '1', total: 1 },
      })
    );
    const current = store.sourceMetadata(first.id);
    editTranslation(store, first.id, {
      text: '고친 장면.',
      expectedRevision: store.source(first.id).translationRevision,
      expectedSourceHash: current.hash,
    });
    expect(exportManuscript(store, chat.id, body).markdown).toBe('고친 장면.\n\n둘째 장면.\n');
  });

  test('the opening is scene 0, scene numbers agree with Reader and metadata excludes manuscript bodies', async () => {
    const store = await database();
    const { chat, first, second } = authoredChat(store);
    store.db
      .prepare(
        "UPDATE runs SET snapshot=json_set(snapshot,'$.packageStart.mode','authored') WHERE id=?"
      )
      .run(first.runId);
    const metadata = manuscriptExportMetadata(store, chat.id);
    expect(metadata.scenes).toEqual([{ number: 0 }, { number: 1 }]);
    expect(metadata.scenes.map((scene) => scene.number)).toEqual(
      readerDetail(store, chat.id, {}).reader.navigation.map((scene) => scene.number)
    );
    expect(JSON.stringify(metadata)).not.toMatch(
      /Scene one|Scene two|Open the story|Keep the narrator/
    );
    expect(
      exportManuscript(store, chat.id, {
        mode: 'source',
        expectedHeadRevision: second.id,
        fromScene: 0,
        toScene: 0,
      }).markdown
    ).toBe('Scene one.\n');
    const empty = createFixtureChat(store, 'Empty');
    expect(manuscriptExportMetadata(store, empty.id).scenes).toEqual([]);
    expect(() =>
      exportManuscript(store, empty.id, { mode: 'source', expectedHeadRevision: null })
    ).toThrow('MANUSCRIPT_EMPTY');
  });
});

describe('chat transcript export and import', () => {
  test('transcript import and fork preserve authored data despite a deleted unrelated bot default', async () => {
    const store = await database();
    const { chat, second } = authoredChat(store);
    const original = exportChatTranscript(store, chat.id);
    const bot = original.packageAttachments.find((item) => item.role === 'bot')!;
    const persona = store.product.content({
      kind: 'persona',
      title: 'Unrelated default',
      description: 'Synthetic',
      text: 'Only for new chats',
      loading: 'pinned',
      relatedIds: [],
    }) as Content;
    store.organization.updateDefaults({
      botId: bot.id,
      expectedRevision: 1,
      persona: { mode: 'persona', persona: { id: persona.id } },
    });
    deleteLibraryItem(store, 'content', persona.id, { expectedRevision: persona.revision });

    const imported = importChatTranscript(
      store,
      {
        transcript: original,
        idempotencyKey: 'deleted-default-import',
      },
      'library'
    );
    const fork = forkChat(store, chat.id, {
      fromRevision: second.id,
      idempotencyKey: 'deleted-default-fork',
    });
    for (const copied of [imported.chat, fork]) {
      const transcript = exportChatTranscript(store, copied.id);
      expect(transcript.entries).toEqual(original.entries);
      expect(transcript.notes).toEqual(original.notes);
      expect(transcript.packageAttachments).toEqual(original.packageAttachments);
      expect(transcript.packageAttachments.some((item) => item.role === 'persona')).toBe(false);
    }
    expect(exportChatTranscript(store, chat.id).entries).toEqual(original.entries);
  });

  test('one package keeps its bot and persona roles through transcript, fork and backup', async () => {
    const store = await database();
    const { chat } = authoredChat(store);
    const profile = store.product.profile(chat.id);
    const bot = profile.packageAttachments!.find((item) => item.role === 'bot')!;
    store.product.updateProfile(chat.id, {
      expectedRevision: profile.revision,
      packageAttachments: [...profile.packageAttachments!, { ...bot, role: 'persona' }],
      image: profile.image,
    });
    const transcript = exportChatTranscript(store, chat.id);
    expect(transcript.packageAttachments.filter((item) => item.id === bot.id)).toEqual([
      bot,
      { ...bot, role: 'persona' },
    ]);
    expect(validateChatTranscript(transcript)).toEqual(transcript);
    const imported = importChatTranscript(
      store,
      { transcript, idempotencyKey: 'shared-roles' },
      'library'
    );
    expect(imported.skippedAttachments).toEqual([]);
    const fork = forkChat(store, chat.id, {
      fromRevision: store.chat(chat.id).headRevision!,
      idempotencyKey: 'shared-roles-fork',
    });
    const destination = await database();
    const restored = await importChatBackup(destination, {
      backup: legacyChatBackupFixture(store, chat.id),
      idempotencyKey: 'shared-roles-backup',
    });
    for (const [owner, copied] of [
      [store, imported.chat],
      [store, fork],
      [destination, restored.chat],
    ] as const) {
      const result = exportChatTranscript(owner, copied.id);
      expect(result.entries).toEqual(transcript.entries);
      expect(result.notes).toEqual(transcript.notes);
      const references = result.packageAttachments.filter((item) =>
        ['bot', 'persona'].includes(item.role)
      );
      expect(references.map((item) => item.role)).toEqual(['bot', 'persona']);
      expect(references[0].id).toBe(references[1].id);
      expect(owner.product.attempts(copied.id)).toEqual([]);
    }
  });

  test('an app-created backup preserves more than 500 notes when restored', async () => {
    const store = await database();
    const chat = createFixtureChat(store, 'Many short notes');
    for (let index = 0; index < 501; index++)
      store.story.notes.write(chat.id, {
        text: `Preserved note ${index}`,
        author: 'Writer',
        expectedRevision: index,
        expectedHeadRevision: null,
        idempotencyKey: `note-${index}`,
      });
    const backup = legacyChatBackupFixture(store, chat.id);
    expect(backup.chats[0].transcript.notes).toHaveLength(501);
    const destination = await database();
    const restored = await importChatBackup(destination, {
      backup,
      idempotencyKey: 'many-notes',
    });
    expect(exportChatTranscript(destination, restored.chat.id).notes).toEqual(
      backup.chats[0].transcript.notes
    );
  });

  test('export keeps current edits and matching translations while respecting note and source scope', async () => {
    const store = await database();
    const { chat, first, second } = authoredChat(store);
    const edited = store.editSource(first.id, {
      expectedRevision: 0,
      text: 'Edited first scene.\n\nPreserve these paragraphs.',
    });
    expect(exportChatTranscript(store, chat.id, first.id).entries).toEqual([
      { request: 'Open the story', text: edited.text, translation: null },
    ]);
    editTranslation(store, first.id, {
      text: '고친 첫 장면.',
      expectedRevision: edited.translationRevision!,
      expectedSourceHash: edited.hash,
    });
    store.story.notes.write(chat.id, {
      text: 'A note for the second scene.',
      author: 'user',
      expectedRevision: 1,
      expectedHeadRevision: second.id,
      idempotencyKey: 'later-note',
    });
    const partial = exportChatTranscript(store, chat.id, first.id);
    expect(partial.entries).toEqual([
      { request: 'Open the story', text: edited.text, translation: '고친 첫 장면.' },
    ]);
    expect(partial.notes).toEqual([]);
    expect(exportChatTranscript(store, chat.id).notes).toEqual([
      { text: 'A note for the second scene.', author: 'user', atIndex: 1, kind: 'author-note' },
    ]);
    expect(exportChatTranscript(store, chat.id, null)).toMatchObject({ entries: [], notes: [] });
    const foreign = createFixtureChat(store, 'Foreign chat');
    expect(() => exportChatTranscript(store, foreign.id, first.id)).toThrow('Source outside chat');
    const scope = store.story.notes.scope(chat.id, second.id);
    store.editSource(second.id, { expectedRevision: 0, text: 'A later correction.' });
    expect(() => store.story.notes.entries(scope)).toThrow('Note source ancestry changed');
  });

  test('external memory remains attributed reference data through transcript, fork and backup', async () => {
    const store = await database();
    const chat = createFixtureChat(store, 'Imported memory fixture');
    const origin = { fileHash: 'a'.repeat(64), entryId: 'lore-4', title: 'Earlier account' };
    store.story.notes.write(chat.id, {
      text: 'A character claims the old gate was open.',
      author: '가져온 자료',
      kind: 'imported-memory',
      origin,
      expectedRevision: 0,
      expectedHeadRevision: null,
      idempotencyKey: 'historical-memory',
    });
    turn(store, chat.id, 'Continue', 'The gate is closed.');
    const transcript = exportChatTranscript(store, chat.id);
    expect(transcript.version).toBe(2);
    expect(transcript.notes[0]).toMatchObject({ kind: 'imported-memory', origin, atIndex: null });
    const imported = importChatTranscript(
      store,
      { transcript, idempotencyKey: 'attributed-copy' },
      'library'
    );
    const fork = forkChat(store, imported.chat.id, {
      fromRevision: imported.chat.headRevision!,
      idempotencyKey: 'memory-fork',
    });
    for (const copied of [imported.chat, fork]) {
      expect(
        store.story.notes.entries(store.story.notes.scope(copied.id, copied.headRevision))[0]
      ).toMatchObject({ kind: 'imported-memory', origin, atRevision: null });
      expect(exportChatTranscript(store, copied.id).notes).toEqual(transcript.notes);
    }
    const backup = legacyChatBackupFixture(store, imported.chat.id);
    const fresh = await database();
    const restored = await importChatBackup(fresh, { backup, idempotencyKey: 'memory-backup' });
    expect(exportChatTranscript(fresh, restored.chat.id).notes).toEqual(transcript.notes);
    expect(() =>
      validateChatTranscript({
        ...transcript,
        notes: [{ ...transcript.notes[0], origin: undefined }],
      })
    ).toThrow();
  });

  test('a transcript carries authored history only and imports as a new chat with the same reading', async () => {
    const store = await database();
    const { chat, first, second } = authoredChat(store);
    const transcript = exportChatTranscript(store, chat.id);
    expect(transcript.format).toBe(CHAT_TRANSCRIPT_FORMAT);
    expect(transcript.title).toBe('Original story');
    expect(transcript.entries).toEqual([
      { request: 'Open the story', text: 'Scene one.', translation: '첫 장면.' },
      { request: 'Continue', text: 'Scene two.', translation: null },
    ]);
    expect(transcript.notes).toEqual([
      { text: 'Keep the narrator formal.', author: 'user', atIndex: 0, kind: 'author-note' },
    ]);
    expect(transcript.packageAttachments.map((item) => item.role)).toEqual(['bot', 'module']);
    expect(JSON.stringify(transcript)).not.toMatch(/snapshot|usage|attempt|runId/);
    expect(validateChatTranscript(JSON.parse(JSON.stringify(transcript)))).toEqual(transcript);

    const imported = importChatTranscript(
      store,
      { transcript, idempotencyKey: 'import-1' },
      'library'
    );
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
      expect(readStoredRunSnapshot(store, run.id).history).toEqual([]);
      expect(run.snapshot.promptCompilation).toBeUndefined();
    }
    expect(store.chat(id).headRevision).toBe(history[1].revision);
    expect(store.source(history[0].revision).parentRevision).toBeNull();
    expect(store.source(history[1].revision).parentRevision).toBe(history[0].revision);
    expect(history.map((item) => store.sourceOriginal(item.revision).hash)).toEqual([
      first.hash,
      second.hash,
    ]);
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
    expect(profile.packageAttachments?.map((item) => item.role)).toEqual(['bot', 'module']);
    expect(
      store.db
        .prepare("SELECT COUNT(*) AS n FROM jobs WHERE chat_id=? AND kind<>'translation'")
        .get(id)
    ).toEqual({ n: 0 });

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

  test('a fork keeps the deleted bot, module and pinned model its chat holds', async () => {
    const store = await database();
    const { chat, glossary, second } = authoredChat(store);
    const connection = store.product.connection({
      title: 'Pinned connection',
      protocol: 'fixture-sse-v1',
      endpoint: 'http://127.0.0.1:9',
      enabled: true,
    }) as { id: string; revision: number };
    const model = store.product.model({
      title: 'Pinned model',
      connectionId: connection.id,
      modelId: 'fixture',
      maxOutputTokens: 1024,
      temperature: null,
    }) as { id: string; revision: number };
    const profile = store.product.profile(chat.id);
    store.product.updateProfile(chat.id, {
      expectedRevision: profile.revision,
      image: profile.image,
      pinned: { mainModel: { id: model.id } },
    });
    const bot = store.product.stored<Content>(
      'content',
      profile.packageAttachments!.find((item) => item.role === 'bot')!.id
    );
    for (const [kind, item] of [
      ['content', bot],
      ['content', glossary],
      ['model', model],
    ] as const)
      softDeleteLibraryItem(store, kind, item);

    const fork = forkChat(store, chat.id, {
      fromRevision: second.id,
      idempotencyKey: 'deleted-held-fork',
    });
    const copied = store.product.profile(fork.id);
    expect(copied.packageAttachments!.map(({ id, role }) => ({ id, role }))).toEqual([
      { id: bot.id, role: 'bot' },
      { id: glossary.id, role: 'module' },
    ]);
    expect(copied.pinned).toEqual({ mainModel: { id: model.id } });
  });

  test('a fork keeps a deleted pinned prompt and its fixed options and still refuses to run it', async () => {
    const store = await database();
    const { chat, second } = authoredChat(store);
    const prompt = pinFixedPrompt(store, chat.id);
    softDeleteLibraryItem(store, 'prompt-preset', prompt);

    const fork = forkChat(store, chat.id, {
      fromRevision: second.id,
      idempotencyKey: 'deleted-pinned-prompt-fork',
    });
    expect(store.product.profile(fork.id).pinned).toEqual({ mainPromptPresetId: prompt.id });
    expect(new ChatOptionsStore(store).get(fork.id, 'preserve').fixedValues).toEqual({
      tone: 'bold',
    });
    expect(() => store.product.snapshot(fork.id)).toThrow('PINNED_PROMPT_UNAVAILABLE');
  });

  test('a restored backup still refuses a pinned prompt that is not a main prompt', async () => {
    const store = await database();
    const { chat } = authoredChat(store);
    const prompt = store.product.promptPreset({
      title: 'Pinned prompt',
      role: 'main',
      text: 'Write',
    }) as { id: string };
    const profile = store.product.profile(chat.id);
    store.product.updateProfile(chat.id, {
      expectedRevision: profile.revision,
      image: profile.image,
      pinned: { mainPromptPresetId: prompt.id },
    });
    const backup = legacyChatBackupFixture(store, chat.id);
    const pinned = backup.resources.prompts.find((entry) => entry.source.id === prompt.id)!;
    pinned.source.role = 'translation';
    const destination = await database();
    await expect(
      importChatBackup(destination, { backup, idempotencyKey: 'translation-pinned' })
    ).rejects.toThrow('PINNED_PROMPT_NOT_MAIN');
    expect(destination.chats()).toEqual([]);
  });

  test('a profile save keeps a deleted package it already holds and refuses a newly attached one', async () => {
    const store = await database();
    const { chat, glossary } = authoredChat(store);
    const persona = store.product.content({
      kind: 'persona',
      title: 'Traveler',
      description: 'Synthetic test data',
      text: 'A traveler',
      loading: 'pinned',
      relatedIds: [],
      package: nativeContent({ name: 'Traveler' }, {}, 'persona'),
    }) as Content;
    softDeleteLibraryItem(store, 'content', glossary);
    softDeleteLibraryItem(store, 'content', persona);
    const profile = store.product.profile(chat.id);
    const held = profile.packageAttachments!;
    expect(() =>
      store.product.updateProfile(chat.id, {
        expectedRevision: profile.revision,
        image: profile.image,
        packageAttachments: [
          ...held,
          { id: persona.id, revision: persona.revision, role: 'persona' },
        ],
      })
    ).toThrow('LIBRARY_ITEM_DELETED');
    const saved = store.product.updateProfile(chat.id, {
      expectedRevision: profile.revision,
      image: !profile.image,
      packageAttachments: held,
    });
    expect(saved.packageAttachments!.map(({ id, role }) => ({ id, role }))).toEqual(
      held.map(({ id, role }) => ({ id, role }))
    );
  });

  test('an import reports a deleted library package as skipped instead of attaching it', async () => {
    const store = await database();
    const { chat, glossary } = authoredChat(store);
    const transcript = exportChatTranscript(store, chat.id);
    softDeleteLibraryItem(store, 'content', glossary);
    const imported = importChatTranscript(
      store,
      { transcript, idempotencyKey: 'deleted-module' },
      'library'
    );
    expect(imported.skippedAttachments).toEqual([
      { id: glossary.id, revision: glossary.revision, role: 'module' },
    ]);
    expect(
      store.product.profile(imported.chat.id).packageAttachments!.map((item) => item.role)
    ).toEqual(['bot']);
  });

  test('a replayed import key returns the same chat and missing library references are reported', async () => {
    const store = await database();
    const { chat } = authoredChat(store);
    const transcript = exportChatTranscript(store, chat.id);
    const first = importChatTranscript(
      store,
      { transcript, idempotencyKey: 'same-key' },
      'library'
    );
    const replay = importChatTranscript(
      store,
      { transcript, idempotencyKey: 'same-key' },
      'library'
    );
    expect(replay).toEqual({ chat: first.chat, created: false, skippedAttachments: [] });
    expect(store.chats().filter((item) => item.title === 'Original story')).toHaveLength(2);

    const withUnknown = {
      ...transcript,
      packageAttachments: [
        ...transcript.packageAttachments.filter((item) => item.role === 'bot'),
        { id: 'missing-module', revision: 3, role: 'module' },
      ],
    };
    const partial = importChatTranscript(
      store,
      {
        transcript: withUnknown,
        title: 'Restored',
        idempotencyKey: 'partial',
      },
      'library'
    );
    expect(partial.chat.title).toBe('Restored');
    expect(partial.skippedAttachments).toEqual([
      { id: 'missing-module', revision: 3, role: 'module' },
    ]);
    expect(
      store.product.profile(partial.chat.id).packageAttachments!.map((item) => item.role)
    ).toEqual(['bot']);
    expect(
      importChatTranscript(
        store,
        {
          transcript: withUnknown,
          title: 'Restored',
          idempotencyKey: 'partial',
        },
        'library'
      )
    ).toEqual({ ...partial, created: false });

    const withoutBot = { ...transcript, packageAttachments: [] };
    expect(() =>
      importChatTranscript(store, { transcript: withoutBot, idempotencyKey: 'no-bot' }, 'library')
    ).toThrow('CHAT_TRANSCRIPT_BOT_REQUIRED');
  });

  test('chat backup restores transcript receipts as history without claiming destination keys', async () => {
    const store = await database();
    const { chat } = authoredChat(store);
    const transcript = exportChatTranscript(store, chat.id);
    const first = importChatTranscript(
      store,
      { transcript, idempotencyKey: 'portable-key' },
      'library'
    );
    const fresh = await database();
    const restored = await importChatBackup(fresh, {
      backup: legacyChatBackupFixture(store, first.chat.id),
      idempotencyKey: 'restore',
    });
    const historical = fresh.db
      .prepare('SELECT kind,entity_id FROM events WHERE chat_id=? AND kind LIKE ? ORDER BY seq')
      .all(restored.chat.id, 'chat.transcript-import%');
    expect(historical).toEqual(
      store.db
        .prepare('SELECT kind,entity_id FROM events WHERE chat_id=? AND kind LIKE ? ORDER BY seq')
        .all(first.chat.id, 'chat.transcript-import%')
        .map((row) => ({ ...row, kind: `${row.kind}.history` }))
    );
    const imported = importChatTranscript(
      fresh,
      {
        transcript: exportChatTranscript(fresh, restored.chat.id),
        title: 'New destination import',
        idempotencyKey: 'portable-key',
      },
      'library'
    );
    expect(imported.created).toBe(true);
    expect(imported.chat.id).not.toBe(restored.chat.id);
  });

  test('foreign formats, other versions and unknown fields are rejected before any write', async () => {
    const store = await database();
    const { chat } = authoredChat(store);
    const transcript = exportChatTranscript(store, chat.id);
    const before = store.chats().length;
    const cases: [unknown, string][] = [
      [{ ...transcript, format: 'uimori-archive' }, 'CHAT_TRANSCRIPT_INVALID_FORMAT'],
      [{ ...transcript, version: 3 }, 'CHAT_TRANSCRIPT_UNSUPPORTED_VERSION'],
      [{ ...transcript, runs: [] }, 'CHAT_TRANSCRIPT_UNKNOWN_FIELD'],
      ...[0, 1].map((revisionOffset): [unknown, string] => [
        {
          ...transcript,
          packageAttachments: [
            ...transcript.packageAttachments,
            {
              ...transcript.packageAttachments[0],
              revision: transcript.packageAttachments[0].revision + revisionOffset,
            },
          ],
        },
        'CHAT_TRANSCRIPT_DUPLICATE_REFERENCE',
      ]),
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
        importChatTranscript(store, { transcript: value, idempotencyKey: code }, 'library')
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
    const transcript = exportChatTranscript(app.store, chat.id);
    const manuscript = await app.inject({
      method: 'POST',
      url: `/api/chats/${chat.id}/manuscript`,
      headers,
      payload: { mode: 'translation', expectedHeadRevision: app.store.chat(chat.id).headRevision },
    });
    expect(manuscript.statusCode).toBe(409);
    expect(manuscript.json()).toEqual({
      code: 'MANUSCRIPT_TRANSLATION_MISSING',
      params: { scenes: '2', total: 1 },
    });
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
    expect(rejected.json()).toEqual({ code: 'CHAT_TRANSCRIPT_INVALID' });
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a backup restores its profile, drops the retired image translation flag and refuses a malformed profile without writing', async () => {
  const store = await database();
  const chat = createFixtureChat(store, 'Backup profile');
  turn(store, chat.id, 'Request', 'A scene.');
  const profile = store.product.profile(chat.id);
  store.product.updateProfile(chat.id, {
    expectedRevision: profile.revision,
    image: true,
    authorNote: 'Keep the harbor bell.',
  });
  const backup = legacyChatBackupFixture(store, chat.id);
  const restore = async (state: Record<string, unknown>, key: string) => {
    const destination = await database();
    const copy = structuredClone(backup);
    copy.chats[0]!.state.profile = state as never;
    const result = importChatBackup(destination, { backup: copy, idempotencyKey: key });
    return { destination, result };
  };
  const saved = backup.chats[0]!.state.profile;
  const { destination, result } = await restore({ ...saved, imageTranslation: false }, 'kept');
  const restored = (await result).chat;
  expect(destination.product.profile(restored.id)).toMatchObject({
    image: true,
    authorNote: 'Keep the harbor bell.',
  });
  expect(destination.product.profile(restored.id)).not.toHaveProperty('imageTranslation');
  for (const [key, state] of [
    ['wrong-types', { image: 'not-a-bool', authorNote: 12345 }],
    ['revision', { ...saved, expectedRevision: 999 }],
    ['attachments', { ...saved, packageAttachments: 'oops' }],
  ] as const) {
    const refused = await restore(state, key);
    await expect(refused.result).rejects.toMatchObject({ code: 'CHAT_BACKUP_INVALID' });
    expect(refused.destination.chats()).toEqual([]);
    expect(refused.destination.product.all('content')).toEqual([]);
  }
});

test('a transcript with two personas is refused before a chat or an import receipt exists', async () => {
  const store = await database();
  const chat = createFixtureChat(store, 'Two readers');
  turn(store, chat.id, 'Request', 'A scene.');
  const persona = (title: string) =>
    store.product.content({
      kind: 'persona',
      title,
      description: '',
      text: title,
      loading: 'pinned',
      relatedIds: [],
      package: nativeContent({ name: title, description: title }, {}, 'persona'),
    }) as Content;
  const transcript = exportChatTranscript(store, chat.id);
  transcript.packageAttachments.push(
    ...[persona('First reader'), persona('Second reader')].map((item) => ({
      id: item.id,
      revision: item.revision,
      role: 'persona' as const,
    }))
  );
  const chats = store.chats().length;
  expect(() =>
    importChatTranscript(store, { transcript, idempotencyKey: 'two-readers' }, 'library')
  ).toThrow('CHAT_TRANSCRIPT_DUPLICATE_REFERENCE');
  expect(store.chats()).toHaveLength(chats);
  expect(store.db.prepare('SELECT COUNT(*) AS n FROM import_operations').get()).toEqual({ n: 0 });
});
