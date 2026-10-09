import { afterEach, expect, test, vi } from 'vitest';
import Fastify from 'fastify';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { Store } from '../server/store.js';
import {
  prepareStoredRisuImport,
  readPreparedRisuImport,
  deletePreparedRisuImport,
  prunePreparedRisuImports,
} from '../server/risu-import-prepared.js';
import { applyRisuImport, discardRisuImport, risuImportRoutes } from '../server/risu-import.js';
import { readImage } from '../server/image-storage.js';
import { writeRisuZip } from '../server/risu-export-codec.js';
import { prepareNativeArchive } from '../server/native-transfer-archive.js';
import { storeUpload, uploadDirectory } from '../server/uploads.js';

const filesystemFailure = vi.hoisted(() => ({ cleanup: '', publish: '' }));
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return {
    ...actual,
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      if (args[0] === filesystemFailure.cleanup) throw new Error('Synthetic locked directory');
      return actual.rmSync(...args);
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (args[1] === filesystemFailure.publish) throw new Error('Synthetic publish failure');
      return actual.renameSync(...args);
    },
  };
});

const fixtures: { store: Store; directory: string }[] = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-prepared-test-'));
  const store = new Store(join(directory, 'fixture.sqlite'));
  fixtures.push({ store, directory });
  return store;
}
afterEach(() => {
  filesystemFailure.cleanup = '';
  filesystemFailure.publish = '';
  for (const { store, directory } of fixtures.splice(0)) {
    store.close();
    const path = resolve(directory),
      within = relative(resolve(tmpdir()), path);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(path).startsWith('uimori-prepared-test-')
    )
      throw new Error('Unsafe fixture cleanup');
    rmSync(path, { recursive: true, force: true });
  }
});
async function source(invalid = false, distinctImages = false) {
  const image = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#ff99aa' } })
    .png()
    .toBuffer();
  const second = distinctImages
    ? await sharp({ create: { width: 2, height: 2, channels: 4, background: '#99aaff' } })
        .png()
        .toBuffer()
    : image;
  const card = {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: 'Prepared card',
      description: 'Description',
      first_mes: 'Opening',
      assets: ['main', 'second'].map((name, index) => ({
        name,
        type: 'icon',
        uri: `embeded://${distinctImages && index === 1 ? 'second.png' : 'image.png'}`,
        ext: 'png',
      })),
    },
  };
  return {
    name: 'prepared.charx',
    base64: writeRisuZip(
      new Map([
        ['card.json', Buffer.from(JSON.stringify(card))],
        ['image.png', invalid ? Buffer.from('not an image') : image],
        ...(distinctImages ? [['second.png', second] as const] : []),
      ])
    ).toString('base64'),
  };
}

test('prepared review reuses final transformed bytes and response-loss receipt after cleanup', async () => {
  const store = fixture();
  const input = await source();
  const preview = await prepareStoredRisuImport(store.path, { source: input });
  const originalFileNotice = preview.findings.find(
    (finding) => finding.code === 'source-file-not-retained'
  );
  expect(originalFileNotice?.level).toBe('info');
  expect(originalFileNotice?.message).not.toMatch(/24\s*MiB|넘어/u);
  const prepared = readPreparedRisuImport(store.path, preview.preparedId!);
  expect(preview.summary.images).toBe(2);
  expect(prepared.images).toHaveLength(1);
  expect(prepared.file.images[0]).not.toHaveProperty('base64');
  const bytes = readFileSync(prepared.images[0].path);
  const command = {
    source: input,
    preparedId: preview.preparedId,
    digest: preview.digest,
    allowPartial: false,
    createChat: false,
    idempotencyKey: 'prepared-apply',
  };
  const first = await applyRisuImport(store, command);
  expect(first.receipt.created).toBe(true);
  expect(readImage(store.db, prepared.images[0].hash).bytes).toEqual(bytes);
  expect(() => readPreparedRisuImport(store.path, preview.preparedId!)).toThrow(
    'RISU_IMPORT_DRAFT_CHANGED'
  );
  const retry = await applyRisuImport(store, command);
  expect(retry.receipt.created).toBe(false);
  expect(retry.receipt.id).toBe(first.receipt.id);
});

test('committed import and retry succeed when staging cleanup is locked, then expiry retries cleanup', async () => {
  const store = fixture(),
    input = await source();
  const preview = await prepareStoredRisuImport(store.path, { source: input });
  const path = join(resolve(store.path, '..'), 'risu-prepared', preview.preparedId!);
  filesystemFailure.cleanup = path;
  const command = {
    source: input,
    preparedId: preview.preparedId,
    digest: preview.digest,
    allowPartial: false,
    createChat: false,
    idempotencyKey: 'locked-cleanup',
  };
  const saved = await applyRisuImport(store, command);
  expect(saved.receipt.created).toBe(true);
  expect(store.product.get('content', saved.receipt.items[0].id)).toMatchObject({
    id: saved.receipt.items[0].id,
  });
  expect(existsSync(path)).toBe(true);
  expect((await applyRisuImport(store, command)).receipt.id).toBe(saved.receipt.id);
  filesystemFailure.cleanup = '';
  const expired = new Date(Date.now() - 25 * 60 * 60 * 1000);
  utimesSync(path, expired, expired);
  prunePreparedRisuImports(store.path);
  expect(existsSync(path)).toBe(false);
});

test('discarding a reviewed upload removes staging, is repeatable and preserves registered material', async () => {
  const store = fixture(),
    input = await source();
  const savedPreview = await prepareStoredRisuImport(store.path, { source: input });
  await applyRisuImport(store, {
    source: input,
    preparedId: savedPreview.preparedId,
    digest: savedPreview.digest,
    allowPartial: false,
    createChat: false,
    idempotencyKey: 'saved-before-discard',
  });
  const before = ['versions', 'image_blobs', 'import_operations'].map((table) =>
    store.db.prepare(`SELECT * FROM ${table}`).all()
  );
  const uploaded = await storeUpload(
    store.path,
    Readable.from(Buffer.from(input.base64, 'base64'))
  );
  const preview = await prepareStoredRisuImport(store.path, {
    source: { name: input.name, uploadId: uploaded.uploadId },
  });
  const preparedPath = join(resolve(store.path, '..'), 'risu-prepared', preview.preparedId!),
    uploadedPath = join(uploadDirectory(store.path), `${uploaded.uploadId}.bin`);
  const app = Fastify();
  risuImportRoutes(app, store);
  try {
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/risu-imports/discard',
      payload: { preparedId: preview.preparedId, uploadId: '../invalid' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(existsSync(preparedPath)).toBe(true);
    expect(existsSync(uploadedPath)).toBe(true);
    for (let attempt = 0; attempt < 2; attempt++) {
      const discarded = await app.inject({
        method: 'POST',
        url: '/api/risu-imports/discard',
        payload: { preparedId: preview.preparedId, uploadId: uploaded.uploadId },
      });
      expect(discarded.statusCode).toBe(200);
      expect(discarded.json()).toEqual({ discarded: true });
    }
    expect(existsSync(preparedPath)).toBe(false);
    expect(existsSync(uploadedPath)).toBe(false);
    expect(
      ['versions', 'image_blobs', 'import_operations'].map((table) =>
        store.db.prepare(`SELECT * FROM ${table}`).all()
      )
    ).toEqual(before);
  } finally {
    await app.close();
  }
});

test('invalid images are reported before consent and the prepared digest prevents stale apply', async () => {
  const store = fixture();
  const input = await source(true);
  const preview = await prepareStoredRisuImport(store.path, { source: input });
  expect(preview.summary.images).toBe(0);
  expect(preview.findings.some((finding) => finding.level === 'unsupported')).toBe(true);
  const command = {
    source: input,
    preparedId: preview.preparedId,
    digest: preview.digest,
    allowPartial: false,
    idempotencyKey: 'invalid-apply',
  };
  await expect(applyRisuImport(store, command)).rejects.toThrow('RISU_IMPORT_PARTIAL_REQUIRED');
  await expect(applyRisuImport(store, { ...command, digest: 'a'.repeat(64) })).rejects.toThrow(
    'RISU_IMPORT_DRAFT_CHANGED'
  );
  expect((await applyRisuImport(store, { ...command, allowPartial: true })).receipt.created).toBe(
    true
  );
});

test('kind change reprojects prepared bytes and corrupted staged bytes roll back all registration', async () => {
  const store = fixture();
  const input = await source(false, true);
  const bot = await prepareStoredRisuImport(store.path, { source: input });
  const original = readPreparedRisuImport(store.path, bot.preparedId!);
  const persona = await prepareStoredRisuImport(store.path, {
    source: input,
    preparedId: bot.preparedId,
    kind: 'persona',
  });
  expect(persona.kind).toBe('persona');
  expect(persona.preparedId).toBe(bot.preparedId);
  const personaImages = readPreparedRisuImport(store.path, persona.preparedId!).images;
  expect(personaImages.map((image) => image.path)).toEqual(
    original.images.map((image) => image.path)
  );
  await expect(
    applyRisuImport(store, {
      source: input,
      preparedId: bot.preparedId,
      digest: bot.digest,
      allowPartial: false,
      idempotencyKey: 'stale-kind',
    })
  ).rejects.toThrow('RISU_IMPORT_DRAFT_CHANGED');
  const cancel = new AbortController();
  const changing = prepareStoredRisuImport(
    store.path,
    {
      preparedId: persona.preparedId,
      kind: 'module',
    },
    cancel.signal
  );
  cancel.abort();
  await expect(changing).rejects.toThrow('RISU_IMPORT_CANCELLED');
  expect(readPreparedRisuImport(store.path, persona.preparedId!).preview.digest).toBe(
    persona.digest
  );
  filesystemFailure.publish = join(
    resolve(store.path, '..'),
    'risu-prepared',
    persona.preparedId!,
    'manifest.json'
  );
  await expect(
    prepareStoredRisuImport(store.path, {
      preparedId: persona.preparedId,
      kind: 'module',
    })
  ).rejects.toThrow('Synthetic publish failure');
  filesystemFailure.publish = '';
  expect(readPreparedRisuImport(store.path, persona.preparedId!).preview.digest).toBe(
    persona.digest
  );
  const automatic = await prepareStoredRisuImport(store.path, {
    source: input,
    preparedId: persona.preparedId,
  });
  expect(automatic.kind).toBe('bot');
  const prepared = readPreparedRisuImport(store.path, automatic.preparedId!);
  expect(prepared.images).toHaveLength(2);
  expect(readdirSync(join(resolve(store.path, '..'), 'risu-prepared'))).toEqual([bot.preparedId]);
  const snapshot = () =>
    ['versions', 'image_blobs', 'import_operations'].map((table) =>
      store.db.prepare(`SELECT * FROM ${table}`).all()
    );
  const before = snapshot();
  writeFileSync(prepared.images[1].path, 'corrupted');
  await expect(
    applyRisuImport(store, {
      source: input,
      preparedId: automatic.preparedId,
      digest: automatic.digest,
      allowPartial: false,
      idempotencyKey: 'corrupt-apply',
    })
  ).rejects.toThrow('RISU_IMPORT_DRAFT_CHANGED');
  expect(snapshot()).toEqual(before);
  deletePreparedRisuImport(store.path, bot.preparedId!);
});

test('abort terminates an active worker before cleanup and concurrent preparation is bounded', async () => {
  const store = fixture();
  const other = fixture();
  const input = await source();
  const uploaded = await storeUpload(
    store.path,
    Readable.from(Buffer.from(input.base64, 'base64'))
  );
  const controller = new AbortController();
  const running = prepareStoredRisuImport(
    store.path,
    { source: { name: input.name, uploadId: uploaded.uploadId } },
    controller.signal
  );
  const preparedId = readdirSync(join(resolve(store.path, '..'), 'risu-prepared'))[0];
  expect(() => discardRisuImport(store.path, { preparedId, uploadId: uploaded.uploadId })).toThrow(
    'RISU_IMPORT_BUSY'
  );
  expect(existsSync(join(uploadDirectory(store.path), `${uploaded.uploadId}.bin`))).toBe(true);
  await expect(prepareStoredRisuImport(store.path, { source: input })).rejects.toThrow(
    'RISU_IMPORT_BUSY'
  );
  // The process memory budget also covers native archives from a different database.
  await expect(prepareNativeArchive(other, 'a'.repeat(32), 'resources')).rejects.toThrow(
    'RISU_IMPORT_BUSY'
  );
  controller.abort();
  await expect(running).rejects.toThrow('RISU_IMPORT_CANCELLED');
  expect(readdirSync(join(resolve(store.path, '..'), 'risu-prepared'))).toEqual([]);
  expect((await prepareStoredRisuImport(store.path, { source: input })).summary.images).toBe(2);
});

test('automatic kind preserves a native module during cached review', async () => {
  const store = fixture();
  const input = {
    name: 'module.json',
    base64: Buffer.from(
      JSON.stringify({
        type: 'risuModule',
        module: { name: 'Prepared module', lorebook: [], regex: [], trigger: [], assets: [] },
      })
    ).toString('base64'),
  };
  const module = await prepareStoredRisuImport(store.path, { source: input });
  expect(module.kind).toBe('module');
  const automatic = await prepareStoredRisuImport(store.path, {
    source: input,
    preparedId: module.preparedId,
  });
  expect(automatic.preparedId).toBe(module.preparedId);
  expect(automatic.kind).toBe('module');
});

test('malformed input rejected by the worker removes its owned staging directory', async () => {
  const store = fixture();
  const input = { name: 'invalid.json', base64: Buffer.from('{"spec":').toString('base64') };
  await expect(prepareStoredRisuImport(store.path, { source: input })).rejects.toThrow(
    'RISU_IMPORT_INVALID_FILE'
  );
  expect(readdirSync(join(resolve(store.path, '..'), 'risu-prepared'))).toEqual([]);
});
