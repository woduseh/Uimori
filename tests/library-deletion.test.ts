import { createFixtureChat, injectWithFixtureBot } from './fixtures/chat.js';
import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import Fastify from 'fastify';
import { createAgentCollaboration, createAgentDefinition } from '../core/agent-collaboration.js';
import { createDefaultPromptProgram } from '../core/prompt-defaults.js';
import { promptWorkspace, updatePromptWorkspace } from '../server/prompt-workspace.js';
import { productRoutes } from '../server/product-routes.js';
import { Store } from '../server/store.js';
import {
  deleteLibraryItem,
  libraryDeletionImpact,
  libraryDeletionRoutes,
  type LibraryKind,
} from '../server/library-deletion.js';

const owned: { directory: string; store: Store }[] = [];
function database() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-deletion-'));
  const store = new Store(join(directory, 'test.sqlite'));
  owned.push({ directory, store });
  return store;
}
afterEach(() => {
  for (const { directory, store } of owned.splice(0)) {
    store.close();
    const target = resolve(directory),
      within = relative(resolve(tmpdir()), target);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(target).startsWith('uimori-deletion-')
    )
      throw new Error('Unsafe cleanup');
    rmSync(target, { recursive: true, force: true });
  }
});
const content = (title = 'Synthetic', relatedIds: string[] = []) => ({
  kind: 'module',
  title,
  description: '',
  text: 'Synthetic module',
  loading: 'pinned',
  relatedIds,
});

test('removes library visibility while preserving every revision and enforcing CAS', () => {
  const s = database(),
    a = s.product.content(content()),
    b = s.product.content(content('Keep'));
  const changed = s.product.content({ ...content('Changed'), expectedRevision: 1 }, a.id);
  expect(() => deleteLibraryItem(s, 'content', a.id, { expectedRevision: 1 })).toThrow(
    '항목이 변경'
  );
  expect(libraryDeletionImpact(s, 'content', a.id)).toMatchObject({ canDelete: true, revision: 2 });
  expect(deleteLibraryItem(s, 'content', a.id, { expectedRevision: changed.revision })).toEqual({
    deleted: true,
    id: a.id,
  });
  expect(s.db.prepare('SELECT * FROM versions WHERE id=?').all(a.id)).toHaveLength(2);
  expect(s.product.all('content').some((item) => item.id === a.id)).toBe(false);
  expect(s.product.get('content', a.id, 1)).toEqual(a);
  expect(s.product.get('content', b.id)).toEqual(b);
  expect(() => deleteLibraryItem(s, 'content', a.id, { expectedRevision: 2 })).toThrow('not found');
});

test('historical and current content references do not block removing a library entry', () => {
  const s = database(),
    module = s.product.content(content()),
    owner = s.product.content(content('Owner', [module.id]));
  s.product.content({ ...content('Unlinked now'), expectedRevision: 1 }, owner.id);
  const history = s.db.prepare('SELECT * FROM versions ORDER BY kind,id,revision').all();
  expect(libraryDeletionImpact(s, 'content', module.id)).toMatchObject({
    canDelete: true,
    blockers: [],
  });
  deleteLibraryItem(s, 'content', module.id, { expectedRevision: 1 });
  expect(s.db.prepare('SELECT * FROM versions ORDER BY kind,id,revision').all()).toEqual(history);
  expect(s.product.get('content', owner.id, 1)).toEqual(owner);
});

test('prompt copies and chat contents survive preset deletion', () => {
  const s = database(),
    prompt = s.product.promptPreset({ title: 'Prompt', role: 'main', text: 'Write' });
  const combination = s.product.promptCombination({
    title: 'Options',
    role: 'main',
    values: {},
  });
  const chat = createFixtureChat(s, 'Synthetic');
  const before = s.product.profile(chat.id);
  deleteLibraryItem(s, 'prompt-preset', prompt.id, { expectedRevision: 1 });
  deleteLibraryItem(s, 'prompt-combination', combination.id, { expectedRevision: 1 });
  expect(s.product.profile(chat.id)).toEqual(before);
  expect(s.product.get('prompt-preset', prompt.id, 1)).toEqual(prompt);
  expect(s.product.get('prompt-combination', combination.id, 1)).toEqual(combination);
});

test('connection deletion revokes future sends and hides dependent models while preserving active diagnostics', () => {
  const s = database(),
    c = s.product.connection({
      title: 'Fixture',
      protocol: 'openai-chat-v1',
      endpoint: 'http://127.0.0.1:9999/v1',
      enabled: true,
    });
  const m = s.product.model({
    title: 'Model',
    connectionId: c.id,
    modelId: 'synthetic',
    maxOutputTokens: 100,
    temperature: null,
  });
  s.db
    .prepare('INSERT INTO provider_connection_tests VALUES(?,?,?,?,?,?,?)')
    .run('test', 'key', m.id, 1, 'running', null, JSON.stringify({ model: m, connection: c }));
  const before = s.db.prepare('SELECT * FROM provider_connection_tests').all();
  expect(libraryDeletionImpact(s, 'connection', c.id)).toMatchObject({
    canDelete: true,
    blockers: [],
  });
  deleteLibraryItem(s, 'connection', c.id, { expectedRevision: 1 });
  expect(s.product.get('connection', c.id)).toMatchObject({ enabled: false, revision: 2 });
  expect(s.product.all('model')).toEqual([]);
  expect(s.product.get('model', m.id)).toEqual(m);
  expect(s.db.prepare('SELECT * FROM provider_connection_tests').all()).toEqual(before);
});

test('all supported kinds expose DELETE and read-only impact routes with strict request validation', async () => {
  const s = database(),
    app = Fastify();
  libraryDeletionRoutes(app, s);
  const routes: Partial<Record<LibraryKind, string>> = {
    content: 'content',
    'prompt-preset': 'prompt-presets',
    'prompt-combination': 'prompt-combinations',
  };
  try {
    for (const [kind, path] of Object.entries(routes)) {
      const item =
        kind === 'content'
          ? s.product.content(content('Synthetic route module'))
          : kind === 'prompt-preset'
            ? s.product.promptPreset({
                title: 'Synthetic route prompt',
                role: 'main',
                text: 'Write.',
              })
            : (() => {
                return s.product.promptCombination({
                  title: 'Synthetic route combination',
                  role: 'main',
                  values: {},
                });
              })();
      expect(
        (
          await injectWithFixtureBot(app, {
            method: 'GET',
            url: `/api/${path}/${item.id}/deletion-impact`,
          })
        ).json()
      ).toMatchObject({ canDelete: true });
      expect(
        (
          await injectWithFixtureBot(app, {
            method: 'DELETE',
            url: `/api/${path}/${item.id}`,
            payload: {},
          })
        ).statusCode
      ).toBe(400);
      expect(
        (
          await injectWithFixtureBot(app, {
            method: 'DELETE',
            url: `/api/${path}/${item.id}`,
            payload: { expectedRevision: 1, force: true },
          })
        ).statusCode
      ).toBe(400);
      expect(
        (
          await injectWithFixtureBot(app, {
            method: 'DELETE',
            url: `/api/${path}/${item.id}`,
            payload: { expectedRevision: 1 },
          })
        ).statusCode
      ).toBe(200);
    }
  } finally {
    await app.close();
  }
});

test('active captured work survives library deletion with unchanged snapshots and archive restore', () => {
  const s = database(),
    chat = createFixtureChat(s, 'Synthetic frozen run');
  const c = s.product.connection({
    title: 'Fixture',
    protocol: 'openai-chat-v1',
    endpoint: 'http://127.0.0.1:9999/v1',
    enabled: true,
  });
  const m = s.product.model({
    title: 'Model',
    connectionId: c.id,
    modelId: 'synthetic',
    maxOutputTokens: 100,
    temperature: null,
  });
  const p = s.product.profile(chat.id);
  s.product.updateProfile(chat.id, {
    expectedRevision: p.revision,
    attachments: [],
    personaReference: p.personaReference,
    routes: { ...p.routes, main: { id: m.id } },
    image: false,
  });
  const captured = s.product.snapshot(chat.id)!;
  const run = s.createRun(
    chat.id,
    {
      request: 'Synthetic',
      expectedRevision: null,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: 'deletion-snapshot',
    },
    (current) => ({
      chatId: chat.id,
      parentRevision: null,
      settingsRevision: current.settingsRevision,
      settings: current.settings,
      request: 'Synthetic',
      history: [],
      resources: s.product.resources(chat.id, captured),
      profile: captured,
    })
  ).run;
  const current = s.product.profile(chat.id);
  s.product.updateProfile(chat.id, {
    expectedRevision: current.revision,
    attachments: [],
    personaReference: current.personaReference,
    routes: p.routes,
    image: false,
  });
  expect(libraryDeletionImpact(s, 'model', m.id)).toMatchObject({ canDelete: true, blockers: [] });
  const frozen = s.run(run.id).snapshot;
  deleteLibraryItem(s, 'model', m.id, { expectedRevision: 1 });
  deleteLibraryItem(s, 'connection', c.id, { expectedRevision: 1 });
  expect(s.run(run.id).snapshot).toEqual(frozen);
  expect(s.run(run.id).status).toBe(run.status);
  s.finishRun(run.id, 'cancelled', 'Synthetic cancellation');
  const target = database();
  expect(target.product.import(s.product.export())).toEqual({ restored: true, chats: 1 });
  expect(target.run(run.id).snapshot.profile?.models.main?.id).toBe(m.id);
  expect(target.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

test('deleting a bot preserves existing chat ownership and attachments but public library reads become unavailable', async () => {
  const s = database();
  const chat = createFixtureChat(s, 'Keep this chat');
  const organization = s.db
    .prepare('SELECT * FROM chat_organization WHERE chat_id=?')
    .get(chat.id) as { bot_id: string };
  const bot = s.product.get<{ id: string; revision: number }>('content', organization.bot_id);
  const profile = s.product.profile(chat.id);
  const app = Fastify();
  productRoutes(app, s, { approvedOrigins: [], publish: () => {} });
  try {
    deleteLibraryItem(s, 'content', bot.id, { expectedRevision: bot.revision });
    expect(s.chat(chat.id)).toEqual(chat);
    expect(s.product.profile(chat.id)).toEqual(profile);
    expect(s.db.prepare('SELECT * FROM chat_organization WHERE chat_id=?').get(chat.id)).toEqual(
      organization
    );
    expect(s.product.get('content', bot.id, bot.revision)).toEqual(bot);
    for (const url of [
      `/api/content/${bot.id}`,
      `/api/revisions/content/${bot.id}/${bot.revision}`,
    ])
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
  } finally {
    await app.close();
  }
});

test.each(['model', 'connection'] as const)(
  'deleting %s clears refusal selection and disables dedicated advice without substituting the main model',
  (kind) => {
    const store = database(),
      chat = createFixtureChat(store, 'Keep main independent');
    const connection = (title: string) =>
      store.product.connection({
        title,
        protocol: 'fixture-sse-v1',
        endpoint: 'http://127.0.0.1:9',
        enabled: true,
      });
    const mainConnection = connection('Main'),
      advisorConnection = connection('Advisor');
    const model = (connectionId: string, title: string) =>
      store.product.model({
        title,
        connectionId,
        modelId: 'fixture',
        maxOutputTokens: 1024,
        temperature: null,
      });
    const main = model(mainConnection.id, 'Main'),
      advisor = model(advisorConnection.id, 'Advisor');
    const profile = store.product.profile(chat.id);
    store.product.updateProfile(chat.id, {
      expectedRevision: profile.revision,
      attachments: profile.attachments,
      routes: { ...profile.routes, main: { id: main.id } },
      image: false,
    });
    const program = createDefaultPromptProgram('Main instructions');
    program.collaboration = {
      ...createAgentCollaboration(),
      enabled: true,
      agents: [{ ...createAgentDefinition('character', 'advisor'), model: { id: advisor.id } }],
    };
    const before = updatePromptWorkspace(store, {
      expectedRevision: 1,
      main: { title: 'Current', program, values: {} },
      translationPolicy: { refusalModel: { id: advisor.id }, maxRetries: 1, maxCalls: 16 },
    });
    const frozen = store.product.snapshot(chat.id);
    const run = store.createRun(
      chat.id,
      {
        request: 'Synthetic',
        expectedRevision: null,
        expectedSettingsRevision: chat.settingsRevision,
        idempotencyKey: 'deletion-advisor',
      },
      () => ({
        chatId: chat.id,
        parentRevision: null,
        settingsRevision: chat.settingsRevision,
        settings: chat.settings,
        request: 'Synthetic',
        history: [],
        resources: store.product.resources(chat.id, frozen),
        profile: frozen,
      })
    ).run;
    const target = kind === 'model' ? advisor : advisorConnection;
    deleteLibraryItem(store, kind, target.id, { expectedRevision: target.revision });
    const after = promptWorkspace(store);
    expect(after.revision).toBe(before.revision + 1);
    expect(after.translationPolicy.refusalModel).toBeNull();
    expect(after.main.program.collaboration).toMatchObject({
      enabled: false,
      agents: [{ id: 'advisor', model: null }],
    });
    expect(store.run(run.id).snapshot.profile).toEqual(frozen);
    const next = store.product.snapshot(chat.id);
    expect(next.models.main!.id).toBe(main.id);
    expect(next).not.toHaveProperty('collaborationModels');
  }
);
