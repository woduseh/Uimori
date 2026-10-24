import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { Store } from '../server/store.js';
import {
  deleteFont,
  fontCatalog,
  registerFont,
  selectFonts,
  downloadFont,
} from '../server/fonts.js';
const stores: Store[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const database = () => {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-fonts-'));
  directories.push(directory);
  const store = new Store(join(directory, 'app.sqlite'));
  stores.push(store);
  return store;
};
function fixture() {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32BE(0x10000);
  bytes.writeUInt16BE(1, 4);
  bytes.write('head', 12);
  bytes.writeUInt32BE(28, 20);
  bytes.writeUInt32BE(4, 24);
  return bytes;
}
test('font bytes deduplicate without replacing the original title and selections fall back after deletion', () => {
  const store = database();
  const bytes = fixture();
  const font = registerFont(store, {
    title: 'First',
    bytes,
  });
  expect(registerFont(store, { title: 'Duplicate', bytes })).toEqual(font);
  expect(fontCatalog(store).fonts).toHaveLength(1);
  const preferences = selectFonts(store, {
    expectedRevision: 0,
    appFontId: font.id,
    readerFontId: null,
  });
  expect(preferences).toEqual({ revision: 1, appFontId: font.id, readerFontId: null });
  expect(() =>
    selectFonts(store, { expectedRevision: 0, appFontId: null, readerFontId: font.id })
  ).toThrow('다른 창');
  expect(deleteFont(store, font.id)).toEqual({
    fonts: [],
    preferences: { revision: 2, appFontId: null, readerFontId: null },
  });
});

test('opening existing fonts removes retired metadata while preserving files, identity and selections', () => {
  const store = database();
  const bytes = fixture();
  const font = registerFont(store, { title: 'Existing font', bytes });
  const preferences = selectFonts(store, {
    expectedRevision: 0,
    appFontId: font.id,
    readerFontId: font.id,
  });
  store.db
    .prepare('UPDATE font_assets SET metadata=? WHERE id=?')
    .run(
      JSON.stringify({ ...font, sourceUrl: 'https://example.com/font.ttf', license: 'Old note' }),
      font.id
    );
  store.close();
  stores.splice(stores.indexOf(store), 1);
  const reopened = new Store(store.path);
  stores.push(reopened);
  expect(fontCatalog(reopened)).toEqual({ fonts: [font], preferences });
  const row = reopened.db
    .prepare('SELECT metadata,bytes FROM font_assets WHERE id=?')
    .get(font.id)!;
  expect(JSON.parse(String(row.metadata))).toEqual(font);
  expect(Buffer.from(row.bytes as Uint8Array)).toEqual(bytes);
  expect(registerFont(reopened, { title: 'Duplicate', bytes })).toEqual(font);
  expect(fontCatalog(reopened)).toEqual({ fonts: [font], preferences });
});
test('rejects unsupported signatures and table ranges before storing any font', () => {
  const store = database();
  expect(() =>
    registerFont(store, { title: 'Text', bytes: Buffer.from('this is not a font') })
  ).toThrow();
  const bytes = fixture();
  bytes.writeUInt32BE(100, 20);
  expect(() => registerFont(store, { title: 'Truncated', bytes })).toThrow('파일 범위');
  expect(fontCatalog(store).fonts).toEqual([]);
});
test('URL downloads refuse local targets and unapproved schemes', async () => {
  await expect(
    downloadFont('https://127.0.0.1/font.ttf', AbortSignal.timeout(1000))
  ).rejects.toThrow('사설');
  await expect(
    downloadFont('http://example.com/font.ttf', AbortSignal.timeout(1000))
  ).rejects.toThrow('HTTPS');
});

test('HTTP upload round-trips exact bytes, survives reopening, and protects font files with sessions', async () => {
  const { createApp } = await import('../server/app.js');
  const directory = mkdtempSync(join(tmpdir(), 'uimori-font-api-'));
  directories.push(directory);
  const dbPath = join(directory, 'app.sqlite');
  const app = await createApp({ dbPath, buildId: 'font-test', testMode: true });
  const bytes = fixture();
  let id = '';
  try {
    for (const retired of ['sourceUrl', 'license']) {
      const rejected = await app.inject({
        method: 'POST',
        url: '/api/fonts',
        payload: {
          title: 'Retired metadata',
          data: bytes.toString('base64'),
          [retired]: 'Old note',
        },
      });
      expect(rejected.statusCode).toBe(400);
    }
    const uploaded = await app.inject({
      method: 'POST',
      url: '/api/fonts',
      payload: { title: 'API font', data: bytes.toString('base64') },
    });
    expect(uploaded.statusCode).toBe(200);
    id = uploaded.json().id;
    const file = await app.inject(`/api/fonts/${id}/file`);
    expect(file.rawPayload).toEqual(bytes);
    expect(file.headers['content-type']).toBe('font/ttf');
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/font-preferences',
      payload: { expectedRevision: 0, appFontId: null, readerFontId: id },
    });
    expect(saved.json()).toMatchObject({ readerFontId: id, revision: 1 });
  } finally {
    await app.close();
  }
  const reopened = await createApp({
    dbPath,
    buildId: 'font-test',
    testMode: true,
    accessToken: 'synthetic-font-token',
  });
  try {
    expect(fontCatalog(reopened.store)).toMatchObject({
      fonts: [{ id }],
      preferences: { readerFontId: id },
    });
    expect((await reopened.inject(`/api/fonts/${id}/file`)).statusCode).toBe(401);
    expect((await reopened.inject('/api/fonts')).statusCode).toBe(401);
  } finally {
    await reopened.close();
  }
});
