import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { Store } from '../server/store.js';
import { deleteLibraryItem } from '../server/library-deletion.js';
import { fixtureBotInput } from './fixtures/chat.js';
import type { Content } from '../core/product.js';
import { libraryCategory, libraryFolderOf } from '../core/library-organization.js';
import { createApp } from '../server/app.js';

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
  const chat = store.createChat('Story', { botId: bot.id });
  const beforeContent = store.product.get('content', bot.id),
    beforeProfile = store.product.profile(chat.id);
  const beforeOrganization = store.libraryOrganization.snapshot();
  const beforeRevision = beforeOrganization.revision;
  const moved = store.libraryOrganization.move({
    expectedRevision: beforeRevision,
    items: [key(bot), key(persona)],
    category: 'module',
    folderId: destination.id,
  });
  expect(moved.revision).toBe(beforeRevision + 1);
  expect(moved.items).toEqual(
    beforeOrganization.items.map((item) =>
      item.kind === 'content' && [bot.id, persona.id].includes(item.id)
        ? { ...item, category: 'module', folderId: destination.id }
        : item
    )
  );
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
  const roleChat = store.createChat('Persona used as bot', { botId: persona.id });
  expect(store.product.profile(roleChat.id).packageAttachments).toEqual([
    { id: persona.id, revision: persona.revision, role: 'bot' },
  ]);
});

test('reordering is category scoped and folder deletion moves members to unclassified without deleting contents', () => {
  const store = fixture(),
    initialItems = store.libraryOrganization.snapshot().items,
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
  expect(current.items).toHaveLength(initialItems.length + 1);
  expect(current.items).toEqual(
    expect.arrayContaining([...initialItems, { ...key(bot), category: 'bot', folderId: null }])
  );
  expect(store.product.get('content', bot.id)).toEqual(bot);
});

test('item deletion cleans placement and retains immutable references', () => {
  const store = fixture(),
    initialItems = store.libraryOrganization.snapshot().items,
    unused = content(store, 'Unused'),
    used = content(store, 'Used');
  const dest = folder(store, 'Folder');
  store.libraryOrganization.move({
    expectedRevision: revision(store),
    items: [key(unused), key(used)],
    category: 'bot',
    folderId: dest.id,
  });
  store.createChat('Protected story', { botId: used.id });
  const before = revision(store);
  deleteLibraryItem(store, 'content', unused.id, { expectedRevision: unused.revision });
  expect(revision(store)).toBe(before + 1);
  const remainingItems = store.libraryOrganization.snapshot().items;
  expect(remainingItems).toHaveLength(initialItems.length + 1);
  expect(remainingItems).toEqual(
    expect.arrayContaining([...initialItems, { ...key(used), category: 'bot', folderId: dest.id }])
  );
  expect(() =>
    deleteLibraryItem(store, 'content', used.id, { expectedRevision: used.revision })
  ).not.toThrow();
  expect(store.product.get('content', used.id)).toEqual(used);
  expect(store.product.all('content')).not.toContainEqual(used);
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
    // Initialization also places the current default prompt presets in the library.
    const initial = built.store.libraryOrganization.snapshot();
    expect((await inject('GET', '/api/library/organization')).json()).toEqual(initial);
    expect(
      (
        await inject('POST', '/api/library/folders', {
          expectedRevision: initial.revision,
          category: ['bot'],
          title: 'Invalid',
        })
      ).statusCode
    ).toBe(400);
    expect((await inject('GET', '/api/library/organization')).json()).toEqual(initial);
    const created = await inject('POST', '/api/library/folders', {
      expectedRevision: initial.revision,
      category: 'prompts',
      title: 'Writing',
    });
    expect(created.statusCode).toBe(200);
    expect(
      (
        await inject('POST', '/api/library/folders', {
          expectedRevision: initial.revision,
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
    expect(removed.json()).toEqual({
      revision: org.revision + 1,
      folders: initial.folders,
      items: initial.items,
    });
  } finally {
    await built.close();
    owned.pop();
    rmSync(dir, { recursive: true, force: true });
  }
});
