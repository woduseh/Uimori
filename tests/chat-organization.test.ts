import { afterEach, expect, test } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { Store } from '../server/store.js';
import { forkChat } from '../server/chat-fork.js';
import type { Content } from '../core/product.js';
import { createApp } from '../server/app.js';

const owned: { directory: string; store?: Store }[] = [];
afterEach(async () => {
  for (const item of owned.splice(0)) {
    item.store?.close();
    const target = resolve(item.directory);
    const inside = relative(resolve(tmpdir()), target);
    if (
      isAbsolute(inside) ||
      inside.startsWith('..') ||
      !basename(target).startsWith('Uimori organization ')
    )
      throw new Error('Unexpected test cleanup path');
    await rm(target, { recursive: true, force: true });
  }
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'Uimori organization '));
  const store = new Store(join(directory, 'story.sqlite'));
  owned.push({ directory, store });
  const make = (kind: 'bot' | 'persona', title: string) =>
    store.product.content({
      kind,
      title,
      description: 'Synthetic',
      text: 'Synthetic content',
      loading: 'pinned',
      relatedIds: [],
    }) as Content;
  return {
    store,
    bot: make('bot', 'A'),
    other: make('bot', 'B'),
    persona: make('persona', 'P'),
    nextPersona: make('persona', 'Q'),
  };
}
const ref = (content: Content) => ({ id: content.id, revision: content.revision });
function titles(store: Store, botId: string, folderId: string | null) {
  return store
    .chats()
    .filter((chat) => chat.botId === botId && chat.folderId === folderId)
    .sort((a, b) => a.sortPosition! - b.sortPosition!)
    .map((chat) => chat.title);
}

test('manual order survives moves, folder deletion, new chats, archive and reopen', async () => {
  const { store, bot } = await fixture();
  const folder = store.organization.createFolder(bot.id, { title: 'Stories' });
  const first = store.createChat('First', 'calm', { botId: bot.id });
  const second = store.createChat('Second', 'calm', { botId: bot.id });
  const third = store.createChat('Third', 'calm', { botId: bot.id });
  expect(titles(store, bot.id, null)).toEqual(['Third', 'Second', 'First']);
  store.organization.move(first.id, {
    expectedRevision: 1,
    folderId: null,
    beforeChatId: second.id,
  });
  expect(titles(store, bot.id, null)).toEqual(['Third', 'First', 'Second']);
  store.organization.move(third.id, {
    expectedRevision: 1,
    folderId: folder.id,
    beforeChatId: null,
  });
  store.organization.move(second.id, {
    expectedRevision: 1,
    folderId: folder.id,
    beforeChatId: third.id,
  });
  expect(titles(store, bot.id, folder.id)).toEqual(['Second', 'Third']);
  store.organization.move(second.id, {
    expectedRevision: 2,
    folderId: folder.id,
    beforeChatId: null,
  });
  expect(titles(store, bot.id, folder.id)).toEqual(['Third', 'Second']);
  store.event(third.id, 'run.updated', 'synthetic-activity');
  expect(titles(store, bot.id, folder.id)).toEqual(['Third', 'Second']);
  store.organization.deleteFolder(bot.id, folder.id, { expectedRevision: 1 });
  expect(titles(store, bot.id, null)).toEqual(['First', 'Third', 'Second']);
  store.createChat('Newest', 'calm', { botId: bot.id });
  const order = ['Newest', 'First', 'Third', 'Second'];
  expect(titles(store, bot.id, null)).toEqual(order);
  const directory = await mkdtemp(join(tmpdir(), 'Uimori organization '));
  const target = new Store(join(directory, 'restored.sqlite'));
  owned.push({ directory, store: target });
  target.product.import(store.product.export());
  expect(titles(target, bot.id, null)).toEqual(order);
  const owner = owned.find((item) => item.store === store)!;
  store.close();
  owner.store = undefined;
  const reopened = new Store(store.path);
  owner.store = reopened;
  expect(titles(reopened, bot.id, null)).toEqual(order);
});

test('invalid and stale order anchors roll back every position and revision', async () => {
  const { store, bot, other } = await fixture();
  const folder = store.organization.createFolder(bot.id, { title: 'Elsewhere' });
  const moving = store.createChat('Moving', 'calm', { botId: bot.id });
  const wrongFolder = store.createChat('Wrong folder', 'calm', {
    botId: bot.id,
    folderId: folder.id,
  });
  const wrongBot = store.createChat('Wrong bot', 'calm', { botId: other.id });
  const original = store.chats();
  for (const beforeChatId of [moving.id, wrongFolder.id, wrongBot.id, 'missing']) {
    expect(() =>
      store.organization.move(moving.id, { expectedRevision: 1, folderId: null, beforeChatId })
    ).toThrow('Order anchor');
    expect(store.chats()).toEqual(original);
  }
  expect(() =>
    store.organization.move(moving.id, { expectedRevision: 99, folderId: null, beforeChatId: null })
  ).toThrow('revision conflict');
  expect(store.chats()).toEqual(original);
});
function attach(store: Store, chatId: string, attachments: { id: string; revision: number }[]) {
  const p = store.product.profile(chatId);
  return store.product.updateProfile(chatId, {
    expectedRevision: p.revision,
    attachments,
    personaReference: p.personaReference,
    routes: p.routes,
    image: p.image,
  });
}

test('bot ownership and folder defaults apply only at creation; moves/deletion preserve profile', async () => {
  const { store, bot, persona, nextPersona } = await fixture();
  const org = store.organization;
  const folder = org.createFolder(bot.id, { title: 'First', defaultPersona: ref(persona) });
  const chat = store.createChat('Owned', 'calm', { botId: bot.id, folderId: folder.id });
  expect(chat).toMatchObject({ botId: bot.id, folderId: folder.id, organizationRevision: 1 });
  expect(store.product.profile(chat.id).attachments).toEqual([ref(bot), ref(persona)]);
  org.updateFolder(bot.id, folder.id, {
    expectedRevision: 1,
    defaultPersona: ref(nextPersona),
    title: 'Renamed',
  });
  expect(store.product.profile(chat.id).attachments).toEqual([ref(bot), ref(persona)]);
  const next = store.createChat('Next', 'calm', { botId: bot.id, folderId: folder.id });
  expect(store.product.profile(next.id).attachments).toEqual([ref(bot), ref(nextPersona)]);
  const profile = store.product.profile(chat.id);
  org.move(chat.id, { expectedRevision: 1, folderId: null });
  expect(store.product.profile(chat.id)).toEqual(profile);
  org.move(chat.id, { expectedRevision: 2, folderId: folder.id });
  const result = org.deleteFolder(bot.id, folder.id, { expectedRevision: 2 });
  expect(result.movedChatIds.sort()).toEqual([chat.id, next.id].sort());
  expect(store.chat(chat.id)).toMatchObject({
    botId: bot.id,
    folderId: null,
    organizationRevision: 4,
  });
  expect(store.product.profile(chat.id)).toEqual(profile);
});

test('cross-bot moves, stale edits and invalid defaults fail without losing organization', async () => {
  const { store, bot, other } = await fixture();
  const org = store.organization;
  const a = org.createFolder(bot.id, { title: 'A' });
  const b = org.createFolder(other.id, { title: 'B' });
  const chat = store.createChat('Owned', 'calm', { botId: bot.id, folderId: a.id });
  expect(() => org.move(chat.id, { expectedRevision: 1, folderId: b.id })).toThrow(
    'Folder not found'
  );
  expect(() => org.move(chat.id, { expectedRevision: 9, folderId: null })).toThrow(
    'revision conflict'
  );
  expect(() => org.updateFolder(bot.id, a.id, { expectedRevision: 9, title: 'Stale' })).toThrow(
    'revision conflict'
  );
  expect(() => org.deleteFolder(bot.id, a.id, { expectedRevision: 9 })).toThrow(
    'revision conflict'
  );
  expect(() => org.createFolder(bot.id, { title: 'Bad', defaultPersona: ref(other) })).toThrow(
    'persona'
  );
  expect(() => store.createChat('Bad', 'calm', { botId: bot.id, folderId: b.id })).toThrow(
    'Folder not found'
  );
  expect(store.chats()).toHaveLength(1);
  expect(store.chat(chat.id).folderId).toBe(a.id);
  expect(() => attach(store, chat.id, [ref(other)])).toThrow('owning bot');
});

test('fork inherits original owner/folder/profile without reapplying changed default', async () => {
  const { store, bot, persona, nextPersona } = await fixture();
  const folder = store.organization.createFolder(bot.id, {
    title: 'Stories',
    defaultPersona: ref(persona),
  });
  const chat = store.createChat('Original', 'calm', {
    botId: bot.id,
    folderId: folder.id,
  });
  const snapshot = store.product.snapshot(chat.id);
  const { run } = store.createRun(
    chat.id,
    {
      request: 'Synthetic',
      expectedRevision: null,
      expectedSettingsRevision: 1,
      idempotencyKey: 'run',
    },
    (current) => ({
      chatId: chat.id,
      parentRevision: null,
      settingsRevision: 1,
      settings: current.settings,
      request: 'Synthetic',
      history: [],
      resources: store.product.resources(chat.id, snapshot),
      profile: snapshot,
    })
  );
  store.startRun(run.id);
  const source = store.completeRun(
    run.id,
    'Synthetic scene.',
    { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null },
    { ...run.snapshot.settings, translation: false, status: false }
  );
  store.organization.updateFolder(bot.id, folder.id, {
    expectedRevision: 1,
    defaultPersona: ref(nextPersona),
  });
  const fork = forkChat(store, chat.id, { fromRevision: source.id, idempotencyKey: 'fork' });
  expect(fork).toMatchObject({ botId: bot.id, folderId: folder.id, organizationRevision: 1 });
  expect(store.product.profile(fork.id).attachments).toEqual([ref(bot), ref(persona)]);
  expect(forkChat(store, chat.id, { fromRevision: source.id, idempotencyKey: 'fork' }).id).toBe(
    fork.id
  );
});

test('creation selects ownership and later attachments never infer a new owner', async () => {
  const { store, bot, other } = await fixture();
  expect(() => store.createChat('Missing owner')).toThrow('owning bot');
  expect(() => store.createChat('Removed sentinel', 'calm', { botId: '__legacy__' })).toThrow();
  expect(store.chats()).toHaveLength(0);
  expect(store.db.prepare('SELECT COUNT(*) AS n FROM branches').get()).toMatchObject({ n: 0 });
  const explicit = store.createChat('Owned', 'calm', { botId: bot.id });
  attach(store, explicit.id, [ref(bot)]);
  expect(() => attach(store, explicit.id, [ref(other)])).toThrow('owning bot');
  expect(store.chat(explicit.id).botId).toBe(bot.id);
  expect(store.chat(explicit.id).organizationRevision).toBe(1);
});

test('organization archive roundtrip retains defaults, ownership and CAS revisions', async () => {
  const { store, bot, persona } = await fixture();
  const folder = store.organization.createFolder(bot.id, {
    title: 'Archive',
    defaultPersona: ref(persona),
  });
  const chat = store.createChat('Stored', 'calm', {
    botId: bot.id,
    folderId: folder.id,
  });
  store.organization.move(chat.id, { expectedRevision: 1, folderId: null });
  const directory = await mkdtemp(join(tmpdir(), 'Uimori organization '));
  const target = new Store(join(directory, 'restored.sqlite'));
  owned.push({ directory, store: target });
  target.product.import(store.product.export());
  expect(target.chat(chat.id)).toEqual(store.chat(chat.id));
  expect(target.organization.folders(bot.id)).toEqual(store.organization.folders(bot.id));
});

test('HTTP organization routes enforce bot scopes and CAS and reject missing owners', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'Uimori organization '));
  const app = await createApp({
    dbPath: join(directory, 'http.sqlite'),
    buildId: 'organization-fixture',
    testMode: true,
  });
  // The app owns Store.close; the cleanup registry only owns the temporary directory.
  owned.push({ directory });
  try {
    const bot = app.store.product.content({
      kind: 'bot',
      title: 'HTTP bot',
      description: 'Synthetic',
      text: 'Synthetic',
      loading: 'pinned',
      relatedIds: [],
    }) as Content;
    const folderResponse = await app.inject({
      method: 'POST',
      url: `/api/bots/${bot.id}/folders`,
      payload: { title: 'Folder' },
    });
    expect(folderResponse.statusCode).toBe(200);
    const folder = folderResponse.json();
    const chatResponse = await app.inject({
      method: 'POST',
      url: '/api/chats',
      payload: { title: 'Owned', botId: bot.id, folderId: folder.id },
    });
    expect(chatResponse.statusCode).toBe(200);
    const chat = chatResponse.json();
    expect(
      (await app.inject({ method: 'GET', url: `/api/bots/${bot.id}/folders` })).json()
    ).toEqual([folder]);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/chats/${chat.id}/organization`,
          payload: { expectedRevision: 5, folderId: null },
        })
      ).statusCode
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/bots/${bot.id}/folders/${folder.id}`,
          payload: { expectedRevision: 1, title: 'New name' },
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/bots/${bot.id}/folders/${folder.id}`,
          payload: { expectedRevision: 2 },
        })
      ).statusCode
    ).toBe(200);
    expect(app.store.chat(chat.id).folderId).toBeNull();
    const missing = await app.inject({
      method: 'POST',
      url: '/api/chats',
      payload: { title: 'Missing owner' },
    });
    expect(missing.statusCode).toBe(400);
    expect(app.store.chats()).toHaveLength(1);
  } finally {
    await app.close();
  }
});

test('one package can own a chat and serve as a persona through explicit attachment roles', async () => {
  const { store } = await fixture();
  const content = store.product.content({
    kind: 'module',
    title: 'Shared package',
    description: 'Synthetic',
    text: '',
    loading: 'pinned',
    relatedIds: [],
    package: {
      version: 1,
      id: 'temporary',
      revision: 1,
      title: 'Shared package',
      description: 'Synthetic',
      lore: [],
      instructions: [],
      controls: [],
      transforms: [],
    },
  }) as Content;
  const folder = store.organization.createFolder(content.id, {
    title: 'Package folder',
    defaultPersona: ref(content),
  });
  const chat = store.createChat('Package roles', 'calm', {
    botId: content.id,
    folderId: folder.id,
  });
  const profile = store.product.profile(chat.id);
  expect(profile.attachments).toEqual([]);
  expect(profile.packageAttachments).toEqual([
    { ...ref(content), role: 'bot' },
    { ...ref(content), role: 'persona' },
  ]);
  expect(() =>
    store.organization.assertBotAttachments(chat.id, [], profile.packageAttachments)
  ).not.toThrow();
  expect(() =>
    store.organization.assertBotAttachments(chat.id, [], [{ ...ref(content), role: 'persona' }])
  ).toThrow('owning bot');
});

test('schema v11 reopen keeps explicit organization revisions without automatic preservation files', async () => {
  const { store, bot } = await fixture();
  const chat = store.createChat('Current schema', 'calm', { botId: bot.id });
  const folder = store.organization.createFolder(bot.id, { title: 'Persisted' });
  store.organization.move(chat.id, { expectedRevision: 1, folderId: folder.id });
  const owner = owned.find((item) => item.store === store)!;
  const path = store.path;
  store.close();
  owner.store = undefined;
  const reopened = new Store(path);
  owner.store = reopened;
  expect(reopened.db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 11 });
  expect(reopened.chat(chat.id)).toMatchObject({
    botId: bot.id,
    folderId: folder.id,
    organizationRevision: 2,
  });
  expect((await readdir(owner.directory)).filter((name) => name.includes('.pre-'))).toEqual([]);
});
