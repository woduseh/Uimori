import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { ManuscriptSearch } from '../server/manuscript-search.js';
import { deleteChat } from '../server/chat-deletion.js';
import { createApp, type App } from '../server/app.js';
import { createFixtureChat } from './fixtures/chat.js';
import { completedSource } from './fixtures/illustration.js';
import { readerTargetFromUrl, readerTargetUrl } from '../core/reader-target.js';
import type { ManuscriptSearchQuery } from '../core/manuscript-search.js';

const owned: { directory: string; store: Store; search: ManuscriptSearch }[] = [];
const apps: App[] = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-search-'));
  const store = new Store(join(directory, 'app.sqlite'));
  const search = new ManuscriptSearch(store);
  const value = { directory, store, search };
  owned.push(value);
  return value;
}
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const item of owned.splice(0)) {
    await item.search.close();
    item.store.close();
    rmSync(item.directory, { recursive: true, force: true });
  }
});
const query = (
  text: string,
  overrides: Partial<ManuscriptSearchQuery> = {}
): ManuscriptSearchQuery => ({
  query: text,
  scope: 'workspace',
  kinds: ['original', 'translation', 'request'],
  ...overrides,
});
async function index(search: ManuscriptSearch, store: Store) {
  for (
    let count = 0;
    count < 100 && store.db.prepare('SELECT 1 FROM search_dirty_sources LIMIT 1').get();
    count++
  )
    await search.refreshBatch();
  expect(store.db.prepare('SELECT count(*) AS n FROM search_dirty_sources').get()!.n).toBe(0);
}

test('short Korean/Japanese names, phrases and literal operators work before and after indexing without executing markup', async () => {
  const { store, search } = fixture();
  const chat = createFixtureChat(store, 'Rainy day');
  const source = completedSource(
    store,
    chat.id,
    '미카는 **붉은 우산**을 접었다.\n\nアリスは東京へ行った。 100%와 a_b.\n\n<script>SECRET_SCRIPT_TOKEN</script>\n<style>SECRET_STYLE_TOKEN</style>'
  );
  for (let phase = 0; phase < 2; phase++) {
    for (const text of ['미카', '東京', '미카 우산', '"붉은 우산"', '%']) {
      const result = await search.search(query(text));
      expect(
        result.items.map((item) => item.target.sourceId),
        text
      ).toEqual([source.id]);
      expect(result.items[0].sceneNumber).toBe(1);
      expect(result.items[0].target).not.toHaveProperty('branchId');
    }
    for (const text of ['SECRET_SCRIPT_TOKEN', 'SECRET_STYLE_TOKEN', 'a%b', '" OR 1=1 --'])
      expect((await search.search(query(text))).items).toEqual([]);
    await index(search, store);
  }
  expect(store.db.prepare('SELECT count(*) AS n FROM search_documents').get()!.n).toBe(2);
});

test('a dirty source overlays the index immediately, including current translations and deletion', async () => {
  const { store, search } = fixture();
  const chat = createFixtureChat(store, 'Current documents');
  const source = completedSource(store, chat.id, 'Original golden lantern');
  const translated = store.editTranslation(source.id, {
    text: '금빛 등불',
    expectedRevision: 0,
    expectedSourceHash: source.hash,
  });
  await index(search, store);
  expect((await search.search(query('금빛'))).items[0].matches[0].kind).toBe('translation');
  store.editTranslation(source.id, {
    text: '새로운 별빛',
    expectedRevision: translated.revision!,
    expectedSourceHash: source.hash,
  });
  expect((await search.search(query('금빛'))).items).toEqual([]);
  expect((await search.search(query('별빛'))).items).toHaveLength(1);
  store.editSource(source.id, { text: 'Original silver lantern', expectedRevision: 0 });
  expect((await search.search(query('golden'))).items).toEqual([]);
  expect((await search.search(query('silver'))).items).toHaveLength(1);
  expect((await search.search(query('별빛'))).items).toEqual([]);
  await index(search, store);
  deleteChat(store, chat.id, {});
  expect((await search.search(query('lantern'))).items).toEqual([]);
  expect(store.db.prepare('SELECT count(*) AS n FROM search_documents').get()!.n).toBe(0);
  expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

test('pagination stays stable across index refresh, scopes isolate bots, and unrelated edits never restart a scoped search', async () => {
  const { store, search } = fixture();
  const chat = createFixtureChat(store, 'First');
  const first = completedSource(store, chat.id, '같은 이름 미카');
  const second = completedSource(store, chat.id, '같은 이름 미카 다시');
  const other = createFixtureChat(store, 'Other');
  const otherSource = completedSource(store, other.id, '미카는 다른 이야기');
  const filter = query('미카', { scope: 'bot', botId: chat.botId, limit: 1 });
  const page = await search.search(filter);
  expect(page.items[0].target.sourceId).toBe(first.id);
  expect(page.nextCursor).toBeTruthy();
  await index(search, store);
  const next = await search.search({ ...filter, cursor: page.nextCursor });
  expect(next.items[0].target.sourceId).toBe(second.id);
  expect(next.items[0].sceneNumber).toBe(2);
  expect(
    (await search.search(query('미카', { scope: 'chat', chatId: other.id }))).items
  ).toHaveLength(1);
  store.editSource(otherSource.id, { text: '미카의 다른 새 장면', expectedRevision: 0 });
  expect(
    (await search.search({ ...filter, cursor: page.nextCursor })).items[0].target.sourceId
  ).toBe(second.id);
  store.editSource(first.id, { text: '달라진 이름', expectedRevision: 0 });
  expect(
    (await search.search({ ...filter, cursor: page.nextCursor })).items[0].target.sourceId
  ).toBe(second.id);
  await expect(
    search.search({ ...filter, query: '다른 검색', cursor: page.nextCursor })
  ).rejects.toThrow('SEARCH_CURSOR_STALE');
});

test('a slow or cancelled search does not block writes and does not turn a partial scan into no matches', async () => {
  const { store, search } = fixture();
  const chat = createFixtureChat(store, 'Responsive');
  completedSource(
    store,
    chat.id,
    `${'긴 문장으로 채워진 원고입니다.\n\n'.repeat(12000)}끝에서만 찾는 보라색우산`
  );
  const pending = search.search(query('보라색우산'));
  const other = createFixtureChat(store, 'A write while searching');
  expect(store.chat(other.id).title).toBe(other.title);
  expect((await pending).items).toHaveLength(1);
  const controller = new AbortController();
  controller.abort();
  await expect(search.search(query('보라색우산'), controller.signal)).rejects.toThrow();
});

test('common location URLs preserve IDs and mode, and POST search stays read-only during maintenance', async () => {
  const { store, search, directory } = fixture();
  const chat = createFixtureChat(store, 'Maintenance');
  const source = completedSource(store, chat.id, '검증할 문장');
  const target = {
    chatId: chat.id,
    sourceId: source.id,
    representation: 'original' as const,
    contentHash: source.hash,
    blockAnchor: source.blocks![0].anchor,
  };
  expect(readerTargetFromUrl(readerTargetUrl(target))).toEqual(target);
  await search.close();
  const app = await createApp({
    dbPath: join(directory, 'read-only-api.sqlite'),
    buildId: 'fixture',
    testMode: true,
    maintenance: true,
  });
  apps.push(app);
  const before = app.store.db.prepare('SELECT count(*) AS n FROM search_documents').get()!.n;
  const response = await app.inject({ method: 'POST', url: '/api/search', payload: query('문장') });
  expect(response.statusCode, response.body).toBe(200);
  expect(app.store.db.prepare('SELECT count(*) AS n FROM search_documents').get()!.n).toBe(before);
});

test('an index written by the previous release keeps answering while it moves to the compact index', async () => {
  const { directory, store, search } = fixture();
  const chat = createFixtureChat(store, 'Legacy index');
  const sources = [
    completedSource(store, chat.id, 'Golden LANTERN 아래 붉은 우산'),
    completedSource(store, chat.id, `${'긴 원고. '.repeat(40000)}보라색우산`),
  ];
  await index(search, store);
  const documents = store.db
    .prepare('SELECT source_id,chat_id,kind,content_hash,text FROM search_documents ORDER BY id')
    .all();
  store.db.exec(`DROP TRIGGER search_document_insert; DROP TRIGGER search_document_delete;
    DROP TRIGGER search_document_update; DROP TABLE search_trigrams; DELETE FROM search_documents;
    CREATE TRIGGER search_document_insert AFTER INSERT ON search_documents BEGIN
      INSERT INTO search_fts(rowid,search_text) VALUES(new.id,new.search_text); END;
    CREATE TRIGGER search_document_delete AFTER DELETE ON search_documents BEGIN
      INSERT INTO search_fts(search_fts,rowid,search_text) VALUES('delete',old.id,old.search_text); END;
    CREATE TRIGGER search_document_update AFTER UPDATE OF search_text ON search_documents BEGIN
      INSERT INTO search_fts(search_fts,rowid,search_text) VALUES('delete',old.id,old.search_text);
      INSERT INTO search_fts(rowid,search_text) VALUES(new.id,new.search_text); END;`);
  const legacyInsert = (target: Store, row: Record<string, unknown>) =>
    target.db
      .prepare(
        'INSERT INTO search_documents(source_id,chat_id,kind,content_hash,text,search_text) VALUES(?,?,?,?,?,?)'
      )
      .run(
        String(row.source_id),
        String(row.chat_id),
        String(row.kind),
        String(row.content_hash),
        String(row.text),
        String(row.text).normalize('NFC').toLowerCase()
      );
  for (const row of documents) legacyInsert(store, row);
  await search.close();
  store.close();
  owned.pop();

  const reopened = new Store(join(directory, 'app.sqlite'));
  const upgraded = new ManuscriptSearch(reopened);
  owned.push({ directory, store: reopened, search: upgraded });
  const found = async (text: string) =>
    (await upgraded.search(query(text))).items.map((item) => item.target.sourceId);
  const legacyRows = () =>
    Number(
      reopened.db.prepare("SELECT count(*) AS n FROM search_documents WHERE search_text<>''").get()!
        .n
    );
  expect(legacyRows()).toBe(documents.length);
  expect(await found('golden lantern')).toEqual([sources[0].id]);
  expect(upgraded.moveLegacyIndexBatch()).toBe(true);
  expect(legacyRows()).toBeGreaterThan(0);
  expect(legacyRows()).toBeLessThan(documents.length);
  expect(await found('보라색우산')).toEqual([sources[1].id]);
  expect(await found('golden lantern')).toEqual([sources[0].id]);
  for (let step = 0; step < 20 && upgraded.moveLegacyIndexBatch(); step++);
  expect(legacyRows()).toBe(0);
  expect(upgraded.moveLegacyIndexBatch()).toBe(false);
  expect(reopened.db.prepare('SELECT count(*) AS n FROM search_fts_idx').get()!.n).toBe(0);
  expect(await found('LANTERN 아래')).toEqual([sources[0].id]);
  expect(await found('보라색우산')).toEqual([sources[1].id]);
  expect(await found('없는 문장')).toEqual([]);

  reopened.db.prepare('DELETE FROM search_documents WHERE source_id=?').run(sources[0].id);
  legacyInsert(reopened, { ...documents[0], text: 'Written by the earlier release: cobalt' });
  expect(await found('cobalt')).toEqual([sources[0].id]);
  for (const table of ['search_fts', 'search_trigrams'])
    reopened.db.exec(`INSERT INTO ${table}(${table}) VALUES('integrity-check')`);
  deleteChat(reopened, chat.id, {});
  expect(reopened.db.prepare('SELECT count(*) AS n FROM search_documents').get()!.n).toBe(0);
  expect(reopened.db.prepare('SELECT count(*) AS n FROM search_fts_docsize').get()!.n).toBe(0);
  expect(
    reopened.db
      .prepare("SELECT count(*) AS n FROM search_trigrams WHERE search_trigrams MATCH 'ant'")
      .get()!.n
  ).toBe(0);
  for (const table of ['search_fts', 'search_trigrams'])
    reopened.db.exec(`INSERT INTO ${table}(${table}) VALUES('integrity-check')`);
  expect(reopened.db.prepare('PRAGMA integrity_check').get()!.integrity_check).toBe('ok');
});

test('large index updates make bounded progress rather than grouping eight oversized scenes', async () => {
  const { store, search } = fixture();
  const chat = createFixtureChat(store, 'Bounded indexing');
  for (let index = 0; index < 3; index++)
    completedSource(store, chat.id, `${'길게 쓴 원고. '.repeat(30000)}보라색우산`);
  const count = () =>
    Number(store.db.prepare('SELECT count(*) AS n FROM search_dirty_sources').get()!.n);
  expect(count()).toBe(3);
  await search.refreshBatch();
  expect(count()).toBe(2);
  expect((await search.search(query('보라색우산'))).items).toHaveLength(3);
  await index(search, store);
  expect((await search.search(query('보라색우산'))).items).toHaveLength(3);
});
