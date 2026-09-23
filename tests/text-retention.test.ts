import sharp from 'sharp';
import { fixtureBotInput } from './fixtures/chat.js';
import { nativeContent } from './fixtures/native-content.js';
import { importChatTranscript } from '../server/chat-transcript.js';
import { deleteChat, chatDeletionImpact } from '../server/chat-deletion.js';
import { deleteLibraryItem } from '../server/library-deletion.js';
import { processImage } from '../server/image-processing.js';
import { putValidatedImageBlob } from '../server/package-images.js';
import { saveResource } from '../server/resource-service.js';
import { editableResource } from '../core/resource-editing.js';
import { forkChat } from '../server/chat-fork.js';
import { type Content } from '../core/product.js';
import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/store.js';
import { type App } from '../server/app.js';
import { applyRisuImport, prepareRisuImport } from '../server/risu-import.js';
import { flushPendingImageCleanup, pruneUnusedData } from '../server/unused-data.js';
import { pruneSourceEdits, pruneTranslationHistory } from '../server/text-retention.js';
import { HelperWorkspace } from '../server/helper-workspace.js';
import { describe } from 'vitest';

describe('Saved text and dependent image retention', () => {
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
    const directory = mkdtempSync(join(tmpdir(), 'uimori-retention-'));
    const owner = { directory, store: new Store(join(directory, 'app.sqlite')) };
    owners.push(owner);
    return owner;
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
        JSON.stringify({
          writing: { history: [{ revision: source.id, contentHash: pinnedHash }] },
        }),
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
});

describe('Image references across copies and editing', () => {
  const owners: { store: Store; path: string }[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const { store, path } of owners.splice(0)) {
      store.close();
      rmSync(path, { recursive: true, force: true });
    }
  });

  function database() {
    const path = mkdtempSync(join(tmpdir(), 'uimori-retention-'));
    const owner = { store: new Store(join(path, 'app.sqlite')), path };
    owners.push(owner);
    return owner.store;
  }

  test('diagnostic events do not invalidate deletion; unreferenced images and hidden resources are reclaimed', async () => {
    const store = database(),
      bot = store.product.content(fixtureBotInput()) as Content;
    const chat = store.createChat('Disposable', { botId: bot.id });
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

  test('deleting one resource never collects an unrelated image still being attached in another editor', async () => {
    const store = database(),
      bot = store.product.content(fixtureBotInput()) as Content;
    const chat = store.createChat('Remove this chat', { botId: bot.id });
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
});
