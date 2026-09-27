import { afterEach, expect, test } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import sharp from 'sharp';
import { createApp, type App } from '../server/app.js';

const apps: App[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

test('manifest has stable root identity and valid standalone/maskable icons without embedding a private target or key', async () => {
  const manifest = JSON.parse(readFileSync('web/public/manifest.webmanifest', 'utf8'));
  expect(manifest).toMatchObject({
    id: '/',
    start_url: '/',
    scope: '/',
    name: 'Uimori',
    display: 'standalone',
  });
  expect(manifest.icons).toHaveLength(3);
  for (const icon of manifest.icons) {
    const metadata = await sharp(join('web/public', icon.src)).metadata();
    expect(icon.sizes).toBe(`${metadata.width}x${metadata.height}`);
    expect(metadata.format).toBe('png');
  }
  expect(
    manifest.icons
      .filter((icon: { purpose: string }) => icon.purpose === 'any')
      .map((icon: { sizes: string }) => icon.sizes)
  ).toEqual(['192x192', '512x512']);
  expect(readFileSync('web/index.html', 'utf8')).toContain('rel="manifest"');
});

test('service worker activation is cache-free and never intercepts or replays authoring/network requests', async () => {
  const callbacks = new Map<
    string,
    (event: { waitUntil: (value: Promise<unknown>) => void }) => void
  >();
  let claims = 0,
    network = 0,
    caches = 0;
  runInNewContext(readFileSync('web/public/sw.js', 'utf8'), {
    self: {
      addEventListener: (
        type: string,
        callback: (event: { waitUntil: (value: Promise<unknown>) => void }) => void
      ) => callbacks.set(type, callback),
      clients: {
        claim: async () => {
          claims++;
        },
      },
    },
    fetch: () => {
      network++;
      throw new Error('No implicit network');
    },
    caches: {
      open: () => {
        caches++;
        throw new Error('No offline manuscript cache');
      },
    },
  });
  const work: Promise<unknown>[] = [];
  callbacks.get('activate')!({ waitUntil: (value) => work.push(value) });
  await Promise.all(work);
  expect(claims).toBe(1);
  expect(network).toBe(0);
  expect(caches).toBe(0);
  for (const type of ['fetch', 'sync', 'periodicsync']) expect(callbacks.has(type)).toBe(false);
});

test('install resources can load before login, revalidate after updates, and do not relax API access', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-pwa-'));
  directories.push(directory);
  const app = await createApp({
    dbPath: join(directory, 'app.sqlite'),
    buildId: 'synthetic-pwa',
    testMode: true,
    webRoot: resolve('web/public'),
    accessToken: 'private-pwa-test-token',
  });
  apps.push(app);
  const sw = await app.inject({ method: 'GET', url: '/sw.js' });
  expect(sw.statusCode).toBe(200);
  expect(sw.headers['cache-control']).toBe('no-cache');
  expect(sw.headers['service-worker-allowed']).toBe('/');
  expect(sw.headers['content-type']).toContain('javascript');
  const manifest = await app.inject({ method: 'GET', url: '/manifest.webmanifest' });
  expect(manifest.statusCode).toBe(200);
  expect(manifest.headers['cache-control']).toBe('no-cache');
  expect(manifest.json().start_url).toBe('/');
  expect((await app.inject({ method: 'GET', url: '/icons/app-192.png' })).statusCode).toBe(200);
  for (const url of ['/api/chats', '/api/usage?from=2026-09-27&to=2026-09-27', '/api/backups'])
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
});
