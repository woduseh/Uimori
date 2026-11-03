import { afterEach, expect, test, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  utimesSync,
  existsSync,
  rmSync,
  symlinkSync,
  lstatSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.js';
import { startImportStagingCleanup } from '../server/import-staging-cleanup.js';
import { deleteUpload, pruneUploads, uploadDirectory } from '../server/uploads.js';
import { discardPreparedRisuImport } from '../server/risu-import-prepared.js';
import { deletePreparedArchive } from '../server/native-transfer-archive.js';

const owned: { directory: string; store: Store; stop?: () => void }[] = [];
afterEach(() => {
  for (const item of owned.splice(0)) {
    item.stop?.();
    item.store.close();
    const path = resolve(item.directory);
    const within = relative(resolve(tmpdir()), path);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(path).startsWith('uimori-staging-')
    )
      throw new Error('Unsafe staging test cleanup');
    rmSync(path, { recursive: true, force: true });
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('expired previews are cleaned on startup and later sweeps while unrelated paths remain', () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  const directory = mkdtempSync(join(tmpdir(), 'uimori-staging-'));
  const store = new Store(join(directory, 'story.sqlite'));
  const owner = { directory, store, stop: undefined as (() => void) | undefined };
  owned.push(owner);
  const roots = [
    join(uploadDirectory(store.path), 'native-prepared'),
    join(dirname(store.path), 'risu-prepared'),
  ];
  const expiredAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
  const stale = roots.map((root) => {
    const path = join(root, 'a'.repeat(32));
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'content'), 'old');
    utimesSync(path, expiredAt, expiredAt);
    return path;
  });
  const recent = roots.map((root) => {
    const path = join(root, 'b'.repeat(32));
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'content'), 'recent');
    return path;
  });
  const unrelated = roots
    .map((root) => {
      const file = join(root, 'c'.repeat(32));
      writeFileSync(file, 'not a staging directory');
      utimesSync(file, expiredAt, expiredAt);
      mkdirSync(join(root, 'unrelated'), { recursive: true });
      return [file, join(root, 'unrelated')];
    })
    .flat();

  let admitted = true;
  let unavailable = true;
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const canRun = () => {
    if (unavailable) throw new Error('Synthetic admission failure');
    return admitted;
  };
  owner.stop = startImportStagingCleanup(store, canRun);
  expect(stale.every(existsSync)).toBe(true);
  owner.stop();
  unavailable = false;
  owner.stop = startImportStagingCleanup(store, canRun);
  expect(stale.some(existsSync)).toBe(false);
  expect(recent.every(existsSync)).toBe(true);
  expect(unrelated.every(existsSync)).toBe(true);

  for (const path of stale) {
    mkdirSync(path);
    utimesSync(path, expiredAt, expiredAt);
  }
  admitted = false;
  vi.advanceTimersByTime(60 * 60 * 1000);
  expect(stale.every(existsSync)).toBe(true);
  admitted = true;
  vi.advanceTimersByTime(60 * 60 * 1000);
  expect(stale.some(existsSync)).toBe(false);

  vi.advanceTimersByTime(25 * 60 * 60 * 1000);
  expect(recent.some(existsSync)).toBe(false);
  expect(unrelated.every(existsSync)).toBe(true);
});

test.each(['risu root', 'archive root', 'uploads parent'] as const)(
  'cleanup refuses an outside directory reached through a %s junction',
  (kind) => {
    const directory = mkdtempSync(join(tmpdir(), 'uimori-staging-'));
    const store = new Store(join(directory, 'db', 'story.sqlite'));
    const owner = { directory, store, stop: undefined as (() => void) | undefined };
    owned.push(owner);
    const outside = join(directory, 'outside');
    const outsideRoot = kind === 'uploads parent' ? join(outside, 'native-prepared') : outside;
    const aged = join(outsideRoot, 'd'.repeat(32));
    mkdirSync(aged, { recursive: true });
    const marker = join(aged, 'outside-user-data');
    writeFileSync(marker, 'must not be deleted');
    const expired = new Date(Date.now() - 25 * 60 * 60 * 1000);
    utimesSync(aged, expired, expired);

    const dbDirectory = dirname(store.path);
    const link =
      kind === 'risu root'
        ? join(dbDirectory, 'risu-prepared')
        : kind === 'archive root'
          ? join(dbDirectory, 'uploads', 'native-prepared')
          : join(dbDirectory, 'uploads');
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(outside, link, 'junction');
    owner.stop = startImportStagingCleanup(store);
    expect(existsSync(marker)).toBe(true);
    if (kind === 'risu root') discardPreparedRisuImport(store.path, 'd'.repeat(32));
    else deletePreparedArchive(store, 'd'.repeat(32));
    expect(existsSync(marker)).toBe(true);
  }
);

test('upload pruning and discard refuse an outside uploads junction', () => {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-staging-'));
  const store = new Store(join(directory, 'db', 'story.sqlite'));
  owned.push({ directory, store });
  const outside = join(directory, 'outside');
  mkdirSync(outside);
  const id = 'e'.repeat(32);
  const marker = join(outside, `${id}.bin`);
  writeFileSync(marker, 'outside-user-data');
  const expired = new Date(Date.now() - 25 * 60 * 60 * 1000);
  utimesSync(marker, expired, expired);
  symlinkSync(outside, uploadDirectory(store.path), 'junction');

  pruneUploads(store.path);
  expect(existsSync(marker)).toBe(true);
  deleteUpload(store.path, id);
  expect(existsSync(marker)).toBe(true);
});

test.each(['risu', 'archive'] as const)(
  'discard leaves a linked %s prepared item and its target untouched',
  (kind) => {
    const directory = mkdtempSync(join(tmpdir(), 'uimori-staging-'));
    const store = new Store(join(directory, 'db', 'story.sqlite'));
    owned.push({ directory, store });
    const outside = join(directory, 'outside');
    mkdirSync(outside);
    const marker = join(outside, 'outside-user-data');
    writeFileSync(marker, 'must not be deleted');
    const root =
      kind === 'risu'
        ? join(dirname(store.path), 'risu-prepared')
        : join(uploadDirectory(store.path), 'native-prepared');
    mkdirSync(root, { recursive: true });
    const id = 'f'.repeat(32);
    const link = join(root, id);
    symlinkSync(outside, link, 'junction');

    if (kind === 'risu') discardPreparedRisuImport(store.path, id);
    else deletePreparedArchive(store, id);
    expect(existsSync(marker)).toBe(true);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  }
);

test('owned upload files still expire and discard remains idempotent with ID validation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-staging-'));
  const store = new Store(join(directory, 'story.sqlite'));
  owned.push({ directory, store });
  const root = uploadDirectory(store.path);
  mkdirSync(root);
  const oldId = 'a'.repeat(32),
    currentId = 'b'.repeat(32);
  const oldPath = join(root, `${oldId}.bin`),
    currentPath = join(root, `${currentId}.bin`);
  writeFileSync(oldPath, 'old');
  writeFileSync(currentPath, 'current');
  const expired = new Date(Date.now() - 25 * 60 * 60 * 1000);
  utimesSync(oldPath, expired, expired);
  pruneUploads(store.path);
  expect(existsSync(oldPath)).toBe(false);
  expect(existsSync(currentPath)).toBe(true);
  deleteUpload(store.path, currentId);
  expect(existsSync(currentPath)).toBe(false);
  expect(() => deleteUpload(store.path, currentId)).not.toThrow();
  expect(() => deleteUpload(store.path, '../invalid')).toThrow('UPLOAD_NOT_FOUND');
  expect(() => discardPreparedRisuImport(store.path, '../invalid')).toThrow(
    'RISU_IMPORT_DRAFT_CHANGED'
  );
  expect(() => deletePreparedArchive(store, '../invalid')).toThrow();
});
