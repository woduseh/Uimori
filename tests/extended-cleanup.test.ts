import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { createApp, type App } from '../server/app.js';
import { applyRisuImport, prepareRisuImport } from '../server/risu-import.js';
import { exportChatBackup, importChatBackup } from '../server/chat-backup.js';
import { flushPendingImageCleanup, pruneUnusedData } from '../server/unused-data.js';
import { pruneSourceEdits, pruneTranslationHistory } from '../server/text-retention.js';
import { HelperWorkspace } from '../server/helper-workspace.js';
import { emptyTheme } from '../core/themes.js';
import { saveResource } from '../server/resource-service.js';

const owners: { directory: string; store: Store; app?: App }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const owner of owners.splice(0)) {
    if (owner.app) await owner.app.close();
    else owner.store.close();
    rmSync(owner.directory, { recursive: true, force: true });
  }
});
function database() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-extended-cleanup-'));
  const owner = { directory, store: new Store(join(directory, 'app.sqlite')) };
  owners.push(owner);
  return owner;
}
async function application() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-extended-cleanup-'));
  const app = await createApp({
    dbPath: join(directory, 'app.sqlite'),
    buildId: 'extended-cleanup-test',
    testMode: true,
    codex: { enabled: false },
  });
  owners.push({ directory, store: app.store, app });
  return app;
}
async function manuscript(store: Store) {
  const card = {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: 'Synthetic cleanup bot',
      description: 'Only synthetic test data.',
      first_mes: 'Original manuscript.',
    },
  };
  const source = {
    name: 'synthetic.json',
    base64: Buffer.from(JSON.stringify(card)).toString('base64'),
  };
  const prepared = prepareRisuImport({ source });
  const result = await applyRisuImport(store, {
    source,
    digest: prepared.digest,
    allowPartial: false,
    idempotencyKey: randomUUID(),
  });
  const row = store.db.prepare('SELECT id FROM sources WHERE chat_id=?').get(result.chat!.id)!;
  return { chat: result.chat!, source: store.source(String(row.id)) };
}

test('provider/model conflict recovery can retrieve the current revision without returning API keys', async () => {
  const app = await application();
  const connection = app.store.product.connection({
    title: 'Current provider',
    protocol: 'fixture-sse-v1',
    endpoint: 'http://127.0.0.1:9',
    enabled: true,
  });
  const model = app.store.product.model({
    title: 'Current model',
    connectionId: connection.id,
    modelId: 'synthetic',
    temperature: null,
    maxOutputTokens: 1024,
  });
  for (const [route, item] of [
    ['connections', connection],
    ['model-presets', model],
  ] as const) {
    const response = await app.inject({ url: `/api/${route}/${item.id}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: item.id,
      title: item.title,
      revision: item.revision,
    });
    expect(response.json()).not.toHaveProperty('apiKey');
  }
});

test('concurrent copies of the same backup return one committed result', async () => {
  const { store } = database();
  const { chat } = await manuscript(store);
  const body = { backup: exportChatBackup(store, chat.id), idempotencyKey: 'same-copy' };
  const [first, second] = await Promise.all([
    importChatBackup(store, body),
    importChatBackup(store, body),
  ]);
  expect([first.created, second.created].sort()).toEqual([false, true]);
  expect(first.chat.id).toBe(second.chat.id);
  expect(store.chats()).toHaveLength(2);
  expect((await importChatBackup(store, body)).created).toBe(false);
});

test('empty cleanup does not scan manuscript or execution tables', () => {
  const { store } = database();
  const prepare = vi.spyOn(store.db, 'prepare');
  pruneUnusedData(store.db);
  expect(prepare.mock.calls.map(([sql]) => sql).join('\n')).not.toMatch(
    /FROM (sources|source_edits|runs|helper_messages|job_results)\b/u
  );
});

test('busy image cleanup survives a database restart and is drained without resupplying candidates', async () => {
  const owner = database();
  const { source } = await manuscript(owner.store);
  const hash = 'a'.repeat(64);
  owner.store.db
    .prepare('INSERT INTO image_blobs VALUES(?,?,?)')
    .run(hash, 'image/webp', Buffer.from('synthetic unused bytes'));
  owner.store.db.prepare("UPDATE runs SET status='running' WHERE id=?").run(source.runId);
  pruneUnusedData(owner.store.db, [hash]);
  expect(owner.store.db.prepare('SELECT hash FROM image_cleanup_candidates').all()).toEqual([
    { hash },
  ]);
  owner.store.close();
  owner.store = new Store(join(owner.directory, 'app.sqlite'));
  owner.store.db.prepare("UPDATE runs SET status='completed' WHERE id=?").run(source.runId);
  flushPendingImageCleanup(owner.store.db);
  expect(
    owner.store.db.prepare('SELECT 1 FROM image_blobs WHERE hash=?').get(hash)
  ).toBeUndefined();
  expect(owner.store.db.prepare('SELECT 1 FROM image_cleanup_candidates').get()).toBeUndefined();
});

test('repeated direct edits retain two edited versions and two translations, not unlimited full text', async () => {
  const { store } = database();
  let { source } = await manuscript(store);
  let previousHash = '';
  for (let i = 0; i < 20; i++) {
    previousHash = source.hash;
    source = store.editSource(source.id, {
      text: `Edited synthetic text ${i}`,
      expectedRevision: source.editRevision ?? 0,
    });
  }
  for (let i = 0; i < 20; i++) {
    source = store.source(source.id);
    store.editTranslation(source.id, {
      text: `Saved translation ${i}`,
      expectedRevision: source.translationRevision ?? 0,
      expectedSourceHash: source.hash,
    });
  }
  expect(
    store.db.prepare('SELECT COUNT(*) AS n FROM source_edits WHERE source_id=?').get(source.id)?.n
  ).toBe(2);
  expect(
    store.db
      .prepare("SELECT COUNT(*) AS n FROM jobs WHERE source_revision=? AND kind='translation'")
      .get(source.id)?.n
  ).toBe(2);
  expect(store.db.prepare('SELECT COUNT(*) AS n FROM job_results').get()?.n).toBe(2);
  expect(store.sourceAtHash(source.id, previousHash).text).toBe('Edited synthetic text 18');
  expect(store.sourceOriginal(source.id).text).toBe('Original manuscript.');
  expect(store.source(source.id).text).toBe('Edited synthetic text 19');
});

test('an unfinished helper retains its exact edited source until the capture is released', async () => {
  const { store } = database();
  let { source } = await manuscript(store);
  source = store.editSource(source.id, { text: 'Pinned source', expectedRevision: 0 });
  const pinnedHash = source.hash;
  const helper = new HelperWorkspace(store).create(
    { kind: 'library', workId: 'synthetic' },
    'retention'
  );
  store.db
    .prepare(
      'INSERT INTO helper_tasks(id,conversation_id,request_key,request,status,snapshot,usage,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)'
    )
    .run(
      'retained-input',
      helper.id,
      'retained-input',
      'Synthetic',
      'interrupted',
      JSON.stringify({ writing: { history: [{ revision: source.id, contentHash: pinnedHash }] } }),
      '{}',
      '2026-09-22',
      '2026-09-22'
    );
  for (let i = 0; i < 5; i++)
    source = store.editSource(source.id, {
      text: `Current ${i}`,
      expectedRevision: source.editRevision ?? 0,
    });
  expect(store.sourceAtHash(source.id, pinnedHash).text).toBe('Pinned source');
  store.db
    .prepare("UPDATE helper_tasks SET status='completed',snapshot='{}' WHERE id='retained-input'")
    .run();
  pruneSourceEdits(store.db, source.id);
  expect(() => store.sourceAtHash(source.id, pinnedHash)).toThrow('Unknown source content hash');
});

test('a translation used by a current image target is retained until that target is released', async () => {
  const { store } = database();
  const { source } = await manuscript(store);
  const first = store.editTranslation(source.id, {
    text: 'Pinned translation',
    expectedRevision: 0,
    expectedSourceHash: source.hash,
  });
  store.db
    .prepare(
      "INSERT INTO jobs(id,chat_id,source_revision,source_hash,kind,status,revision,input,created_at,updated_at) VALUES(?,?,?,?,'image','completed',1,?,?,?)"
    )
    .run(
      'image-target',
      source.chatId,
      source.id,
      source.hash,
      JSON.stringify({ imageTarget: { mode: 'translation', translationJobId: first.id } }),
      '2026-09-22',
      '2026-09-22'
    );
  // Simulate completed generated translations: direct editing intentionally invalidates old image targets.
  for (let revision = 2; revision <= 8; revision++) {
    const id = `translation-${revision}`;
    store.db
      .prepare(
        "INSERT INTO jobs(id,chat_id,source_revision,source_hash,kind,status,revision,created_at,updated_at) VALUES(?,?,?,?,'translation','completed',?,?,?)"
      )
      .run(id, source.chatId, source.id, source.hash, revision, '2026-09-22', '2026-09-22');
    store.db
      .prepare('INSERT INTO job_results VALUES(?,?,?,?)')
      .run(id, 1, JSON.stringify({ text: `Translation ${revision}` }), '2026-09-22');
  }
  pruneTranslationHistory(store.db, source.id);
  expect(store.job(first.id).result).toMatchObject({ text: 'Pinned translation' });
  store.db.prepare("UPDATE jobs SET status='stale' WHERE id='image-target'").run();
  pruneTranslationHistory(store.db, source.id);
  expect(() => store.job(first.id)).toThrow();
});

test('helper opening returns current state and a cursor beyond old update pages', async () => {
  const app = await application();
  const workspace = new HelperWorkspace(app.store);
  const conversation = workspace.create({ kind: 'library', workId: 'synthetic' }, 'open');
  app.store.transaction(() => {
    for (let i = 0; i < 1200; i++) workspace.event(conversation.id, null, 'conversation.updated');
  });
  const response = await app.inject({ url: `/api/helper/conversations/${conversation.id}/view` });
  expect(response.statusCode).toBe(200);
  const view = response.json();
  expect(view.eventCursor).toBe(workspace.latestEventSequence(conversation.id));
  expect(view.messages).toEqual([]);
  expect(workspace.events(conversation.id, view.eventCursor)).toEqual([]);
  workspace.event(conversation.id, null, 'theme.updated');
  expect(workspace.events(conversation.id, view.eventCursor).map((event) => event.kind)).toEqual([
    'theme.updated',
  ]);
});

test('unchanged theme catalog revalidates without sending definitions, and saves invalidate its ETag', async () => {
  const app = await application();
  const first = await app.inject({ url: '/api/themes' });
  expect(first.statusCode).toBe(200);
  const headers = { 'if-none-match': String(first.headers.etag) };
  const same = await app.inject({ url: '/api/themes', headers });
  expect(same.statusCode).toBe(304);
  expect(same.body).toBe('');
  saveResource(app.store, { kind: 'theme', id: null, model: emptyTheme('New synthetic theme') });
  const changed = await app.inject({ url: '/api/themes', headers });
  expect(changed.statusCode).toBe(200);
  expect(changed.headers.etag).not.toBe(first.headers.etag);
});
