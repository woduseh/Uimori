import { afterEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizeChatSettings } from '../core/chat-settings.js';
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
  for (const maxCalls of [0, 33, 2.5, '8', null])
    expect(() => normalizeChatSettings({ status: false, maxCalls })).toThrow('Invalid settings');
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
