import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createApp, type App } from '../server/app.js';
import { Store } from '../server/store.js';
import { emptyTheme, parseThemeFile, validateTheme, type ThemeAsset } from '../core/themes.js';

const owned: { directory: string; app?: App; store?: Store }[] = [];
afterEach(async () => {
  for (const item of owned.splice(0)) {
    if (item.app) await item.app.close();
    else item.store?.close();
    rmSync(item.directory, { recursive: true, force: true });
  }
});

async function server() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-theme-assets-'));
  const app = await createApp({
    dbPath: join(directory, 'app.sqlite'),
    buildId: 'theme-assets-test',
    testMode: true,
  });
  owned.push({ directory, app });
  return { app, directory };
}

function minimalTtf() {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32BE(0x00010000, 0);
  bytes.writeUInt16BE(1, 4);
  bytes.write('head', 12, 'ascii');
  bytes.writeUInt32BE(28, 20);
  bytes.writeUInt32BE(4, 24);
  return bytes;
}

async function upload(app: App, kind: 'font' | 'image', bytes: Buffer) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/theme-assets',
    payload: { kind, data: bytes.toString('base64') },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as { hash: string; mime: string };
}

async function saveTheme(app: App, assets: ThemeAsset[], id?: string, expectedRevision?: number) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/resources/save',
    payload: {
      kind: 'theme',
      ...(id && { id, expectedRevision }),
      model: {
        ...emptyTheme('Asset theme'),
        appCss: 'body { font-family: var(--theme-font-title); }',
        assets,
      },
    },
  });
  return response;
}

const stored = (app: App, hash: string) =>
  !!app.store.db.prepare('SELECT 1 FROM theme_assets WHERE hash=?').get(hash);

test('asset manifests accept only named fonts and images with unique names per kind', () => {
  const hash = 'a'.repeat(64);
  const theme = (assets: unknown) => ({ ...emptyTheme(), assets });
  expect(validateTheme(theme([{ name: 'paper', kind: 'image', hash }])).assets).toEqual([
    { name: 'paper', kind: 'image', hash },
  ]);
  expect(validateTheme(theme([])).assets).toBeUndefined();
  expect(
    validateTheme(
      theme([
        { name: 'title', kind: 'image', hash },
        { name: 'title', kind: 'font', hash },
      ])
    ).assets
  ).toHaveLength(2);
  for (const invalid of [
    [{ name: 'Paper', kind: 'image', hash }],
    [{ name: 'paper', kind: 'video', hash }],
    [{ name: 'paper', kind: 'image', hash: 'x' }],
    [
      { name: 'paper', kind: 'image', hash },
      { name: 'paper', kind: 'image', hash },
    ],
  ])
    expect(() => validateTheme(theme(invalid))).toThrow();
});

test('uploaded assets are served, saved, exported with their bytes and re-imported', async () => {
  const { app } = await server();
  const png = await sharp({
    create: { width: 4, height: 4, channels: 3, background: '#c08040' },
  })
    .png()
    .toBuffer();
  const image = await upload(app, 'image', png);
  expect(image.mime).toBe('image/webp');
  const font = await upload(app, 'font', minimalTtf());
  expect(font.mime).toBe('font/ttf');
  const served = await app.inject(`/api/theme-assets/${image.hash}`);
  expect(served.headers['content-type']).toBe('image/webp');
  expect(served.headers['x-content-type-options']).toBe('nosniff');

  const missing = await saveTheme(app, [{ name: 'paper', kind: 'image', hash: 'b'.repeat(64) }]);
  expect(missing.statusCode).toBe(400);
  const wrongKind = await saveTheme(app, [{ name: 'paper', kind: 'font', hash: image.hash }]);
  expect(wrongKind.statusCode).toBe(400);

  const assets: ThemeAsset[] = [
    { name: 'paper', kind: 'image', hash: image.hash },
    { name: 'title', kind: 'font', hash: font.hash },
  ];
  const saved = await saveTheme(app, assets);
  expect(saved.statusCode, saved.body).toBe(200);
  const exported = (await app.inject(`/api/themes/${saved.json().saved.id}/export`)).json();
  expect(exported).toMatchObject({ version: 2, theme: { assets } });
  const parsed = parseThemeFile(exported);
  expect(parsed.theme.assets).toEqual(assets);
  expect(Buffer.from(parsed.files.find((file) => file.kind === 'font')!.data, 'base64')).toEqual(
    minimalTtf()
  );
  expect(() => parseThemeFile({ ...exported, files: [] })).toThrow();
});

test('theme saves, undo replacement and deletion release only bytes no theme still owns', async () => {
  const { app } = await server();
  const shared = await upload(app, 'font', minimalTtf());
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#000' } })
    .png()
    .toBuffer();
  const first = await upload(app, 'image', png);
  const asset = (name: string, kind: 'font' | 'image', hash: string) => ({ name, kind, hash });

  const v1 = (
    await saveTheme(app, [asset('title', 'font', shared.hash), asset('paper', 'image', first.hash)])
  ).json().saved;
  const v2 = (await saveTheme(app, [asset('title', 'font', shared.hash)], v1.id, 1)).json().saved;
  expect(stored(app, first.hash)).toBe(true);
  await saveTheme(app, [asset('title', 'font', shared.hash)], v2.id, 2);
  expect(stored(app, first.hash)).toBe(false);
  expect(stored(app, shared.hash)).toBe(true);

  const other = (await saveTheme(app, [asset('title', 'font', shared.hash)])).json().saved;
  const deleted = await app.inject({
    method: 'DELETE',
    url: `/api/themes/${v1.id}`,
    payload: { expectedRevision: 3 },
  });
  expect(deleted.statusCode, deleted.body).toBe(200);
  expect(stored(app, shared.hash)).toBe(true);
  await app.inject({
    method: 'DELETE',
    url: `/api/themes/${other.id}`,
    payload: { expectedRevision: 1 },
  });
  expect(stored(app, shared.hash)).toBe(false);
});

test('an upload never saved into a theme is swept on a later start, not before', async () => {
  const { app, directory } = await server();
  const font = await upload(app, 'font', minimalTtf());
  const path = join(directory, 'app.sqlite');
  await app.close();
  owned.splice(
    owned.findIndex((item) => item.app === app),
    1
  );

  const fresh = new Store(path);
  expect(!!fresh.db.prepare('SELECT 1 FROM theme_assets WHERE hash=?').get(font.hash)).toBe(true);
  fresh.db.prepare("UPDATE theme_assets SET created_at='2000-01-01T00:00:00.000Z'").run();
  fresh.close();

  const later = new Store(path);
  owned.push({ directory, store: later });
  expect(!!later.db.prepare('SELECT 1 FROM theme_assets WHERE hash=?').get(font.hash)).toBe(false);
});

test('built-in assets ship as hashed files and saved copies carry their own bytes', async () => {
  const { BUILTIN_THEME_ASSET_FILES } = await import('../core/builtin-theme-assets.js');
  const { BUILTIN_THEMES, themeDefinition } = await import('../core/themes.js');
  const { createHash } = await import('node:crypto');
  const { readFileSync } = await import('node:fs');
  for (const entry of BUILTIN_THEME_ASSET_FILES)
    expect(
      createHash('sha256')
        .update(readFileSync(join('third_party/theme-assets', entry.file)))
        .digest('hex'),
      entry.file
    ).toBe(entry.hash);
  const { app } = await server();
  const letter = BUILTIN_THEMES.find((theme) => theme.id === 'builtin:letter')!;
  expect(letter.assets?.length).toBeGreaterThan(0);
  const exported = (await app.inject('/api/themes/builtin:letter/export')).json();
  expect(parseThemeFile(exported).files).toHaveLength(letter.assets!.length);
  const copy = await app.inject({
    method: 'POST',
    url: '/api/resources/save',
    payload: { kind: 'theme', model: { ...themeDefinition(letter), title: 'Letter copy' } },
  });
  expect(copy.statusCode, copy.body).toBe(200);
  for (const asset of letter.assets!) expect(stored(app, asset.hash)).toBe(true);
});
