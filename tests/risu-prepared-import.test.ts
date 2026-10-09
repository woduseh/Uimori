import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import sharp from 'sharp';
import { Store } from '../server/store.js';
import {
  prepareStoredRisuImport,
  readPreparedRisuImport,
  deletePreparedRisuImport,
} from '../server/risu-import-prepared.js';
import { applyRisuImport } from '../server/risu-import.js';
import { readImage } from '../server/image-storage.js';
import { writeRisuZip } from '../server/risu-export-codec.js';
import { prepareNativeArchive } from '../server/native-transfer-archive.js';

const fixtures: { store: Store; directory: string }[] = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-prepared-test-'));
  const store = new Store(join(directory, 'fixture.sqlite'));
  fixtures.push({ store, directory });
  return store;
}
afterEach(() => {
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
async function source(invalid = false) {
  const image = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#ff99aa' } })
    .png()
    .toBuffer();
  const card = {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: 'Prepared card',
      description: 'Description',
      first_mes: 'Opening',
      assets: ['main', 'second'].map((name) => ({
        name,
        type: 'icon',
        uri: 'embeded://image.png',
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
      ])
    ).toString('base64'),
  };
}

test('prepared review reuses final transformed bytes and response-loss receipt after cleanup', async () => {
  const store = fixture();
  const input = await source();
  const preview = await prepareStoredRisuImport(store.path, { source: input });
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
  const input = await source();
  const bot = await prepareStoredRisuImport(store.path, { source: input });
  const persona = await prepareStoredRisuImport(store.path, {
    source: input,
    preparedId: bot.preparedId,
    kind: 'persona',
  });
  expect(persona.kind).toBe('persona');
  const automatic = await prepareStoredRisuImport(store.path, {
    source: input,
    preparedId: persona.preparedId,
  });
  expect(automatic.kind).toBe('bot');
  const a = readPreparedRisuImport(store.path, bot.preparedId!);
  const b = readPreparedRisuImport(store.path, persona.preparedId!);
  expect(a.images.map((image) => image.hash)).toEqual(b.images.map((image) => image.hash));
  writeFileSync(b.images[0].path, 'corrupted');
  await expect(
    applyRisuImport(store, {
      source: input,
      preparedId: persona.preparedId,
      kind: 'persona',
      digest: persona.digest,
      allowPartial: false,
      idempotencyKey: 'corrupt-apply',
    })
  ).rejects.toThrow('RISU_IMPORT_DRAFT_CHANGED');
  expect(store.db.prepare('SELECT count(*) AS n FROM image_blobs').get()?.n).toBe(0);
  deletePreparedRisuImport(store.path, bot.preparedId!);
});

test('abort terminates an active worker before cleanup and concurrent preparation is bounded', async () => {
  const store = fixture();
  const other = fixture();
  const input = await source();
  const controller = new AbortController();
  const running = prepareStoredRisuImport(store.path, { source: input }, controller.signal);
  await expect(prepareStoredRisuImport(store.path, { source: input })).rejects.toThrow(
    'RISU_IMPORT_BUSY'
  );
  // The process memory budget also covers native archives from a different database.
  await expect(prepareNativeArchive(other, 'a'.repeat(32), 'resources')).rejects.toThrow(
    'RISU_IMPORT_BUSY'
  );
  setTimeout(() => controller.abort(), 20);
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
