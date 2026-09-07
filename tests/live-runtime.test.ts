import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp, type App } from '../server/app.js';
import type { Chat, ChatDetail, Run, Usage } from '../core/types.js';
import type { Connection, ModelPreset } from '../core/product.js';
import type { ProviderResult } from '../core/transport.js';
import { loopbackProvider, writeSse } from './fixtures/loopback-provider.js';

const owned: { directory: string; app?: App; close?: () => Promise<void>; release?: () => void }[] = [];
afterEach(async () => {
  for (const item of owned.splice(0).reverse()) {
    item.release?.(); await item.app?.close(); await item.close?.();
    const target = resolve(item.directory); const within = relative(resolve(tmpdir()), target);
    if (isAbsolute(within) || within.startsWith('..') || !basename(target).startsWith('uimori live runtime fixture ')) throw new Error('Refusing cleanup outside owned fixture directory');
    await rm(target, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});
async function api<T>(url: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(url + path, { method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const value = await response.json(); expect(response.status, JSON.stringify(value)).toBe(200); return value as T;
}

for (const observed of [
  { inputTokens: 17, outputTokens: 5, costUsd: 0.00012 },
  { inputTokens: 0, outputTokens: 0, costUsd: null },
]) test(`P05 P06 cancellation after observed HTTP usage keeps terminal state and settles usage once (${observed.costUsd === null ? 'unknown cost' : 'known cost'})`, async () => {
  const item = { directory: await mkdtemp(join(tmpdir(), 'uimori live runtime fixture ')) } as (typeof owned)[number]; owned.push(item);
  const provider = await loopbackProvider(async (_request, response) => writeSse(response, [
    { type: 'text_delta', delta: 'Synthetic text received before cancellation; never commit it as source.' },
    { type: 'usage', ...observed, raw: { synthetic: true }, priceRevision: observed.costUsd === null ? null : 'fixture-price-v1' },
    { type: 'done', reason: 'stop' },
  ])); item.close = provider.close;
  const app = await createApp({ dbPath: join(item.directory, 'story.sqlite'), instanceId: randomUUID(), buildId: 'cancelled-usage-fixture', approvedOrigins: [provider.origin] }); item.app = app;
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  const chat = await api<Chat>(url, '/api/chats', { title: 'Synthetic cancelled usage' });
  const connection = app.store.product.connection({ title: 'Isolated fixture', protocol: 'fixture-sse-v1', endpoint: provider.endpoint, enabled: true }) as Connection;
  const model = app.store.product.model({ title: 'Fixture model', connectionId: connection.id, connectionRevision: connection.revision, modelId: 'fixture-cancelled-usage', maxOutputTokens: 100, temperature: null }) as ModelPreset;
  const originalProfile = app.store.product.profile(chat.id);
  const profile = app.store.product.updateProfile(chat.id, { expectedRevision: originalProfile.revision, attachments: [], creative: originalProfile.creative, routes: { ...originalProfile.routes, main: { id: model.id, revision: model.revision } }, image: false });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); item.release = release;
  let recorded!: (value: { id: string; result: ProviderResult }) => void; const persisted = new Promise<{ id: string; result: ProviderResult }>(resolve => { recorded = resolve; });
  const finishAttempt = app.store.product.finishAttempt.bind(app.store.product);
  // Real HTTP decoding and durable attempt persistence finish before this gate.
  // Cancellation then races only the application commit, without timing sleeps.
  vi.spyOn(app.store.product, 'finishAttempt').mockImplementation(async (id, result) => { finishAttempt(id, result); recorded({ id, result }); await gate; });
  const run = await api<Run>(url, `/api/chats/${chat.id}/runs`, { request: 'Synthetic short scene', expectedRevision: chat.headRevision, expectedSettingsRevision: chat.settingsRevision, expectedProfileRevision: profile.revision, idempotencyKey: randomUUID() });
  const attempt = await persisted; expect(provider.requests).toHaveLength(1); expect(app.store.product.attempts(chat.id)[0]).toMatchObject({ status: 'completed', ...observed });
  const cancelled = await api<Run>(url, `/api/runs/${run.id}/cancel`, {}); expect(cancelled).toMatchObject({ status: 'cancelled', sourceRevision: null });
  release(); const expected: Usage = { modelCalls: 1, ...observed };
  await expect.poll(async () => (await api<Run>(url, `/api/runs/${run.id}`)).usage).toEqual(expected);
  const preserved = await api<ChatDetail>(url, `/api/chats/${chat.id}`); expect(preserved.sources).toHaveLength(0); expect(preserved.jobs).toHaveLength(0); expect(preserved.runs[0]).toMatchObject({ status: 'cancelled', sourceRevision: null, usage: expected }); expect(preserved.chat.headRevision).toBeNull();
  await api(url, `/api/runs/${run.id}/cancel`, {});
  app.store.finishRun(run.id, 'cancelled', 'duplicate terminal write', '', { modelCalls: 999, inputTokens: 999, outputTokens: 999, costUsd: 999 });
  app.store.settleCancelledUsage(run.id, { modelCalls: 999, inputTokens: 999, outputTokens: 999, costUsd: 999 });
  finishAttempt(attempt.id, { ...attempt.result, usage: { ...attempt.result.usage, inputTokens: 999, outputTokens: 999, costUsd: 999 } });
  expect((await api<Run>(url, `/api/runs/${run.id}`)).usage).toEqual(expected); expect(app.store.product.attempts(chat.id)[0]).toMatchObject(observed); expect(provider.requests).toHaveLength(1);
});
