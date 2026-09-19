import { createFixtureChat } from './fixtures/chat.js';
import { afterEach, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp, type App } from '../server/app.js';
import { readerDetail } from '../server/reader.js';
import type { Store } from '../server/store.js';
import type { ProviderResult, WireRecord } from '../core/transport.js';

const owned: { app: App; directory: string }[] = [];
afterEach(async () => {
  for (const { app, directory } of owned.splice(0)) {
    await app.close();
    const target = resolve(directory),
      within = relative(resolve(tmpdir()), target);
    if (
      isAbsolute(within) ||
      within.startsWith('..') ||
      !basename(target).startsWith('uimori-rejection-tests-')
    )
      throw new Error('Unsafe cleanup');
    await rm(target, { recursive: true, force: true });
  }
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'uimori-rejection-tests-'));
  const app = await createApp({
    dbPath: join(directory, 'reader.sqlite'),
    buildId: 'rejection-test',
    testMode: true,
  });
  owned.push({ app, directory });
  return app;
}
function newRun(store: Store, chatId: string) {
  const chat = store.chat(chatId),
    branch = store.product.branch(chatId);
  const run = store.createRun(
    chatId,
    {
      request: 'Synthetic request',
      expectedRevision: branch.headRevision,
      expectedSettingsRevision: chat.settingsRevision,
      idempotencyKey: randomUUID(),
    },
    (current) => ({
      chatId,
      parentRevision: current.headRevision,
      settingsRevision: current.settingsRevision,
      settings: current.settings,
      request: 'Synthetic request',
      history: store.history(current.headRevision),
      resources: [],
    })
  ).run;
  store.startRun(run.id);
  return run;
}
const wire = (): WireRecord => ({
  connectionId: 'synthetic-connection',
  protocol: 'openai-responses-v1',
  role: 'main',
  modelId: 'gpt-future',
  method: 'POST',
  url: 'https://api.openai.com/v1/responses',
  headers: {},
  body: {},
  bodySha256: '0'.repeat(64),
  stablePrefixSha256: '0'.repeat(64),
});
const failure = (code: string, fields?: string[]): ProviderResult => ({
  status: 'error',
  text: '',
  toolCalls: [],
  refusal: null,
  error: {
    code,
    ...(fields
      ? {
          diagnostic: {
            httpStatus: Number(code.replace('HTTP_', '')),
            bodyState: 'parsed' as const,
            providerCode: 'unsupported_parameter',
            fields,
          },
        }
      : {}),
  },
  usage: { inputTokens: null, outputTokens: null, costUsd: null, raw: null, priceRevision: null },
  opaqueState: null,
});

test('a 4xx main run carries the rejected options read from its stored attempt; other failures carry none', async () => {
  const app = await setup(),
    store = app.store;
  const chat = createFixtureChat(store, 'Rejection projection');
  const rejected = newRun(store, chat.id);
  store.product.finishAttempt(
    store.product.startAttempt(chat.id, rejected.id, null, wire()),
    failure('HTTP_400', ['reasoning.effort', 'temperature', 'messages[0].role'])
  );
  store.db.prepare("UPDATE runs SET status='failed',error='HTTP_400' WHERE id=?").run(rejected.id);
  const timedOut = newRun(store, chat.id);
  store.product.finishAttempt(
    store.product.startAttempt(chat.id, timedOut.id, null, wire()),
    failure('TIMEOUT')
  );
  store.db.prepare("UPDATE runs SET status='failed',error='TIMEOUT' WHERE id=?").run(timedOut.id);
  const detail = readerDetail(store, chat.id, {});
  expect(detail.runs.find((run) => run.id === rejected.id)?.rejection).toEqual({
    httpStatus: 400,
    providerCode: 'unsupported_parameter',
    options: ['thinking', 'temperature', 'input'],
  });
  expect(detail.runs.find((run) => run.id === timedOut.id)).not.toHaveProperty('rejection');
  // The projection is read-time only: nothing about the verdict is written to the run row.
  expect(
    JSON.stringify(store.db.prepare('SELECT * FROM runs WHERE id=?').get(rejected.id))
  ).not.toContain('unsupported_parameter');
});
