import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { Chat, ChatDetail, Run } from '../core/types.js';
import { createApp, type App } from '../server/app.js';
import { ResponseStreamStore } from '../server/response-stream.js';
import { fixtureBotInput } from './fixtures/chat.js';

const owned: { app?: App; directory: string }[] = [];
afterEach(async () => {
  for (const item of owned.splice(0).reverse()) {
    await item.app?.close();
    const target = resolve(item.directory);
    if (!basename(target).startsWith('uimori-translation-stream-'))
      throw new Error('Refusing cleanup outside owned test directory');
    await rm(target, { recursive: true, force: true });
  }
});

async function api<T>(url: string, path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`${url}${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  expect(response.status, JSON.stringify(value)).toBe(200);
  return value as T;
}
async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5000;
  let value: T;
  do {
    value = await read();
    if (predicate(value)) return value;
    await new Promise((done) => setTimeout(done, 10));
  } while (Date.now() < deadline);
  throw new Error(`Condition timed out: ${JSON.stringify(value)}`);
}
async function start(directory: string) {
  const app = await createApp({
    dbPath: join(directory, 'story.sqlite'),
    instanceId: randomUUID(),
    buildId: 'translation-stream',
    testMode: true,
  });
  const entry: (typeof owned)[number] = { app, directory };
  owned.push(entry);
  return { app, url: await app.listen({ port: 0, host: '127.0.0.1' }), entry };
}
async function translatedScene(url: string) {
  const owner = await api<{ id: string }>(url, '/api/content', fixtureBotInput());
  const chat = await api<Chat>(url, '/api/chats', { title: '번역 스트림', botId: owner.id });
  const run = await api<Run>(url, `/api/chats/${chat.id}/runs`, {
    request: '작은 항구에서 장면을 이어줘.',
    expectedRevision: chat.headRevision,
    expectedSettingsRevision: chat.settingsRevision,
    idempotencyKey: randomUUID(),
  });
  await until(
    () => api<Run>(url, `/api/runs/${run.id}`),
    (value) => value.status === 'completed'
  );
  const detail = () => api<ChatDetail>(url, `/api/chats/${chat.id}`);
  const source = (await detail()).sources[0];
  const translation = async () =>
    (await detail()).jobs.filter(
      (job) => job.kind === 'translation' && job.sourceRevision === source.id
    );
  return { chat, source, translation };
}
const stream = (url: string, jobId: string) =>
  api<{ status: string; chunks: unknown[] }>(url, `/api/response-streams/translation/${jobId}`);

test('a translation job owns a response stream that ends with the job and is recovered after a restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'uimori-translation-stream-'));
  const first = await start(directory);
  const scene = await translatedScene(first.url);
  await api(first.url, `/api/sources/${scene.source.id}/translation`, {});
  const [completed] = await until(scene.translation, (jobs) => jobs[0]?.status === 'completed');
  expect(await stream(first.url, completed.id)).toMatchObject({ status: 'completed', chunks: [] });

  await api(first.url, '/api/test/control', {
    action: 'fail-next',
    point: 'job-transaction',
    chatId: scene.chat.id,
  });
  await api(first.url, `/api/sources/${scene.source.id}/retranslate`, {});
  const failed = (
    await until(scene.translation, (jobs) => jobs.some((job) => job.status === 'failed'))
  ).find((job) => job.status === 'failed')!;
  expect(await stream(first.url, failed.id)).toMatchObject({ status: 'failed', chunks: [] });

  new ResponseStreamStore(first.app.store).createWriter({
    taskKind: 'translation',
    taskId: 'job-left-running',
    chatId: scene.chat.id,
    signal: new AbortController().signal,
  });
  expect((await stream(first.url, 'job-left-running')).status).toBe('running');
  await first.app.close();
  first.entry.app = undefined;
  const second = await start(directory);
  expect(await stream(second.url, 'job-left-running')).toMatchObject({
    status: 'interrupted',
    chunks: [],
  });
});
