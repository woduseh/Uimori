import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { ServerResponse } from 'node:http';
import { Store, HttpError } from './store.js';
import { Controls, type Barrier, type FailurePoint } from './controls.js';
import { executeMain, syntheticResources } from '../core/provider.js';
import type { Settings, RunSnapshot, Job } from '../core/types.js';

export type AppOptions = { dbPath: string; buildId: string; instanceId?: string; testMode?: boolean; webRoot?: string };
export type App = FastifyInstance & { store: Store; controls: Controls };
type RecordBody = Record<string, unknown>;
const object = (value: unknown): RecordBody => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Expected an object');
  return value as RecordBody;
};
const only = (body: RecordBody, keys: string[]) => {
  if (Object.keys(body).some(key => !keys.includes(key))) throw new HttpError(400, 'Unknown request field');
};
const string = (value: unknown, name: string, max = 4000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new HttpError(400, `Invalid ${name}`);
  return value;
};
const integer = (value: unknown, name: string, min: number, max: number) => {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) throw new HttpError(400, `Invalid ${name}`);
  return Number(value);
};
function settings(body: RecordBody): Settings {
  if (!['calm', 'vivid'].includes(String(body.preset)) || !['direct', 'research'].includes(String(body.mode)) || typeof body.translation !== 'boolean' || typeof body.status !== 'boolean') throw new HttpError(400, 'Invalid settings');
  return { preset: body.preset as Settings['preset'], mode: body.mode as Settings['mode'], translation: body.translation, status: body.status, maxCalls: integer(body.maxCalls, 'maxCalls', 1, 16) };
}

export async function createApp(options: AppOptions): Promise<App> {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 }) as unknown as App;
  const store = new Store(options.dbPath);
  const controls = new Controls();
  const instanceId = options.instanceId ?? randomUUID();
  app.decorate('store', store); app.decorate('controls', controls);
  const subscribers = new Map<string, Map<ServerResponse, number>>();
  const work = new Set<Promise<void>>();
  const runs = new Map<string, AbortController>();
  const jobs = new Set<string>();
  const stopping = new AbortController();
  const publish = (chatId: string) => {
    for (const [response, cursor] of subscribers.get(chatId) ?? []) {
      for (const event of store.events(chatId, cursor) as { seq: number }[]) {
        response.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
        subscribers.get(chatId)?.set(response, event.seq);
      }
    }
  };
  const track = (promise: Promise<void>) => { work.add(promise); void promise.finally(() => work.delete(promise)); };
  const pumpJobs = () => {
    if (stopping.signal.aborted) return;
    for (const id of store.queuedJobs()) {
      if (jobs.has(id)) continue;
      jobs.add(id);
      track((async () => {
        let generation = 0;
        let chatId = '';
        try {
          const queued = store.job(id); chatId = queued.chatId;
          const source = store.source(queued.sourceRevision);
          const input = queued.kind === 'translation'
            ? { role: 'translation', mock: true, contract: 'M0 deterministic mock translation; preserve source identity. This does not evaluate translation quality.', sourceRevision: source.id, sourceHash: source.hash, text: source.text, schema: { mock: true, text: 'string', sourceRevision: 'string', sourceHash: 'string' } }
            : { role: 'status', mock: true, contract: 'M0 display-only annotation. Never authoritative state or story evidence.', sourceRevision: source.id, sourceHash: source.hash, text: source.text, previousState: null, schema: { mock: true, label: 'string', sourceRevision: 'string', sourceHash: 'string' } };
          const job = store.claimJob(id, instanceId, input);
          if (!job) return;
          generation = job.generation; publish(chatId);
          await controls.wait(job.kind, stopping.signal);
          await delay(job.kind === 'translation' ? 80 : 140, undefined, { signal: stopping.signal });
          controls.fail(job.kind);
          const result: NonNullable<Job['result']> = job.kind === 'translation'
            ? { mock: true, text: '[모의 한국어 번역 · 고정 합성 문장 · 의미 품질 미검증]\n항구의 저녁빛 아래, 여행자는 오래된 지도 곁에서 다음 길을 생각했다. 먼 언덕의 불빛이 하나씩 켜졌다.', sourceRevision: source.id, sourceHash: source.hash }
            : { mock: true, label: '모의 표시 상태 · 원문 보존됨 · 정사에 반영하지 않음', sourceRevision: source.id, sourceHash: source.hash };
          store.completeJob(id, generation, instanceId, result, controls);
        } catch (error) {
          if (!stopping.signal.aborted && generation) store.failJob(id, generation, instanceId, error instanceof Error && error.message.startsWith('Injected failure:') ? error.message : 'Mock auxiliary job failed');
        } finally { jobs.delete(id); if (chatId && !stopping.signal.aborted) publish(chatId); }
      })());
    }
  };
  const execute = (id: string) => {
    const controller = new AbortController(); runs.set(id, controller);
    const onStop = () => controller.abort(new Error('Server stopping'));
    stopping.signal.addEventListener('abort', onStop, { once: true });
    track((async () => {
      const run = store.run(id);
      try {
        if (!store.startRun(id)) return;
        publish(run.chatId);
        await controls.wait('run', controller.signal);
        const result = await executeMain(run.snapshot, {
          signal: controller.signal,
          onInput: input => store.input(id, input),
          onToolEvent: event => store.tool(id, event),
        });
        controller.signal.throwIfAborted();
        store.completeRun(id, result.text, result.usage, run.snapshot.settings, controls);
        if (controls.crashAfterSourceCommit) process.exit(86);
        publish(run.chatId); pumpJobs();
      } catch (error) {
        if (!stopping.signal.aborted) {
          const message = error instanceof Error ? error.message : '';
          const safeError = message === 'Model call budget exhausted' || message.startsWith('Injected failure:') ? message : controller.signal.aborted ? 'Run cancelled' : 'Scripted generation failed';
          store.finishRun(id, controller.signal.aborted ? 'cancelled' : 'failed', safeError);
          publish(run.chatId);
        }
      } finally { runs.delete(id); stopping.signal.removeEventListener('abort', onStop); }
    })());
  };

  app.addHook('onRequest', async request => {
    // M0 is a loopback-only single-user synthetic app, with no cross-origin writes.
    let hostname: string;
    try { hostname = new URL(`http://${request.headers.host}`).hostname; }
    catch { throw new HttpError(403, 'Invalid local host'); }
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) throw new HttpError(403, 'Non-loopback host denied');
    const origin = request.headers.origin;
    if (origin && origin !== `http://${request.headers.host}`) throw new HttpError(403, 'Cross-origin access denied');
  });
  app.setErrorHandler((error, _request, reply) => {
    const statusCode = error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined;
    const code = error instanceof HttpError ? error.statusCode : typeof statusCode === 'number' && statusCode < 500 ? statusCode : 500;
    void reply.code(code).send({ error: error instanceof HttpError ? error.message : code === 400 ? 'Invalid request' : 'Request failed' });
  });
  app.get('/api/health', async () => ({ ready: true, buildId: options.buildId, instanceId, dbPath: options.dbPath, mode: 'local-scripted-mock' }));
  app.get('/api/chats', async () => store.chats());
  app.post('/api/chats', async request => {
    const body = object(request.body); only(body, ['title', 'preset']);
    if (body.preset !== undefined && !['calm', 'vivid'].includes(String(body.preset))) throw new HttpError(400, 'Invalid preset');
    return store.createChat(string(body.title, 'title', 120), body.preset as Settings['preset'] | undefined, syntheticResources);
  });
  app.get<{ Params: { id: string } }>('/api/chats/:id', async request => store.detail(request.params.id));
  app.patch<{ Params: { id: string } }>('/api/chats/:id/settings', async request => {
    const body = object(request.body); only(body, ['expectedSettingsRevision', 'preset', 'mode', 'translation', 'status', 'maxCalls']);
    const chat = store.settings(request.params.id, integer(body.expectedSettingsRevision, 'settings revision', 1, 1e9), settings(body));
    publish(chat.id); return chat;
  });
  app.post<{ Params: { id: string } }>('/api/chats/:id/runs', async request => {
    const body = object(request.body); only(body, ['request', 'expectedRevision', 'expectedSettingsRevision', 'idempotencyKey']);
    const command = { request: string(body.request, 'request'), expectedRevision: body.expectedRevision === null ? null : string(body.expectedRevision, 'source revision', 100), expectedSettingsRevision: integer(body.expectedSettingsRevision, 'settings revision', 1, 1e9), idempotencyKey: string(body.idempotencyKey, 'idempotency key', 120) };
    const result = store.createRun(request.params.id, command, chat => ({ chatId: chat.id, parentRevision: chat.headRevision, settingsRevision: chat.settingsRevision, settings: chat.settings, request: command.request, history: store.history(chat.headRevision), resources: store.resources(chat.id) } satisfies RunSnapshot));
    if (result.created) { publish(request.params.id); execute(result.run.id); }
    return result.run;
  });
  app.get<{ Params: { id: string } }>('/api/runs/:id', async request => store.run(request.params.id));
  app.post<{ Params: { id: string } }>('/api/runs/:id/cancel', async request => {
    const run = store.finishRun(request.params.id, 'cancelled', 'Run cancelled');
    runs.get(run.id)?.abort(new Error('Run cancelled'));
    publish(run.chatId); return run;
  });
  app.post<{ Params: { id: string } }>('/api/jobs/:id/retry', async request => {
    const job = store.retryJob(request.params.id); publish(job.chatId); pumpJobs(); return job;
  });
  app.get<{ Params: { id: string } }>('/api/chats/:id/events', async (request, reply) => {
    store.chat(request.params.id);
    const rawCursor = request.headers['last-event-id'];
    const cursor = rawCursor === undefined ? 0 : Number(rawCursor);
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new HttpError(400, 'Invalid event cursor');
    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff' });
    const listeners = subscribers.get(request.params.id) ?? new Map<ServerResponse, number>();
    subscribers.set(request.params.id, listeners); listeners.set(reply.raw, cursor);
    reply.raw.write(`data: ${JSON.stringify({ kind: 'snapshot', chatId: request.params.id })}\n\n`);
    publish(request.params.id);
    const heartbeat = setInterval(() => reply.raw.write(': keepalive\n\n'), 15000); heartbeat.unref();
    reply.raw.on('close', () => { clearInterval(heartbeat); listeners.delete(reply.raw); if (!listeners.size) subscribers.delete(request.params.id); });
  });
  if (options.testMode) {
    app.get('/api/test/control', async () => controls.snapshot());
    app.post('/api/test/control', async request => {
      const body = object(request.body); only(body, ['action', 'barrier', 'point']);
      if (body.action === 'hold' || body.action === 'release') {
        if (!['run', 'translation', 'status'].includes(String(body.barrier))) throw new HttpError(400, 'Invalid barrier');
        controls[body.action](body.barrier as Barrier);
      } else if (body.action === 'fail-next') {
        if (!['source-transaction', 'job-transaction', 'translation', 'status'].includes(String(body.point))) throw new HttpError(400, 'Invalid failure point');
        controls.failures.add(body.point as FailurePoint);
      } else if (body.action === 'crash-after-source-commit') controls.crashAfterSourceCommit = true;
      else throw new HttpError(400, 'Invalid control action');
      return controls.snapshot();
    });
  }
  if (options.webRoot && existsSync(options.webRoot)) {
    await app.register(fastifyStatic, { root: options.webRoot });
    app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/') ? reply.code(404).send({ error: 'Not found' }) : reply.sendFile('index.html'));
  }
  app.addHook('preClose', async () => {
    stopping.abort(new Error('Server stopping'));
    for (const listeners of subscribers.values()) for (const response of listeners.keys()) response.end();
    await Promise.allSettled([...work]);
  });
  app.addHook('onClose', async () => store.close());
  store.recover();
  app.addHook('onListen', async () => pumpJobs());
  return app;
}
