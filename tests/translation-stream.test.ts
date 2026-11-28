import { DatabaseSync } from 'node:sqlite';
import type { ServerResponse } from 'node:http';
import { afterEach, expect, test, vi } from 'vitest';
import { encodeStoryUi, type StoryUiMessage } from '../core/story-ui.js';
import { prepareStoryUiTranslation } from '../core/story-ui-translation.js';
import { translationPolicy } from '../core/translation-settings.js';
import type { AuxiliaryBundle } from '../server/product-auxiliary.js';
import { runAuxiliaryJob } from '../server/product-auxiliary.js';
import { initResponseStreams, ResponseStreamStore } from '../server/response-stream.js';
import { loopbackProvider } from './fixtures/loopback-provider.js';
import { bridge, bundle, hooks, selectProvider } from './fixtures/translation-job.js';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function responseStreams() {
  const db = new DatabaseSync(':memory:');
  cleanups.push(() => db.close());
  db.exec(
    "PRAGMA foreign_keys=ON; CREATE TABLE chats(id TEXT PRIMARY KEY); INSERT INTO chats VALUES('chat-a'); CREATE TABLE runs(id TEXT PRIMARY KEY); CREATE TABLE helper_tasks(id TEXT PRIMARY KEY);"
  );
  initResponseStreams(db);
  return new ResponseStreamStore({
    db,
    transaction: <T>(action: () => T): T => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = action();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  });
}

const delta = (content: string, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: 'local', choices: [{ index: 0, delta: { content }, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } } : {}) })}\n\n`;
function complete(response: ServerResponse, text: string) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(delta(text, 'stop'));
  response.end('data: [DONE]\n\n');
}
const verdict = (refusal: number) =>
  new Response(
    JSON.stringify({
      model: 'jev-latest',
      answers: { explicitRefusal: { type: 'noul', noul: refusal } },
      usage: { input_tokens: 40, output_tokens: 2 },
    }),
    { status: 200 }
  );

async function translationJob(
  handler: Parameters<typeof loopbackProvider>[0],
  sourceText?: string
) {
  const server = await loopbackProvider(handler);
  cleanups.push(server.close);
  const seed: AuxiliaryBundle = bundle(sourceText);
  selectProvider(seed, server.endpoint);
  const model = seed.snapshot.profile!.models.translation!;
  model.modelId = 'provider/translator';
  model.connection.protocol = 'openai-chat-v1';
  seed.translationPolicy = translationPolicy();
  const streams = responseStreams();
  const controller = new AbortController();
  const recorded = bridge(seed);
  const log: string[] = [];
  const store: typeof recorded.store = {
    ...recorded.store,
    stageTranslationJudgment: (id, generation, owner, candidate, pending) => {
      log.push(pending ? 'stage:pending' : 'stage:refused');
      return recorded.store.stageTranslationJudgment(id, generation, owner, candidate, pending);
    },
    finish: (id, generation, owner, outcome) => {
      log.push(`finish:${outcome.status}`);
      return recorded.store.finish(id, generation, owner, outcome);
    },
  };
  const received = new Map<string, string>();
  let cursor = 0;
  streams.subscribeChat(seed.source.chatId, (identity) => {
    if (identity.taskKind !== 'translation' || identity.taskId !== seed.job.id) return;
    const page = streams.read('translation', seed.job.id, cursor);
    cursor = page.cursor;
    for (const chunk of page.chunks) {
      const key = `${chunk.segment}:${chunk.attemptId}`;
      received.set(key, (received.get(key) ?? '') + chunk.text);
    }
  });
  const visible = () =>
    streams
      .read('translation', seed.job.id)
      .chunks.map((chunk) => chunk.text)
      .join('');
  const run = (judge: (call: number) => Response | Promise<Response>) => {
    let judgments = 0;
    return runAuxiliaryJob(store, seed.job.id, 'owner', {
      ...hooks(server.origin).options,
      signal: controller.signal,
      jev: {
        credential: () => 'test-key',
        fetch: async () => {
          log.push('judgment');
          return judge(++judgments);
        },
      },
      openResponseStream: () =>
        streams.createWriter({
          taskKind: 'translation',
          taskId: seed.job.id,
          chatId: seed.source.chatId,
          signal: controller.signal,
        }),
    });
  };
  return { seed, server, streams, controller, recorded, log, received, visible, run };
}

test('translated text streams before the verdict and reaches the job result only after it', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  cleanups.push(() => release());
  const job = await translationJob(async (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(delta('첫 문장이에요. '));
    await held;
    response.write(delta('둘째 문장이에요.', 'stop'));
    response.end('data: [DONE]\n\n');
  });
  const result = job.run(async () => {
    await vi.waitFor(() => expect(job.visible()).toBe('첫 문장이에요. 둘째 문장이에요.'), {
      timeout: 5000,
    });
    expect(job.streams.read('translation', job.seed.job.id).status).toBe('running');
    expect(job.recorded.outputs).toEqual([]);
    return verdict(0.01);
  });
  await vi.waitFor(() => expect(job.visible()).toBe('첫 문장이에요. '), { timeout: 5000 });
  expect(job.streams.runningTasks('chat-a')).toEqual([
    { taskKind: 'translation', taskId: job.seed.job.id },
  ]);
  expect(job.log).toEqual([]);
  expect(job.recorded.outputs).toEqual([]);
  release();
  expect(await result).toMatchObject({
    status: 'completed',
    result: { text: '첫 문장이에요. 둘째 문장이에요.' },
  });
  expect(job.log).toEqual(['stage:pending', 'judgment', 'finish:completed']);
  expect(job.streams.read('translation', job.seed.job.id)).toMatchObject({
    status: 'completed',
    chunks: [],
  });
  expect(job.streams.runningTasks('chat-a')).toEqual([]);
});

test('a refused attempt and its retry stream as separate attempts', async () => {
  let translations = 0;
  const job = await translationJob((_request, response) =>
    complete(response, ++translations === 1 ? 'Cannot translate.' : '번역된 이야기예요.')
  );
  job.seed.translationPolicy = { judgment: { threshold: 0.9 }, maxRetries: 1, maxCalls: 6 };
  const result = await job.run(async (call) => {
    await vi.waitFor(
      () =>
        expect([...job.received.values()].at(-1)).toBe(
          call === 1 ? 'Cannot translate.' : '번역된 이야기예요.'
        ),
      { timeout: 5000 }
    );
    return verdict(call === 1 ? 0.95 : 0.01);
  });
  expect(result).toMatchObject({ status: 'completed', result: { text: '번역된 이야기예요.' } });
  expect([...job.received]).toEqual([
    ['0:attempt-1', 'Cannot translate.'],
    ['1:attempt-3', '번역된 이야기예요.'],
  ]);
  expect(job.log).toEqual([
    'stage:pending',
    'judgment',
    'stage:refused',
    'stage:pending',
    'judgment',
    'finish:completed',
  ]);
});

test('cancelling a translation ends its stream as cancelled', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  cleanups.push(() => release());
  const job = await translationJob(async (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(delta('끝나지 않을 문장'));
    await held;
    response.end();
  });
  const result = job.run(() => verdict(0.01));
  await vi.waitFor(() => expect(job.visible()).toBe('끝나지 않을 문장'), { timeout: 5000 });
  job.controller.abort();
  expect(job.streams.read('translation', job.seed.job.id)).toMatchObject({
    status: 'cancelled',
    chunks: [],
  });
  expect(await result).toMatchObject({ status: 'cancelled', error: 'AUXILIARY_CANCELLED' });
  expect(job.log).toEqual(['finish:cancelled']);
  expect(job.streams.runningTasks('chat-a')).toEqual([]);
});

test('a failed translation ends its stream as failed', async () => {
  const job = await translationJob((_request, response) => {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end('{"error":{"message":"synthetic"}}');
  });
  expect(await job.run(() => verdict(0.01))).toMatchObject({ status: 'failed' });
  expect(job.streams.read('translation', job.seed.job.id)).toMatchObject({
    status: 'failed',
    chunks: [],
  });
  expect(job.log).toEqual(['finish:failed']);
});

test('a translation that carries protected Story UI placeholders is not streamed', async () => {
  const messages = [
    {
      version: '1.0',
      createSurface: {
        surfaceId: 'main',
        catalogId: 'urn:uimori:story-ui:1',
        components: [{ id: 'root', component: 'Text', text: 'Choose a route' }],
      },
    },
  ] as unknown as StoryUiMessage[];
  const source = `Mira waited.\n\n${encodeStoryUi('<a2ui>root = Text("Choose a route")</a2ui>', messages)}`;
  const prepared = prepareStoryUiTranslation(source);
  expect(prepared.protected).toBe(true);
  const job = await translationJob(
    (_request, response) => complete(response, prepared.text),
    source
  );
  const result = await job.run(() => verdict(0.01));
  expect(result).toMatchObject({ status: 'completed' });
  expect([...job.received]).toEqual([]);
});
