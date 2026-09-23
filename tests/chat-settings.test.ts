import { afterEach, expect, test } from 'vitest';
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
  ).toEqual({ status: true, maxCalls: 7 });
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
  expect(app.store.chat(chat.id).settings).toEqual({ status: false, maxCalls: 6 });
  const saved = await app.inject({
    method: 'PATCH',
    url: `/api/chats/${chat.id}/settings`,
    payload: { expectedSettingsRevision: 1, status: true, maxCalls: 4 },
  });
  expect(saved.statusCode).toBe(200);
  expect(
    JSON.parse(
      String(app.store.db.prepare('SELECT settings FROM chats WHERE id=?').get(chat.id)!.settings)
    )
  ).toEqual({ status: true, maxCalls: 4 });
  const invalid = await app.inject({
    method: 'PATCH',
    url: `/api/chats/${chat.id}/settings`,
    payload: { expectedSettingsRevision: 2, status: true, maxCalls: 4, preset: 'vivid' },
  });
  expect(invalid.statusCode).toBe(400);
  expect(app.store.chat(chat.id).settingsRevision).toBe(2);
  const control = await app.inject({
    method: 'POST',
    url: '/api/test/control',
    payload: { action: 'fixture', mode: 'research' },
  });
  expect(control.statusCode).toBe(200);
  expect(app.controls.fixture.mode).toBe('research');
  expect(app.store.chat(chat.id).settings).toEqual({ status: true, maxCalls: 4 });
});
