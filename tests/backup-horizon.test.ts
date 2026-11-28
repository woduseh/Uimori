import { afterEach, expect, test } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import Fastify from 'fastify';
import { Store } from '../server/store.js';
import { ManuscriptSearch } from '../server/manuscript-search.js';
import { foldSearchText } from '../server/search-schema.js';
import { HelperWorkspace } from '../server/helper-workspace.js';
import { illustrationPresetCatalog } from '../server/illustration-presets.js';
import { illustrationSettings } from '../server/illustrations.js';
import { defaultIllustrationSettings } from '../core/illustration.js';
import { deleteChat } from '../server/chat-deletion.js';
import { uploadDirectory, uploadRoutes } from '../server/uploads.js';
import { prepareNativeArchive } from '../server/native-transfer-archive.js';
import { transferRoutes } from '../server/transfer-routes.js';
import { importChatBackupArchiveRequest } from '../server/chat-backup.js';
import type { Content, PromptPreset, SavedPromptCombination } from '../core/product.js';

const fixtures = join(import.meta.dirname, 'fixtures', 'backup-horizon-0.18.0');
const manifest = JSON.parse(readFileSync(join(fixtures, 'manifest.json'), 'utf8'));
const firstScene = 'Golden LANTERN 아래 붉은 우산을 든 미라가 부두에서 기다렸다.';
const secondScene = '강물 위로 보라색우산이 천천히 떠내려갔다.';

const owned: { directory: string; store: Store }[] = [];
afterEach(() => {
  for (const { directory, store } of owned.splice(0)) {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
function database(bytes?: Buffer) {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-horizon-'));
  const path = join(directory, 'app.sqlite');
  if (bytes) writeFileSync(path, bytes);
  const store = new Store(path);
  owned.push({ directory, store });
  return store;
}
function upload(store: Store, name: string) {
  const id = randomBytes(16).toString('hex');
  mkdirSync(uploadDirectory(store.path), { recursive: true });
  writeFileSync(join(uploadDirectory(store.path), `${id}.bin`), readFileSync(join(fixtures, name)));
  return id;
}
const lore = (content: Content) =>
  (content.package.nativeRisu.card.character_book as { entries: { content: string }[] }).entries;

test('stored native greeting titles survive a full database restore and a chat archive import', async () => {
  const source = database(gunzipSync(readFileSync(join(fixtures, 'snapshot.db.gz'))));
  const [chat] = source.chats();
  const [bot] = source.product.all('content') as Content[];
  const starts = [
    { id: 'start-0', title: '  부두에서 — 다시 만남  ', mode: 'authored' as const, text: '인사' },
    { id: 'start-2', title: '', mode: 'authored' as const, text: '인사' },
    { id: 'start-3', title: '시작문 4', mode: 'authored' as const, text: '마지막 인사' },
  ];
  bot.package.nativeRisu.card.first_mes = '인사';
  bot.package.nativeRisu.card.alternate_greetings = ['', '인사', '마지막 인사', '새 인사'];
  bot.package.starts = starts;
  source.db
    .prepare("UPDATE versions SET body=? WHERE kind='content' AND id=? AND revision=?")
    .run(JSON.stringify(bot), bot.id, bot.revision);

  const exporter = Fastify(),
    importer = Fastify();
  const target = database();
  transferRoutes(exporter, source, () => {});
  transferRoutes(importer, target, () => {});
  uploadRoutes(importer, target.path);
  try {
    const full = await exporter.inject({ method: 'GET', url: '/api/backup' });
    expect(full.statusCode).toBe(200);
    const restored = database(full.rawPayload);
    expect(restored.product.stored<Content>('content', bot.id).package.starts).toEqual(starts);

    const archive = await exporter.inject({
      method: 'GET',
      url: `/api/chats/${chat.id}/backup-archive`,
    });
    expect(archive.statusCode).toBe(200);
    const upload = await importer.inject({
      method: 'POST',
      url: '/api/uploads',
      headers: { 'content-type': 'application/octet-stream' },
      payload: archive.rawPayload,
    });
    expect(upload.statusCode).toBe(200);
    const prepared = await importer.inject({
      method: 'POST',
      url: '/api/chats/prepare-backup-archive',
      payload: { uploadId: upload.json().uploadId },
    });
    expect(prepared.statusCode).toBe(200);
    const { preparedId, digest } = prepared.json();
    const imported = await importer.inject({
      method: 'POST',
      url: '/api/chats/import-backup-archive',
      payload: { preparedId, digest, idempotencyKey: 'horizon-start-titles' },
    });
    expect(imported.statusCode).toBe(200);
    const [attachment] = target.product.profile(imported.json().chat.id).packageAttachments!;
    expect(target.product.stored<Content>('content', attachment.id).package.starts).toEqual([
      ...starts,
      { id: 'start-4', title: '첫 메시지 5', mode: 'authored', text: '새 인사' },
    ]);
  } finally {
    await Promise.all([exporter.close(), importer.close()]);
  }
});

test('a v0.18.0 automatic backup, made in a worktree of tag v0.18.0, opens with its chat, search, library, presets and helper conversation', async () => {
  const snapshot = gunzipSync(readFileSync(join(fixtures, 'snapshot.db.gz')));
  expect(manifest).toMatchObject({
    format: 'uimori-snapshot-v1',
    appVersion: '0.18.0',
    schema: 15,
  });
  expect(createHash('sha256').update(snapshot).digest('hex')).toBe(manifest.sha256);
  const store = database(snapshot);

  const [chat] = store.chats();
  expect(chat.title).toBe('Lantern river');
  expect(store.history(chat.headRevision).map((entry) => entry.text)).toEqual([
    firstScene,
    secondScene,
  ]);
  expect(store.db.prepare('SELECT count(*) AS n FROM search_dirty_sources').get()!.n).toBe(0);
  expect(
    store.db.prepare("SELECT 1 FROM sqlite_master WHERE name LIKE 'search_fts%'").get()
  ).toBeUndefined();
  const search = new ManuscriptSearch(store);
  const found = async (query: string) =>
    (await search.search({ query, scope: 'workspace', kinds: ['original'] })).items.map(
      (item) => item.target.sourceId
    );
  const [first, second] = store.history(chat.headRevision).map((entry) => entry.revision);
  expect(await found('golden lantern')).toEqual([first]);
  expect(await found('보라색우산')).toEqual([second]);
  await search.close();

  const [bot] = store.product.all('content') as Content[];
  expect(bot.title).toBe('Mira of the Pier');
  expect(lore(bot).map((entry) => entry.content)).toEqual([
    'The golden lantern on the pier never goes out.',
  ]);
  const preset = (store.product.all('prompt-preset') as PromptPreset[]).find(
    (item) => item.title === 'Horizon main prompt'
  )!;
  expect(store.product.all('prompt-combination')).toMatchObject([
    { title: 'Horizon combination', role: 'main', owner: { kind: 'preset', id: preset.id } },
  ]);
  expect(illustrationPresetCatalog(store).presets.map((item) => item.title)).toContain('Ink wash');
  expect(illustrationSettings(store)).toEqual(defaultIllustrationSettings());

  const conversationId = String(store.db.prepare('SELECT id FROM helper_conversations').get()!.id);
  const helper = new HelperWorkspace(store);
  expect(helper.conversation(conversationId).limits).toEqual({ totalCalls: 128, helperCalls: 64 });
  expect(helper.messages(conversationId).map((message) => message.text)).toEqual([
    'Summarize the lantern lore',
  ]);

  deleteChat(store, chat.id);
  expect(store.db.prepare('SELECT count(*) AS n FROM search_documents').get()!.n).toBe(0);
  store.db.exec("INSERT INTO search_trigrams(search_trigrams) VALUES('integrity-check')");
  expect(store.db.prepare('PRAGMA integrity_check').get()!.integrity_check).toBe('ok');
});

test('a v0.18.0 backup taken before the legacy search index finished moving finds those scenes again', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-horizon-legacy-'));
  const path = join(directory, 'app.sqlite');
  writeFileSync(path, gunzipSync(readFileSync(join(fixtures, 'snapshot.db.gz'))));
  const legacy = new DatabaseSync(path);
  const row = legacy
    .prepare("SELECT id,text FROM search_documents WHERE kind='original' AND text=?")
    .get(firstScene)!;
  legacy
    .prepare('UPDATE search_documents SET search_text=? WHERE id=?')
    .run(foldSearchText(String(row.text)), Number(row.id));
  legacy.prepare('DELETE FROM search_trigrams WHERE rowid=?').run(Number(row.id));
  legacy.close();
  const store = database(readFileSync(path));
  rmSync(directory, { recursive: true, force: true });

  const search = new ManuscriptSearch(store);
  const [first] = store.history(store.chats()[0].headRevision).map((entry) => entry.revision);
  const found = async () =>
    (await search.search({ query: 'golden lantern', scope: 'workspace', kinds: ['original'] }))
      .items;
  expect((await found()).map((item) => item.target.sourceId)).toEqual([first]);
  await search.refreshBatch();
  expect(store.db.prepare('SELECT count(*) AS n FROM search_dirty_sources').get()!.n).toBe(0);
  expect(
    store.db.prepare("SELECT count(*) AS n FROM search_documents WHERE search_text<>''").get()!.n
  ).toBe(0);
  expect((await found()).map((item) => item.target.sourceId)).toEqual([first]);
  await search.close();
});

test('.uimori and .chat.uimori archives exported by v0.18.0 import as new copies', async () => {
  const store = database();
  const resources = await prepareNativeArchive(
    store,
    upload(store, 'resources.uimori'),
    'resources'
  );
  const app = Fastify();
  transferRoutes(app, store, () => {});
  const applied = await app.inject({
    method: 'POST',
    url: '/api/native-transfers/apply-archive',
    payload: {
      preparedId: resources.preparedId,
      digest: resources.digest,
      idempotencyKey: 'horizon-resources',
      modelBindings: [],
    },
  });
  await app.close();
  expect(applied.statusCode).toBe(200);
  const imported = store.product.all('content') as Content[];
  expect(imported.map((item) => item.title)).toEqual(['Mira of the Pier']);
  expect(lore(imported[0]).map((entry) => entry.content)).toEqual([
    'The golden lantern on the pier never goes out.',
  ]);
  const preset = (store.product.all('prompt-preset') as PromptPreset[]).find(
    (item) => item.title === 'Horizon main prompt'
  )!;
  expect(store.product.all('prompt-combination') as SavedPromptCombination[]).toMatchObject([
    { title: 'Horizon combination', owner: { kind: 'preset', id: preset.id } },
  ]);

  const backup = await prepareNativeArchive(store, upload(store, 'chat.chat.uimori'), 'chat');
  const restored = importChatBackupArchiveRequest(store, {
    preparedId: backup.preparedId,
    digest: backup.digest,
    idempotencyKey: 'horizon-chat',
  });
  expect(restored.chat.title).toBe('Lantern river');
  expect(store.history(restored.chat.headRevision).map((entry) => entry.text)).toEqual([
    firstScene,
    secondScene,
  ]);
  expect(store.product.all('content')).toHaveLength(2);
});
