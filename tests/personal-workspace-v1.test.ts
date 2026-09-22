import { DATABASE_SCHEMA_VERSION } from '../server/database-schema.js';
import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import { fixtureBotInput } from './fixtures/chat.js';
import { nativeDraftTitle } from './fixtures/native-content.js';
import { saveResource, undoResource } from '../server/resource-service.js';
import { editableResource } from '../core/resource-editing.js';
import { JevCredentialStore } from '../server/jev-credentials.js';
import { AccessSessions } from '../server/access-session.js';
import { processImage } from '../server/image-processing.js';
import { storeImage, readImage } from '../server/image-storage.js';
import {
  exportResourceBundle,
  importResourceBundle,
  inspectBundle,
} from '../server/resource-bundle.js';
import { importChatTranscript } from '../server/chat-transcript.js';
import { exportChatBackup, importChatBackup } from '../server/chat-backup.js';
import { forkChat } from '../server/chat-fork.js';
import { invokeResourceTool } from '../server/helper-resource-tools.js';

const owned: { path: string; store?: Store; app?: Awaited<ReturnType<typeof createApp>> }[] = [];
afterEach(async () => {
  for (const item of owned.splice(0)) {
    if (item.app) await item.app.close();
    else item.store?.close();
    rmSync(item.path, { recursive: true, force: true });
  }
});
function database() {
  const path = mkdtempSync(join(tmpdir(), 'uimori-personal-v1-'));
  const store = new Store(join(path, 'app.sqlite'));
  owned.push({ path, store });
  return store;
}

test('fresh schema is personal v1; adding an index does not block reopening', () => {
  const store = database();
  expect(store.db.prepare('PRAGMA user_version').get()!.user_version).toBe(DATABASE_SCHEMA_VERSION);
  store.db.exec('CREATE INDEX extra_user_index ON sources(created_at)');
  const path = store.path;
  store.close();
  const reopened = new Store(path);
  owned.at(-1)!.store = reopened;
  expect(
    reopened.db.prepare("SELECT name FROM sqlite_schema WHERE name='extra_user_index'").get()
  ).toBeTruthy();
});

test('API keys including JEV share SQLite; public connection data never contains the key', () => {
  const store = database();
  const connection = store.product.connection({
    title: 'API',
    protocol: 'openai-chat-v1',
    endpoint: 'https://api.openai.com/v1',
    apiKey: 'sk-test-local-only',
    enabled: true,
  });
  expect(JSON.stringify(connection)).not.toContain('sk-test-local-only');
  expect(store.credentials.get(connection.credentialRef)).toBe('sk-test-local-only');
  const jev = new JevCredentialStore(store.db);
  jev.update(0, 'jev-test-local-only');
  expect(jev.resolve()).toBe('jev-test-local-only');
  expect(JSON.stringify(jev.status())).not.toContain('jev-test-local-only');
  const path = store.path;
  store.close();
  const reopened = new Store(path);
  owned.at(-1)!.store = reopened;
  expect(reopened.credentials.get(connection.credentialRef)).toBe('sk-test-local-only');
  expect(new JevCredentialStore(reopened.db).resolve()).toBe('jev-test-local-only');
});

test('sessions do not expire with time or restart, and logout revokes the device', () => {
  const store = database();
  const options = {
    accessToken: 'local-only-test-access-token'.repeat(2),
    publicOrigin: 'https://test.example',
    now: () => 0,
  };
  const sessions = new AccessSessions(store.db, options);
  const cookie = sessions.login(options.accessToken).cookie;
  expect(sessions.authenticated(cookie)).toBe(true);
  expect(
    new AccessSessions(store.db, { ...options, now: () => 10 ** 13 }).authenticated(cookie)
  ).toBe(true);
  const path = store.path;
  store.close();
  const reopened = new Store(path);
  owned.at(-1)!.store = reopened;
  const next = new AccessSessions(reopened.db, options);
  expect(next.authenticated(cookie)).toBe(true);
  next.logout(cookie);
  expect(next.authenticated(cookie)).toBe(false);
});

test('ordinary saves retain only one undo record and reject stale revisions', () => {
  const store = database();
  const first = saveResource(store, {
    kind: 'content',
    id: null,
    model: fixtureBotInput('Before', 'Long source '.repeat(1000)),
  });
  const initial = first.saved as import('../core/product.js').Content;
  let saved = initial;
  for (let i = 0; i < 12; i++)
    saved = saveResource(store, {
      kind: 'content',
      id: saved.id,
      expectedRevision: saved.revision,
      model: nativeDraftTitle(editableResource('content', saved), `Change ${i}`),
    }).saved as typeof initial;
  expect(store.db.prepare('SELECT count(*) AS n FROM resource_undo').get()!.n).toBe(1);
  expect(() =>
    saveResource(store, {
      kind: 'content',
      id: initial.id,
      expectedRevision: initial.revision,
      model: editableResource('content', initial),
    })
  ).toThrow();
  expect(
    (undoResource(store, 'content', saved.id, saved.revision).saved as typeof initial).title
  ).toBe('Change 10');
});

test('helper resource tools can directly create and edit outside any selected editor', () => {
  const store = database();
  const saved = invokeResourceTool(store, 'resource.save', {
    kind: 'content',
    model: fixtureBotInput('Helper bot', 'body'),
  }) as { id: string; revision: number };
  const current = invokeResourceTool(store, 'resource.read', {
    kind: 'content',
    id: saved.id,
  }) as import('../core/product.js').Content;
  expect(current.title).toBe('Helper bot');
  invokeResourceTool(store, 'resource.save', {
    kind: 'content',
    id: current.id,
    expectedRevision: current.revision,
    model: nativeDraftTitle(editableResource('content', current), 'Updated'),
  });
  expect(store.product.get<typeof current>('content', current.id).title).toBe('Updated');
});

test('WebP intake preserves dimensions and alpha; already-WebP data is not re-encoded', async () => {
  const png = await sharp({
    create: {
      width: 128,
      height: 96,
      channels: 4,
      background: { r: 120, g: 30, b: 80, alpha: 0.5 },
    },
  })
    .png()
    .toBuffer();
  const image = await processImage(png);
  const metadata = await sharp(image.bytes).metadata();
  expect(metadata.format).toBe('webp');
  expect(metadata.width).toBe(128);
  expect(metadata.height).toBe(96);
  expect(metadata.hasAlpha).toBe(true);
  expect((await processImage(image.bytes)).bytes.equals(image.bytes)).toBe(true);
  const store = database();
  storeImage(store.db, image);
  expect(readImage(store.db, image.hash).bytes.equals(image.bytes)).toBe(true);
});

test('individual resource import creates fresh identities and current data survives a round trip', () => {
  const store = database();
  const bot = store.product.content(fixtureBotInput('Portable bot', 'portable source'));
  const file = exportResourceBundle(store, [{ kind: 'content', id: bot.id }]);
  const target = database();
  const input = {
    file,
    digest: inspectBundle(file).digest,
    modelBindings: [],
    idempotencyKey: randomUUID(),
  };
  const result = importResourceBundle(target, input);
  expect(result.items[0]!.id).not.toBe(bot.id);
  expect(target.product.get<any>('content', result.items[0]!.id).text).toBe('portable source');
  expect(importResourceBundle(target, input).created).toBe(false);
});

function story(store: Store) {
  const bot = store.product.content(fixtureBotInput('Story bot', 'Friendly bot'));
  return importChatTranscript(store, {
    idempotencyKey: randomUUID(),
    transcript: {
      format: 'uimori-chat-transcript',
      version: 2,
      exportedAt: new Date().toISOString(),
      title: 'Story',
      packageAttachments: [{ id: bot.id, revision: bot.revision, role: 'bot' }],
      notes: [],
      entries: [
        { request: 'First request', text: 'First scene', translation: '첫 장면' },
        { request: 'Second request', text: 'Second scene', translation: null },
      ],
    },
  }).chat;
}

test('fork is an independent chat and only copies through the selected source', () => {
  const store = database();
  const chat = story(store);
  const history = store.history(chat.headRevision);
  const copy = forkChat(store, chat.id, {
    fromRevision: history[0]!.revision,
    idempotencyKey: randomUUID(),
  });
  const copied = store.history(copy.headRevision);
  expect(copy.id).not.toBe(chat.id);
  expect(copied).toHaveLength(1);
  expect(copied[0]!.text).toBe('First scene');
  expect(copied[0]!.revision).not.toBe(history[0]!.revision);
  expect(
    store.db.prepare('SELECT count(*) AS n FROM attempts WHERE chat_id=?').get(copy.id)!.n
  ).toBe(0);
});

test('portable chat restores fresh resources and a continuing conversation without execution history', async () => {
  const source = database();
  const chat = story(source);
  const file = exportChatBackup(source, chat.id);
  expect(file).not.toHaveProperty('records');
  const target = database();
  const result = await importChatBackup(target, { backup: file, idempotencyKey: randomUUID() });
  expect(result.created).toBe(true);
  expect(result.chat.id).not.toBe(chat.id);
  expect(target.history(result.chat.headRevision).map((item) => item.text)).toEqual([
    'First scene',
    'Second scene',
  ]);
  expect(target.product.profile(result.chat.id).packageAttachments?.[0]?.id).not.toBe(
    source.product.profile(chat.id).packageAttachments?.[0]?.id
  );
  expect(target.product.snapshot(result.chat.id).packages?.length).toBeGreaterThan(0);
});
