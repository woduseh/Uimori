import { afterEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizeChatSettings } from '../core/chat-settings.js';
import type { Chat } from '../core/types.js';
import { createApp, type App } from '../server/app.js';
import { createFixtureChat } from './fixtures/chat.js';
import { requestTranslation } from '../server/source-editing.js';
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
  for (const invalid of ['theme:with space', `theme:${'x'.repeat(101)}`])
    expect(() => normalizeChatSettings({ maxCalls: 8, storyUiStyle: invalid })).toThrow(
      'Invalid story UI style'
    );
  expect(
    normalizeChatSettings({ maxCalls: 8, autoRefusalRetryEnabled: true, autoRefusalMaxRetries: 0 })
  ).toEqual({ maxCalls: 8, autoRefusalRetryEnabled: true, autoRefusalMaxRetries: 0 });
  for (const invalid of [
    { autoRefusalRetryEnabled: 'on' },
    { autoRefusalMaxRetries: 6 },
    { autoRefusalMaxRetries: 1.5 },
  ])
    expect(() => normalizeChatSettings({ maxCalls: 8, ...invalid })).toThrow(
      /automatic refusal retry/
    );
  for (const maxCalls of [0, 129, '8'])
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
  const initialRetry = { autoRefusalRetryEnabled: true, autoRefusalMaxRetries: 2 };
  expect((await app.inject(url)).json()).toEqual({ revision: 0, ...initial, ...initialRetry });
  const before = createFixtureChat(app.store, 'Chat before saving defaults');
  expect(before.settings).toEqual(initial);
  const chosen = { maxCalls: 128, storyUi: true, storyUiStyle: 'theme:custom-theme' };
  const chosenRetry = { autoRefusalRetryEnabled: false, autoRefusalMaxRetries: 5 };
  const put = (expectedRevision: number, settings: Record<string, unknown>) =>
    app.inject({ method: 'PUT', url, payload: { expectedRevision, ...settings } });
  for (const invalid of [
    { ...chosen, maxCalls: 129 },
    { ...chosen, maxCalls: '128' },
    { ...chosen, storyUi: 'true' },
    { ...chosen, storyUiStyle: undefined },
    { ...chosen, autoTranslate: true },
    { ...chosen, autoRefusalMaxRetries: 6 },
    { ...chosen, autoRefusalRetryEnabled: 'yes' },
  ])
    expect((await put(0, invalid)).statusCode).toBe(400);
  expect((await app.inject(url)).json().revision).toBe(0);
  const overLimit = await app.inject({
    method: 'PATCH',
    url: `/api/chats/${before.id}/settings`,
    payload: { expectedSettingsRevision: before.settingsRevision, maxCalls: 129 },
  });
  expect(overLimit.statusCode).toBe(400);
  const saved = await put(0, { ...chosen, ...chosenRetry });
  expect(saved.statusCode).toBe(200);
  expect(saved.json()).toEqual({ revision: 1, ...chosen, ...chosenRetry });
  expect((await put(0, { ...initial, ...initialRetry })).statusCode).toBe(409);
  expect((await app.inject(url)).json()).toEqual({ revision: 1, ...chosen, ...chosenRetry });
  expect(app.store.chat(before.id).settings).toEqual(initial);
  expect(app.store.chat(before.id).settingsRevision).toBe(before.settingsRevision);
  expect((await app.inject('/api/auto-translation-defaults')).json()).toEqual({
    revision: 0,
    autoTranslate: false,
    translationLanguage: 'ko',
  });

  await app.close();
  owned.pop();
  const reopened = await createApp(options);
  owned.push({ app: reopened, path });
  expect((await reopened.inject(url)).json()).toEqual({ revision: 1, ...chosen, ...chosenRetry });
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
  expect((await get()).json()).toEqual({
    revision: 0,
    autoTranslate: false,
    translationLanguage: 'ko',
  });
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
  expect((await put(0, true)).json()).toEqual({
    revision: 1,
    autoTranslate: true,
    translationLanguage: 'ko',
  });
  expect((await put(0, false)).statusCode).toBe(409);
  expect((await put(1, 'yes')).statusCode).toBe(400);
  expect(app.store.chat(inherit.id).settings.autoTranslate).toBeUndefined();
  expect(reserve(explicitOff.id).snapshot.settings.autoTranslate).toBe(false);
  expect(reserve(explicitOn.id).snapshot.settings.autoTranslate).toBe(true);
  const inheritNext = createFixtureChat(app.store, 'New inherited chat');
  const after = reserve(inheritNext.id);
  expect(after.snapshot.settings.autoTranslate).toBe(true);
  expect((await put(1, false)).json()).toEqual({
    revision: 2,
    autoTranslate: false,
    translationLanguage: 'ko',
  });
  expect(app.store.run(after.id).snapshot.settings.autoTranslate).toBe(true);
  expect(app.store.run(before.id).snapshot.settings.autoTranslate).toBe(false);
  await app.close();
  owned.pop();
  const restarted = await createApp(options);
  owned.push({ app: restarted, path });
  expect(
    (await restarted.inject({ method: 'GET', url: '/api/auto-translation-defaults' })).json()
  ).toEqual({ revision: 2, autoTranslate: false, translationLanguage: 'ko' });
  expect(restarted.store.chat(inherit.id).settings.autoTranslate).toBeUndefined();
});

test('automatic translation skips writing already in the translation language and leaves manual translation available', async () => {
  const path = mkdtempSync(join(tmpdir(), 'uimori-auto-translation-language-'));
  const app = await createApp({
    dbPath: join(path, 'app.sqlite'),
    buildId: 'auto-translation-language-test',
    testMode: true,
    codex: { enabled: false },
  });
  owned.push({ app, path });
  const korean =
    '비가 그친 골목에는 아직 물웅덩이가 남아 있었다. 서연은 우산을 접으며 가게 문을 밀었다. "늦었네." 카운터 뒤에서 민호가 고개도 들지 않고 말했다.';
  const english =
    'The rain had stopped, but the alley still held its puddles. Seoyeon folded her umbrella and pushed the shop door open without a word.';
  const write = (text: string) => {
    const created = createFixtureChat(app.store, 'Automatic translation language');
    app.store.settings(created.id, created.settingsRevision, {
      ...created.settings,
      autoTranslate: true,
    });
    const chat = app.store.chat(created.id);
    const profile = app.store.product.snapshot(chat.id);
    const run = app.store.createRun(
      chat.id,
      {
        request: 'Synthetic request',
        expectedRevision: chat.headRevision,
        expectedSettingsRevision: chat.settingsRevision,
        idempotencyKey: randomUUID(),
      },
      (selected) => ({
        chatId: chat.id,
        parentRevision: selected.headRevision,
        settingsRevision: selected.settingsRevision,
        settings: selected.settings,
        request: 'Synthetic request',
        history: app.store.history(selected.headRevision),
        resources: app.store.product.resources(chat.id, profile),
        profile,
      })
    ).run;
    app.store.startRun(run.id);
    const source = app.store.completeRun(run.id, text, {
      modelCalls: 1,
      inputTokens: 1,
      outputTokens: 1,
      costUsd: null,
    });
    return {
      source,
      jobs: () => app.store.detail(chat.id).jobs.filter((job) => job.kind === 'translation'),
    };
  };
  const put = (payload: Record<string, unknown>) =>
    app.inject({ method: 'PUT', url: '/api/auto-translation-defaults', payload });

  const skipped = write(korean);
  expect(skipped.jobs()).toEqual([]);
  expect(requestTranslation(app.store, skipped.source.id).status).toBe('queued');
  expect(skipped.jobs()).toHaveLength(1);
  expect(write(english).jobs()).toMatchObject([{ status: 'queued' }]);

  expect(
    (await put({ expectedRevision: 0, autoTranslate: false, translationLanguage: 'fr' })).statusCode
  ).toBe(400);
  expect(
    (await put({ expectedRevision: 0, autoTranslate: false, translationLanguage: 'en' })).json()
  ).toEqual({ revision: 1, autoTranslate: false, translationLanguage: 'en' });
  expect(write(english).jobs()).toEqual([]);
  expect(write(korean).jobs()).toHaveLength(1);

  expect(
    (await put({ expectedRevision: 1, autoTranslate: false, translationLanguage: null })).json()
  ).toEqual({ revision: 2, autoTranslate: false, translationLanguage: null });
  expect(write(english).jobs()).toHaveLength(1);
  expect(write(korean).jobs()).toHaveLength(1);
});
