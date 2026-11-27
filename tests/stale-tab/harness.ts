import { join } from 'node:path';
import { expect } from 'vitest';
import { allEndpoints, type AppErrorCode, type Endpoint, endpointRequest } from '#contracts';
import type { Content, Connection, ModelPreset } from '../../core/product.js';
import { createApp, type App } from '../../server/app.js';
import { deleteChat } from '../../server/chat-deletion.js';
import { deleteLibraryItem, type LibraryKind } from '../../server/library-deletion.js';
import { promptWorkspace } from '../../server/prompt-workspace.js';
import { createFixtureChat, fixtureBotInput } from '../fixtures/chat.js';
import { completedSource } from '../fixtures/illustration.js';
import { softDeleteLibraryItem } from '../fixtures/soft-delete.js';
import { createTestDirectory } from '../fixtures/test-directory.js';

export type Domain = keyof typeof allEndpoints;
export type Input = Record<string, unknown>;
export type Answer = { status: number; code: AppErrorCode };
export type Probe = { input: Input; control?: Input };
export type Case = {
  when: string;
  arrange: () => Probe | Promise<Probe>;
  answer: Answer;
  reason?: string;
  targetRevision?: true;
};
export type Entry = { cases: Case[] } | { exempt: string };
export type DomainCases<D extends Domain = Domain> = {
  domain: D;
  entries: Partial<Record<keyof (typeof allEndpoints)[D] & string, Entry>>;
};

export const domainCases = <D extends Domain>(
  domain: D,
  entries: DomainCases<D>['entries']
): DomainCases<D> => ({ domain, entries });

export const conflict: Answer = { status: 409, code: 'REVISION_CONFLICT' };
export const deleted: Answer = { status: 404, code: 'LIBRARY_ITEM_DELETED' };
export const singletonExemption =
  'A singleton setting with no target to delete; its input is fully checked by the operation schema before the revision, so a stale tab meets 409 for any value the schema admits.';

const origin = 'https://story.example.test';
const accessToken = 'synthetic-stale-tab-access-key-32-chars';

let app: App;
let headers: Record<string, string>;
const directory = createTestDirectory('uimori-stale-tab-');

export async function startStaleTabApp() {
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
}

export async function stopStaleTabApp() {
  await app?.close();
  directory.remove();
}

export async function call(endpoint: Endpoint, input: Input) {
  const { path, body } = endpointRequest(endpoint, input);
  const response = await app.inject({
    method: endpoint.method,
    url: `/api${path}`,
    headers,
    ...(body === undefined ? {} : { payload: body }),
  });
  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
}

export async function read<T = Record<string, unknown>>(endpoint: Endpoint, input: Input = {}) {
  const response = await call(endpoint, input);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body as T;
}

export const store = () => app.store;
export const removed = <T extends { id: string; revision: number }>(kind: LibraryKind, item: T) =>
  softDeleteLibraryItem(store(), kind, item).revision;
export const purged = (kind: LibraryKind, item: { id: string; revision: number }) => {
  deleteLibraryItem(store(), kind, item.id, { expectedRevision: item.revision });
  expect(store().product.isHidden(kind, item.id), `${kind} is purged`).toBe(false);
  expect(store().product.isLive(kind, item.id), `${kind} is purged`).toBe(false);
};
export const bot = () => store().product.content(fixtureBotInput('Stale tab bot')) as Content;
export const preset = () =>
  store().product.promptPreset({ title: 'Stale tab preset', role: 'main', text: 'Write' }) as {
    id: string;
    revision: number;
  };
export const combination = (owner?: { id: string; revision: number }) =>
  store().product.promptCombination({
    ...(owner
      ? { owner: { kind: 'preset', id: owner.id }, expectedRevision: owner.revision }
      : { workspaceRevision: promptWorkspace(store()).revision }),
    title: 'Stale tab options',
    role: 'main',
    values: {},
  }) as { id: string; revision: number };
export const connection = (endpoint = 'http://127.0.0.1:9999/v1') =>
  store().product.connection({
    title: 'Stale tab connection',
    protocol: 'openai-chat-v1',
    endpoint,
    enabled: true,
  }) as Connection;
export const model = () =>
  store().product.model({
    title: 'Stale tab model',
    connectionId: connection().id,
    modelId: 'synthetic',
    maxOutputTokens: 100,
    temperature: null,
  }) as ModelPreset;
export function scene(title: string) {
  const chat = createFixtureChat(store(), title);
  return { chat, source: completedSource(store(), chat.id) };
}
export function deletedChat() {
  const { chat, source } = scene('Stale tab chat');
  deleteChat(store(), chat.id, {});
  return { chatId: chat.id, sourceId: source.id };
}
