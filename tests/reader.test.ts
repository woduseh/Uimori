import { afterEach, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp, type App } from '../server/app.js';
import { readerDetail } from '../server/reader.js';
import type { Store } from '../server/store.js';

const owned: { app: App; directory: string }[] = [];
afterEach(async () => {
  for (const { app, directory } of owned.splice(0)) {
    await app.close();
    const target = resolve(directory), within = relative(resolve(tmpdir()), target);
    if (isAbsolute(within) || within.startsWith('..') || !basename(target).startsWith('uimori-reader-tests-')) throw new Error('Unsafe cleanup');
    await rm(target, { recursive: true, force: true });
  }
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'uimori-reader-tests-'));
  const app = await createApp({ dbPath: join(directory, 'reader.sqlite'), buildId: 'reader-test', testMode: true });
  owned.push({ app, directory });
  return app;
}
function source(store: Store, chatId: string, text = 'Synthetic paragraph.', branchId?: string) {
  const chat = store.chat(chatId), branch = store.product.branch(chatId, branchId);
  const run = store.createRun(chatId, { request: 'Synthetic request', expectedRevision: branch.headRevision, expectedSettingsRevision: chat.settingsRevision, idempotencyKey: randomUUID(), branchId }, current => ({ chatId, parentRevision: current.headRevision, settingsRevision: current.settingsRevision, settings: current.settings, request: 'Synthetic request', history: store.history(current.headRevision), resources: [] })).run;
  store.startRun(run.id);
  return store.completeRun(run.id, text, { modelCalls: 0, inputTokens: null, outputTokens: null, costUsd: null }, run.snapshot.settings);
}

test('100-source HTTP reader pages retain order while execution snapshot and full detail stay intact', async () => {
  const app = await setup(), store = app.store, chat = store.createChat('100 synthetic sources');
  const sources = Array.from({ length: 100 }, (_, i) => source(store, chat.id, `Synthetic source ${i}.`));
  const frozen = store.run(sources[99].runId).snapshot;
  const full = store.detail(chat.id);
  let next: string | null = null;
  const collected: string[] = [];
  do {
    const response: { statusCode: number; body: string; json(): ReturnType<typeof readerDetail> } = await app.inject({ method: 'GET', url: `/api/chats/${chat.id}/reader${next ? '?source=' + next : ''}` });
    expect(response.statusCode, response.body).toBe(200);
    const page: ReturnType<typeof readerDetail> = response.json();
    expect(page.sources).toHaveLength(5); expect(page.reader.total).toBe(100);
    expect(page.sources.map((s: { id: string }) => s.id)).toEqual(page.reader.order);
    expect(page.runs.every((r: { snapshot: Record<string, unknown> }) => !('history' in r.snapshot) && !('resources' in r.snapshot) && !('inputs' in r) && !('toolEvents' in r))).toBe(true);
    collected.push(...page.reader.order); next = page.reader.next;
  } while (next);
  expect(collected).toEqual(sources.map(s => s.id));
  expect(store.detail(chat.id)).toEqual(full);
  expect(store.run(sources[99].runId).snapshot).toEqual(frozen);
  expect(frozen.history).toHaveLength(99);
});

test('source cursors and supplied known IDs cannot cross branch or chat boundaries', async () => {
  const { store } = await setup(), chat = store.createChat('Branch scope');
  const root = source(store, chat.id), main = source(store, chat.id);
  const branch = store.product.createBranch(chat.id, { title: 'Independent branch', fromRevision: root.id });
  const child = source(store, chat.id, 'Branch child', branch.id);
  const other = source(store, store.createChat('Other chat').id);
  expect(readerDetail(store, chat.id, { branch: branch.id }).reader.order).toEqual([root.id, child.id]);
  expect(readerDetail(store, chat.id, {}).reader.order).toEqual([root.id, main.id]);
  for (const id of [main.id, other.id]) expect(() => readerDetail(store, chat.id, { branch: branch.id, source: id })).toThrow('Source is not in this branch');
  const first = readerDetail(store, chat.id, { branch: branch.id });
  expect(readerDetail(store, chat.id, { branch: branch.id, since: String(first.reader.cursor), known: other.id }).sources.map(s => s.id)).toEqual([root.id, child.id]);
});

test('delta includes current edited source and matching latest translation only, with unchanged assets omitted', async () => {
  const { store } = await setup(), chat = store.createChat('Delta');
  const a = source(store, chat.id), b = source(store, chat.id);
  const manual = store.editTranslation(a.id, { text: 'Original translation', expectedRevision: 0, expectedSourceHash: a.hash });
  const first = readerDetail(store, chat.id, {}), known = first.reader.order.join(',');
  expect(first).toHaveProperty('assets');
  const idle = readerDetail(store, chat.id, { since: String(first.reader.cursor), known });
  expect(idle.sources).toEqual([]); expect(idle.jobs).toEqual([]); expect(idle).not.toHaveProperty('assets');
  const edited = store.editSource(a.id, { text: 'Revised source', expectedRevision: 0 });
  const changed = readerDetail(store, chat.id, { since: String(first.reader.cursor), known });
  expect(changed.sources.map(s => s.id)).toEqual([a.id]); expect(changed.sources[0].hash).toBe(edited.hash);
  expect(changed.jobs.some(job => job.id === manual.id)).toBe(false);
  const translated = store.editTranslation(a.id, { text: 'Current translation', expectedRevision: edited.translationRevision!, expectedSourceHash: edited.hash });
  const delta = readerDetail(store, chat.id, { since: String(changed.reader.cursor), known });
  expect(delta.sources.map(s => s.id)).toEqual([a.id]); expect(delta.sources.some(s => s.id === b.id)).toBe(false);
  expect(delta.jobs.find(j => j.id === translated.id)?.result?.text).toBe('Current translation');
  expect(delta.jobs.every(j => j.sourceHash === edited.hash)).toBe(true);
  expect(delta.jobs.every(j => !('input' in j))).toBe(true);
  store.event(chat.id, 'asset.created', 'synthetic-asset-event');
  expect(readerDetail(store, chat.id, { since: String(delta.reader.cursor), known })).toHaveProperty('assets');
});

test('new source joins an incomplete last page on delta and another chat does not dirty it', async () => {
  const { store } = await setup(), chat = store.createChat('Last page');
  const items = Array.from({ length: 6 }, () => source(store, chat.id));
  const first = readerDetail(store, chat.id, { source: items[5].id });
  source(store, store.createChat('Other chat activity').id);
  expect(readerDetail(store, chat.id, { source: items[5].id, since: String(first.reader.cursor), known: items[5].id }).sources).toEqual([]);
  const added = source(store, chat.id);
  const delta = readerDetail(store, chat.id, { source: items[5].id, since: String(first.reader.cursor), known: items[5].id });
  expect(delta.reader.order).toEqual([items[5].id, added.id]); expect(delta.sources.map(s => s.id)).toEqual([added.id]);
});

test('HTTP reader rejects invalid or future cursors', async () => {
  const app = await setup(), chat = app.store.createChat('Cursor validation');
  for (const cursor of ['-1', 'NaN', '1.5', '9007199254740992', '1']) {
    const response = await app.inject({ method: 'GET', url: `/api/chats/${chat.id}/reader?since=${cursor}` });
    expect(response.statusCode, response.body).toBe(400);
  }
  expect((await app.inject({ method: 'GET', url: `/api/chats/${chat.id}/reader?since=0` })).statusCode).toBe(200);
});

test('restoring any source retains its whole fixed page, including all of a short chat', async () => {
  const { store } = await setup(), chat = store.createChat('Restore fixed pages');
  const items = Array.from({ length: 3 }, () => source(store, chat.id));
  const short = readerDetail(store, chat.id, { source: items[2].id });
  expect(short.reader.order).toEqual(items.map(s => s.id));
  expect(short.reader.start).toBe(0); expect(short.reader.previous).toBeNull();
  items.push(...Array.from({ length: 9 }, () => source(store, chat.id)));
  for (const index of [1, 4, 6, 9, 11]) {
    const page = readerDetail(store, chat.id, { source: items[index].id });
    const start = Math.floor(index / 5) * 5;
    expect(page.reader.start).toBe(start);
    expect(page.reader.order).toEqual(items.slice(start, start + 5).map(s => s.id));
    expect(page.reader.order).toContain(items[index].id);
    expect(page.reader.latest).toBe(items[10].id);
  }
});

