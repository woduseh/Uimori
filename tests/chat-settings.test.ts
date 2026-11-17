import { afterEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizeChatSettings } from '../core/chat-settings.js';
import type { Chat } from '../core/types.js';
import { createApp, type App } from '../server/app.js';
import { createFixtureChat } from './fixtures/chat.js';
const owned: { app: App; path: string }[] = [];
afterEach(async () => {
  for (const { app, path } of owned.splice(0)) {
    await app.close();
    rmSync(path, { recursive: true, force: true });
  }
});

test('only active settings survive old DB and backup projections', () => {
  expect(
    normalizeChatSettings({
      preset: 'vivid',
      mode: 'research',
      translation: true,
      status: true,
      maxCalls: 7,
    })
  ).toEqual({ maxCalls: 7 });
  expect(normalizeChatSettings({ maxCalls: 8, autoTranslate: true })).toEqual({
    maxCalls: 8,
    autoTranslate: true,
  });
  expect(() => normalizeChatSettings({ maxCalls: 8, autoTranslate: 'yes' })).toThrow();
  expect(normalizeChatSettings({ maxCalls: 8, storyUiStyle: 'theme:custom-theme' })).toEqual({
    maxCalls: 8,
    storyUiStyle: 'theme:custom-theme',
  });
  for (const invalid of ['theme:', 'theme:with space', `theme:${'x'.repeat(101)}`])
    expect(() => normalizeChatSettings({ maxCalls: 8, storyUiStyle: invalid })).toThrow(
      'Invalid story UI style'
    );
  for (const maxCalls of [0, 129, 2.5, '8', null])
    expect(() => normalizeChatSettings({ status: false, maxCalls })).toThrow('Invalid settings');
});

test('generation defaults persist and apply only when creating a new chat', async () => {
  const path = mkdtempSync(join(tmpdir(), 'uimori-chat-generation-defaults-'));
  const options = {
    dbPath: join(path, 'app.sqlite'),
    buildId: 'chat-generation-defaults-test',
    testMode: true,
    codex: { enabled: false },
  };
  const app = await createApp(options);
  owned.push({ app, path });
  const url = '/api/chat-generation-defaults';
  const initial = { maxCalls: 8, storyUi: false, storyUiStyle: 'auto' };
  expect((await app.inject(url)).json()).toEqual({ revision: 0, ...initial });
  const before = createFixtureChat(app.store, 'Chat before saving defaults');
  expect(before.settings).toEqual(initial);
  const chosen = { maxCalls: 128, storyUi: true, storyUiStyle: 'theme:custom-theme' };
  const put = (expectedRevision: number, settings: typeof initial) =>
    app.inject({ method: 'PUT', url, payload: { expectedRevision, ...settings } });
  const saved = await put(0, chosen);
  expect(saved.statusCode).toBe(200);
  expect(saved.json()).toEqual({ revision: 1, ...chosen });
  expect((await put(0, initial)).statusCode).toBe(409);
  expect((await app.inject(url)).json()).toEqual({ revision: 1, ...chosen });
  expect(app.store.chat(before.id).settings).toEqual(initial);
  expect(app.store.chat(before.id).settingsRevision).toBe(before.settingsRevision);
  expect((await app.inject('/api/auto-translation-defaults')).json()).toEqual({
    revision: 0,
    autoTranslate: false,
  });

  await app.close();
  owned.pop();
  const reopened = await createApp(options);
  owned.push({ app: reopened, path });
  expect((await reopened.inject(url)).json()).toEqual({ revision: 1, ...chosen });
  const created = await reopened.inject({
    method: 'POST',
    url: '/api/chats',
    payload: { title: 'Chat after saving defaults', botId: before.botId },
  });
  expect(created.statusCode).toBe(200);
  expect(created.json<Chat>().settings).toEqual(chosen);
  const forked = await reopened.inject({
    method: 'POST',
    url: `/api/chats/${before.id}/fork`,
    payload: { fromRevision: null, idempotencyKey: 'fork-existing-chat' },
  });
  expect(forked.statusCode).toBe(200);
  expect(forked.json<Chat>().settings).toEqual(initial);
});

test('generation defaults and per-chat settings enforce the same call limit', async () => {
  const path = mkdtempSync(join(tmpdir(), 'uimori-chat-generation-limit-'));
  const app = await createApp({
    dbPath: join(path, 'app.sqlite'),
    buildId: 'chat-generation-limit-test',
    testMode: true,
    codex: { enabled: false },
  });
  owned.push({ app, path });
  const chat = createFixtureChat(app.store, 'Call limit');
  const defaultsUrl = '/api/chat-generation-defaults';
  const defaults = {
    expectedRevision: 0,
    maxCalls: 128,
    storyUi: false,
    storyUiStyle: 'fantasy',
  };
  for (const payload of [
    { ...defaults, maxCalls: 0 },
    { ...defaults, maxCalls: 129 },
    { ...defaults, maxCalls: 1.5 },
    { ...defaults, maxCalls: '128' },
    { ...defaults, storyUi: 'true' },
    { ...defaults, storyUi: undefined },
    { ...defaults, storyUiStyle: 'theme:contains a space' },
    { ...defaults, storyUiStyle: undefined },
    { ...defaults, autoTranslate: true },
  ]) {
    expect((await app.inject({ method: 'PUT', url: defaultsUrl, payload })).statusCode).toBe(400);
  }
  expect((await app.inject(defaultsUrl)).json().revision).toBe(0);

  const patch = (maxCalls: number) =>
    app.inject({
      method: 'PATCH',
      url: `/api/chats/${chat.id}/settings`,
      payload: { expectedSettingsRevision: chat.settingsRevision, maxCalls },
    });
  expect((await patch(129)).statusCode).toBe(400);
  const saved = await patch(128);
  expect(saved.statusCode).toBe(200);
  expect(saved.json<Chat>().settings.maxCalls).toBe(128);
});

test('existing database settings are normalized on read/save and public settings never accept fixture controls', async () => {
  const path = mkdtempSync(join(tmpdir(), 'uimori-chat-settings-'));
  const app = await createApp({
    dbPath: join(path, 'app.sqlite'),
    buildId: 'settings-test',
    testMode: true,
    codex: { enabled: false },
  });
  owned.push({ app, path });
  const chat = createFixtureChat(app.store, 'Synthetic settings');
  app.store.db.prepare('UPDATE chats SET settings=? WHERE id=?').run(
    JSON.stringify({
      preset: 'vivid',
      mode: 'research',
      translation: true,
      status: false,
      maxCalls: 6,
    }),
    chat.id
  );
  expect(app.store.chat(chat.id).settings).toEqual({ maxCalls: 6 });
  const saved = await app.inject({
    method: 'PATCH',
    url: `/api/chats/${chat.id}/settings`,
    payload: { expectedSettingsRevision: 1, maxCalls: 4 },
  });
  expect(saved.statusCode).toBe(200);
  expect(
    JSON.parse(
      String(app.store.db.prepare('SELECT settings FROM chats WHERE id=?').get(chat.id)!.settings)
    )
  ).toEqual({ maxCalls: 4 });
  const invalid = await app.inject({
    method: 'PATCH',
    url: `/api/chats/${chat.id}/settings`,
    payload: { expectedSettingsRevision: 2, status: true, maxCalls: 4, preset: 'vivid' },
  });
  expect(invalid.statusCode).toBe(400);
  expect(app.store.chat(chat.id).settingsRevision).toBe(2);
  expect(app.hasRoute({ method: 'POST', url: '/api/sources/:id/status' })).toBe(false);
  const retired = await app.inject({
    method: 'POST',
    url: '/api/sources/legacy/status',
    payload: {},
  });
  expect(retired.statusCode).toBe(404);
  for (const url of [
    '/api/story-jobs/legacy/cancel',
    `/api/chats/${chat.id}/extension`,
    `/api/chats/${chat.id}/extension-operations/legacy/cancel`,
  ]) {
    const response = await app.inject({ method: 'POST', url, payload: {} });
    expect(response.statusCode).toBe(404);
  }
  const control = await app.inject({
    method: 'POST',
    url: '/api/test/control',
    payload: { action: 'fixture', mode: 'research' },
  });
  expect(control.statusCode).toBe(200);
  expect(app.controls.fixture.mode).toBe('research');
  expect(app.store.chat(chat.id).settings).toEqual({ maxCalls: 4 });
});

test('global auto translation defaults inherit without rewriting chats and freeze at run reservation', async () => {
  const path = mkdtempSync(join(tmpdir(), 'uimori-auto-translation-defaults-'));
  const dbPath = join(path, 'app.sqlite');
  const options = {
    dbPath,
    buildId: 'auto-translation-test',
    testMode: true,
    codex: { enabled: false },
  };
  const app = await createApp(options);
  owned.push({ app, path });
  const get = () => app.inject({ method: 'GET', url: '/api/auto-translation-defaults' });
  const put = (revision: number, autoTranslate: unknown) =>
    app.inject({
      method: 'PUT',
      url: '/api/auto-translation-defaults',
      payload: {
        expectedRevision: revision,
        autoTranslate,
      },
    });
  expect((await get()).json()).toEqual({ revision: 0, autoTranslate: false });
  const inherit = createFixtureChat(app.store, 'Inherits global default');
  const explicitOff = createFixtureChat(app.store, 'Always off');
  const explicitOn = createFixtureChat(app.store, 'Always on');
  app.store.settings(explicitOff.id, explicitOff.settingsRevision, {
    ...explicitOff.settings,
    autoTranslate: false,
  });
  app.store.settings(explicitOn.id, explicitOn.settingsRevision, {
    ...explicitOn.settings,
    autoTranslate: true,
  });
  const reserve = (id: string) => {
    const chat = app.store.chat(id);
    const profile = app.store.product.snapshot(id);
    return app.store.createRun(
      id,
      {
        request: 'Synthetic reservation',
        expectedRevision: chat.headRevision,
        expectedSettingsRevision: chat.settingsRevision,
        idempotencyKey: randomUUID(),
      },
      (selected) => ({
        chatId: id,
        parentRevision: selected.headRevision,
        settingsRevision: selected.settingsRevision,
        settings: selected.settings,
        request: 'Synthetic reservation',
        history: app.store.history(selected.headRevision),
        resources: app.store.product.resources(id, profile),
        profile,
      })
    ).run;
  };
  const before = reserve(inherit.id);
  expect(before.snapshot.settings.autoTranslate).toBe(false);
  expect((await put(0, true)).json()).toEqual({ revision: 1, autoTranslate: true });
  expect((await put(0, false)).statusCode).toBe(409);
  expect((await put(1, 'yes')).statusCode).toBe(400);
  expect(app.store.chat(inherit.id).settings.autoTranslate).toBeUndefined();
  expect(reserve(explicitOff.id).snapshot.settings.autoTranslate).toBe(false);
  expect(reserve(explicitOn.id).snapshot.settings.autoTranslate).toBe(true);
  const inheritNext = createFixtureChat(app.store, 'New inherited chat');
  const after = reserve(inheritNext.id);
  expect(after.snapshot.settings.autoTranslate).toBe(true);
  expect((await put(1, false)).json()).toEqual({ revision: 2, autoTranslate: false });
  expect(app.store.run(after.id).snapshot.settings.autoTranslate).toBe(true);
  expect(app.store.run(before.id).snapshot.settings.autoTranslate).toBe(false);
  await app.close();
  owned.pop();
  const restarted = await createApp(options);
  owned.push({ app: restarted, path });
  expect(
    (await restarted.inject({ method: 'GET', url: '/api/auto-translation-defaults' })).json()
  ).toEqual({ revision: 2, autoTranslate: false });
  expect(restarted.store.chat(inherit.id).settings.autoTranslate).toBeUndefined();
});
