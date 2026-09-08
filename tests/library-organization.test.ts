import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { Store } from '../server/store.js';
import { deleteLibraryItem, libraryDeletionImpact } from '../server/library-deletion.js';
import { fixtureBotInput } from './fixtures/chat.js';
import type { Content } from '../core/product.js';
import { libraryCategory, libraryFolderOf } from '../core/library-organization.js';
import { createApp } from '../server/app.js';
import { putImageBlob } from '../server/package-images.js';

const owned: { dir: string; store: Store }[] = [];
afterEach(() => {
  for (const item of owned.splice(0)) {
    item.store.close();
    const dir = resolve(item.dir),
      within = relative(resolve(tmpdir()), dir);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(dir).startsWith('uimori-library-org-')
    )
      throw new Error('Unsafe test cleanup path');
    rmSync(dir, { recursive: true, force: true });
  }
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'uimori-library-org-'));
  const store = new Store(join(dir, 'story.sqlite'));
  owned.push({ dir, store });
  return store;
}
const key = (content: { id: string }) => ({ kind: 'content' as const, id: content.id });
const revision = (store: Store) => store.libraryOrganization.snapshot().revision;
function folder(
  store: Store,
  title: string,
  category: 'bot' | 'persona' | 'module' | 'prompts' = 'bot'
) {
  return store.libraryOrganization
    .createFolder({ expectedRevision: revision(store), category, title })
    .folders.find((item) => item.title === title)!;
}
function content(store: Store, title: string, kind: 'bot' | 'persona' | 'module' = 'bot') {
  return store.product.content({ ...fixtureBotInput(title, `Body of ${title}`), kind }) as Content;
}

test('library folders and cross-category moves preserve exact content revisions, package roles and chat ownership', () => {
  const store = fixture(),
    bot = content(store, 'Owner'),
    persona = content(store, 'Reader', 'persona');
  const destination = folder(store, 'Characters', 'module');
  const chat = store.createChat('Story', 'calm', { botId: bot.id });
  const beforeContent = store.product.get('content', bot.id),
    beforeProfile = store.product.profile(chat.id);
  const beforeRevision = revision(store);
  const moved = store.libraryOrganization.move({
    expectedRevision: beforeRevision,
    items: [key(bot), key(persona)],
    category: 'module',
    folderId: destination.id,
  });
  expect(moved.revision).toBe(beforeRevision + 1);
  expect(moved.items).toHaveLength(2);
  expect(
    moved.items.every((item) => item.category === 'module' && item.folderId === destination.id)
  ).toBe(true);
  expect(store.product.get('content', bot.id)).toEqual(beforeContent);
  expect(store.product.profile(chat.id)).toEqual(beforeProfile);
  expect(store.chat(chat.id).botId).toBe(bot.id);
  for (const summary of [false, true]) {
    const library = store.product.library(summary);
    expect(library.organization).toEqual(moved);
    expect(libraryCategory(library, bot)).toBe('module');
    expect(libraryFolderOf(library, key(bot))).toBe(destination.id);
  }
  // Actual package roles are independent of both immutable kind and current folder category.
  const roleChat = store.createChat('Persona used as bot', 'calm', { botId: persona.id });
  expect(store.product.profile(roleChat.id).packageAttachments).toEqual([
    { id: persona.id, revision: persona.revision, role: 'bot' },
  ]);
});

test('bulk moves validate every item and destination before mutation, and stale CAS changes nothing', () => {
  const store = fixture(),
    bot = content(store, 'A'),
    dest = folder(store, 'Persona folder', 'persona');
  const prompt = store.product.promptPreset({ title: 'Prompt', role: 'main', text: 'Write.' });
  const before = store.product.export().tables;
  const attempts = [
    {
      items: [key(bot), { kind: 'content', id: 'missing' }],
      category: 'persona',
      folderId: dest.id,
    },
    {
      items: [key(bot), { kind: 'prompt-preset', id: prompt.id }],
      category: 'persona',
      folderId: dest.id,
    },
    { items: [key(bot)], category: 'bot', folderId: dest.id },
    { items: [key(bot), key(bot)], category: 'persona', folderId: dest.id },
    { items: [key(bot)], category: 'prompts', folderId: null },
    { items: [key(bot)], category: 'persona', folderId: 'missing' },
  ];
  for (const request of attempts) {
    expect(() =>
      store.libraryOrganization.move({ expectedRevision: revision(store), ...request })
    ).toThrow();
    expect(store.product.export().tables).toEqual(before);
  }
  expect(() =>
    store.libraryOrganization.move({
      expectedRevision: revision(store) - 1,
      items: [key(bot)],
      category: 'persona',
      folderId: dest.id,
    })
  ).toThrow('새로고침');
  expect(store.product.export().tables).toEqual(before);
});

test('reordering is category scoped and folder deletion moves members to unclassified without deleting contents', () => {
  const store = fixture(),
    a = folder(store, 'A'),
    b = folder(store, 'B'),
    c = folder(store, 'C'),
    foreign = folder(store, 'Elsewhere', 'persona');
  let current = store.libraryOrganization.updateFolder(c.id, {
    expectedRevision: revision(store),
    beforeFolderId: a.id,
    title: 'First',
  });
  expect(current.folders.filter((item) => item.category === 'bot').map((item) => item.id)).toEqual([
    c.id,
    a.id,
    b.id,
  ]);
  expect(() =>
    store.libraryOrganization.updateFolder(a.id, {
      expectedRevision: current.revision,
      beforeFolderId: foreign.id,
    })
  ).toThrow('outside');
  expect(store.libraryOrganization.snapshot()).toEqual(current);
  const bot = content(store, 'Moved');
  current = store.libraryOrganization.move({
    expectedRevision: revision(store),
    items: [key(bot)],
    category: 'bot',
    folderId: a.id,
  });
  current = store.libraryOrganization.deleteFolder(a.id, { expectedRevision: current.revision });
  expect(
    current.folders.filter((item) => item.category === 'bot').map((item) => item.sortPosition)
  ).toEqual([0, 1]);
  expect(current.items).toEqual([{ ...key(bot), category: 'bot', folderId: null }]);
  expect(store.product.get('content', bot.id)).toEqual(bot);
});

test('item deletion cleans placement but still honors immutable reference blockers', () => {
  const store = fixture(),
    unused = content(store, 'Unused'),
    used = content(store, 'Used');
  const dest = folder(store, 'Folder');
  store.libraryOrganization.move({
    expectedRevision: revision(store),
    items: [key(unused), key(used)],
    category: 'bot',
    folderId: dest.id,
  });
  store.createChat('Protected story', 'calm', { botId: used.id });
  expect(libraryDeletionImpact(store, 'content', unused.id).canDelete).toBe(true);
  expect(libraryDeletionImpact(store, 'content', used.id).canDelete).toBe(false);
  const before = revision(store);
  deleteLibraryItem(store, 'content', unused.id, { expectedRevision: unused.revision });
  expect(revision(store)).toBe(before + 1);
  expect(store.libraryOrganization.snapshot().items.map((item) => item.id)).toEqual([used.id]);
  expect(() =>
    deleteLibraryItem(store, 'content', used.id, { expectedRevision: used.revision })
  ).toThrow('삭제할 수 없어요');
});

test('archives round trip folders and reject poisoned scope or missing placement atomically', () => {
  const store = fixture(),
    bot = content(store, 'A'),
    dest = folder(store, 'P', 'persona');
  store.libraryOrganization.move({
    expectedRevision: revision(store),
    items: [key(bot)],
    category: 'persona',
    folderId: dest.id,
  });
  const archive = store.product.export(),
    before = structuredClone(archive),
    restored = fixture();
  expect(archive.version).toBe(12);
  restored.product.import(archive);
  expect(restored.libraryOrganization.snapshot()).toEqual(store.libraryOrganization.snapshot());
  expect(archive).toEqual(before);
  for (const poison of ['scope', 'missing', 'order', 'revision'] as const) {
    const target = fixture(),
      empty = target.product.export().tables,
      bad = structuredClone(archive);
    if (poison === 'scope') bad.tables.library_placements[0].category = 'bot';
    if (poison === 'missing') bad.tables.library_placements = [];
    if (poison === 'order') bad.tables.library_folders[0].sort_position = 3;
    if (poison === 'revision') bad.tables.library_organization_state[0].revision = 0;
    expect(() => target.product.import(bad), poison).toThrow();
    expect(target.product.export().tables, poison).toEqual(empty);
  }
});

test('old standalone content kinds are rejected at creation and archive restore', () => {
  const store = fixture(),
    bot = content(store, 'A');
  for (const kind of ['lore', 'canon', 'skill', 'glossary']) {
    expect(() => store.product.content({ ...fixtureBotInput('Rejected'), kind })).toThrow(
      'content kind'
    );
    const target = fixture(),
      before = target.product.export().tables,
      archive = store.product.export();
    const row = archive.tables.versions.find((row) => row.kind === 'content' && row.id === bot.id)!;
    row.body = JSON.stringify({ ...JSON.parse(row.body), kind });
    expect(() => target.product.import(archive)).toThrow('content kind');
    expect(target.product.export().tables).toEqual(before);
  }
});

test('summary cover follows the latest portrait while exact revision and archived blob references stay fixed', () => {
  const store = fixture();
  const blob = putImageBlob(store.product, {
    mime: 'image/png',
    base64:
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=',
  });
  const input = fixtureBotInput('Portrait');
  input.package.images = [
    {
      id: 'portrait',
      title: 'First portrait',
      blobHash: blob.hash,
      mime: blob.mime,
      allowedUse: 'profile',
      description: '',
    },
  ];
  input.package.portraitImageId = 'portrait';
  const first = store.product.content(input) as Content;
  expect(
    store.product.library(true).contents.find((item) => item.id === first.id)?.coverImage
  ).toEqual({ url: `/api/package-image-blobs/${blob.hash}`, title: 'First portrait' });
  const updated = structuredClone(input);
  delete updated.package.portraitImageId;
  store.product.content({ ...updated, expectedRevision: first.revision }, first.id);
  expect(
    store.product.library(true).contents.find((item) => item.id === first.id)?.coverImage
  ).toBeUndefined();
  expect(store.product.get<Content>('content', first.id, 1).package?.portraitImageId).toBe(
    'portrait'
  );
  expect(store.product.get<Content>('content', first.id, 2).package?.images).toHaveLength(1);
  const restored = fixture();
  restored.product.import(store.product.export());
  expect(restored.product.get('content', first.id, 1)).toEqual(first);
  expect(restored.product.get('package-image', blob.id, 1)).toEqual(blob);
});

test('HTTP routes share one organization revision and reject hidden or unknown fields', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'uimori-library-org-'));
  const within = relative(resolve(tmpdir()), resolve(dir));
  if (
    isAbsolute(within) ||
    within.startsWith('..') ||
    !basename(dir).startsWith('uimori-library-org-')
  )
    throw new Error('Unsafe cleanup');
  const built = await createApp({
    dbPath: join(dir, 'story.sqlite'),
    buildId: 'library-org-test',
    testMode: true,
  });
  owned.push({ dir, store: built.store });
  const inject = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: Record<string, unknown>
  ) => built.inject({ method, url, ...(payload ? { payload } : {}) });
  try {
    const initial = (await inject('GET', '/api/library/organization')).json();
    expect(initial).toEqual({ revision: 1, folders: [], items: [] });
    expect(
      (
        await inject('POST', '/api/library/folders', {
          expectedRevision: 1,
          category: ['bot'],
          title: 'Invalid',
        })
      ).statusCode
    ).toBe(400);
    expect((await inject('GET', '/api/library/organization')).json()).toEqual(initial);
    const created = await inject('POST', '/api/library/folders', {
      expectedRevision: 1,
      category: 'prompts',
      title: 'Writing',
    });
    expect(created.statusCode).toBe(200);
    expect(
      (
        await inject('POST', '/api/library/folders', {
          expectedRevision: 1,
          category: 'bot',
          title: 'Stale',
        })
      ).statusCode
    ).toBe(409);
    const org = created.json();
    expect(
      (
        await inject('PATCH', `/api/library/folders/${org.folders[0].id}`, {
          expectedRevision: org.revision,
          title: 'Updated',
          category: 'bot',
        })
      ).statusCode
    ).toBe(400);
    const removed = await inject('DELETE', `/api/library/folders/${org.folders[0].id}`, {
      expectedRevision: org.revision,
    });
    expect(removed.json()).toEqual({ revision: org.revision + 1, folders: [], items: [] });
  } finally {
    await built.close();
    owned.pop();
    rmSync(dir, { recursive: true, force: true });
  }
});
