import { normalizeChatSettings } from '../core/chat-settings.js';
import { createRunExecutor } from './run-executor.js';
import { APP_VERSION } from './app-version.js';
import { flushPendingImageCleanup } from './unused-data.js';
import { themeRoutes } from './themes.js';
import { inputTranslationRoutes } from './input-translation.js';
import { ChatTranscriptError } from '../core/chat-transcript.js';
import { resourceRoutes } from './resource-routes.js';
import { rejudgeTranslation } from './source-editing.js';
import { HttpError, fields, number, record, text } from './request-validation.js';
import { promptWorkspaceRoutes } from './prompt-workspace.js';
import { loreContextDefaultRoutes } from './lore-context-defaults.js';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { Store } from './store.js';
import { ChatTitleService } from './chat-title.js';
import { HelperRuntime, helperWritingSnapshot } from './helper-runtime.js';
import { readHelperChatContext } from './helper-context.js';
import { helperRoutes } from './helper-routes.js';
import { contextRoutes } from './context-routes.js';
import { ChatOverridesStore, chatOverrideRoutes } from './chat-overrides.js';
import { chatOptionRoutes } from './chat-options.js';
import { chatVariableRoutes } from './chat-variable-routes.js';
import { ResponseStreamStore, responseStreamRoutes } from './response-stream.js';
import { readerActivities, readerDetail, readerRuns } from './reader.js';
import { chatActivities } from './chat-activity.js';
import { readerRoutes } from './reader-routes.js';
import { Controls, type Barrier, type FailurePoint } from './controls.js';
import { type MainHooks } from './model-runner.js';
import { prepareInputContext } from './context-compaction.js';
import { prepareNativeRisuReadOnly } from './risu-native-readonly.js';
import { createNativeRisuHost } from './risu-native-host.js';
import { nativeInteractionRoutes } from './risu-native-interactions.js';
import { disposeAllNativeRisuSessions } from './risu-native-runtime.js';
import { validateImageJudgmentWire } from './image-judgment.js';
import { validateTranslationJudgmentWire } from './jev-attribution.js';
import { runAuxiliaryJob } from './product-auxiliary.js';
import { auxiliaryBridge } from './auxiliary-bridge.js';
import { productRoutes } from './product-routes.js';
import { providerConnectionTestRoutes } from './provider-connection-test.js';
import { storyRoutes } from './story-routes.js';
import { outlineRoutes } from './outline-routes.js';
import { packageImageRoutes, imageCatalog, imageTargetSource } from './package-images.js';
import { nativeTransferRoutes } from './native-transfer.js';
import { risuImportRoutes } from './risu-import.js';
import { applyNativeRisuAction } from './risu-native-actions.js';
import { pruneUploads, uploadRoutes } from './uploads.js';
import { admissionOpen, maintenanceRoutes, maintenanceStatus } from './maintenance.js';
import { risuPresetImportRoutes } from './risu-preset-import.js';
import { risuExportRoutes } from './risu-export.js';
import { NativeTransferError } from '../core/native-transfer-validation.js';
import { diagnosticReportRoutes } from './diagnostic-report.js';
import { packageFeatureRoutes } from './package-features.js';
import { reconcileIllustrationJob, runIllustrationJob } from './illustration-runner.js';
import { illustrationJob, illustrationRoutes, queuedIllustrations } from './illustrations.js';
import { createPackageStart } from './package-start.js';
import { deniedBrowserRequest, networkPolicy } from './network-policy.js';
import { VertexCredentialStore } from './vertex-credentials.js';
import { JevCredentialStore } from './jev-credentials.js';
import { jevProviderRoutes } from './jev-provider.js';
import {
  CodexRuntime,
  type CodexRuntimeOptions,
  type CodexRuntimeService,
} from './codex-runtime.js';
import { agentRuntimeRoutes } from './agent-runtime-routes.js';
import {
  ProviderContractError,
  type ProviderExecutionOptions,
  type WireRecord,
} from '../core/transport.js';
import type { Connection } from '../core/product.js';
import type { CodexImageRequest } from './codex-runtime.js';

import { PROVIDER_PROTOCOLS } from '../core/product.js';
import type { RunSnapshot } from '../core/types.js';

export type AppOptions = {
  dbPath: string;
  buildId: string;
  instanceId?: string;
  testMode?: boolean;
  webRoot?: string;

  accessToken?: string;
  publicOrigin?: string;
  vertexRequestTier?: 'standard' | 'flex';
  codex?: CodexRuntimeOptions;
  codexRuntime?: CodexRuntimeService;
  /** Boots with writes closed and no worker start: a candidate only proves migration and reads. */
  maintenance?: boolean;
};
export type App = FastifyInstance & { store: Store; controls: Controls };
type RecordBody = Record<string, unknown>;

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
    if (job.kind !== 'image') requireModel(snapshot.profile?.models[job.kind], job.kind);
  };
  const credentials = new VertexCredentialStore(store.db);
  const jevCredentials = new JevCredentialStore(store.db);
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
        current.credentialRef !== connection.credentialRef
      )
        throw new ProviderContractError('CONNECTION_NOT_AUTHORIZED');
    };
    authorize();
    return codex.execute(connection, request, {
      ...execution,
      beforeTurn: async () => {
        authorize();
        await execution.beforeTurn?.();
      },
      onWire: async (wire) => {
        authorize();
        await execution.onWire?.(wire);
        authorize();
      },
    });
  };
  /** Illustration turns share the Codex login and the same live-connection authorization. */
  const generateCodexImage = (
    connection: Connection,
    request: CodexImageRequest,
    execution: {
      signal: AbortSignal;
      timeoutMs?: number;
      onWire: (wire: WireRecord) => void | Promise<void>;
    }
  ) => {
    const authorize = () => {
      const current = store.product.get<Connection>('connection', connection.id);
      if (
        !current.enabled ||
        current.protocol !== connection.protocol ||
        current.endpoint !== connection.endpoint ||
        current.credentialRef !== connection.credentialRef
      )
        throw new ProviderContractError('CONNECTION_NOT_AUTHORIZED');
    };
    authorize();
    return codex.generateImage(
      {
        id: connection.id,
        protocol: connection.protocol,
        endpoint: connection.endpoint,
        ...(connection.credentialRef ? { credentialRef: connection.credentialRef } : {}),
      },
      request,
      {
        signal: execution.signal,
        timeoutMs: execution.timeoutMs,
        beforeTurn: authorize,
        onWire: async (wire) => {
          authorize();
          await execution.onWire(wire);
          authorize();
        },
      }
    );
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
        current.credentialRef !== reference
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
  const jobControllers = new Map<string, AbortController>();
  const illustrationControllers = new Map<string, AbortController>();

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
    const settled = () => {
      work.delete(promise);
      if (!work.size) {
        try {
          flushPendingImageCleanup(store.db);
        } catch {
          app.log.error(
            { code: 'IMAGE_CLEANUP_DEFERRED' },
            'Image cleanup will retry on restart or the next settled task'
          );
        }
      }
    };
    void promise.then(settled, () => {
      settled();
      // A storage/finalization failure can escape a worker's own handler. Observe
      // it without creating an unhandled child rejection or logging manuscript data.
      app.log.error({ code: 'BACKGROUND_TASK_FAILED' }, 'Background task did not settle normally');
    });
  };
  const streams = new ResponseStreamStore(store);
  const helper: HelperRuntime = new HelperRuntime(store, {
    owner: instanceId,

    resolveCredential,
    executeCodex,
    vertexRequestTier: options.vertexRequestTier,
    signal: stopping.signal,
    track,
    streams,
    services: {
      context: async (task, name, args, hooks, operationId) => {
        const scope = task.snapshot.scope;
        if (scope.kind !== 'chat') throw new HttpError(403, 'CHAT_SCOPE_REQUIRED');
        if (name === 'context.read')
          return readHelperChatContext(store, scope.chatId, scope.branchId);
        const key = `helper:${task.id}:${operationId}`;
        const base = {
          branchId: scope.branchId,
          expectedHeadRevision: task.snapshot.writing!.parentRevision,
          idempotencyKey: key,
        };
        if (name === 'notes.write')
          return store.story.notes.write(scope.chatId, {
            ...record(args.body),
            ...base,
            author: '사용자 도우미 요청',
          });
        const snapshot = await prepareNativeRisuReadOnly(
          helperWritingSnapshot(store, scope.chatId, scope.branchId, 'context'),
          'context'
        );
        if (name === 'context.edit')
          return store.context.edit(
            scope.chatId,
            {
              ...base,
              expectedRevision: number(args.expectedRevision, 'context revision', 0),
              summary: text(args.summary, 'summary', 200000),
            },
            snapshot
          );
        const job = store.context.schedule(
          scope.chatId,
          { ...base, expectedRevision: number(args.expectedRevision, 'context revision', 0) },
          snapshot
        );
        if (job.status !== 'queued') return job;
        if (!job.snapshot) throw new HttpError(409, 'CONTEXT_INPUT_MISSING');
        const input = job.snapshot;
        if (!store.context.start(job.id)) return store.context.job(job.id);
        try {
          const remaining =
            task.snapshot.limits.totalCalls - helper.workspace.task(task.id).usage.modelCalls;
          const prepared = await prepareInputContext(
            {
              ...input,
              settings: {
                ...input.settings,
                maxCalls: Math.min(input.settings.maxCalls, remaining),
              },
            },
            {
              ...hooks,
              reason: 'manual',
              reserveCalls: 1,
              onResponseProgress: undefined,
              onProgress: () => {},
              onAttemptStart: async (wire) => {
                const attempt = await hooks.onAttemptStart(wire);
                store.db
                  .prepare('INSERT INTO context_job_attempts VALUES(?,?)')
                  .run(job.id, attempt);
                return attempt;
              },
            },
            store.context.previous(input)
          );
          hooks.signal.throwIfAborted();
          return store.context.finish(job.id, prepared.snapshot);
        } catch (error) {
          if (hooks.signal.aborted) store.context.cancel(scope.chatId, job.id);
          else
            store.context.fail(
              job.id,
              error instanceof Error ? error.message : 'CONTEXT_COMPACTION_FAILED'
            );
          throw error;
        }
      },
    },
  });
  const titles = new ChatTitleService(store, {
    resolveCredential,
    executeCodex,
    vertexRequestTier: options.vertexRequestTier,
    signal: stopping.signal,
    track,
    publish,
  });

  // Maintenance keeps admitted work finishing but starts no new external work.
  const forcedClosed = options.maintenance === true;
  const admitted = () => admissionOpen(store, forcedClosed);
  const pumpJobs = () => {
    if (stopping.signal.aborted || !admitted()) return;
    for (const id of store.queuedJobs()) {
      if (jobControllers.has(id)) continue;
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
            if (
              queued.kind !== 'image' &&
              !(queued.kind === 'translation' && record(queued.input).judgmentRecovery)
            )
              requireModel(snapshot.profile?.models[queued.kind], queued.kind);
            await runAuxiliaryJob(auxiliaryBridge(store, controls, signal), id, instanceId, {
              jev: { credential: jevCredentials.resolve },
              signal,

              resolveCredential,
              executeCodex,
              authorize: (connection) => store.product.authorize(connection),
              vertexRequestTier: options.vertexRequestTier,
              onAttemptStart: (wire) => {
                if (wire.judgment) {
                  const current = store.job(id);
                  if (current.status !== 'running' || signal.aborted)
                    throw new Error('Judgment job is inactive');
                  if (current.kind === 'image')
                    validateImageJudgmentWire(
                      imageTargetSource(store, current),
                      imageCatalog(current.input),
                      wire
                    );
                  else if (current.kind === 'translation')
                    validateTranslationJudgmentWire(
                      current.sourceHash,
                      record(record(current.input).translationPolicy).judgment,
                      wire,
                      record(current.input).judgmentRecovery?.text
                    );
                  else throw new Error('Invalid judgment job kind');
                }
                return store.product.startAttempt(chatId, null, id, wire);
              },
              onAttemptFinish: (attempt, result) => store.product.finishAttempt(attempt, result),
              onInput: (_id, input) => {
                if (queued.kind !== 'image' && !snapshot.profile?.models[queued.kind])
                  store.product.mockAttempt(chatId, null, id, queued.kind, input);
              },
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
  /** Illustration work never shares a queue, slot or transaction with story text jobs. */
  const pumpIllustrations = () => {
    if (stopping.signal.aborted || !admitted()) return;
    for (const id of queuedIllustrations(store)) {
      if (illustrationControllers.has(id)) continue;
      const controller = new AbortController();
      illustrationControllers.set(id, controller);
      const signal = AbortSignal.any([controller.signal, stopping.signal]);
      track(
        (async () => {
          let chatId = '';
          let requeued = false;
          let attempt = 1;
          try {
            const queued = illustrationJob(store, id);
            chatId = queued.chatId;
            attempt = queued.attempt;
            const outcome = await runIllustrationJob(store, id, instanceId, {
              signal,

              resolveCredential,
              resolveComfyCredential: (name) => process.env[name],
              cancelRemoteOnAbort: () => controller.signal.aborted && !stopping.signal.aborted,
              executeCodex,
              generateCodexImage,
              authorize: (connection) => store.product.authorize(connection),
              onAttemptStart: (wire) => store.product.startAttempt(chatId, null, null, wire),
              onAttemptFinish: (attemptId, result) =>
                store.product.finishAttempt(attemptId, result),
              onProgress: () => publish(chatId),
              cancellationStatus: 'interrupted',
              allowFixture: options.testMode === true,
              gate: async () => {
                await controls.wait('illustration', signal);
                signal.throwIfAborted();
                controls.fail('illustration');
              },
            });
            requeued = outcome?.status === 'requeued';
          } catch {
            if (!stopping.signal.aborted)
              store.transaction(() => {
                const changed = store.db
                  .prepare(
                    "UPDATE illustration_jobs SET status='failed',owner=NULL,error='ILLUSTRATION_FAILED',updated_at=? WHERE id=? AND status='running' AND owner=?"
                  )
                  .run(new Date().toISOString(), id, instanceId);
                if (changed.changes && chatId) store.event(chatId, 'illustration.failed', id);
              });
          } finally {
            illustrationControllers.delete(id);
            if (chatId && !stopping.signal.aborted) {
              publish(chatId);
              if (queuedIllustrations(store).length) {
                // Automatic retries back off briefly outside test mode; a manual pump is immediate.
                const delay = requeued && !options.testMode ? Math.min(5000, attempt * 1000) : 0;
                if (delay) setTimeout(pumpIllustrations, delay).unref();
                else queueMicrotask(pumpIllustrations);
              }
            }
          }
        })()
      );
    }
  };
  const execute = createRunExecutor({
    store,
    controls,
    streams,
    signal: stopping.signal,
    runs,
    track,
    requireModel,
    resolveCredential,
    executeCodex,
    batchPollIntervalMs: options.testMode ? 5 : 10_000,
    vertexRequestTier: options.vertexRequestTier,
    jevCredential: jevCredentials.resolve,
    publish,
    afterSource: (id) => {
      pumpJobs();
      pumpIllustrations();
      if (admitted()) titles.afterSource(id);
    },
  });
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
    const transferCode =
      error instanceof NativeTransferError && /^NATIVE_TRANSFER_[A-Z0-9_]{1,100}$/.test(error.code);
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
        error instanceof HttpError || error instanceof ChatTranscriptError || transferCode
          ? error.message
          : code === 400
            ? 'Invalid request'
            : 'Request failed',
    });
  });
  const session = productRoutes(app, store, {
    maintenance: () => maintenanceStatus(store, forcedClosed),
    credentials,
    codex,

    accessToken: options.accessToken,
    publicOrigin: network.publicOrigin,
    publish,
    onChatDeleted: (chatId) => {
      titles.cancel(chatId);
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
  helperRoutes(app, helper);
  chatOptionRoutes(app, store);
  chatVariableRoutes(app, store, publish);
  contextRoutes(app, store, {
    signal: stopping.signal,
    track,
    snapshot: (chatId, branchId) =>
      prepareNativeRisuReadOnly(
        helperWritingSnapshot(store, chatId, store.product.branch(chatId, branchId).id, 'context'),
        'context'
      ),
    execute: async (job, signal) => {
      const snapshot = job.snapshot;
      if (!snapshot) throw new HttpError(409, 'CONTEXT_INPUT_MISSING');
      const hooks: MainHooks = {
        signal: AbortSignal.any([signal, stopping.signal]),

        resolveCredential,
        executeCodex,
        vertexRequestTier: options.vertexRequestTier,
        authorize: (connection) => store.product.authorize(connection),
        onInput: () => {},
        onToolEvent: () => {},
        onAttemptStart: (wire) =>
          store.transaction(() => {
            if (
              signal.aborted ||
              stopping.signal.aborted ||
              store.context.job(job.id).status !== 'running'
            )
              throw new Error('CONTEXT_CANCELLED');
            const target = snapshot.profile?.contextModel;
            if (!target) throw new Error('MODEL_REQUIRED:context');
            store.product.authorize(target.connection);
            const attempt = store.product.startAttempt(job.chatId, null, null, wire);
            store.db.prepare('INSERT INTO context_job_attempts VALUES(?,?)').run(job.id, attempt);
            return attempt;
          }),
        onAttemptFinish: (id, result) => store.product.finishAttempt(id, result),
      };
      const prepared = await prepareInputContext(
        snapshot,
        { ...hooks, reason: 'manual', reserveCalls: 0, onProgress: () => {} },
        store.context.previous(snapshot)
      );
      return prepared.snapshot;
    },
  });
  resourceRoutes(app, store);
  themeRoutes(app, store);
  inputTranslationRoutes(app, store, {
    signal: stopping.signal,
    resolveCredential,
    executeCodex,
    vertexRequestTier: options.vertexRequestTier,
    track,
  });
  chatOverrideRoutes(app, new ChatOverridesStore(store), publish);
  responseStreamRoutes(app, streams, { authenticated: session.authenticated });
  providerConnectionTestRoutes(app, store, {
    resolveCredential,
    executeCodex,
    signal: stopping.signal,
    vertexRequestTier: options.vertexRequestTier,
    track,
    authenticated: session.authenticated,
  });
  agentRuntimeRoutes(app, codex);
  jevProviderRoutes(app, store, jevCredentials, {
    signal: stopping.signal,
    track,
    authenticated: session.authenticated,
  });
  storyRoutes(app, store, {
    publish,
    execute,
  });
  outlineRoutes(app, store, { publish });
  packageImageRoutes(app, store, { publish, pump: pumpJobs });
  illustrationRoutes(app, store, {
    publish,
    pump: pumpIllustrations,
    abort: (id) => illustrationControllers.get(id)?.abort(new Error('Illustration cancelled')),
    testMode: options.testMode === true,
    reconcile: (id) =>
      reconcileIllustrationJob(store, id, instanceId, {
        signal: AbortSignal.any([AbortSignal.timeout(20_000), stopping.signal]),
        resolveCredential: (name) => process.env[name],
        onProgress: () => publish(illustrationJob(store, id).chatId),
      }),
    resolveCredential: (name) => process.env[name],
  });
  packageFeatureRoutes(app, store);
  nativeTransferRoutes(app, store);
  uploadRoutes(app, store.path);
  risuImportRoutes(app, store);
  nativeInteractionRoutes(app, store);
  app.post<{ Params: { id: string; sourceId: string } }>(
    '/api/chats/:id/sources/:sourceId/risu-action',
    async (request) => {
      const controller = new AbortController();
      const onStop = () => controller.abort();
      stopping.signal.addEventListener('abort', onStop, { once: true });
      let actionRunId: string | undefined;
      try {
        const result = await applyNativeRisuAction(
          store,
          request.params.id,
          request.params.sourceId,
          request.body,
          {
            signal: controller.signal,
            createHost: (runId, snapshot, usage) => {
              actionRunId = runId;
              runs.set(runId, controller);
              publish(request.params.id);
              return createNativeRisuHost(
                store,
                runId,
                snapshot,
                usage,
                {
                  resolveCredential,
                  executeCodex,
                  vertexRequestTier: options.vertexRequestTier,
                },
                'user-action'
              );
            },
          }
        );
        publish(request.params.id);
        return result;
      } finally {
        if (actionRunId) runs.delete(actionRunId);
        stopping.signal.removeEventListener('abort', onStop);
      }
    }
  );
  risuPresetImportRoutes(app, store);
  risuExportRoutes(app, store);
  diagnosticReportRoutes(app, store, { buildId: options.buildId, testMode: options.testMode });
  app.post<{ Params: { id: string } }>('/api/chats/:id/package-start', async (request) => {
    const result = createPackageStart(store, request.params.id, request.body);
    if (result.created) {
      publish(result.run.chatId);
      if (result.run.status === 'queued') execute(result.run.id);
    }
    return result;
  });
  app.get('/api/health', async () => ({
    ready: true,
    version: APP_VERSION,
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
    const body: RecordBody = record(request.body);
    fields(body, ['title', 'botId', 'folderId', 'autoTitle']);
    if (body.autoTitle !== undefined && typeof body.autoTitle !== 'boolean')
      throw new HttpError(400, 'Invalid automatic title choice');
    const chat = store.createChat(text(body.title, 'title', 120), {
      ...(body.botId === undefined ? {} : { botId: text(body.botId, 'bot ID', 100) }),
      ...(body.folderId === undefined
        ? {}
        : { folderId: body.folderId === null ? null : text(body.folderId, 'folder ID', 100) }),
    });
    if (body.autoTitle === true) titles.enroll(chat.id);
    return chat;
  });
  app.patch<{ Params: { id: string } }>('/api/chats/:id/title', async (request) => {
    const body = record(request.body);
    fields(body, ['title', 'expectedTitleRevision']);
    const chat = store.renameChat(
      request.params.id,
      text(body.title, 'chat title', 200),
      number(body.expectedTitleRevision, 'title revision', 0)
    );
    titles.cancel(chat.id);
    publish(chat.id);
    return chat;
  });

  app.get<{ Params: { id: string } }>('/api/chats/:id', async (request) =>
    store.detail(request.params.id)
  );
  app.get<{ Params: { id: string }; Querystring: Record<string, string | undefined> }>(
    '/api/chats/:id/reader',
    async (request) => readerDetail(store, request.params.id, request.query)
  );
  app.get<{ Params: { id: string } }>('/api/chats/:id/reader-runs', async (request) =>
    readerRuns(store, request.params.id)
  );
  app.get<{ Params: { id: string }; Querystring: Record<string, string | undefined> }>(
    '/api/chats/:id/activities',
    async (request) => readerActivities(store, request.params.id, request.query)
  );
  app.patch<{ Params: { id: string } }>('/api/chats/:id/settings', async (request) => {
    const body: RecordBody = record(request.body);
    fields(body, ['expectedSettingsRevision', 'status', 'maxCalls']);
    const chat = store.settings(
      request.params.id,
      number(body.expectedSettingsRevision, 'settings revision', 1, 1e9),
      normalizeChatSettings(body)
    );
    publish(chat.id);
    return chat;
  });
  app.post<{ Params: { id: string } }>('/api/chats/:id/runs', async (request) => {
    const body: RecordBody = record(request.body);
    fields(body, [
      'request',
      'expectedRevision',
      'expectedSettingsRevision',
      'idempotencyKey',
      'branchId',
      'expectedProfileRevision',
      'loreContextReset',
    ]);
    if (body.loreContextReset !== undefined && typeof body.loreContextReset !== 'boolean')
      throw new HttpError(400, 'Invalid lore context reset');
    const command = {
      ...(body.loreContextReset !== undefined
        ? { loreContextReset: body.loreContextReset as boolean }
        : {}),
      request: text(body.request, 'request'),
      expectedRevision:
        body.expectedRevision === null ? null : text(body.expectedRevision, 'source revision', 100),
      expectedSettingsRevision: number(body.expectedSettingsRevision, 'settings revision', 1, 1e9),
      idempotencyKey: text(body.idempotencyKey, 'idempotency key', 120),
      ...(body.branchId !== undefined ? { branchId: text(body.branchId, 'branch ID', 100) } : {}),
      ...(body.expectedProfileRevision !== undefined
        ? {
            expectedProfileRevision: number(
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
  promptWorkspaceRoutes(app, store, publish);
  loreContextDefaultRoutes(app, store);
  app.post<{ Params: { id: string } }>('/api/runs/:id/retry', async (request) => {
    const body = record(request.body);
    fields(body, ['idempotencyKey', 'request']);
    const result = store.retryRun(
      request.params.id,
      text(body.idempotencyKey, 'idempotency key', 120),
      (snapshot) => requireModel(snapshot.profile?.models.main, 'main'),
      body.request === undefined ? undefined : text(body.request, 'request')
    );
    if (result.created) {
      publish(result.run.chatId);
      execute(result.run.id);
    }
    return result.run;
  });
  app.post<{ Params: { id: string } }>('/api/runs/:id/candidate', async (request) => {
    const body: RecordBody = record(request.body);
    fields(body, ['idempotencyKey', 'title']);
    const result = store.candidate(
      request.params.id,
      text(body.idempotencyKey, 'idempotency key', 120),
      body.title === undefined ? '후보 분기' : text(body.title, 'title', 200),
      (snapshot) => requireModel(snapshot.profile?.models.main, 'main')
    );
    if (result.created) {
      publish(result.run.chatId);
      execute(result.run.id);
    }
    return result.run;
  });
  app.post<{ Params: { id: string } }>('/api/runs/:id/rejudge', async (request) => {
    const body = record(request.body);
    fields(body, ['idempotencyKey']);
    const result = store.candidate(
      request.params.id,
      text(body.idempotencyKey, 'idempotency key', 120),
      '판정 복구',
      undefined,
      true
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
  app.post<{ Params: { id: string } }>('/api/jobs/:id/rejudge', async (request) => {
    fields(record(request.body ?? {}), []);
    const job = rejudgeTranslation(store, request.params.id);
    publish(job.chatId);
    pumpJobs();
    return job;
  });
  app.post<{ Params: { id: string } }>('/api/jobs/:id/retry', async (request) => {
    const body: RecordBody = record(request.body ?? {});
    fields(body, []);
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
    const body: RecordBody = record(request.body);
    fields(body, ['expectedSourceHash', 'expectedJobId']);
    const job = store.requestStatus(
      request.params.id,
      text(body.expectedSourceHash, 'source hash', 64),
      body.expectedJobId === null ? null : text(body.expectedJobId, 'status job', 100),
      requireJobModel
    );
    publish(job.chatId);
    pumpJobs();
    return job;
  });
  app.post<{ Params: { id: string } }>('/api/sources/:id/translation', async (request) => {
    const body: RecordBody = record(request.body ?? {});
    fields(body, []);
    const job = store.requestTranslation(request.params.id, requireJobModel);
    publish(job.chatId);
    pumpJobs();
    return job;
  });
  app.post<{ Params: { id: string } }>('/api/sources/:id/retranslate', async (request) => {
    const body: RecordBody = record(request.body ?? {});
    fields(body, []);
    const job = store.retranslate(request.params.id, requireJobModel);
    publish(job.chatId);
    pumpJobs();
    return job;
  });
  app.put<{ Params: { id: string } }>(
    '/api/sources/:id/text',
    { bodyLimit: 8 * 1024 * 1024 },
    async (request) => {
      const body: RecordBody = record(request.body);
      fields(body, ['text', 'expectedRevision']);
      const source = store.editSource(request.params.id, {
        text: text(body.text, 'source text', 2_000_000),
        expectedRevision: number(
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
      publish(source.chatId);
      return source;
    }
  );
  app.put<{ Params: { id: string } }>(
    '/api/sources/:id/translation',
    { bodyLimit: 8 * 1024 * 1024 },
    async (request) => {
      const body: RecordBody = record(request.body);
      fields(body, ['text', 'expectedRevision', 'expectedSourceHash']);
      const job = store.editTranslation(request.params.id, {
        text: text(body.text, 'translation text', 2_000_000),
        expectedRevision: number(
          body.expectedRevision,
          'translation revision',
          0,
          Number.MAX_SAFE_INTEGER
        ),
        expectedSourceHash: text(body.expectedSourceHash, 'source hash', 64),
      });
      jobControllers.get(job.id)?.abort(new Error('Translation edited'));
      publish(job.chatId);
      return job;
    }
  );
  app.get<{ Params: { id: string } }>('/api/chats/:id/events', async (request, reply) => {
    store.chat(request.params.id);
    const rawCursor = request.headers['last-event-id'];
    const cursor =
      rawCursor === undefined ? store.latestEventSequence(request.params.id) : Number(rawCursor);
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
    reply.raw.write(
      `id: ${cursor}\ndata: ${JSON.stringify({ kind: 'snapshot', chatId: request.params.id, seq: cursor })}\n\n`
    );
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
      const body: RecordBody = record(request.body);
      fields(body, ['action', 'barrier', 'point', 'preset', 'mode']);
      if (body.action === 'fixture') {
        if (body.preset !== undefined && !['calm', 'vivid'].includes(String(body.preset)))
          throw new HttpError(400, 'Invalid fixture preset');
        if (body.mode !== undefined && !['direct', 'research'].includes(String(body.mode)))
          throw new HttpError(400, 'Invalid fixture mode');
        controls.fixture = {
          preset: body.preset as 'calm' | 'vivid' | undefined,
          mode: body.mode as 'direct' | 'research' | undefined,
        };
      } else if (body.action === 'hold' || body.action === 'release') {
        if (
          !['run', 'translation', 'status', 'image', 'state', 'context', 'illustration'].includes(
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
            'context',
            'illustration',
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
  app.addHook('onClose', async () => {
    disposeAllNativeRisuSessions();
    store.close();
  });
  // Authentication answers first; a maintenance gate never tells an anonymous caller the state.
  maintenanceRoutes(app, store, { forcedClosed, activeWork: () => work.size });
  // A maintenance boot proves migration and reads only: it neither recovers nor starts work.
  pruneUploads(store.path);
  let recoveredRuns: string[] = [];
  if (!forcedClosed) {
    recoveredRuns = store.recover();
    helper.workspace.interrupt();
    streams.recover();
    flushPendingImageCleanup(store.db);
  }
  app.addHook('onListen', async () => {
    for (const runId of recoveredRuns) execute(runId, true);
    pumpJobs();
    pumpIllustrations();
  });
  return app;
}
