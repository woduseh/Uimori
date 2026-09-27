import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../server/store.js';
import { BackupService, nextBackupAt } from '../server/backup-service.js';
import { createApp, type App } from '../server/app.js';
import { chatWithSource } from './fixtures/illustration.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, statfs: vi.fn(actual.statfs) };
});

const directories: string[] = [];
const stores: Store[] = [];
const services: BackupService[] = [];
const apps: App[] = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-backup-'));
  directories.push(directory);
  const store = new Store(join(directory, 'live', 'app.sqlite'));
  stores.push(store);
  const service = new BackupService(store, 'synthetic-build', join(directory, 'backups'));
  services.push(service);
  return { store, service, directory };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const service of services.splice(0)) await service.close();
  for (const app of apps.splice(0)) await app.close();
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

test('consistent snapshot restores saved prose, blobs and settings without starting any workers', async () => {
  const { store, service, directory } = fixture();
  const { chat, source } = chatWithSource(store);
  const bytes = Buffer.from('synthetic-image-bytes');
  const hash = createHash('sha256').update(bytes).digest('hex');
  store.db
    .prepare('INSERT INTO image_blobs(hash,mime,bytes) VALUES(?,?,?)')
    .run(hash, 'image/png', bytes);
  store.db
    .prepare('INSERT INTO app_metadata VALUES(?,?)')
    .run('synthetic-private-setting', 'retained');
  expect(service.settings()).toMatchObject({ enabled: false, retain: 7, hour: 3 });
  service.start();
  expect(() => service.start()).toThrow('이미 백업');
  await service.settle();
  const status = await service.status();
  expect(status.error).toBeNull();
  expect(status.status).toBe('idle');
  expect(status.backups).toHaveLength(1);
  const manifest = status.backups[0];
  const path = join(service.directory, manifest.id, 'uimori.sqlite');
  expect(createHash('sha256').update(readFileSync(path)).digest('hex')).toBe(manifest.sha256);
  const restore = join(directory, 'restored.sqlite');
  writeFileSync(restore, readFileSync(path));
  const restored = new Store(restore);
  stores.push(restored);
  expect(restored.chat(chat.id).title).toBe(chat.title);
  expect(restored.source(source.id).text).toBe(store.source(source.id).text);
  expect(
    Buffer.from(
      restored.db.prepare('SELECT bytes FROM image_blobs WHERE hash=?').get(hash)!
        .bytes as Uint8Array
    )
  ).toEqual(bytes);
  expect(
    restored.db
      .prepare('SELECT value FROM app_metadata WHERE key=?')
      .get('synthetic-private-setting')!.value
  ).toBe('retained');
  expect(restored.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  const freshService = new BackupService(restored, 'restored-build', service.directory);
  services.push(freshService);
  expect((await freshService.status()).backups).toHaveLength(1);
  expect((await freshService.status()).status).not.toBe('running');
});

test('retention follows success, leaves unrelated data, and never prunes to make room for a failed backup', async () => {
  const { store, service } = fixture();
  chatWithSource(store);
  service.update({ expectedRevision: 0, enabled: false, hour: 3, minute: 0, retain: 1 });
  mkdirSync(join(service.directory, 'deployment-backup'), { recursive: true });
  writeFileSync(join(service.directory, 'deployment-backup', 'important'), 'keep');
  service.start();
  await service.settle();
  const first = (await service.list())[0];
  vi.mocked(fs.statfs).mockRejectedValueOnce(
    Object.assign(new Error('synthetic no space'), { code: 'ENOSPC' })
  );
  service.start();
  await service.settle();
  expect((await service.status()).status).toBe('failed');
  expect((await service.status()).lastSuccess!.id).toBe(first.id);
  expect((await service.list()).map((item) => item.id)).toEqual([first.id]);
  expect((await service.status()).error).toContain('공간');
  service.start();
  await service.settle();
  expect(await service.list()).toHaveLength(1);
  expect((await service.list())[0].id).not.toBe(first.id);
  expect(readFileSync(join(service.directory, 'deployment-backup', 'important'), 'utf8')).toBe(
    'keep'
  );
  await expect(service.download('../app.sqlite')).rejects.toThrow();
});

test('daily Korea time, stale settings and downtime catch-up do not create a burst or overlap', async () => {
  const { service } = fixture();
  expect(nextBackupAt(new Date('2026-09-27T17:59:59Z'), 3, 0)).toBe('2026-09-27T18:00:00.000Z');
  expect(nextBackupAt(new Date('2026-09-27T18:00:00Z'), 3, 0)).toBe('2026-09-28T18:00:00.000Z');
  const saved = service.update({
    expectedRevision: 0,
    enabled: true,
    hour: 3,
    minute: 0,
    retain: 7,
  });
  expect(() =>
    service.update({ expectedRevision: 0, enabled: false, hour: 3, minute: 0, retain: 7 })
  ).toThrow('다른 창');
  const future = new Date(Date.parse(saved.nextRunAt!) + 4 * 86400_000);
  service.tick(future);
  service.tick(future);
  await service.settle();
  service.tick(future);
  await service.settle();
  expect(await service.list()).toHaveLength(1);
  expect(Date.parse(service.settings().nextRunAt!)).toBeGreaterThan(future.getTime());
});

test('HTTP creation and download require the existing session; maintenance blocks new snapshots', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-backup-api-'));
  directories.push(directory);
  const app = await createApp({
    dbPath: join(directory, 'app.sqlite'),
    backupDirectory: join(directory, 'backups'),
    buildId: 'fixture',
    testMode: true,
    accessToken: 'synthetic-access-token',
  });
  apps.push(app);
  expect((await app.inject({ method: 'GET', url: '/api/backups' })).statusCode).toBe(401);
  const publicApp = await createApp({
    dbPath: join(directory, 'other.sqlite'),
    buildId: 'fixture',
    testMode: true,
    maintenance: true,
  });
  apps.push(publicApp);
  expect(
    (await publicApp.inject({ method: 'POST', url: '/api/backups', payload: {} })).statusCode
  ).toBe(503);
});
