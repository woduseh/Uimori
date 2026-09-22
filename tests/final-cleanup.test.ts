import { afterEach, expect, test, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { Store } from '../server/store.js';
import { fixtureBotInput } from './fixtures/chat.js';
import { nativeContent } from './fixtures/native-content.js';
import { nativePrompt } from './fixtures/native-prompt.js';
import { importChatTranscript } from '../server/chat-transcript.js';
import { helperWritingSnapshot } from '../server/helper-runtime.js';
import { prepareNativeRisuReadOnly } from '../server/risu-native-readonly.js';
import {
  modelWorkspace,
  updateModelWorkspace,
  promptWorkspace,
  updatePromptWorkspace,
} from '../server/prompt-workspace.js';
import { contextSourceRefs } from '../server/context-planning.js';
import { deleteChat, chatDeletionImpact } from '../server/chat-deletion.js';
import { deleteLibraryItem } from '../server/library-deletion.js';
import { processImage } from '../server/image-processing.js';
import { putValidatedImageBlob } from '../server/package-images.js';
import { saveResource } from '../server/resource-service.js';
import { editableResource } from '../core/resource-editing.js';
import { writeChatVariables } from '../server/chat-variables.js';
import { ChatOptionsStore } from '../server/chat-options.js';
import { HelperWorkspace } from '../server/helper-workspace.js';
import { forkChat } from '../server/chat-fork.js';
import type { Content } from '../core/product.js';

const owners: { store: Store; path: string }[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const { store, path } of owners.splice(0)) {
    store.close();
    rmSync(path, { recursive: true, force: true });
  }
});
function database() {
  const path = mkdtempSync(join(tmpdir(), 'uimori-final-cleanup-'));
  const owner = { store: new Store(join(path, 'app.sqlite')), path };
  owners.push(owner);
  return owner.store;
}
function fixture(count = 4) {
  const store = database();
  const connection = store.product.connection({
    title: 'Synthetic',
    protocol: 'fixture-sse-v1',
    endpoint: 'http://127.0.0.1:9',
    enabled: true,
  });
  const model = store.product.model({
    title: 'Main',
    connectionId: connection.id,
    modelId: 'fixture',
    temperature: null,
    maxOutputTokens: 1024,
    inputTokenLimit: 272000,
  });
  const helper = store.product.model({
    title: 'Helper',
    connectionId: connection.id,
    modelId: 'other',
    temperature: null,
    maxOutputTokens: 1024,
  });
  const workspace = modelWorkspace(store);
  updateModelWorkspace(store, {
    expectedRevision: workspace.revision,
    routes: { ...workspace.routes, main: { id: model.id } },
    translationPolicy: workspace.translationPolicy,
  });
  const bot = store.product.content(fixtureBotInput()) as Content;
  const chat = importChatTranscript(store, {
    idempotencyKey: randomUUID(),
    transcript: {
      format: 'uimori-chat-transcript',
      version: 2,
      exportedAt: new Date().toISOString(),
      title: 'Current summary',
      packageAttachments: [{ id: bot.id, revision: bot.revision, role: 'bot' }],
      notes: [],
      entries: Array.from({ length: count }, (_, i) => ({
        request: 'Request ' + i,
        text: ('Scene ' + i + '. ' + 'river '.repeat(600)).slice(0, 3000),
        translation: null,
      })),
    },
  }).chat;
  const branch = store.product.branch(chat.id);
  const snapshot = () =>
    prepareNativeRisuReadOnly(
      helperWritingSnapshot(store, chat.id, branch.id, 'context'),
      'context'
    );
  return { store, chat, branch, model, helper, bot, snapshot };
}

test('current summaries do not retain full inputs or detail receipts after repeated jobs and edits', async () => {
  const { store, chat, branch, snapshot } = fixture(4);
  for (let i = 0; i < 2; i++) {
    const input = await snapshot(),
      current = store.context.current(chat.id);
    const job = store.context.schedule(
      chat.id,
      {
        expectedRevision: current.activeRevision,
        expectedHeadRevision: branch.headRevision,
        idempotencyKey: randomUUID(),
      },
      input
    );
    store.context.start(job.id);
    const plan = {
      ...input.contextPlan!,
      status: 'ready' as const,
      compacted: contextSourceRefs(input).slice(0, 2),
      recentSourceRevisions: input.history.slice(2).map((s) => s.revision),
      summary: 'Summary ' + i,
      estimatedInputTokens: 1000,
    };
    store.context.finish(job.id, { ...input, contextPlan: plan });
    const detail = store.context.detail(chat.id);
    expect(detail.jobs.every((j) => !('snapshot' in j))).toBe(true);
    const body = {
      expectedRevision: detail.activeRevision,
      expectedHeadRevision: branch.headRevision,
      idempotencyKey: randomUUID(),
      summary: 'Edited ' + i,
    };
    const saved = store.context.edit(chat.id, body, await snapshot());
    expect(store.context.edit(chat.id, body, await snapshot()).activeRevision).toBe(
      saved.activeRevision
    );
  }
  expect(
    store.db
      .prepare('PRAGMA table_info(context_checkpoints)')
      .all()
      .map((r) => r.name)
  ).not.toContain('snapshot');
  expect(store.db.prepare('SELECT count(*) AS n FROM context_checkpoints').get()?.n).toBe(1);
  expect(
    store.db.prepare('SELECT count(*) AS n FROM context_jobs WHERE snapshot IS NOT NULL').get()?.n
  ).toBe(0);
  expect(
    Buffer.byteLength(JSON.stringify(store.db.prepare('SELECT * FROM context_commands').all()))
  ).toBeLessThan(4000);
  expect(store.context.current(chat.id)).toMatchObject({
    usable: true,
    checkpoint: { plan: { summary: 'Edited 1' } },
  });
  expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

test('unrelated helper and translation settings do not invalidate the main summary', async () => {
  const { store, chat, branch, helper, snapshot } = fixture();
  store.context.edit(
    chat.id,
    {
      expectedRevision: 0,
      expectedHeadRevision: branch.headRevision,
      idempotencyKey: 'summary',
      summary: 'A factual source summary.',
    },
    await snapshot()
  );
  const initial = store.context.current(chat.id);
  expect(initial.usable).toBe(true);
  const models = modelWorkspace(store);
  updateModelWorkspace(store, {
    expectedRevision: models.revision,
    helperModel: { id: helper.id },
    routes: { ...models.routes, translation: { id: helper.id } },
    translationPolicy: models.translationPolicy,
  });
  expect(store.context.current(chat.id)).toMatchObject({
    usable: true,
    checkpoint: initial.checkpoint,
  });
  const workspace = promptWorkspace(store);
  updatePromptWorkspace(store, {
    expectedRevision: workspace.revision,
    translation: {
      ...workspace.translation,
      program: nativePrompt('A new translation-only rule.', {}, 'translation'),
      values: {},
      defaultValues: {},
    },
  });
  expect(store.context.current(chat.id).usable).toBe(true);
  const next = promptWorkspace(store);
  updatePromptWorkspace(store, {
    expectedRevision: next.revision,
    main: {
      ...next.main,
      program: nativePrompt('A genuinely different main instruction.'),
      values: {},
      defaultValues: {},
    },
  });
  expect(store.context.current(chat.id).usable).toBe(false);
});

test('diagnostic events do not invalidate deletion; unreferenced images and hidden resources are reclaimed', async () => {
  const store = database(),
    bot = store.product.content(fixtureBotInput()) as Content;
  const chat = store.createChat('Disposable', 'calm', { botId: bot.id });
  const image = await processImage(
    await sharp({ create: { width: 16, height: 16, channels: 3, background: '#37516a' } })
      .png()
      .toBuffer()
  );
  store.product.createAsset(chat.id, {
    title: 'Unused',
    description: '',
    actor: '',
    outfit: '',
    location: '',
    allowedUse: 'both',
    mime: image.mime,
    base64: image.bytes.toString('base64'),
  });
  deleteLibraryItem(store, 'content', bot.id, { expectedRevision: bot.revision });
  expect(store.product.get('content', bot.id)).toBeTruthy();
  const confirmation = chatDeletionImpact(store, chat.id);
  store.event(chat.id, 'run.usage', 'diagnostic-only');
  deleteChat(store, chat.id, confirmation.request);
  expect(store.db.prepare('SELECT * FROM assets').all()).toEqual([]);
  expect(store.db.prepare('SELECT hash FROM image_blobs').all()).toEqual([]);
  expect(store.db.prepare('SELECT id FROM versions WHERE id=?').all(bot.id)).toEqual([]);
  expect(store.db.prepare('SELECT * FROM library_hidden').all()).toEqual([]);
});

test('saved independent copies and one-level undo retain referenced image bytes, then release them', async () => {
  const store = database();
  const image = await processImage(
    await sharp({ create: { width: 12, height: 8, channels: 3, background: '#124c66' } })
      .png()
      .toBuffer()
  );
  putValidatedImageBlob(store.product, {
    id: image.hash,
    hash: image.hash,
    revision: 1,
    mime: image.mime,
    base64: image.bytes.toString('base64'),
  });
  const pkg = nativeContent(
    { name: 'Image bot' },
    {
      images: [
        {
          id: 'portrait',
          title: 'Image',
          description: '',
          blobHash: image.hash,
          mime: image.mime,
          allowedUse: 'both',
        },
      ],
      portraitImageId: 'portrait',
    }
  );
  const bot = store.product.content({ ...fixtureBotInput(), package: pkg }) as Content;
  const input = editableResource('content', bot);
  const withoutImage = { ...input, package: nativeContent({ name: 'Image bot' }) };
  saveResource(store, { kind: 'content', id: bot.id, expectedRevision: 1, model: withoutImage });
  expect(
    store.db.prepare('SELECT hash FROM image_blobs WHERE hash=?').get(image.hash)
  ).toBeTruthy();
  const current = store.product.get<Content>('content', bot.id);
  const chat = importChatTranscript(store, {
    idempotencyKey: randomUUID(),
    transcript: {
      format: 'uimori-chat-transcript',
      version: 2,
      title: 'Inline',
      exportedAt: new Date().toISOString(),
      packageAttachments: [{ id: bot.id, revision: current.revision, role: 'bot' }],
      notes: [],
      entries: [
        {
          request: 'Show image',
          text: `![illustration](/api/package-image-blobs/${image.hash})`,
          translation: null,
        },
      ],
    },
  }).chat;
  const copy = forkChat(store, chat.id, {
    fromRevision: chat.headRevision,
    idempotencyKey: randomUUID(),
  });
  saveResource(store, { kind: 'content', id: bot.id, expectedRevision: 2, model: withoutImage });
  deleteChat(store, chat.id, {});
  expect(
    store.db.prepare('SELECT hash FROM image_blobs WHERE hash=?').get(image.hash)
  ).toBeTruthy();
  expect(store.source(copy.headRevision!).text).toContain(image.hash);
  deleteChat(store, copy.id, {});
  expect(
    store.db.prepare('SELECT hash FROM image_blobs WHERE hash=?').get(image.hash)
  ).toBeUndefined();
});

test('library summary never contains preset programs and variable retries never overwrite current values', () => {
  const { store, chat, branch } = fixture();
  const presets = Array.from({ length: 8 }, (_, i) =>
    store.product.promptPreset({
      title: 'Preset ' + i,
      role: 'main',
      text: 'Long prompt. '.repeat(3000),
    })
  );
  const summary = store.product.library(true);
  expect(summary.promptPresets).toHaveLength(8);
  expect(summary.promptPresets!.every((p) => !('program' in p))).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThan(16000);
  expect(store.product.get('prompt-preset', presets[0].id)).toHaveProperty('program');
  const source = store.source(branch.headRevision!);
  let first: Parameters<typeof writeChatVariables>[3] | undefined;
  for (let i = 0; i < 10; i++) {
    const command = {
      expectedRevision: i,
      expectedSourceHash: source.hash,
      idempotencyKey: randomUUID(),
      values: { large: 'v'.repeat(32000), iteration: String(i) },
    };
    first ??= command;
    writeChatVariables(store, chat.id, branch.id, command);
  }
  expect(writeChatVariables(store, chat.id, branch.id, first!).values.iteration).toBe('9');
  expect(
    Buffer.byteLength(JSON.stringify(store.db.prepare('SELECT * FROM chat_variable_journal').all()))
  ).toBeLessThan(5000);
});

test('real previous schema 3 converts shared branches once while preserving independent user data', () => {
  const path = mkdtempSync(join(tmpdir(), 'uimori-final-migration-'));
  const db = new DatabaseSync(join(path, 'app.sqlite'));
  db.exec('PRAGMA foreign_keys=OFF');
  db.exec(readFileSync(new URL('./fixtures/personal-schema-3.sql', import.meta.url), 'utf8'));
  expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(3);
  const originalId = String(
    db.prepare("SELECT id FROM chats WHERE title='Legacy shared story'").get()!.id
  );
  const standaloneId = String(
    db.prepare("SELECT id FROM chats WHERE title='Standalone unchanged'").get()!.id
  );
  const conversationId = String(db.prepare('SELECT id FROM helper_conversations').get()!.id);
  const artifactText = db.prepare('SELECT text FROM helper_artifacts').get()!.text;
  db.close();
  const owner = { path, store: new Store(join(path, 'app.sqlite')) };
  owners.push(owner);
  const store = owner.store;
  expect(store.db.prepare('PRAGMA user_version').get()?.user_version).toBe(4);
  expect(() => store.chat(originalId)).toThrow('Chat not found');
  expect(store.chat(standaloneId).title).toBe('Standalone unchanged');
  expect(store.context.current(standaloneId)).toMatchObject({
    usable: true,
    checkpoint: { plan: { summary: 'Standalone current summary.' } },
  });
  const copies = store.chats().filter((c) => c.id !== standaloneId);
  expect(copies).toHaveLength(2);
  const alternative = copies.find((c) => c.title.includes('Alternative'))!;
  const original = copies.find((c) => c.id !== alternative.id)!;
  expect(store.history(original.headRevision).map((s) => s.text)).toEqual([
    'Shared first scene.',
    'Default ending.',
  ]);
  expect(store.history(alternative.headRevision).map((s) => s.text)).toEqual([
    'Shared first scene.',
    'Alternative ending.',
  ]);
  expect(
    store.db
      .prepare('SELECT result FROM job_results')
      .all()
      .map((r) => JSON.parse(String(r.result)).text)
  ).toEqual(expect.arrayContaining(['공통 첫 장면.', '기본 결말.']));
  expect(copies.every((c) => store.product.branches(c.id).length === 1)).toBe(true);
  const helpers = new HelperWorkspace(store);
  expect(helpers.conversation(conversationId).scope).toMatchObject({ chatId: alternative.id });
  expect(store.db.prepare('SELECT text FROM helper_artifacts').get()!.text).toBe(artifactText);
  expect(helpers.messages(conversationId).map((m) => m.text)).toEqual(
    expect.arrayContaining(['Preserve this helper question', 'Preserved helper answer.'])
  );
  const options = new ChatOptionsStore(store).get(alternative.id);
  expect(options.pending.map((p) => p.values)).toEqual([{ tone: 'quiet' }]);
  expect(
    store.story.notes
      .entries({ chatId: alternative.id, history: store.history(alternative.headRevision) })
      .map((n) => n.text)
  ).toContain('Only this route has the silver key.');
  expect(
    store.db
      .prepare('SELECT values_json FROM chat_variable_states WHERE chat_id=?')
      .get(alternative.id)?.values_json
  ).toBe('{"choice":"alternate"}');
  expect(store.db.prepare('SELECT count(*) AS n FROM assets').get()?.n).toBe(1);
  expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  const ids = store
    .chats()
    .map((c) => c.id)
    .sort();
  store.close();
  owner.store = new Store(join(path, 'app.sqlite'));
  expect(
    owner.store
      .chats()
      .map((c) => c.id)
      .sort()
  ).toEqual(ids);
});

test('deleting one resource never collects an unrelated image still being attached in another editor', async () => {
  const store = database(),
    bot = store.product.content(fixtureBotInput()) as Content;
  const chat = store.createChat('Remove this chat', 'calm', { botId: bot.id });
  const make = (background: string) =>
    sharp({ create: { width: 10, height: 10, channels: 3, background } })
      .png()
      .toBuffer();
  const staged = await processImage(await make('#105070'));
  putValidatedImageBlob(store.product, {
    id: staged.hash,
    hash: staged.hash,
    revision: 1,
    mime: staged.mime,
    base64: staged.bytes.toString('base64'),
  });
  const removed = await processImage(await make('#b08070'));
  store.product.createAsset(chat.id, {
    title: 'Owned image',
    description: '',
    actor: '',
    outfit: '',
    location: '',
    allowedUse: 'both',
    mime: removed.mime,
    base64: removed.bytes.toString('base64'),
  });
  deleteChat(store, chat.id, {});
  expect(
    store.db.prepare('SELECT hash FROM image_blobs WHERE hash=?').get(staged.hash)
  ).toBeTruthy();
  expect(
    store.db.prepare('SELECT hash FROM image_blobs WHERE hash=?').get(removed.hash)
  ).toBeUndefined();
});
