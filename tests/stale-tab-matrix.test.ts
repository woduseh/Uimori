import { readdirSync, readFileSync } from 'node:fs';
import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { z } from 'zod/v4';
import {
  allEndpoints,
  type AppErrorCode,
  type Endpoint,
  endpointRequest,
  isAppErrorCode,
} from '#contracts';
import * as contracts from '#contracts';
import { allOperations } from '#contracts/operations';
import * as operations from '#contracts/operations';
import type { Content, Connection, ModelPreset } from '../core/product.js';
import { DEFAULT_PUSH_PREFERENCES } from '../core/push.js';
import { emptyTheme } from '../core/themes.js';
import { createApp, type App } from '../server/app.js';
import { deleteChat } from '../server/chat-deletion.js';
import { deleteFont, registerFont } from '../server/fonts.js';
import { deleteLibraryItem, type LibraryKind } from '../server/library-deletion.js';
import { promptWorkspace } from '../server/prompt-workspace.js';
import { addBookmark } from '../server/reading-state.js';
import { saveResource } from '../server/resource-service.js';
import { deletePalette, deleteTheme, savePalette, saveTheme } from '../server/themes.js';
import { createFixtureChat, fixtureBotInput } from './fixtures/chat.js';
import { completedSource } from './fixtures/illustration.js';
import { softDeleteLibraryItem } from './fixtures/soft-delete.js';
import { createTestDirectory } from './fixtures/test-directory.js';

type Domain = keyof typeof allEndpoints;
type Input = Record<string, unknown>;
type Answer = { status: number; code: AppErrorCode };
type Probe = { input: Input; control?: Input };
type Case = {
  when: string;
  arrange: () => Probe | Promise<Probe>;
  answer: Answer;
  reason?: string;
  targetRevision?: true;
};
type Entry = { cases: Case[] } | { exempt: string };

const origin = 'https://story.example.test';
const accessToken = 'synthetic-stale-tab-access-key-32-chars';
const revisionField = /^expected[A-Z]\w*$|^\w+Revision$/u;
const targetField = /^(?:id|\w+Id)$/u;
const conflict: Answer = { status: 409, code: 'REVISION_CONFLICT' };
const deleted: Answer = { status: 404, code: 'LIBRARY_ITEM_DELETED' };
const same = (left: Answer, right: Answer) =>
  left.status === right.status && left.code === right.code;

let app: App;
let headers: Record<string, string>;
const directory = createTestDirectory('uimori-stale-tab-');

beforeAll(async () => {
  app = await createApp({
    dbPath: join(directory.directory, 'app.sqlite'),
    buildId: 'stale-tab-matrix',
    accessToken,
    publicOrigin: origin,
    pushSender: async () => ({ status: 201 }),
  });
  const base = { host: 'story.example.test', origin };
  const session = await app.inject({
    method: 'POST',
    url: '/api/session',
    headers: base,
    payload: { token: accessToken },
  });
  expect(session.statusCode, session.body).toBe(200);
  headers = { ...base, cookie: String(session.headers['set-cookie']) };
});

afterAll(async () => {
  await app?.close();
  directory.remove();
});

async function call(endpoint: Endpoint, input: Input) {
  const { path, body } = endpointRequest(endpoint, input);
  const response = await app.inject({
    method: endpoint.method,
    url: `/api${path}`,
    headers,
    ...(body === undefined ? {} : { payload: body }),
  });
  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
}

async function read<T = Record<string, unknown>>(endpoint: Endpoint, input: Input = {}) {
  const response = await call(endpoint, input);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body as T;
}

const store = () => app.store;
const removed = <T extends { id: string; revision: number }>(kind: LibraryKind, item: T) =>
  softDeleteLibraryItem(store(), kind, item).revision;
const purged = (kind: LibraryKind, item: { id: string; revision: number }) => {
  deleteLibraryItem(store(), kind, item.id, { expectedRevision: item.revision });
  expect(store().product.isHidden(kind, item.id), `${kind} is purged`).toBe(false);
  expect(store().product.isLive(kind, item.id), `${kind} is purged`).toBe(false);
};
const bot = () => store().product.content(fixtureBotInput('Stale tab bot')) as Content;
const preset = () =>
  store().product.promptPreset({ title: 'Stale tab preset', role: 'main', text: 'Write' }) as {
    id: string;
    revision: number;
  };
const combination = (owner?: { id: string; revision: number }) =>
  store().product.promptCombination({
    ...(owner
      ? { owner: { kind: 'preset', id: owner.id }, expectedRevision: owner.revision }
      : { workspaceRevision: promptWorkspace(store()).revision }),
    title: 'Stale tab options',
    role: 'main',
    values: {},
  }) as { id: string; revision: number };
const connection = (endpoint = 'http://127.0.0.1:9999/v1') =>
  store().product.connection({
    title: 'Stale tab connection',
    protocol: 'openai-chat-v1',
    endpoint,
    enabled: true,
  }) as Connection;
const model = () =>
  store().product.model({
    title: 'Stale tab model',
    connectionId: connection().id,
    modelId: 'synthetic',
    maxOutputTokens: 100,
    temperature: null,
  }) as ModelPreset;
const theme = () => saveTheme(store(), emptyTheme('Stale tab theme'));
const paletteModel = {
  title: 'Stale tab palette',
  description: '',
  colors: { light: {}, dark: {} },
};
const palette = () => savePalette(store(), paletteModel);
const fontBytes = readFileSync(join(import.meta.dirname, 'fixtures/appearance-synthetic.ttf'));
const font = (padding: number) =>
  registerFont(store(), {
    title: 'Stale tab font',
    bytes: Buffer.concat([fontBytes, Buffer.alloc(padding)]),
  });
const themeRevision = async () =>
  (await read<{ preferences: { revision: number } }>(allEndpoints.appearance.readThemes))
    .preferences.revision;
const organization = () =>
  read<{ revision: number; folders: { id: string; title: string }[] }>(
    allEndpoints.library.readOrganization
  );
async function removedFolders(count: number) {
  const ids: string[] = [];
  for (let index = 0; index < count; index++) {
    const title = `Stale tab folder ${randomUUID()}`;
    const created = await read<{ folders: { id: string; title: string }[] }>(
      allEndpoints.library.createFolder,
      { expectedRevision: (await organization()).revision, category: 'bot', title }
    );
    ids.push(created.folders.find((folder) => folder.title === title)!.id);
  }
  const kept = await organization();
  const gone = ids.pop()!;
  await read(allEndpoints.library.deleteFolder, { id: gone, expectedRevision: kept.revision });
  return { gone, kept: ids, revision: (await organization()).revision };
}
function scene(title: string) {
  const chat = createFixtureChat(store(), title);
  return { chat, source: completedSource(store(), chat.id) };
}
function deletedChat() {
  const { chat, source } = scene('Stale tab chat');
  deleteChat(store(), chat.id, {});
  return { chatId: chat.id, sourceId: source.id };
}
async function removedBookmark() {
  const { chat, source } = scene('Stale tab bookmark');
  const mark = addBookmark(store(), chat.id, {
    id: randomUUID(),
    target: { sourceId: source.id, representation: 'original' },
    title: 'Mark',
    note: '',
    quote: '',
  });
  await read(allEndpoints['personal-workspace'].deleteBookmark, {
    id: mark.id,
    expectedRevision: mark.revision,
  });
  return mark;
}
function pushSubscription() {
  const key = createECDH('prime256v1');
  key.generateKeys();
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
    keys: {
      p256dh: key.getPublicKey().toString('base64url'),
      auth: randomBytes(16).toString('base64url'),
    },
  };
}
async function removedPushDevice() {
  const endpoints = allEndpoints['personal-workspace'];
  const clientId = randomUUID();
  await read(endpoints.preparePush, { clientId });
  await read(endpoints.subscribePush, {
    clientId,
    expectedRevision: 0,
    subscription: pushSubscription(),
    preferences: DEFAULT_PUSH_PREFERENCES,
  });
  await read(endpoints.unsubscribePush, { clientId, expectedRevision: 1 });
  return clientId;
}
async function modelWorkspace() {
  return read<{ revision: number; routes: unknown; translationPolicy: unknown }>(
    allEndpoints.prompts.readModelWorkspace
  );
}
const singletonExemption =
  'A singleton setting with no target to delete; its input is fully checked by the operation schema before the revision, so a stale tab meets 409 for any value the schema admits.';
const jevExemption =
  'The JEV key and settings are one singleton with no target to delete; the operation schema checks the whole input and the handler checks the revision before the stored key.';
const fontReason =
  'Fonts are not library items: a removed font answers the catalogued FONT_NOT_FOUND, whose text asks for a reload of the font list.';

const libraryDeletion = (
  [
    ['deleteContent', 'content', bot],
    ['deletePromptPreset', 'prompt-preset', preset],
    ['deletePromptCombination', 'prompt-combination', () => combination()],
    ['deleteConnection', 'connection', () => connection()],
    ['deleteModelPreset', 'model', model],
  ] as const
).map(([key, kind, create]): [string, Entry] => [
  `deletion.${key}`,
  {
    cases: [
      {
        when: `a ${kind} another tab deleted`,
        arrange: () => {
          const item = create();
          return { input: { id: item.id, expectedRevision: removed(kind, item) } };
        },
        answer: conflict,
        targetRevision: true,
      },
    ],
  },
]);

const matrix: Record<string, Entry> = {
  'appearance.selectFonts': {
    cases: [
      {
        when: 'a font another tab removed',
        arrange: async () => {
          const live = font(1);
          const gone = font(2);
          deleteFont(store(), gone.id);
          const { revision } = await read<{ revision: number }>(
            allEndpoints.appearance.readFontPreferences
          );
          const choice = { expectedRevision: revision, readerFontId: null };
          return {
            input: { ...choice, appFontId: gone.id },
            control: { ...choice, appFontId: live.id },
          };
        },
        answer: { status: 404, code: 'FONT_NOT_FOUND' },
        reason: fontReason,
      },
    ],
  },
  'appearance.deleteFont': {
    cases: [
      {
        when: 'a font another tab removed',
        arrange: () => {
          const gone = font(3);
          deleteFont(store(), gone.id);
          return { input: { id: gone.id } };
        },
        answer: { status: 404, code: 'FONT_NOT_FOUND' },
        reason: fontReason,
      },
    ],
  },
  'appearance.selectTheme': {
    cases: [
      {
        when: 'a theme another tab deleted',
        arrange: async () => {
          const live = theme();
          const gone = theme();
          deleteTheme(store(), gone.id, gone.revision);
          const choice = { dimension: 'theme', scope: 'global' };
          const expectedRevision = await themeRevision();
          return {
            input: { ...choice, themeId: gone.id, expectedRevision },
            control: { ...choice, themeId: live.id, expectedRevision },
          };
        },
        answer: deleted,
      },
      {
        when: 'a palette another tab deleted',
        arrange: async () => {
          const live = palette();
          const gone = palette();
          deletePalette(store(), gone.id, gone.revision);
          const choice = { dimension: 'palette', scope: 'global' };
          const expectedRevision = await themeRevision();
          return {
            input: { ...choice, paletteId: gone.id, expectedRevision },
            control: { ...choice, paletteId: live.id, expectedRevision },
          };
        },
        answer: deleted,
      },
      {
        when: 'a bot scope another tab deleted',
        arrange: async () => {
          const live = bot();
          const gone = bot();
          removed('content', gone);
          const choice = { dimension: 'theme', scope: 'bot', themeId: null };
          const expectedRevision = await themeRevision();
          return {
            input: { ...choice, targetId: gone.id, expectedRevision },
            control: { ...choice, targetId: live.id, expectedRevision },
          };
        },
        answer: conflict,
      },
    ],
  },
  'appearance.selectThemeBackground': {
    cases: [
      {
        when: 'a bot scope another tab deleted',
        arrange: async () => {
          const live = bot();
          const gone = bot();
          removed('content', gone);
          const choice = { scope: 'bot', background: null };
          const expectedRevision = await themeRevision();
          return {
            input: { ...choice, targetId: gone.id, expectedRevision },
            control: { ...choice, targetId: live.id, expectedRevision },
          };
        },
        answer: conflict,
      },
    ],
  },
  'appearance.deleteTheme': {
    cases: [
      {
        when: 'a theme another tab deleted',
        arrange: () => {
          const item = theme();
          deleteTheme(store(), item.id, item.revision);
          return { input: { id: item.id, expectedRevision: item.revision } };
        },
        answer: conflict,
        targetRevision: true,
      },
    ],
  },
  'appearance.updatePalette': {
    cases: [
      {
        when: 'a palette another tab deleted',
        arrange: () => {
          const item = palette();
          deletePalette(store(), item.id, item.revision);
          return { input: { id: item.id, model: {}, expectedRevision: item.revision } };
        },
        answer: conflict,
        targetRevision: true,
      },
    ],
  },
  'appearance.deletePalette': {
    cases: [
      {
        when: 'a palette another tab deleted',
        arrange: () => {
          const item = palette();
          deletePalette(store(), item.id, item.revision);
          return { input: { id: item.id, expectedRevision: item.revision } };
        },
        answer: conflict,
        targetRevision: true,
      },
    ],
  },
  ...Object.fromEntries(libraryDeletion),
  'library.createFolder': { exempt: singletonExemption },
  'library.updateFolder': {
    cases: [
      {
        when: 'a folder another tab deleted',
        arrange: async () => {
          const { gone, kept, revision } = await removedFolders(2);
          const rename = { expectedRevision: revision, title: 'Renamed' };
          return { input: { ...rename, id: gone }, control: { ...rename, id: kept[0] } };
        },
        answer: conflict,
      },
      {
        when: 'an order anchor another tab deleted',
        arrange: async () => {
          const { gone, kept, revision } = await removedFolders(3);
          const order = { id: kept[0], expectedRevision: revision };
          return {
            input: { ...order, beforeFolderId: gone },
            control: { ...order, beforeFolderId: kept[1] },
          };
        },
        answer: conflict,
      },
    ],
  },
  'library.deleteFolder': {
    cases: [
      {
        when: 'a folder another tab deleted',
        arrange: async () => {
          const { gone, kept, revision } = await removedFolders(2);
          return {
            input: { id: gone, expectedRevision: revision },
            control: { id: kept[0], expectedRevision: revision },
          };
        },
        answer: conflict,
      },
    ],
  },
  'library.moveItems': {
    cases: [
      {
        when: 'a destination folder another tab deleted',
        arrange: async () => {
          const item = bot();
          const { gone, kept, revision } = await removedFolders(2);
          const move = {
            expectedRevision: revision,
            category: 'bot',
            items: [{ kind: 'content', id: item.id }],
          };
          return { input: { ...move, folderId: gone }, control: { ...move, folderId: kept[0] } };
        },
        answer: conflict,
      },
      {
        when: 'an item another tab deleted',
        arrange: async () => {
          const live = bot();
          const gone = bot();
          removed('content', gone);
          const move = {
            expectedRevision: (await organization()).revision,
            category: 'bot',
            folderId: null,
          };
          return {
            input: { ...move, items: [{ kind: 'content', id: gone.id }] },
            control: { ...move, items: [{ kind: 'content', id: live.id }] },
          };
        },
        answer: conflict,
      },
    ],
  },
  'personal-workspace.updateBackupSettings': { exempt: singletonExemption },
  'personal-workspace.readReadingPositions': {
    cases: [
      {
        when: 'a chat another tab deleted',
        arrange: () => ({ input: { chatId: deletedChat().chatId, clientId: randomUUID() } }),
        answer: deleted,
      },
    ],
  },
  'personal-workspace.saveReadingPosition': {
    cases: [
      {
        when: 'a chat another tab deleted',
        arrange: () => {
          const gone = deletedChat();
          const live = scene('Stale tab reading');
          const position = { clientId: randomUUID(), expectedRevision: 0 };
          const target = (sourceId: string) => ({ sourceId, representation: 'original' });
          return {
            input: { ...position, chatId: gone.chatId, target: target(gone.sourceId) },
            control: { ...position, chatId: live.chat.id, target: target(live.source.id) },
          };
        },
        answer: conflict,
      },
    ],
  },
  'personal-workspace.listBookmarks': {
    cases: [
      {
        when: 'a chat another tab deleted',
        arrange: () => ({ input: { chatId: deletedChat().chatId } }),
        answer: deleted,
      },
    ],
  },
  'personal-workspace.addBookmark': {
    cases: [
      {
        when: 'a chat another tab deleted',
        arrange: () => {
          const gone = deletedChat();
          return {
            input: {
              chatId: gone.chatId,
              id: randomUUID(),
              target: { sourceId: gone.sourceId, representation: 'original' },
              title: 'Mark',
            },
          };
        },
        answer: conflict,
      },
    ],
  },
  'personal-workspace.updateBookmark': {
    cases: [
      {
        when: 'a bookmark another tab deleted',
        arrange: async () => {
          const mark = await removedBookmark();
          return {
            input: { id: mark.id, expectedRevision: mark.revision, title: 'Edited', note: 'Kept' },
          };
        },
        answer: conflict,
        targetRevision: true,
      },
    ],
  },
  'personal-workspace.deleteBookmark': {
    cases: [
      {
        when: 'a bookmark another tab deleted',
        arrange: async () => {
          const mark = await removedBookmark();
          return { input: { id: mark.id, expectedRevision: mark.revision } };
        },
        answer: conflict,
        targetRevision: true,
      },
    ],
  },
  'personal-workspace.readPush': {
    exempt:
      'The client id is this browser’s own; reading a device another tab removed answers the push state without a device.',
  },
  'personal-workspace.preparePush': {
    exempt:
      'The client id is this browser’s own and preparing creates the server keys only; there is no device to have been removed.',
  },
  'personal-workspace.subscribePush': {
    cases: [
      {
        when: 'a device another tab unsubscribed',
        arrange: async () => ({
          input: {
            clientId: await removedPushDevice(),
            expectedRevision: 1,
            subscription: pushSubscription(),
            preferences: DEFAULT_PUSH_PREFERENCES,
          },
        }),
        answer: conflict,
        targetRevision: true,
      },
    ],
  },
  'personal-workspace.updatePush': {
    cases: [
      {
        when: 'a device another tab unsubscribed',
        arrange: async () => ({
          input: {
            clientId: await removedPushDevice(),
            expectedRevision: 1,
            preferences: DEFAULT_PUSH_PREFERENCES,
          },
        }),
        answer: conflict,
        targetRevision: true,
      },
    ],
  },
  'personal-workspace.unsubscribePush': {
    exempt:
      'Removing a device another tab already removed reaches the state the request asks for and holds nothing of the user’s, so it answers the current push state instead of a conflict.',
  },
  'personal-workspace.testPush': {
    cases: [
      {
        when: 'a device another tab unsubscribed',
        arrange: async () => ({ input: { clientId: await removedPushDevice() } }),
        answer: conflict,
      },
    ],
  },
  'personal-workspace.searchManuscripts': {
    cases: [
      {
        when: 'a chat another tab deleted',
        arrange: () => ({
          input: {
            query: 'lantern',
            kinds: ['original'],
            scope: 'chat',
            chatId: deletedChat().chatId,
          },
        }),
        answer: deleted,
      },
    ],
  },
  'prompts.readTemplate': {
    exempt:
      'Prompt templates are built in and cannot be deleted, so no tab can hold a template that is gone.',
  },
  'prompts.updateWorkspace': {
    cases: [
      {
        when: 'a stale revision with a prompt body the service refuses',
        arrange: async () => {
          const { revision } = await read<{ revision: number }>(allEndpoints.prompts.readWorkspace);
          return { input: { expectedRevision: revision + 1, main: 'not a prompt' } };
        },
        answer: conflict,
        targetRevision: true,
      },
    ],
  },
  'prompts.applyPreset': {
    cases: [
      {
        when: 'a preset another tab deleted',
        arrange: () => {
          const live = preset();
          const gone = preset();
          removed('prompt-preset', gone);
          const apply = { expectedRevision: promptWorkspace(store()).revision, role: 'main' };
          return {
            input: { ...apply, presetId: gone.id },
            control: { ...apply, presetId: live.id },
          };
        },
        answer: deleted,
      },
    ],
  },
  'prompts.applyCombination': {
    cases: [
      {
        when: 'a combination another tab deleted',
        arrange: () => {
          const live = combination();
          const gone = combination();
          removed('prompt-combination', gone);
          const apply = { expectedRevision: promptWorkspace(store()).revision, role: 'main' };
          return {
            input: { ...apply, combinationId: gone.id },
            control: { ...apply, combinationId: live.id },
          };
        },
        answer: deleted,
      },
    ],
  },
  'prompts.updateCombination': {
    cases: [
      {
        when: 'a combination another tab deleted',
        arrange: () => {
          const item = combination();
          return {
            input: {
              id: item.id,
              expectedRevision: removed('prompt-combination', item),
              sourceRevision: promptWorkspace(store()).revision,
              title: 'Edited',
              values: {},
            },
          };
        },
        answer: conflict,
        targetRevision: true,
      },
      {
        when: 'the owning preset another tab deleted',
        arrange: () => {
          const liveOwner = preset();
          const live = combination(liveOwner);
          const owner = preset();
          const item = combination(owner);
          removed('prompt-preset', owner);
          const edit = { title: 'Edited', values: {} };
          return {
            input: {
              ...edit,
              id: item.id,
              expectedRevision: item.revision,
              sourceRevision: owner.revision,
            },
            control: {
              ...edit,
              id: live.id,
              expectedRevision: live.revision,
              sourceRevision: liveOwner.revision,
            },
          };
        },
        answer: conflict,
      },
    ],
  },
  'prompts.updateModelWorkspace': {
    cases: [
      {
        when: 'a model another tab deleted',
        arrange: async () => {
          const live = model();
          const gone = model();
          removed('model', gone);
          const current = await modelWorkspace();
          const workspace = {
            expectedRevision: current.revision,
            translationPolicy: current.translationPolicy,
          };
          return {
            input: { ...workspace, routes: { main: { id: gone.id }, translation: null } },
            control: { ...workspace, routes: { main: { id: live.id }, translation: null } },
          };
        },
        answer: { status: 400, code: 'MODEL_SELECTION_UNAVAILABLE' },
        reason:
          'A model another tab deleted shares MODEL_SELECTION_UNAVAILABLE with a disabled model or connection: its text names both causes and asks for another model.',
      },
      {
        when: 'a judgment connection another tab deleted',
        arrange: async () => {
          const live = connection('https://api.openai.com/v1');
          const gone = connection('https://api.openai.com/v1');
          removed('connection', gone);
          const current = await modelWorkspace();
          const workspace = {
            expectedRevision: current.revision,
            routes: current.routes,
            translationPolicy: current.translationPolicy,
          };
          const judgment = (connectionId: string) => ({
            provider: 'openai',
            connectionId,
            modelId: 'gpt-6-luna',
            images: false,
          });
          return {
            input: { ...workspace, judgment: judgment(gone.id) },
            control: { ...workspace, judgment: judgment(live.id) },
          };
        },
        answer: deleted,
      },
    ],
  },
  'prompts.updateLoreContextDefaults': {
    cases: [
      {
        when: 'a stale revision with a value the service refuses',
        arrange: async () => {
          const endpoints = allEndpoints.prompts;
          const { revision, ...policy } = await read<{ revision: number }>(
            endpoints.readLoreContextDefaults
          );
          await read(endpoints.updateLoreContextDefaults, {
            ...policy,
            expectedRevision: revision,
          });
          return { input: { ...policy, expectedRevision: revision, maxRetainedTokens: -1 } };
        },
        answer: conflict,
        targetRevision: true,
      },
    ],
  },
  'providers.saveJevKey': { exempt: jevExemption },
  'providers.deleteJevKey': { exempt: jevExemption },
  'providers.updateJevSettings': { exempt: jevExemption },
  'providers.startJevTest': { exempt: jevExemption },
  'providers.startModelTest': {
    cases: [
      {
        when: 'a model another tab deleted',
        arrange: () => {
          const item = model();
          return {
            input: {
              id: item.id,
              expectedRevision: removed('model', item),
              idempotencyKey: randomUUID(),
            },
          };
        },
        answer: conflict,
        targetRevision: true,
      },
    ],
  },
  'providers.readConnectionTest': {
    exempt:
      'Connection test records are never deleted and their id comes from the answer that started the test, so no tab can hold one that is gone.',
  },
  'resourceEditors.readResource': {
    cases: [
      {
        when: 'content another tab deleted',
        arrange: () => {
          const item = bot();
          removed('content', item);
          return { input: { kind: 'content', id: item.id } };
        },
        answer: deleted,
      },
    ],
  },
  'resourceEditors.readPreviousResource': {
    cases: [
      {
        when: 'content another tab deleted after a save',
        arrange: () => {
          const item = bot();
          const { saved } = saveResource(store(), {
            kind: 'content',
            id: item.id,
            expectedRevision: item.revision,
            model: { ...fixtureBotInput('Stale tab bot, edited') },
          });
          removed('content', saved as { id: string; revision: number });
          return { input: { kind: 'content', id: item.id } };
        },
        answer: deleted,
      },
    ],
  },
  'resourceEditors.saveResource': {
    cases: [
      {
        when: 'content another tab deleted',
        arrange: () => {
          const item = bot();
          return {
            input: {
              kind: 'content',
              id: item.id,
              expectedRevision: removed('content', item),
              model: {},
            },
          };
        },
        answer: conflict,
        targetRevision: true,
      },
    ],
  },
  'resourceEditors.cloneResource': {
    cases: [
      {
        when: 'a source another tab deleted',
        arrange: () => {
          const item = bot();
          return {
            input: {
              kind: 'content',
              sourceId: item.id,
              expectedSourceRevision: removed('content', item),
              title: 'Copy',
            },
          };
        },
        answer: conflict,
        targetRevision: true,
      },
    ],
  },
  'resourceEditors.undoResource': {
    cases: [
      {
        when: 'content another tab deleted and the cleanup purged after a save',
        arrange: () => {
          const item = bot();
          const { saved } = saveResource(store(), {
            kind: 'content',
            id: item.id,
            expectedRevision: item.revision,
            model: { ...fixtureBotInput('Stale tab bot, edited') },
          });
          purged('content', saved as { id: string; revision: number });
          return { input: { kind: 'content', id: item.id, expectedRevision: saved.revision } };
        },
        answer: conflict,
        targetRevision: true,
      },
      {
        when: 'content another tab deleted after a save',
        arrange: () => {
          const item = bot();
          const { saved } = saveResource(store(), {
            kind: 'content',
            id: item.id,
            expectedRevision: item.revision,
            model: { ...fixtureBotInput('Stale tab bot, edited') },
          });
          const expectedRevision = removed('content', saved as { id: string; revision: number });
          return { input: { kind: 'content', id: item.id, expectedRevision } };
        },
        answer: conflict,
        targetRevision: true,
      },
    ],
  },
  'translation.saveAutoTranslationDefaults': { exempt: singletonExemption },
};

function fieldNames(schema: z.ZodType): string[] {
  const found = new Set<string>();
  const seen = new Set<unknown>();
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const internals = (value as { _zod?: { def?: Record<string, unknown>; innerType?: unknown } })
      ._zod;
    const def = internals?.def;
    if (!def) {
      for (const child of Object.values(value)) visit(child);
      return;
    }
    if (def.type === 'lazy') visit(internals.innerType);
    if (def.type === 'object')
      for (const [key, child] of Object.entries(def.shape as object)) {
        found.add(key);
        visit(child);
      }
    for (const [key, child] of Object.entries(def)) if (key !== 'shape') visit(child);
  };
  visit(schema);
  return [...found].sort();
}
const revisionFields = (schema: z.ZodType) =>
  fieldNames(schema).filter((name) => revisionField.test(name));
const targetFields = (schema: z.ZodType) =>
  fieldNames(schema).filter((name) => targetField.test(name));

const endpointEntries = Object.entries(allEndpoints).flatMap(([domain, endpoints]) =>
  Object.entries(endpoints).map(([key, endpoint]) => ({
    domain: domain as Domain,
    name: `${domain}.${key}`,
    endpoint: endpoint as Endpoint,
  }))
);
const operationFor = (domain: Domain, name: string) =>
  Object.values(allOperations[domain]).find((operation) => operation.name === name);
const inputOf = (name: string) => {
  const { domain, endpoint } = endpointEntries.find((item) => item.name === name)!;
  return operationFor(domain, endpoint.operation)!.input;
};

test('every endpoint names an operation of its own domain and every operation is served', () => {
  expect(Object.keys(allOperations).sort()).toEqual(Object.keys(allEndpoints).sort());
  for (const { domain, name, endpoint } of endpointEntries) {
    expect(endpoint.operation.startsWith(`${domain}.`), name).toBe(true);
    expect(
      operationFor(domain, endpoint.operation),
      `${name} → ${endpoint.operation}`
    ).toBeDefined();
  }
  const served = new Set(endpointEntries.map(({ endpoint }) => endpoint.operation));
  for (const operations of Object.values(allOperations))
    for (const operation of Object.values(operations))
      expect(served.has(operation.name), `${operation.name} has no endpoint`).toBe(true);
});

test('every endpoint and operation set the contracts export is in the registries', () => {
  const exported = (suffix: string, from: Record<string, unknown>, registry: object) => {
    const sets = Object.entries(from)
      .filter(([name]) => name.endsWith(suffix) && name !== `all${suffix}`)
      .map(([, value]) => value);
    expect(new Set(Object.values(registry))).toEqual(new Set(sets));
  };
  exported('Endpoints', contracts, allEndpoints);
  exported('Operations', operations, allOperations);
  const domains = readdirSync(join(import.meta.dirname, '../packages/contracts/src/domains'), {
    withFileTypes: true,
  }).filter((entry) => entry.isDirectory());
  expect(Object.keys(allEndpoints)).toHaveLength(domains.length);
});

test('the field walker reads through unions, refinements and nested objects', () => {
  const { appearance, library, resourceEditors, prompts } = allOperations;
  expect(revisionFields(appearance.selectTheme.input)).toEqual(['expectedRevision']);
  expect(revisionFields(library.moveItems.input)).toEqual(['expectedRevision']);
  expect(revisionFields(library.updateFolder.input)).toEqual(['expectedRevision']);
  expect(revisionFields(resourceEditors.cloneResource.input)).toEqual(['expectedSourceRevision']);
  expect(revisionFields(prompts.updateCombination.input)).toEqual([
    'expectedRevision',
    'sourceRevision',
  ]);
  expect(
    revisionFields(
      z.strictObject({
        expectedOrder: z.array(z.string()),
        nested: z.strictObject({ workspaceRevision: z.int() }),
        revision: z.int(),
        expectation: z.string(),
      })
    )
  ).toEqual(['expectedOrder', 'workspaceRevision']);
  expect(targetFields(allOperations['personal-workspace'].addBookmark.input)).toEqual([
    'chatId',
    'id',
    'sourceId',
  ]);
});

test('every endpoint that carries a revision or names a target has a stale-tab matrix entry', () => {
  const missing = endpointEntries
    .filter(({ name }) => {
      const input = inputOf(name);
      return revisionFields(input).length > 0 || targetFields(input).length > 0;
    })
    .map(({ name }) => name)
    .filter((name) => !Object.hasOwn(matrix, name));
  expect(
    missing,
    'Add an entry to the matrix in tests/stale-tab-matrix.test.ts for each endpoint listed: a case that deletes or hides the target and expects 409 REVISION_CONFLICT for a write or 404 LIBRARY_ITEM_DELETED for a read or selection, or { exempt: reason } when nothing can be deleted underneath it.'
  ).toEqual([]);
  const known = new Set(endpointEntries.map(({ name }) => name));
  expect(Object.keys(matrix).filter((name) => !known.has(name))).toEqual([]);
  for (const [name, entry] of Object.entries(matrix)) {
    if ('exempt' in entry) {
      expect(entry.exempt.length, name).toBeGreaterThan(20);
      continue;
    }
    for (const item of entry.cases) {
      const label = `${name} with ${item.when}`;
      expect(isAppErrorCode(item.answer.code), `${label}: ${item.answer.code}`).toBe(true);
      if (!same(item.answer, conflict) && !same(item.answer, deleted))
        expect(item.reason, `${label} answers ${item.answer.code} and needs a reason`).toBeTruthy();
    }
  }
});

const probes = Object.entries(matrix).flatMap(([name, entry]) =>
  'exempt' in entry ? [] : entry.cases.map((item) => ({ name, ...item }))
);

test.each(probes)('$name with $when answers $answer.code', async (item) => {
  const { endpoint } = endpointEntries.find((entry) => entry.name === item.name)!;
  const revisions = revisionFields(inputOf(item.name));
  const { input, control } = await item.arrange();
  if (revisions.length && !item.targetRevision)
    expect(control, 'a target reached through a shared revision needs a control').toBeDefined();
  const sent = Object.keys(input).filter((key) => revisions.includes(key));
  const stale = sent.filter((key) => typeof input[key] === 'number');
  if (!same(item.answer, conflict) && revisions.length)
    expect(stale, 'a numeric top-level revision to send one ahead').not.toEqual([]);
  if (!same(item.answer, conflict) && stale.length) {
    const bumped = Object.fromEntries(stale.map((key) => [key, Number(input[key]) + 1]));
    const first = await call(endpoint, { ...input, ...bumped });
    expect(first, 'a stale revision answers before the target lookup').toMatchObject({
      status: 409,
      body: { code: 'REVISION_CONFLICT' },
    });
  }
  const response = await call(endpoint, input);
  expect({ status: response.status, body: response.body }).toEqual({
    status: item.answer.status,
    body: { code: item.answer.code },
  });
  if (control) {
    for (const key of sent)
      expect(control[key], `the control sends the same ${key}`).toEqual(input[key]);
    const live = await call(endpoint, control);
    expect(live.status, `the same revision with a live target: ${JSON.stringify(live.body)}`).toBe(
      200
    );
  }
});
