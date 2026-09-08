import { translationChunkChars } from '../core/translation-settings.js';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { Store, HttpError } from './store.js';
import { readerDetail } from './reader.js';
import { chatActivities } from './chat-activity.js';
import { readerRoutes } from './reader-routes.js';
import { Controls, type Barrier, type FailurePoint } from './controls.js';
import { runMain, type MainHooks } from './model-runner.js';
import { prepareInputContext, ContextCompactionError } from './context-compaction.js';
import {
  previousContextPlan,
  contextSourceRefs,
  validateContextPlan,
  candidateCompilationSnapshot,
} from './context-planning.js';
import { executeRunBehaviorTool } from './package-behavior-run.js';
import { runAuxiliaryJob } from './product-auxiliary.js';
import { auxiliaryBridge } from './auxiliary-bridge.js';
import { productRoutes } from './product-routes.js';
import { registrationRoutes } from './provider-registration-routes.js';
import { providerConnectionTestRoutes } from './provider-connection-test.js';
import { storyRoutes } from './story-routes.js';
import { packageImageRoutes } from './package-images.js';
import { packageFeatureRoutes } from './package-features.js';
import { createPackageStart } from './package-start.js';
import { runStoryJob } from './story-runner.js';
import { deniedBrowserRequest, networkPolicy } from './network-policy.js';
import { VertexCredentialStore } from './vertex-credentials.js';
import {
  CodexRuntime,
  type CodexRuntimeOptions,
  type CodexRuntimeService,
} from './codex-runtime.js';
import { agentRuntimeRoutes } from './agent-runtime-routes.js';
import { ProviderContractError, type ProviderExecutionOptions } from '../core/transport.js';
import type { Connection } from '../core/product.js';

import { PROVIDER_PROTOCOLS } from '../core/product.js';
import type { Settings, RunSnapshot } from '../core/types.js';

export type AppOptions = {
  dbPath: string;
  buildId: string;
  instanceId?: string;
  testMode?: boolean;
  webRoot?: string;
  approvedOrigins?: string[];
  accessToken?: string;
  publicOrigin?: string;
  vertexRequestTier?: 'standard' | 'flex';
  codex?: CodexRuntimeOptions;
  codexRuntime?: CodexRuntimeService;
};
export type App = FastifyInstance & { store: Store; controls: Controls };
type RecordBody = Record<string, unknown>;
const object = (value: unknown): RecordBody => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new HttpError(400, 'Expected an object');
  return value as RecordBody;
};
const only = (body: RecordBody, keys: string[]) => {
  if (Object.keys(body).some((key) => !keys.includes(key)))
    throw new HttpError(400, 'Unknown request field');
};
const string = (value: unknown, name: string, max = 4000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new HttpError(400, `Invalid ${name}`);
  return value;
};
const integer = (value: unknown, name: string, min: number, max: number) => {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max)
    throw new HttpError(400, `Invalid ${name}`);
  return Number(value);
};
function settings(body: RecordBody): Settings {
  if (
    !['calm', 'vivid'].includes(String(body.preset)) ||
    !['direct', 'research'].includes(String(body.mode)) ||
    typeof body.translation !== 'boolean' ||
    typeof body.status !== 'boolean'
  )
    throw new HttpError(400, 'Invalid settings');
  let chunkChars: number | null;
  try {
    chunkChars = translationChunkChars(body.translationChunkChars);
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }
  return {
    preset: body.preset as Settings['preset'],
    mode: body.mode as Settings['mode'],
    translation: body.translation,
    translationChunkChars: chunkChars,
    status: body.status,
    maxCalls: integer(body.maxCalls, 'maxCalls', 1, 16),
  };
}

export async function createApp(options: AppOptions): Promise<App> {
  const network = networkPolicy(options);
  const app = Fastify({ logger: false, bodyLimit: 4 * 1024 * 1024 }) as unknown as App;
  const store = new Store(options.dbPath);
  const requireModel = (target: unknown, role: string) => {
    if (!options.testMode && !target) throw new HttpError(409, `MODEL_REQUIRED:${role}`);
  };
  const requireJobModel = (id: string) => {
    const job = store.job(id);
    const source = store.sourceAtHash(job.sourceRevision, job.sourceHash);
    const snapshot = store.product.resolveJobPrompt(store.run(source.runId).snapshot, job.input);
    requireModel(snapshot.profile?.models[job.kind], job.kind);
  };
  const credentials = new VertexCredentialStore(options.dbPath);
  const codex = options.codexRuntime ?? new CodexRuntime(options.dbPath, options.codex);
  const executeCodex: NonNullable<ProviderExecutionOptions['executeCodex']> = (
    connection,
    request,
    execution
  ) => {
    const authorize = () => {
      const current = store.product.get<Connection>('connection', connection.id);
      if (
        !current.enabled ||
        current.protocol !== connection.protocol ||
        current.endpoint !== connection.endpoint ||
        current.credentialEnv !== connection.credentialEnv
      )
        throw new ProviderContractError('CONNECTION_NOT_AUTHORIZED');
    };
    authorize();
    return codex.execute(connection, request, {
      ...execution,
      beforeTurn: () => {
        authorize();
        execution.beforeTurn?.();
      },
      onWire: async (wire) => {
        authorize();
        await execution.onWire?.(wire);
        authorize();
      },
    });
  };
  const resolveCredential: NonNullable<ProviderExecutionOptions['resolveCredential']> = async (
    reference,
    connection,
    signal
  ) => {
    const authorize = () => {
      if (!connection) throw new ProviderContractError('CREDENTIAL_UNAVAILABLE');
      const current = store.product.get<Connection>('connection', connection.id);
      if (
        !current.enabled ||
        current.protocol !== connection.protocol ||
        current.endpoint !== connection.endpoint ||
        current.credentialEnv !== reference
      )
        throw new ProviderContractError('CREDENTIAL_UNAVAILABLE');
    };
    authorize();
    const token = await credentials.resolve(reference, connection, signal);
    authorize();
    return token;
  };
  const controls = new Controls();
  const instanceId = options.instanceId ?? randomUUID();
  app.decorate('store', store);
  app.decorate('controls', controls);
  const subscribers = new Map<string, Map<ServerResponse, number>>();
  const streamAuthority = new Map<ServerResponse, () => boolean>();
  const work = new Set<Promise<void>>();
  const runs = new Map<string, AbortController>();
  const jobs = new Set<string>();
  const jobControllers = new Map<string, AbortController>();
  const storyControllers = new Map<string, AbortController>();
  const approvedOrigins = options.approvedOrigins ?? [];
  const stopping = new AbortController();
  const publish = (chatId: string) => {
    for (const [response, cursor] of subscribers.get(chatId) ?? []) {
      if (streamAuthority.get(response)?.() === false) {
        response.end();
        continue;
      }
      for (const event of store.events(chatId, cursor) as { seq: number }[]) {
        response.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
        subscribers.get(chatId)?.set(response, event.seq);
      }
    }
  };
  const track = (promise: Promise<void>) => {
    work.add(promise);
    void promise.finally(() => work.delete(promise));
  };
  const pumpJobs = () => {
    if (stopping.signal.aborted) return;
    for (const id of store.queuedJobs()) {
      if (jobs.has(id)) continue;
      jobs.add(id);
      const controller = new AbortController();
      jobControllers.set(id, controller);
      const signal = AbortSignal.any([controller.signal, stopping.signal]);
      track(
        (async () => {
          let chatId = '';
          try {
            const queued = store.job(id);
            chatId = queued.chatId;
            const source = store.sourceAtHash(queued.sourceRevision, queued.sourceHash);
            const snapshot = store.product.resolveJobPrompt(
              store.run(source.runId).snapshot,
              queued.input
            );
            requireModel(snapshot.profile?.models[queued.kind], queued.kind);
            const log = (kind: 'inputs' | 'toolEvents', value: unknown) => {
              const current = store.job(id);
              if (current.status !== 'running') return;
              const input = current.input as Record<string, unknown>;
              const prior = Array.isArray(input[kind]) ? input[kind] : [];
              store.db
                .prepare('UPDATE jobs SET input=? WHERE id=?')
                .run(JSON.stringify({ ...input, [kind]: [...prior, value] }), id);
            };
            await runAuxiliaryJob(auxiliaryBridge(store, controls, signal), id, instanceId, {
              signal,
              approvedOrigins,
              resolveCredential,
              executeCodex,
              authorize: (connection) => store.product.authorize(connection),
              vertexRequestTier: options.vertexRequestTier,
              onAttemptStart: (wire) => store.product.startAttempt(chatId, null, id, wire),
              onAttemptFinish: (attempt, result) => store.product.finishAttempt(attempt, result),
              onInput: (_id, input) => {
                log('inputs', input);
                if (!snapshot.profile?.models[queued.kind])
                  store.product.mockAttempt(chatId, null, id, queued.kind, input);
              },
              onToolEvent: (_id, event) => log('toolEvents', event),
              onProgress: () => publish(chatId),
              cancellationStatus: 'interrupted',
            });
          } catch (error) {
            if (!stopping.signal.aborted) {
              const current = store.job(id);
              const message =
                error instanceof Error &&
                (error.message.startsWith('Injected failure:') ||
                  error.message.startsWith('MODEL_REQUIRED:'))
                  ? error.message
                  : 'Auxiliary job failed';
              if (current.status === 'queued') store.failQueuedJob(id, current.generation, message);
              else if (current.status === 'running')
                store.failJob(id, current.generation, instanceId, message);
            }
          } finally {
            jobs.delete(id);
            jobControllers.delete(id);
            if (chatId && !stopping.signal.aborted) {
              publish(chatId);
              if (store.queuedJobs().length) queueMicrotask(pumpJobs);
            }
          }
        })()
      );
    }
  };
  const execute = (id: string) => {
    const controller = new AbortController();
    runs.set(id, controller);
    const onStop = () => controller.abort(new Error('Server stopping'));
    stopping.signal.addEventListener('abort', onStop, { once: true });
    track(
      (async () => {
        const run = store.run(id);
        try {
          if (!store.startRun(id)) return;
          requireModel(run.snapshot.profile?.models.main, 'main');
          publish(run.chatId);
          await controls.wait('run', controller.signal);
          const hooks: MainHooks = {
            signal: controller.signal,
            onInput: (input) => {
              store.input(id, input);
              if (run.snapshot.profile && !run.snapshot.profile.models.main)
                store.product.mockAttempt(run.chatId, id, null, 'main', input);
            },
            onToolEvent: (event) => store.tool(id, event),
            onBehaviorTool: (binding, action) =>
              executeRunBehaviorTool(store, id, binding, action, controller.signal),
            approvedOrigins,
            resolveCredential,
            executeCodex,
            authorize: (connection) => store.product.authorize(connection),
            vertexRequestTier: options.vertexRequestTier,
            onAttemptStart: (wire) => {
              if (controller.signal.aborted || store.run(id).status !== 'running')
                throw new Error('Run cancelled');
              const target =
                wire.agentId !== undefined
                  ? run.snapshot.profile?.collaborationModels?.[wire.agentId]
                  : wire.role === 'memory'
                    ? (run.snapshot.story?.models.memory ?? run.snapshot.profile?.models.main)
                    : run.snapshot.profile?.models.main;
              if (
                wire.agentId !== undefined &&
                (!target ||
                  target.modelId !== wire.modelId ||
                  target.connectionId !== wire.connectionId)
              )
                throw new Error('Invalid advisor attempt');
              if (target) store.product.authorize(target.connection);
              return store.product.startAttempt(run.chatId, id, null, wire);
            },
            onAttemptFinish: (attempt, result) => store.product.finishAttempt(attempt, result),
          };
          let executionSnapshot = run.snapshot;
          if (executionSnapshot.contextPlan) {
            const assertCurrent = () => {
              if (controller.signal.aborted || store.run(id).status !== 'running')
                throw new Error('CONTEXT_CANCELLED');
              if (
                store.product.branch(run.chatId, run.snapshot.branchId).headRevision !==
                  run.parentRevision ||
                JSON.stringify(contextSourceRefs(run.snapshot)) !==
                  JSON.stringify(
                    contextSourceRefs({
                      ...run.snapshot,
                      history: store.history(run.parentRevision),
                    })
                  ) ||
                (run.snapshot.story &&
                  store.story.memory.canonHash({
                    chatId: run.chatId,
                    history: run.snapshot.history,
                  }) !== run.snapshot.story.canonHash)
              )
                throw new Error('CONTEXT_DEPENDENCIES_CHANGED');
            };
            assertCurrent();
            const compilationSnapshot = candidateCompilationSnapshot(store, executionSnapshot, id);
            const reuse =
              executionSnapshot.candidateOf &&
              executionSnapshot.contextPlan.status === 'ready' &&
              executionSnapshot.promptCompilation;
            if (!reuse) {
              const prepared = await prepareInputContext(
                compilationSnapshot,
                {
                  ...hooks,
                  authorize: (connection) => {
                    assertCurrent();
                    return store.product.authorize(connection);
                  },
                  onAttemptStart: (wire) => {
                    assertCurrent();
                    return hooks.onAttemptStart(wire);
                  },
                  onProgress: (plan) => {
                    store.transaction(() => {
                      assertCurrent();
                      const current = store.run(id);
                      store.db
                        .prepare('UPDATE runs SET snapshot=?,updated_at=? WHERE id=?')
                        .run(
                          JSON.stringify({ ...current.snapshot, contextPlan: plan }),
                          new Date().toISOString(),
                          id
                        );
                      store.event(run.chatId, 'run.context.updated', id);
                    });
                    publish(run.chatId);
                  },
                },
                previousContextPlan(store, executionSnapshot)
              );
              prepared.snapshot.branchId = executionSnapshot.branchId;
              store.transaction(() => {
                assertCurrent();
                validateContextPlan(prepared.snapshot);
                store.db
                  .prepare('UPDATE runs SET snapshot=?,updated_at=? WHERE id=?')
                  .run(JSON.stringify(prepared.snapshot), new Date().toISOString(), id);
                store.event(run.chatId, 'run.context.updated', id);
              });
              executionSnapshot = prepared.snapshot;
              hooks.initialUsage = prepared.usage;
            }
          }
          const result = await runMain(executionSnapshot, hooks);
          if (controller.signal.aborted) {
            // Cancellation owns the terminal state; late provider usage is accounting only.
            store.settleCancelledUsage(id, result.usage);
            publish(run.chatId);
            return;
          }
          if (result.status !== 'completed') {
            store.finishRun(
              id,
              result.status === 'error' ? 'failed' : result.status,
              result.error ?? 'Provider execution ended',
              result.status === 'partial' ? result.text : '',
              result.usage
            );
            publish(run.chatId);
            return;
          }
          store.completeRun(id, result.text, result.usage, run.snapshot.settings, controls);
          if (controls.crashAfterSourceCommit) process.exit(86);
          publish(run.chatId);
          pumpJobs();
          pumpStory();
        } catch (error) {
          if (!stopping.signal.aborted) {
            if (error instanceof ContextCompactionError) {
              store.transaction(() => {
                const current = store.run(id);
                if (current.status === 'running')
                  store.db
                    .prepare('UPDATE runs SET snapshot=? WHERE id=?')
                    .run(JSON.stringify({ ...current.snapshot, contextPlan: error.plan }), id);
              });
              store.finishRun(
                id,
                controller.signal.aborted ? 'cancelled' : 'failed',
                error.message,
                '',
                error.usage
              );
              if (controller.signal.aborted) store.settleCancelledUsage(id, error.usage);
              publish(run.chatId);
              return;
            }
            const message = error instanceof Error ? error.message : '';
            const safeError =
              message === 'Model call budget exhausted' ||
              message.startsWith('Injected failure:') ||
              message.startsWith('MODEL_REQUIRED:') ||
              message.startsWith('CONTEXT_')
                ? message
                : controller.signal.aborted
                  ? 'Run cancelled'
                  : 'Scripted generation failed';
            store.finishRun(id, controller.signal.aborted ? 'cancelled' : 'failed', safeError);
            publish(run.chatId);
          }
        } finally {
          runs.delete(id);
          stopping.signal.removeEventListener('abort', onStop);
        }
      })()
    );
  };
  const pumpStory = () => {
    if (stopping.signal.aborted) return;
    for (const [id, controller] of storyControllers)
      if (!['queued', 'running'].includes(store.story.job(id).status)) controller.abort();
    for (const runId of store.story.resumeWaiting()) execute(runId);
    for (const id of store.story.queued()) {
      if (storyControllers.size >= 2) break;
      if (storyControllers.has(id)) continue;
      const job = store.story.claim(id, instanceId);
      if (!job) continue;
      const controller = new AbortController();
      storyControllers.set(id, controller);
      const signal = AbortSignal.any([controller.signal, stopping.signal]);
      track(
        (async () => {
          try {
            publish(job.chatId);
            await controls.wait(job.kind, signal);
            controls.fail(job.kind);
            requireModel(store.story.bundle(id).snapshot.story?.models[job.kind], job.kind);
            const result = await runStoryJob(store.story.bundle(id), {
              signal,
              approvedOrigins,
              resolveCredential,
              executeCodex,
              authorize: (connection) => store.product.authorize(connection),
              vertexRequestTier: options.vertexRequestTier,
              onAttemptStart: (wire) =>
                store.transaction(() => {
                  const current = store.story.job(id);
                  if (
                    current.status !== 'running' ||
                    current.generation !== job.generation ||
                    current.owner !== instanceId
                  )
                    throw new Error('STORY_JOB_STALE');
                  const models = store.story.bundle(id).snapshot.story!.models;
                  const target =
                    wire.role === 'memory' ? (models.memory ?? models[job.kind]) : models[job.kind];
                  if (target) store.product.authorize(target.connection);
                  const attempt = store.product.startAttempt(job.chatId, null, null, wire);
                  store.db
                    .prepare('UPDATE attempts SET story_job_id=? WHERE id=?')
                    .run(id, attempt);
                  return attempt;
                }),
              onAttemptFinish: (attempt, result) => store.product.finishAttempt(attempt, result),
              onInput: (input) => {
                store.story.diagnostic(id, job.generation, instanceId, 'inputs', input);
                if (job.mock) {
                  const attempt = store.product.mockAttempt(
                    job.chatId,
                    null,
                    null,
                    job.kind,
                    input
                  );
                  store.db
                    .prepare('UPDATE attempts SET story_job_id=? WHERE id=?')
                    .run(id, attempt);
                }
              },
              onToolEvent: (event) =>
                store.story.diagnostic(id, job.generation, instanceId, 'tool_events', event),
            });
            store.story.finish(id, job.generation, instanceId, result);
          } catch (error) {
            if (job) {
              const safe =
                error instanceof Error &&
                (error.message.startsWith('Injected failure:') ||
                  error.message.startsWith('MODEL_REQUIRED:'))
                  ? error.message
                  : signal.aborted
                    ? '보조 작업이 중단됐어요.'
                    : '상태·기억 결과를 검증하지 못했어요.';
              store.story.finish(id, job.generation, instanceId, {
                status: signal.aborted ? 'interrupted' : 'failed',
                result: null,
                error: safe,
                mock: job.mock,
              });
            }
          } finally {
            storyControllers.delete(id);
            if (!stopping.signal.aborted) {
              publish(store.story.job(id).chatId);
              queueMicrotask(pumpStory);
            }
          }
        })()
      );
    }
  };

  app.addHook('onRequest', async (request) => {
    const denied = deniedBrowserRequest(network, {
      method: request.method,
      headers: {
        host: request.headers.host,
        origin: request.headers.origin,
        'sec-fetch-site':
          typeof request.headers['sec-fetch-site'] === 'string'
            ? request.headers['sec-fetch-site']
            : undefined,
      },
    });
    if (denied) throw new HttpError(403, denied);
  });
  app.setErrorHandler((error, _request, reply) => {
    const statusCode =
      error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined;
    const code =
      error instanceof HttpError
        ? error.statusCode
        : typeof statusCode === 'number' && statusCode < 500
          ? statusCode
          : 500;
    void reply.code(code).send({
      error:
        error instanceof HttpError
          ? error.message
          : code === 400
            ? 'Invalid request'
            : 'Request failed',
    });
  });
  const session = productRoutes(app, store, {
    credentials,
    codex,
    approvedOrigins,
    accessToken: options.accessToken,
    publicOrigin: network.publicOrigin,
    publish,
    onChatDeleted: (chatId) => {
      for (const response of subscribers.get(chatId)?.keys() ?? []) {
        if (streamAuthority.get(response)?.() !== false)
          response.write(`data: ${JSON.stringify({ kind: 'chat.deleted', chatId })}\n\n`);
        response.end();
      }
      subscribers.delete(chatId);
    },
    onAuthChanged: () => {
      for (const chatId of subscribers.keys()) publish(chatId);
    },
  });
  readerRoutes(app, store);
  registrationRoutes(app, store, {
    approvedOrigins,
    resolveCredential,
    executeCodex,
    signal: stopping.signal,
    vertexRequestTier: options.vertexRequestTier,
    track,
    authenticated: session.authenticated,
  });
  providerConnectionTestRoutes(app, store, {
    approvedOrigins,
    resolveCredential,
    executeCodex,
    signal: stopping.signal,
    vertexRequestTier: options.vertexRequestTier,
    track,
    authenticated: session.authenticated,
  });
  agentRuntimeRoutes(app, codex);
  storyRoutes(app, store, {
    publish,
    pump: pumpStory,
    execute,
    abort: (id) => storyControllers.get(id)?.abort(),
  });
  packageImageRoutes(app, store, { publish, pump: pumpJobs });
  packageFeatureRoutes(app, store);
  app.post<{ Params: { id: string } }>('/api/chats/:id/package-start', async (request) => {
    const result = createPackageStart(store, request.params.id, request.body, (snapshot) =>
      requireModel(snapshot.profile?.models.main, 'main')
    );
    if (result.created) {
      publish(result.run.chatId);
      if (result.run.status === 'queued') execute(result.run.id);
      else if (result.run.status === 'waiting_for_state') pumpStory();
    }
    return result;
  });
  app.get('/api/health', async () => ({
    ready: true,
    testMode: options.testMode === true,
    buildId: options.buildId,
    instanceId,
    dbPath: options.dbPath,
    mode: network.publicOrigin ? 'self-host' : 'local-provider-runtime',
    supportedProtocols: [...PROVIDER_PROTOCOLS],
    vertexRequestTier: options.vertexRequestTier ?? null,
  }));
  app.get('/api/chats', async () => store.chats());
  app.get('/api/chat-activities', async () => chatActivities(store));
  app.post('/api/chats', async (request) => {
    const body = object(request.body);
    only(body, ['title', 'preset', 'botId', 'folderId']);
    if (body.preset !== undefined && !['calm', 'vivid'].includes(String(body.preset)))
      throw new HttpError(400, 'Invalid preset');
    return store.createChat(
      string(body.title, 'title', 120),
      body.preset as Settings['preset'] | undefined,
      {
        ...(body.botId === undefined ? {} : { botId: string(body.botId, 'bot ID', 100) }),
        ...(body.folderId === undefined
          ? {}
          : { folderId: body.folderId === null ? null : string(body.folderId, 'folder ID', 100) }),
      }
    );
  });
  app.get<{ Params: { id: string } }>('/api/chats/:id', async (request) =>
    store.detail(request.params.id)
  );
  app.get<{ Params: { id: string }; Querystring: Record<string, string | undefined> }>(
    '/api/chats/:id/reader',
    async (request) => readerDetail(store, request.params.id, request.query)
  );
  app.patch<{ Params: { id: string } }>('/api/chats/:id/settings', async (request) => {
    const body = object(request.body);
    only(body, [
      'expectedSettingsRevision',
      'preset',
      'mode',
      'translation',
      'translationChunkChars',
      'status',
      'maxCalls',
    ]);
    const chat = store.settings(
      request.params.id,
      integer(body.expectedSettingsRevision, 'settings revision', 1, 1e9),
      settings(body)
    );
    publish(chat.id);
    return chat;
  });
  app.post<{ Params: { id: string } }>('/api/chats/:id/runs', async (request) => {
    const body = object(request.body);
    only(body, [
      'request',
      'expectedRevision',
      'expectedSettingsRevision',
      'idempotencyKey',
      'branchId',
      'expectedProfileRevision',
      'packageRequestId',
      'loreContextReset',
    ]);
    if (body.loreContextReset !== undefined && typeof body.loreContextReset !== 'boolean')
      throw new HttpError(400, 'Invalid lore context reset');
    const command = {
      ...(body.loreContextReset !== undefined
        ? { loreContextReset: body.loreContextReset as boolean }
        : {}),
      ...(body.packageRequestId !== undefined
        ? { packageRequestId: string(body.packageRequestId, 'package request', 120) }
        : {}),
      request: string(body.request, 'request'),
      expectedRevision:
        body.expectedRevision === null
          ? null
          : string(body.expectedRevision, 'source revision', 100),
      expectedSettingsRevision: integer(body.expectedSettingsRevision, 'settings revision', 1, 1e9),
      idempotencyKey: string(body.idempotencyKey, 'idempotency key', 120),
      ...(body.branchId !== undefined ? { branchId: string(body.branchId, 'branch ID', 100) } : {}),
      ...(body.expectedProfileRevision !== undefined
        ? {
            expectedProfileRevision: integer(
              body.expectedProfileRevision,
              'profile revision',
              1,
              1e9
            ),
          }
        : {}),
    };
    const result = store.createRun(request.params.id, command, (chat) => {
      const profile = store.product.snapshot(chat.id);
      requireModel(profile.models.main, 'main');
      return {
        chatId: chat.id,
        parentRevision: chat.headRevision,
        settingsRevision: chat.settingsRevision,
        settings: chat.settings,
        request: command.request,
        history: store.history(chat.headRevision),
        resources: store.product.resources(chat.id, profile),
        ...(profile ? { profile } : {}),
      } satisfies RunSnapshot;
    });
    if (result.created) {
      publish(request.params.id);
      if (result.run.status === 'queued') execute(result.run.id);
    }
    return result.run;
  });
  app.get<{ Params: { id: string } }>('/api/runs/:id', async (request) =>
    store.run(request.params.id)
  );
  app.post<{ Params: { id: string } }>('/api/runs/:id/candidate', async (request) => {
    const body = object(request.body);
    only(body, ['idempotencyKey', 'title']);
    const result = store.candidate(
      request.params.id,
      string(body.idempotencyKey, 'idempotency key', 120),
      body.title === undefined ? '후보 분기' : string(body.title, 'title', 200),
      (snapshot) => requireModel(snapshot.profile?.models.main, 'main')
    );
    if (result.created) {
      publish(result.run.chatId);
      execute(result.run.id);
    }
    return result.run;
  });
  app.post<{ Params: { id: string } }>('/api/runs/:id/cancel', async (request) => {
    const run = store.finishRun(request.params.id, 'cancelled', 'Run cancelled');
    runs.get(run.id)?.abort(new Error('Run cancelled'));
    publish(run.chatId);
    return run;
  });
  app.post<{ Params: { id: string } }>('/api/jobs/:id/retry', async (request) => {
    const body = object(request.body ?? {});
    only(body, []);
    const job = store.retryJob(request.params.id, requireJobModel);
    publish(job.chatId);
    pumpJobs();
    return job;
  });
  app.post<{ Params: { id: string } }>('/api/jobs/:id/cancel', async (request) => {
    const job = store.cancelJob(request.params.id);
    jobControllers.get(job.id)?.abort(new Error('Job cancelled'));
    publish(job.chatId);
    return job;
  });
  app.post<{ Params: { id: string } }>('/api/sources/:id/status', async (request) => {
    const body = object(request.body);
    only(body, ['expectedSourceHash', 'expectedJobId']);
    const job = store.requestStatus(
      request.params.id,
      string(body.expectedSourceHash, 'source hash', 64),
      body.expectedJobId === null ? null : string(body.expectedJobId, 'status job', 100),
      requireJobModel
    );
    publish(job.chatId);
    pumpJobs();
    return job;
  });
  app.post<{ Params: { id: string } }>('/api/sources/:id/translation', async (request) => {
    const body = object(request.body ?? {});
    only(body, []);
    const job = store.requestTranslation(request.params.id, requireJobModel);
    publish(job.chatId);
    pumpJobs();
    return job;
  });
  app.post<{ Params: { id: string } }>('/api/sources/:id/retranslate', async (request) => {
    const body = object(request.body ?? {});
    only(body, []);
    const job = store.retranslate(request.params.id, requireJobModel);
    publish(job.chatId);
    pumpJobs();
    return job;
  });
  app.put<{ Params: { id: string } }>(
    '/api/sources/:id/text',
    { bodyLimit: 8 * 1024 * 1024 },
    async (request) => {
      const body = object(request.body);
      only(body, ['text', 'expectedRevision']);
      const source = store.editSource(request.params.id, {
        text: string(body.text, 'source text', 2_000_000),
        expectedRevision: integer(
          body.expectedRevision,
          'source edit revision',
          0,
          Number.MAX_SAFE_INTEGER
        ),
      });
      for (const [jobId, controller] of jobControllers) {
        const job = store.job(jobId);
        if (job.sourceRevision === source.id && job.sourceHash !== source.hash)
          controller.abort(new Error('Source edited'));
      }
      for (const [jobId, controller] of storyControllers)
        if (store.story.job(jobId).status === 'stale') controller.abort();
      pumpStory();
      publish(source.chatId);
      return source;
    }
  );
  app.put<{ Params: { id: string } }>(
    '/api/sources/:id/translation',
    { bodyLimit: 8 * 1024 * 1024 },
    async (request) => {
      const body = object(request.body);
      only(body, ['text', 'expectedRevision', 'expectedSourceHash']);
      const job = store.editTranslation(request.params.id, {
        text: string(body.text, 'translation text', 2_000_000),
        expectedRevision: integer(
          body.expectedRevision,
          'translation revision',
          0,
          Number.MAX_SAFE_INTEGER
        ),
        expectedSourceHash: string(body.expectedSourceHash, 'source hash', 64),
      });
      jobControllers.get(job.id)?.abort(new Error('Translation edited'));
      publish(job.chatId);
      return job;
    }
  );
  app.get<{ Params: { id: string } }>('/api/chats/:id/events', async (request, reply) => {
    store.chat(request.params.id);
    const rawCursor = request.headers['last-event-id'];
    const cursor = rawCursor === undefined ? 0 : Number(rawCursor);
    if (!Number.isSafeInteger(cursor) || cursor < 0)
      throw new HttpError(400, 'Invalid event cursor');
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff',
      'X-Accel-Buffering': 'no',
    });
    const listeners = subscribers.get(request.params.id) ?? new Map<ServerResponse, number>();
    subscribers.set(request.params.id, listeners);
    listeners.set(reply.raw, cursor);
    streamAuthority.set(reply.raw, () => session.authenticated(request.headers.cookie));
    reply.raw.write(`data: ${JSON.stringify({ kind: 'snapshot', chatId: request.params.id })}\n\n`);
    publish(request.params.id);
    const heartbeat = setInterval(() => {
      if (!session.authenticated(request.headers.cookie)) reply.raw.end();
      else reply.raw.write(': keepalive\n\n');
    }, 15000);
    heartbeat.unref();
    reply.raw.on('close', () => {
      clearInterval(heartbeat);
      streamAuthority.delete(reply.raw);
      listeners.delete(reply.raw);
      if (!listeners.size) subscribers.delete(request.params.id);
    });
  });
  if (options.testMode) {
    app.get('/api/test/control', async () => controls.snapshot());
    app.post('/api/test/control', async (request) => {
      const body = object(request.body);
      only(body, ['action', 'barrier', 'point']);
      if (body.action === 'hold' || body.action === 'release') {
        if (
          !['run', 'translation', 'status', 'image', 'state', 'memory'].includes(
            String(body.barrier)
          )
        )
          throw new HttpError(400, 'Invalid barrier');
        controls[body.action](body.barrier as Barrier);
      } else if (body.action === 'fail-next') {
        if (
          ![
            'source-transaction',
            'job-transaction',
            'translation',
            'status',
            'image',
            'state',
            'memory',
          ].includes(String(body.point))
        )
          throw new HttpError(400, 'Invalid failure point');
        controls.failures.add(body.point as FailurePoint);
      } else if (body.action === 'crash-after-source-commit')
        controls.crashAfterSourceCommit = true;
      else throw new HttpError(400, 'Invalid control action');
      return controls.snapshot();
    });
  }
  if (options.webRoot && existsSync(options.webRoot)) {
    await app.register(fastifyStatic, { root: options.webRoot });
    app.setNotFoundHandler((request, reply) =>
      request.url.startsWith('/api/')
        ? reply.code(404).send({ error: 'Not found' })
        : reply.sendFile('index.html')
    );
  }
  app.addHook('preClose', async () => {
    stopping.abort(new Error('Server stopping'));
    await codex.close();
    for (const listeners of subscribers.values())
      for (const response of listeners.keys()) response.end();
    await Promise.allSettled([...work]);
  });
  app.addHook('onClose', async () => store.close());
  store.recover();
  store.story.recover();
  app.addHook('onListen', async () => {
    pumpJobs();
    pumpStory();
  });
  return app;
}
