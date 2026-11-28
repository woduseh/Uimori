import { PushService, pushRoutes } from './push-service.js';
import type { PushSender } from './push-transport.js';
import { basename, relative, sep } from 'node:path';
import { usageRoutes } from './usage-report.js';
import { readingStateRoutes } from './reading-state.js';
import { ManuscriptSearch, manuscriptSearchRoutes } from './manuscript-search.js';
import { BackupService, backupRoutes } from './backup-service.js';
import { illustrationPresetRoutes } from './illustration-presets.js';
import { normalizeChatSettings } from '../core/chat-settings.js';
import { projectStoryUiText } from '../core/story-ui.js';
import { storyUiRoutes } from './story-ui-routes.js';
import { compileStoryUiBlocks } from './story-ui.js';
import { compileEditedSourceText, storyUiAssetResolver } from './story-ui-assets.js';
import { autoTranslationDefaultRoutes } from './auto-translation-defaults.js';
import { chatGenerationDefaultRoutes } from './chat-generation-defaults.js';
import { REQUEST_TEXT_MAX_CHARS, SOURCE_TEXT_MAX_CHARS } from '../core/content-limits.js';
import { createRunExecutor } from './run-executor.js';
import { imageInputSupported } from '../core/provider-images.js';
import { sameVertexProject } from '../core/vertex-location.js';
import { APP_VERSION } from './app-version.js';
import { PendingImageCleanup, flushPendingImageCleanup } from './unused-data.js';
import { themeRoutes } from './themes.js';
import { themeAssetRoutes } from './theme-assets.js';
import { fontRoutes } from './fonts.js';
import { inputTranslationRoutes } from './input-translation.js';
import { storyGuideRoutes } from './story-guide-routes.js';
import { selectionRevisionRoutes } from './selection-revision.js';
import { resourceRoutes } from './resource-routes.js';
import { rejudgeTranslation, sourceVersions } from './source-editing.js';
import { setSceneTitle } from './scene-titles.js';
import { updateSceneContext } from './scene-context.js';
import { chatTitle, HttpError, fields, number, record, text } from './request-validation.js';
import { z } from 'zod/v4';
import { nonBlank } from '#contracts/operations';
import { AppError, asAppError, errorWire, storedModelRequired } from './app-errors.js';
import { checkEndpointOutputs, registerRawRoute } from './endpoint.js';
import { promptWorkspaceRoutes } from './prompt-workspace.js';
import { loreContextDefaultRoutes } from './lore-context-defaults.js';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type RouteOptions,
} from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { readTranslationSelection, readStoredRunSnapshot, runResponse } from './run-projections.js';
import { composerRunSnapshot } from './composer-run.js';
import { ChatTitleService } from './chat-title.js';
import { createChat } from './chat-creation.js';
import { HelperRuntime, helperWritingSnapshot } from './helper-runtime.js';
import { invokeTaskTool } from './helper-task-tools.js';
import { readHelperChatContext } from './helper-context.js';
import { helperRoutes } from './helper-routes.js';
import { contextRoutes } from './context-routes.js';
import { chatOptionRoutes } from './chat-options.js';
import { chatVariableRoutes } from './chat-variable-routes.js';
import {
  ResponseStreamStore,
  pruneUnreachableResponseChunks,
  responseStreamRoutes,
} from './response-stream.js';
import { precomputePackagePresentation } from './package-presentation-routes.js';
import { chatEventResume, createChatEventStreams } from './chat-event-stream.js';
import { createLiveHub, LIVE_FRAME_EVENTS, type LiveFrameEvent } from './live-events.js';
import { readerActivities, readerDetail, readerRuns } from './reader.js';
import { dismissReaderRun } from './run-reader-state.js';
import { activityFeed, acknowledgedActivities, acknowledgeActivities } from './activity-feed.js';
import { readerRoutes } from './reader-routes.js';
import { Controls, FAILURE_POINTS, type Barrier, type FailurePoint } from './controls.js';
import { type MainHooks } from './model-runner.js';
import { prepareInputContext } from './context-compaction.js';
import { contextFailureCode } from './context-failure.js';
import { failureLabel } from './failure-label.js';
import { prepareNativeRisuReadOnly } from './risu-native-readonly.js';
import { createNativeRisuHost } from './risu-native-host.js';
import { nativeInteractionRoutes } from './risu-native-interactions.js';
import { disposeAllNativeRisuSessions } from './risu-native-runtime.js';
import { validateImageJudgmentWire } from './image-judgment.js';
import { validateTranslationJudgmentWire } from './jev-attribution.js';
import { runAuxiliaryJob } from './product-auxiliary.js';
import { recordToolDiagnostic, startToolDiagnostic } from './execution-diagnostics.js';
import { auxiliaryBridge } from './auxiliary-bridge.js';
import { productRoutes } from './product-routes.js';
import { requestMetricsRoutes } from './request-metrics.js';
import { registerResponseCompression } from './response-compression.js';
import { revalidatePrivateJson } from './private-etag.js';
import { connectionTestRoutes, createConnectionTestRunner } from './provider-connection-test.js';
import { storyRoutes } from './story-routes.js';
import { sceneDeletionRoutes } from './scene-deletion.js';
import { orphanMemoryRoutes } from './orphan-memory.js';
import { outlineRoutes } from './outline-routes.js';
import { packageImageRoutes, imageCatalog, imageTargetSource } from './package-images.js';
import { risuImportRoutes } from './risu-import.js';
import { applyNativeRisuAction } from './risu-native-actions.js';
import { withRisuFailureCode } from './risu-failure-code.js';
import { pruneUploads, uploadRoutes } from './uploads.js';
import { startImportStagingCleanup } from './import-staging-cleanup.js';
import { requestFileRoutes } from './request-files.js';
import {
  prepareRequestImages,
  releaseRequestImageUploads,
  requestImageUploads,
  storeRequestImages,
} from './request-images.js';
import { admissionOpen, maintenanceRoutes, maintenanceStatus } from './maintenance.js';
import { risuPresetImportRoutes } from './risu-preset-import.js';
import { risuExportRoutes } from './risu-export.js';
import { packageFeatureRoutes } from './package-features.js';
import { reconcileIllustrationJob, runIllustrationJob } from './illustration-runner.js';
import {
  cancelIllustration,
  illustrationJob,
  illustrationRoutes,
  NOVELAI_CREDENTIAL_ID,
  queuedIllustrations,
  retryIllustration,
} from './illustrations.js';
import { CredentialStore } from './credentials.js';
import { createPackageStart } from './package-start.js';
import { deniedBrowserRequest, mcpToken, networkPolicy } from './network-policy.js';
import { mcpRoutes } from './mcp-routes.js';
import { VertexCredentialStore } from './vertex-credentials.js';
import { JevCredentialStore } from './jev-credentials.js';
import { jevSettings } from './jev-settings.js';
import { judgmentRuntime, assertJudgmentRuntimeWire } from './judgment-runtime.js';
import { readImage as readJevImage } from './image-storage.js';
import {
  autoTranslationNeedsConfirmation,
  codexContentWarningRoutes,
} from './codex-content-warning.js';
import { jevProviderRoutes } from './jev-provider.js';
import {
  CodexRuntime,
  type CodexRuntimeOptions,
  type CodexRuntimeService,
} from './codex-runtime.js';
import { agentRuntimeRoutes } from './agent-runtime-routes.js';
import {
  ProviderContractError,
  type ProviderConnection,
  type ProviderExecutionOptions,
  type WireRecord,
} from '../core/transport.js';
import type { Connection } from '../core/product.js';
import type { CodexImageRequest, CodexImageResult, CodexSession } from './codex-runtime.js';

import { PROVIDER_PROTOCOLS } from '../core/product.js';
import type { RunSnapshot } from '../core/types.js';
import { recordHelperTaskResult } from './helper-task-results.js';

export type AppOptions = {
  dbPath: string;
  backupDirectory?: string;
  pushSender?: PushSender;
  buildId: string;
  instanceId?: string;
  testMode?: boolean;
  webRoot?: string;

  accessToken?: string;
  mcpToken?: string;
  publicOrigin?: string;
  vertexRequestTier?: 'standard' | 'flex';
  codex?: CodexRuntimeOptions;
  codexRuntime?: CodexRuntimeService;
  maintenance?: boolean;
  onRoute?: (route: RouteOptions) => void;
};
export type App = FastifyInstance & { store: Store; controls: Controls };
type RecordBody = Record<string, unknown>;
const DOCUMENT_CONTENT_SECURITY_POLICY =
  "script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

export async function createApp(options: AppOptions): Promise<App> {
  const network = networkPolicy(options);
  const mcp = mcpToken(options.mcpToken, options.accessToken);
  const app = Fastify({ logger: false, bodyLimit: 4 * 1024 * 1024 }) as unknown as App;
  if (options.onRoute) app.addHook('onRoute', options.onRoute);
  if (options.testMode) checkEndpointOutputs(app);
  await registerResponseCompression(app);
  revalidatePrivateJson(app);
  const requestMetrics = requestMetricsRoutes(app);
  const store = new Store(options.dbPath);
  const requireModel = (target: unknown, role: string) => {
    if (!options.testMode && !target) throw new AppError(409, 'MODEL_REQUIRED', { role });
  };
  const requireRequestModel = (snapshot: RunSnapshot) => {
    const target = snapshot.profile?.models.main;
    requireModel(target, 'main');
    if (
      snapshot.requestImages?.length &&
      target &&
      imageInputSupported(target.connection.protocol, target.modelId) === false
    )
      throw new AppError(400, 'IMAGE_INPUT_UNSUPPORTED_MODEL');
  };
  const requireJobModel = (id: string) => {
    const job = store.job(id);
    if (job.kind === 'status') throw new HttpError(410, 'SCENE_COMMENTARY_RETIRED');
    const source = store.sourceAtHash(job.sourceRevision, job.sourceHash);
    const snapshot = readTranslationSelection(store, source.runId, job.input);
    if (job.kind === 'translation') requireModel(snapshot.profile?.models.translation, job.kind);
  };
  const credentials = new VertexCredentialStore(store.db);
  const jevCredentials = new JevCredentialStore(store.db);
  const codex = options.codexRuntime ?? new CodexRuntime(options.dbPath, options.codex);
  const authorizeCodex = (connection: ProviderConnection) => {
    const current = store.product.stored<Connection>('connection', connection.id);
    if (
      !current.enabled ||
      current.protocol !== connection.protocol ||
      current.endpoint !== connection.endpoint ||
      current.credentialRef !== connection.credentialRef
    )
      throw new ProviderContractError('CONNECTION_NOT_AUTHORIZED');
  };
  const executeCodex: NonNullable<ProviderExecutionOptions['executeCodex']> = (
    connection,
    request,
    execution
  ) => {
    const authorize = () => authorizeCodex(connection);
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
  const executeCodexAgent: CodexRuntimeService['executeAgent'] = (
    connection,
    request,
    execution
  ) => {
    authorizeCodex(connection);
    return codex.executeAgent(connection, request, {
      ...execution,
      beforeTurn: async () => {
        authorizeCodex(connection);
        await execution.beforeTurn?.();
      },
      onWire: async (wire) => {
        authorizeCodex(connection);
        await execution.onWire?.(wire);
        authorizeCodex(connection);
      },
    });
  };
  let illustrationSession: { key: string; session: CodexSession } | undefined;
  const closeIllustrationSession = async () => {
    const current = illustrationSession;
    illustrationSession = undefined;
    await current?.session.close();
  };
  const generateCodexImage = (
    connection: Connection,
    request: CodexImageRequest,
    execution: {
      signal: AbortSignal;
      timeoutMs?: number;
      onWire: (wire: WireRecord) => void | Promise<void>;
    },
    sessionKey?: string
  ): Promise<CodexImageResult> => {
    const authorize = () => authorizeCodex(connection);
    authorize();
    return (async () => {
      if (illustrationSession?.key !== sessionKey) await closeIllustrationSession();
      if (sessionKey && !illustrationSession && codex.createSession)
        illustrationSession = { key: sessionKey, session: codex.createSession(connection) };
      const session = illustrationSession?.session;
      const generate = session
        ? (
            _connection: ProviderConnection,
            imageRequest: CodexImageRequest,
            executionOptions: ProviderExecutionOptions
          ) => session.generateImage(imageRequest, executionOptions)
        : codex.generateImage.bind(codex);
      let result = await generate(
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
      if (
        session &&
        ['CODEX_SESSION_MISMATCH', 'CODEX_SESSION_FULL'].includes(result.error?.code ?? '')
      ) {
        await closeIllustrationSession();
        result = await generateCodexImage(connection, request, execution);
      }
      if (result.status !== 'completed') await closeIllustrationSession();
      return result;
    })();
  };
  const resolveCredential: NonNullable<ProviderExecutionOptions['resolveCredential']> = async (
    reference,
    connection,
    signal
  ) => {
    const authorize = () => {
      if (!connection) throw new ProviderContractError('CREDENTIAL_UNAVAILABLE');
      const current = store.product.stored<Connection>('connection', connection.id);
      if (
        !current.enabled ||
        current.protocol !== connection.protocol ||
        (current.endpoint !== connection.endpoint &&
          !(
            connection.protocol === 'vertex-gemini-v1' &&
            sameVertexProject(current.endpoint, connection.endpoint)
          )) ||
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
  const streams = new ResponseStreamStore(store);
  const chatEvents = createChatEventStreams({
    events: (chatId, after) => store.events(chatId, after),
    latestEventSequence: (chatId) => store.latestEventSequence(chatId),
    streams,
  });
  const work = new Set<Promise<void>>();
  const imageCleanup = new PendingImageCleanup(store);
  const runs = new Map<string, AbortController>();
  const jobControllers = new Map<string, AbortController>();
  const illustrationControllers = new Map<
    string,
    { controller: AbortController; lane: 'render' | 'text' }
  >();

  const stopping = new AbortController();
  const forcedClosed = options.maintenance === true;
  const admitted = () => admissionOpen(store, forcedClosed);
  let recoveredRuns: string[] = [];
  const deferredRuns = new Map<string, boolean>();
  const live = createLiveHub(store, { instanceId, publishChat: chatEvents.publish });
  store.observeChanges((chatId) => live.notify(chatId));
  store.observeInvalidations((name) => live.invalidate(name));
  const publish = (chatId: string) => {
    chatEvents.publish(chatId);
    live.notify();
  };
  const publishAll = () => {
    chatEvents.publishAll();
    live.notify();
  };
  const track = (promise: Promise<void>) => {
    work.add(promise);
    const settled = () => {
      work.delete(promise);
      if (!work.size) void imageCleanup.flush();
    };
    void promise.then(settled, () => {
      settled();
      process.stderr.write('BACKGROUND_TASK_FAILED\n');
    });
  };
  const precomputeAdmittedPresentation = (sourceId: string) =>
    precomputePackagePresentation(
      store,
      sourceId,
      () => !stopping.signal.aborted && admitted(),
      track
    );
  const sceneUpdated = (sourceId: string) => {
    const source = store.source(sourceId);
    for (const [jobId, controller] of jobControllers) {
      const job = store.job(jobId);
      if (
        job.sourceRevision === sourceId &&
        (job.sourceHash !== source.hash || ['stale', 'cancelled'].includes(job.status))
      )
        controller.abort(new Error('Scene edited'));
    }
    publish(source.chatId);
    pumpIllustrations();
  };
  const connectionTests = createConnectionTestRunner(store, {
    resolveCredential,
    executeCodex,
    signal: stopping.signal,
    vertexRequestTier: options.vertexRequestTier,
    track,
  });
  const helper: HelperRuntime = new HelperRuntime(store, {
    owner: instanceId,
    testMode: options.testMode === true,
    resolveCredential,
    executeCodex,
    executeCodexAgent,
    vertexRequestTier: options.vertexRequestTier,
    signal: stopping.signal,
    canStart: admitted,
    track,
    streams,
    services: {
      connectionTests,
      sceneUpdated,
      chatChanged: publish,
      chatCreated: (chatId, autoTitleLocale) => {
        if (autoTitleLocale) titles.enroll(chatId, autoTitleLocale);
        publish(chatId);
      },
      chatDeleted: (chatId) => chatDeleted(chatId),
      story: {
        requireRunModel: requireRequestModel,
        requireTranslationModel: requireJobModel,
        started: (work) => {
          if ('run' in work) {
            publish(work.run.chatId);
            execute(work.run.id);
          } else {
            publish(work.job.chatId);
            pumpJobs();
          }
        },
      },
      illustrationsUpdated: (chatId, queued) => {
        publish(chatId);
        if (queued) pumpIllustrations();
      },
      task: (task, name, args, operationId) => {
        const afterCommit: (() => void)[] = [];
        const invoke = () =>
          invokeTaskTool(store, task, name, args, operationId, {
            cancelRun: (id) => {
              const run = store.finishRun(id, 'cancelled', 'Run cancelled');
              afterCommit.push(() => {
                runs.get(id)?.abort(new Error('Run cancelled'));
                publish(run.chatId);
              });
            },
            retryRun: (id, key) => {
              const result = store.retryRun(id, key, (snapshot) =>
                requireModel(snapshot.profile?.models.main, 'main')
              );
              if (result.created) {
                afterCommit.push(() => {
                  publish(result.run.chatId);
                  execute(result.run.id);
                });
              }
              return { id: result.run.id };
            },
            cancelJob: (id) => {
              const job = store.cancelJob(id);
              afterCommit.push(() => {
                jobControllers.get(id)?.abort(new Error('Job cancelled'));
                publish(job.chatId);
              });
            },
            retryJob: (id) => {
              const job = store.retryJob(id, requireJobModel);
              afterCommit.push(() => {
                publish(job.chatId);
                pumpJobs();
              });
              return { id: job.id };
            },
            cancelIllustration: (id) => {
              const job = cancelIllustration(store, id);
              afterCommit.push(() => {
                illustrationControllers
                  .get(id)
                  ?.controller.abort(new Error('Illustration cancelled'));
                publish(job.chatId);
              });
            },
            retryIllustration: (id) => {
              const job = retryIllustration(store, id);
              afterCommit.push(() => {
                publish(job.chatId);
                pumpIllustrations();
              });
            },
            cancelHelper: (id) => {
              helper.workspace.cancel(id);
              afterCommit.push(() => {
                helper.cancel(id);
              });
            },
            retryHelper: (id, key) => {
              const previous = helper.workspace.task(id);
              const retried = helper.enqueue(
                previous.conversationId,
                key,
                previous.request,
                previous.snapshot.editor,
                previous.snapshot.selection,
                previous.id,
                previous.snapshot.outlineTarget,
                false
              );
              afterCommit.push(() => {
                helper.pump();
              });
              return { id: retried.id };
            },
          });
        const result =
          name === 'task.inspect' || name === 'task.list'
            ? invoke()
            : helper.workspace.operation(
                task.id,
                `${task.id}:${operationId}`,
                { name, args },
                invoke
              );
        for (const effect of afterCommit) effect();
        return result;
      },
      context: async (task, name, args, hooks, operationId) => {
        const scope = task.snapshot.scope;
        if (scope.kind !== 'chat') throw new HttpError(403, 'CHAT_SCOPE_REQUIRED');
        if (name === 'context.read') return readHelperChatContext(store, scope.chatId, args);
        const key = `helper:${task.id}:${operationId}`;
        const base = {
          expectedHeadRevision: task.snapshot.writing!.parentRevision,
          idempotencyKey: key,
        };
        if (name === 'notes.write') {
          const receiptId = `${task.id}:${operationId}`;
          return helper.workspace.operation(task.id, receiptId, { name, args }, () => {
            const saved = store.story.notes.write(scope.chatId, {
              ...record(args.body),
              ...base,
              author: '사용자 도우미 요청',
            });
            recordHelperTaskResult(helper.workspace, task, {
              receiptId,
              operation: name,
              requestedTargets: 1,
              targets: [
                {
                  kind: 'notes',
                  id: scope.chatId,
                  chatId: scope.chatId,
                  title: store.chat(scope.chatId).title,
                  revision: saved.revision,
                },
              ],
            });
            return saved;
          });
        }
        const snapshot = await prepareNativeRisuReadOnly(
          helperWritingSnapshot(store, scope.chatId),
          'context'
        );
        hooks.signal.throwIfAborted();
        if (name === 'context.edit')
          return helper.workspace.operation(
            task.id,
            `${task.id}:${operationId}`,
            { name, args },
            () =>
              store.context.edit(
                scope.chatId,
                {
                  ...base,
                  expectedRevision: number(args.expectedRevision, 'context revision', 0),
                  summary: text(args.summary, 'summary', SOURCE_TEXT_MAX_CHARS),
                },
                snapshot
              )
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
            task.snapshot.limits.totalCalls - helper.workspace.taskState(task.id).usage.modelCalls;
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
          return helper.workspace.operation(
            task.id,
            `${task.id}:${operationId}`,
            { name, args },
            () => {
              const saved = store.context.finish(job.id, prepared.snapshot);
              if (saved.status !== 'completed') throw new HttpError(409, 'CONTEXT_JOB_NOT_RUNNING');
              return saved;
            }
          );
        } catch (error) {
          if (hooks.signal.aborted) store.context.cancel(scope.chatId, job.id);
          else store.context.fail(job.id, contextFailureCode(error));
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
  const chatDeleted = (chatId: string) => {
    titles.cancel(chatId);
    chatEvents.closeChat(chatId, { kind: 'chat.deleted', chatId });
  };

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
          let translationStream: ReturnType<ResponseStreamStore['createWriter']> | undefined;
          try {
            const queued = store.job(id);
            const judgment = judgmentRuntime(store, jevCredentials.resolve);
            if (queued.kind === 'status') throw new HttpError(410, 'SCENE_COMMENTARY_RETIRED');
            chatId = queued.chatId;
            const reservation =
              queued.kind === 'translation' && queued.input ? record(queued.input) : undefined;
            if (
              reservation?.autoTranslateRunId &&
              (!Object.hasOwn(reservation, 'translationModelSelection') ||
                reservation.translationModelSnapshot?.connection?.protocol ===
                  'codex-app-server-v1')
            ) {
              const source = store.sourceAtHash(queued.sourceRevision, queued.sourceHash);
              const snapshot = readTranslationSelection(store, source.runId, queued.input);
              if (
                await autoTranslationNeedsConfirmation(
                  snapshot.profile?.models.translation,
                  source.text,
                  jevCredentials.resolve,
                  signal,
                  jevSettings(store.db),
                  { store, chatId, jobId: id }
                )
              ) {
                store.failQueuedJob(
                  id,
                  queued.generation,
                  'Codex 콘텐츠 경고를 확인해야 해요. 원문에서 번역 보기를 눌러 진행해 주세요.'
                );
                return;
              }
            }
            const bridge = auxiliaryBridge(store, controls, signal, (target, recovery) => {
              if (!recovery) requireModel(target, 'translation');
            });
            const outcome = await runAuxiliaryJob(bridge, id, instanceId, {
              jev: {
                ...judgment,
                readImage: (hash) => readJevImage(store.db, hash).bytes,
              },
              signal,

              resolveCredential,
              executeCodex,
              authorize: (connection) => store.product.authorize(connection),
              vertexRequestTier: options.vertexRequestTier,
              onAttemptStart: (wire) => {
                if (wire.judgment) {
                  assertJudgmentRuntimeWire(wire, judgment);
                  const current = store.job(id);
                  if (current.status !== 'running' || signal.aborted)
                    throw new Error('Judgment job is inactive');
                  if (current.kind === 'image')
                    validateImageJudgmentWire(
                      imageTargetSource(store, current),
                      imageCatalog(current.input),
                      wire
                    );
                  else if (current.kind === 'translation') {
                    const recovery = record(current.input).judgmentRecovery?.text;
                    validateTranslationJudgmentWire(
                      current.sourceHash,
                      record(record(current.input).translationPolicy).judgment,
                      wire,
                      typeof recovery === 'string' ? projectStoryUiText(recovery) : recovery
                    );
                  } else throw new Error('Invalid judgment job kind');
                }
                return store.product.startAttempt(chatId, null, id, wire);
              },
              onAttemptFinish: (attempt, result) => store.product.finishAttempt(attempt, result),
              onScriptedInput: (input) => {
                store.product.mockAttempt(chatId, null, id, 'translation', input);
              },
              onToolStart: (_id, event, generation) =>
                startToolDiagnostic(
                  store.db,
                  {
                    kind: 'job',
                    id,
                    generation,
                    owner: instanceId,
                    origin: 'translation',
                  },
                  event
                ),
              onToolEvent: (_id, event, timing, generation) =>
                recordToolDiagnostic(
                  store.db,
                  {
                    kind: 'job',
                    id,
                    generation,
                    owner: instanceId,
                    origin: 'translation',
                  },
                  event,
                  timing
                ),
              onProgress: () => publish(chatId),
              openResponseStream: () =>
                (translationStream = streams.createWriter({
                  taskKind: 'translation',
                  taskId: id,
                  chatId,
                  signal,
                  abortStatus: () => (stopping.signal.aborted ? 'interrupted' : 'cancelled'),
                })),
              cancellationStatus: 'interrupted',
            });
            if (queued.kind === 'translation' && outcome?.status === 'completed')
              precomputeAdmittedPresentation(queued.sourceRevision);
          } catch (error) {
            if (!stopping.signal.aborted) {
              const current = store.job(id);
              const message =
                storedModelRequired(error) ??
                (error instanceof Error && error.message.startsWith('Injected failure:')
                  ? error.message
                  : 'Auxiliary job failed');
              if (current.status === 'queued') store.failQueuedJob(id, current.generation, message);
              else if (current.status === 'running')
                store.failJob(id, current.generation, instanceId, message);
            }
          } finally {
            translationStream?.finish('failed');
            jobControllers.delete(id);
            if (chatId && !stopping.signal.aborted) {
              publish(chatId);
              if (store.queuedJobs().length) queueMicrotask(pumpJobs);
              queueMicrotask(pumpIllustrations);
            }
          }
        })()
      );
    }
  };
  const pumpIllustrations = () => {
    if (stopping.signal.aborted || !admitted()) return;
    for (const id of queuedIllustrations(store)) {
      if (illustrationControllers.has(id)) continue;
      const kind = illustrationJob(store, id).input.task === 'render' ? 'render' : 'text';
      if ([...illustrationControllers.values()].some((active) => active.lane === kind)) continue;
      const controller = new AbortController();
      illustrationControllers.set(id, { controller, lane: kind });
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
              resolveJevCredential: jevCredentials.resolve,

              resolveCredential,
              resolveComfyCredential: (name) => process.env[name],
              resolveNovelAIToken: () => new CredentialStore(store.db).get(NOVELAI_CREDENTIAL_ID),
              cancelRemoteOnAbort: () => controller.signal.aborted && !stopping.signal.aborted,
              executeCodex,
              generateCodexImage: (connection, request, execution) =>
                generateCodexImage(
                  connection,
                  request,
                  execution,
                  queued.input.target?.planId && !queued.input.redraw
                    ? JSON.stringify([
                        queued.chatId,
                        queued.sourceHash,
                        queued.input.target.planId,
                        connection.id,
                      ])
                    : undefined
                ),
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
                controls.fail('illustration', chatId);
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
            if (kind === 'render' && illustrationSession) {
              const key = illustrationSession.key;
              const hasNext = queuedIllustrations(store).some((nextId) => {
                const next = illustrationJob(store, nextId);
                return (
                  next.input.target?.planId &&
                  !next.input.redraw &&
                  next.input.codex &&
                  JSON.stringify([
                    next.chatId,
                    next.sourceHash,
                    next.input.target.planId,
                    next.input.codex.model.connection.id,
                  ]) === key
                );
              });
              if (!hasNext) await closeIllustrationSession();
            }
            if (chatId && !stopping.signal.aborted) {
              publish(chatId);
              if (queuedIllustrations(store).length) {
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
  const executeRun = createRunExecutor({
    store,
    controls,
    streams,
    signal: stopping.signal,
    runs,
    track,
    requireModel,
    resolveCredential,
    executeCodex,
    executeCodexAgent,
    batchPollIntervalMs: options.testMode ? 5 : 10_000,
    vertexRequestTier: options.vertexRequestTier,
    jevCredential: jevCredentials.resolve,
    publish,
    afterSource: (id, sourceId) => {
      pumpJobs();
      pumpIllustrations();
      titles.afterSource(id, !admitted());
      precomputeAdmittedPresentation(sourceId);
    },
  });
  const execute = (id: string, resume = false) => {
    if (stopping.signal.aborted) return;
    if (!admitted()) {
      deferredRuns.set(id, resume);
      return;
    }
    executeRun(id, resume);
  };
  app.addHook('onRequest', async (request) => {
    const denied = deniedBrowserRequest(network, {
      method: request.method,
      route: request.routeOptions.url,
      headers: {
        host: request.headers.host,
        origin: request.headers.origin,
        cookie: request.headers.cookie,
        'sec-fetch-site':
          typeof request.headers['sec-fetch-site'] === 'string'
            ? request.headers['sec-fetch-site']
            : undefined,
      },
    });
    if (denied) throw new HttpError(403, denied);
  });
  app.setErrorHandler((error, request, reply) => {
    const appError = asAppError(error);
    const statusCode =
      appError && typeof appError === 'object' && 'statusCode' in appError
        ? appError.statusCode
        : undefined;
    const code =
      appError instanceof HttpError
        ? appError.statusCode
        : typeof statusCode === 'number' && statusCode < 500
          ? statusCode
          : 500;
    if (code >= 500)
      process.stderr.write(
        `REQUEST_FAILED ${request.method} ${request.routeOptions.url ?? 'unknown'} ${failureLabel(error)}\n`
      );
    void reply
      .code(code)
      .send(
        errorWire(
          appError,
          error instanceof HttpError
            ? error.message
            : code === 400
              ? 'Invalid request'
              : 'Request failed'
        )
      );
  });
  let pushService: PushService | undefined;
  const session = productRoutes(app, store, {
    maintenance: () => maintenanceStatus(store, forcedClosed),
    credentials,
    codex,

    accessToken: options.accessToken,
    mcpToken: mcp,
    publicOrigin: network.publicOrigin,
    publish,
    onChatDeleted: chatDeleted,
    onAuthChanged: () => {
      pushService?.revokeInactive();
      publishAll();
    },
  });
  requestMetrics.addAuthenticationMark();
  pushService = new PushService(store, {
    origin: network.publicOrigin,
    sessionHash: session.sessionHash,
    canSend: () => admitted(),
    sender: options.pushSender,
  });
  pushRoutes(app, pushService);
  const backups = new BackupService(store, options.buildId, options.backupDirectory, () =>
    admitted()
  );
  backupRoutes(app, backups);
  const manuscriptSearch = new ManuscriptSearch(store, () => admitted());
  manuscriptSearchRoutes(app, manuscriptSearch);
  readingStateRoutes(app, store);
  usageRoutes(app, store);
  readerRoutes(app, store);
  helperRoutes(app, helper);
  if (mcp) mcpRoutes(app, store);
  chatOptionRoutes(app, store);
  chatVariableRoutes(app, store, publish);
  contextRoutes(app, store, {
    signal: stopping.signal,
    track,
    snapshot: (chatId) =>
      prepareNativeRisuReadOnly(helperWritingSnapshot(store, chatId), 'context'),
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
        {
          ...hooks,
          reason: 'manual',
          priorities: job.priorities,
          reserveCalls: 0,
          onProgress: () => {},
        },
        store.context.previous(snapshot)
      );
      return prepared.snapshot;
    },
  });
  resourceRoutes(app, store, publishAll);
  themeRoutes(app, store);
  themeAssetRoutes(app, store);
  fontRoutes(app, store);
  illustrationPresetRoutes(app, store);
  inputTranslationRoutes(app, store, {
    signal: stopping.signal,
    resolveCredential,
    executeCodex,
    vertexRequestTier: options.vertexRequestTier,
    track,
  });
  storyGuideRoutes(app, store, { publish });
  selectionRevisionRoutes(app, store, {
    signal: stopping.signal,
    resolveCredential,
    executeCodex,
    vertexRequestTier: options.vertexRequestTier,
    track,
  });
  responseStreamRoutes(app, streams);
  connectionTestRoutes(app, connectionTests, session.authenticated);
  agentRuntimeRoutes(app, codex);
  codexContentWarningRoutes(app, store, jevCredentials, stopping.signal);
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
  sceneDeletionRoutes(app, store, (chatId) => {
    titles.cancel(chatId);
    publish(chatId);
  });
  orphanMemoryRoutes(app, store, { publish });
  packageImageRoutes(app, store, { publish, pump: pumpJobs });
  illustrationRoutes(app, store, {
    publish,
    pump: pumpIllustrations,
    abort: (id) =>
      illustrationControllers.get(id)?.controller.abort(new Error('Illustration cancelled')),
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
  uploadRoutes(app, store.path);
  requestFileRoutes(app, store);
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
        const result = await withRisuFailureCode(
          () =>
            applyNativeRisuAction(store, request.params.id, request.params.sourceId, request.body, {
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
            }),
          'action'
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
  app.post<{ Params: { id: string } }>('/api/chats/:id/package-start', async (request) => {
    const result = createPackageStart(store, request.params.id, request.body);
    if (result.created) {
      publish(request.params.id);
      if (result.run?.status === 'queued') execute(result.run.id);
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
  app.get('/api/activity-feed', async () => activityFeed(store));
  app.get<{ Params: { id: string } }>(
    '/api/chats/:id/activity-acknowledgements',
    async (request) => ({ keys: acknowledgedActivities(store, request.params.id) })
  );
  app.post<{ Params: { id: string } }>(
    '/api/chats/:id/activity-acknowledgements',
    async (request) => {
      const body = record(request.body);
      fields(body, ['keys']);
      acknowledgeActivities(store, request.params.id, body.keys);
      return { ok: true };
    }
  );
  app.post('/api/chats', async (request) => {
    const { chat, autoTitleLocale } = createChat(store, request.body);
    if (autoTitleLocale) titles.enroll(chat.id, autoTitleLocale);
    return chat;
  });
  app.patch<{ Params: { id: string } }>('/api/chats/:id/title', async (request) => {
    const body = record(request.body);
    fields(body, ['title', 'expectedTitleRevision']);
    const chat = store.renameChat(
      request.params.id,
      chatTitle(body.title),
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
  autoTranslationDefaultRoutes(app, store);
  chatGenerationDefaultRoutes(app, store);
  storyUiRoutes(app, store, { publish, execute, requireRequestModel });
  app.post('/api/story-ui/preview', { bodyLimit: 2 * 1024 * 1024 }, async (request) => {
    const body = record(request.body);
    fields(body, ['text', 'runId']);
    const block = text(body.text, 'UI preview', 1_000_000, true);
    const runId = body.runId === undefined ? undefined : text(body.runId, 'run ID', 200);
    return compileStoryUiBlocks(block, {
      resolveImage: runId
        ? storyUiAssetResolver(() => readStoredRunSnapshot(store, runId))
        : undefined,
    });
  });
  app.patch<{ Params: { id: string } }>('/api/chats/:id/settings', async (request) => {
    const body: RecordBody = record(request.body);
    fields(body, [
      'expectedSettingsRevision',
      'maxCalls',
      'autoTranslate',
      'storyUi',
      'storyUiStyle',
      'autoRefusalRetryEnabled',
      'autoRefusalMaxRetries',
    ]);
    const chat = store.settings(
      request.params.id,
      number(body.expectedSettingsRevision, 'settings revision', 1, 1e9),
      normalizeChatSettings(body)
    );
    publish(chat.id);
    return chat;
  });
  app.post<{ Params: { id: string } }>(
    '/api/chats/:id/runs',
    { bodyLimit: 16 * 1024 * 1024 },
    async (request) => {
      const body: RecordBody = record(request.body);
      fields(body, [
        'request',
        'expectedRevision',
        'expectedSettingsRevision',
        'idempotencyKey',
        'expectedProfileRevision',
        'loreContextReset',
        'requestImages',
      ]);
      const uploads = requestImageUploads(body.requestImages);
      if (body.loreContextReset !== undefined && typeof body.loreContextReset !== 'boolean')
        throw new HttpError(400, 'Invalid lore context reset');
      const command = {
        ...(body.loreContextReset !== undefined
          ? { loreContextReset: body.loreContextReset as boolean }
          : {}),
        request: text(body.request, 'request', REQUEST_TEXT_MAX_CHARS, uploads.length > 0),
        ...(uploads.length
          ? { requestImages: uploads.map(({ sha256, name }) => ({ sha256, name })) }
          : {}),
        expectedRevision:
          body.expectedRevision === null
            ? null
            : text(body.expectedRevision, 'source revision', 100),
        expectedSettingsRevision: number(
          body.expectedSettingsRevision,
          'settings revision',
          1,
          1e9
        ),
        idempotencyKey: text(body.idempotencyKey, 'idempotency key', 120),
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
      const previous = store.findRunByCommand(request.params.id, command);
      if (previous) {
        releaseRequestImageUploads(store, uploads);
        return runResponse(request.headers.prefer, previous);
      }
      store.assertRunAdmission(request.params.id, command);
      const prepared = await prepareRequestImages(store, uploads);
      const result = store.transaction(() => {
        const prior = store.findRunByCommand(request.params.id, command);
        if (prior) return { run: prior, created: false };
        storeRequestImages(store, prepared);
        return store.createRunInTransaction(request.params.id, command, (chat) => {
          const snapshot = composerRunSnapshot(store, chat, command.request, prepared.images);
          requireRequestModel(snapshot);
          return snapshot;
        });
      });
      releaseRequestImageUploads(store, uploads);
      if (result.created) {
        publish(request.params.id);
        if (result.run.status === 'queued') execute(result.run.id);
      }
      return runResponse(request.headers.prefer, result.run);
    }
  );
  app.get<{ Params: { id: string } }>('/api/runs/:id', async (request) =>
    store.run(request.params.id)
  );
  promptWorkspaceRoutes(app, store, publishAll);
  loreContextDefaultRoutes(app, store);
  app.post<{ Params: { id: string } }>(
    '/api/runs/:id/retry',
    { bodyLimit: 16 * 1024 * 1024 },
    async (request) => {
      const body = record(request.body);
      fields(body, ['idempotencyKey', 'request', 'mode']);
      if (body.mode !== undefined && body.mode !== 'replace' && body.mode !== 'copy')
        throw new HttpError(400, 'Invalid retry mode');
      const result = store.retryRun(
        request.params.id,
        text(body.idempotencyKey, 'idempotency key', 120),
        requireRequestModel,
        body.request === undefined
          ? undefined
          : text(
              body.request,
              'request',
              REQUEST_TEXT_MAX_CHARS,
              !!readStoredRunSnapshot(store, request.params.id).requestImages?.length
            ),
        body.mode as 'replace' | 'copy' | undefined
      );
      if (result.created) {
        publish(result.run.chatId);
        execute(result.run.id);
      }
      return runResponse(request.headers.prefer, result.run);
    }
  );
  app.post<{ Params: { id: string } }>('/api/runs/:id/rejudge', async (request) => {
    const body = record(request.body);
    fields(body, ['idempotencyKey']);
    const result = store.candidate(
      request.params.id,
      text(body.idempotencyKey, 'idempotency key', 120)
    );
    if (result.created) {
      publish(result.run.chatId);
      execute(result.run.id);
    }
    return runResponse(request.headers.prefer, result.run);
  });
  app.post<{ Params: { id: string } }>('/api/runs/:id/cancel', async (request) => {
    const run = store.finishRun(request.params.id, 'cancelled', 'Run cancelled');
    runs.get(run.id)?.abort(new Error('Run cancelled'));
    publish(run.chatId);
    return runResponse(request.headers.prefer, run);
  });
  app.post<{ Params: { id: string } }>('/api/runs/:id/dismiss-reader', async (request) => {
    fields(record(request.body ?? {}), []);
    const result = dismissReaderRun(store, request.params.id);
    publish(result.chatId);
    return result;
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
  app.patch<{ Params: { id: string } }>('/api/sources/:id/scene-context', async (request) => {
    const result = updateSceneContext(store, request.params.id, request.body);
    sceneUpdated(request.params.id);
    return result;
  });
  app.get<{ Params: { id: string } }>('/api/sources/:id/versions', async (request) =>
    sourceVersions(store, request.params.id)
  );
  app.patch<{ Params: { id: string } }>('/api/sources/:id/title', async (request) => {
    const result = setSceneTitle(store, request.params.id, request.body);
    publish(result.chatId);
    return result;
  });
  app.put<{ Params: { id: string } }>(
    '/api/sources/:id/text',
    { bodyLimit: 8 * 1024 * 1024 },
    async (request) => {
      const body: RecordBody = record(request.body);
      fields(body, ['text', 'expectedRevision']);
      const source = store.editSource(request.params.id, {
        text: compileEditedSourceText(
          store,
          request.params.id,
          text(body.text, 'source text', 2_000_000)
        ).text,
        expectedRevision: number(
          body.expectedRevision,
          'source edit revision',
          0,
          Number.MAX_SAFE_INTEGER
        ),
      });
      sceneUpdated(source.id);
      return source;
    }
  );
  app.put<{ Params: { id: string } }>(
    '/api/sources/:id/translation',
    { bodyLimit: 8 * 1024 * 1024 },
    async (request) => {
      const body: RecordBody = record(request.body);
      fields(body, ['text', 'expectedRevision', 'expectedSourceHash', 'expectedTextHash']);
      const job = store.editTranslation(request.params.id, {
        text: text(body.text, 'translation text', 2_000_000),
        expectedRevision: number(
          body.expectedRevision,
          'translation revision',
          0,
          Number.MAX_SAFE_INTEGER
        ),
        expectedSourceHash: text(body.expectedSourceHash, 'source hash', 64),
        ...(body.expectedTextHash === undefined
          ? {}
          : { expectedTextHash: text(body.expectedTextHash, 'translation hash', 64) }),
      });
      sceneUpdated(job.sourceRevision);
      return job;
    }
  );
  const openEventStream = (request: FastifyRequest, reply: FastifyReply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Content-Type-Options': 'nosniff',
      'X-Accel-Buffering': 'no',
    });
    return () => session.authenticated(request.headers.cookie);
  };
  const liveEventsInput = z.strictObject({
    chat: nonBlank(120).optional(),
    streamAfter: z.string().optional(),
  });
  registerRawRoute(
    app,
    {
      method: 'GET',
      url: '/api/events',
      cache: 'no-store-refusals',
      input: liveEventsInput,
    },
    ({ chat: chatId, streamAfter }, request, reply) => {
      if (chatId !== undefined) store.chat(chatId);
      const resume = chatEventResume(request.headers['last-event-id'], streamAfter);
      const authorized = openEventStream(request, reply);
      live.connect(reply.raw, authorized);
      chatEvents.connect(chatId ?? null, resume, reply.raw, authorized);
    }
  );
  if (options.testMode) {
    app.post('/api/test/live-frame', async (request) => {
      const body: RecordBody = record(request.body);
      fields(body, ['event', 'data']);
      if (!LIVE_FRAME_EVENTS.includes(body.event as LiveFrameEvent))
        throw new HttpError(400, 'Invalid live frame event');
      live.inject(body.event as LiveFrameEvent, record(body.data));
      return { ok: true };
    });
    app.get('/api/test/control', async () => controls.snapshot());
    app.post('/api/test/control', async (request) => {
      const body: RecordBody = record(request.body);
      fields(body, ['action', 'barrier', 'point', 'chatId', 'preset', 'mode']);
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
          !['run', 'translation', 'image', 'state', 'context', 'illustration'].includes(
            String(body.barrier)
          )
        )
          throw new HttpError(400, 'Invalid barrier');
        controls[body.action](body.barrier as Barrier);
      } else if (body.action === 'fail-next') {
        if (!FAILURE_POINTS.includes(body.point as FailurePoint))
          throw new HttpError(400, 'Invalid failure point');
        if (typeof body.chatId !== 'string') throw new HttpError(400, 'Invalid chat');
        store.chat(body.chatId);
        controls.armFailure(body.point as FailurePoint, body.chatId);
      } else if (body.action === 'crash-after-source-commit')
        controls.crashAfterSourceCommit = true;
      else throw new HttpError(400, 'Invalid control action');
      return controls.snapshot();
    });
  }
  if (options.webRoot && existsSync(options.webRoot)) {
    await app.register(fastifyStatic, {
      root: options.webRoot,
      preCompressed: true,
      setHeaders(response, path) {
        const name = basename(path);
        if (relative(options.webRoot!, path).split(sep)[0] === 'assets')
          response.header('Cache-Control', 'public, max-age=31536000, immutable');
        if (name === 'index.html') {
          response.header('Content-Security-Policy', DOCUMENT_CONTENT_SECURITY_POLICY);
          response.header('Referrer-Policy', 'no-referrer');
        }
        if (name === 'sw.js' || name === 'manifest.webmanifest') {
          response.header('Cache-Control', 'no-cache');
          response.header('X-Content-Type-Options', 'nosniff');
          if (name === 'sw.js') response.header('Service-Worker-Allowed', '/');
        }
      },
    });
    app.setNotFoundHandler((request, reply) =>
      request.url.startsWith('/api/')
        ? reply.code(404).send({ error: 'Not found' })
        : reply.sendFile('index.html')
    );
  }
  let stopImportStagingCleanup: (() => void) | undefined;
  app.addHook('preClose', async () => {
    stopping.abort(new Error('Server stopping'));
    stopImportStagingCleanup?.();
    await pushService?.close();
    await backups.close();
    await manuscriptSearch.close();
    await closeIllustrationSession();
    await codex.close();
    chatEvents.closeAll();
    live.closeAll();
    await Promise.allSettled([...work]);
    await imageCleanup.close();
  });
  app.addHook('onClose', async () => {
    disposeAllNativeRisuSessions();
    store.close();
  });
  const resumeWork = () => {
    if (stopping.signal.aborted || !admitted()) return;
    for (const runId of recoveredRuns.splice(0)) execute(runId, true);
    for (const [runId, resume] of deferredRuns) {
      deferredRuns.delete(runId);
      execute(runId, resume);
    }
    helper.pump();
    pumpJobs();
    pumpIllustrations();
    titles.resumeDeferred();
  };
  maintenanceRoutes(app, store, {
    forcedClosed,
    activeWork: () => work.size + Number(backups.isActive),
    onOpen: () =>
      queueMicrotask(() => {
        try {
          resumeWork();
        } catch {
          process.stderr.write('BACKGROUND_RESUME_FAILED\n');
        }
      }),
  });
  if (!forcedClosed) {
    if (admitted()) pruneUploads(store.path);
    store.context.recover();
    recoveredRuns = store.recover();
    helper.workspace.interrupt();
    streams.recover();
    pruneUnreachableResponseChunks(store.db);
    flushPendingImageCleanup(store.db);
  }
  app.addHook('onListen', async () => {
    if (!forcedClosed) stopImportStagingCleanup = startImportStagingCleanup(store, admitted);
    if (!forcedClosed && !options.testMode) backups.listen();
    if (!forcedClosed) pushService?.listen();
    if (!forcedClosed) manuscriptSearch.listen();
    resumeWork();
  });
  return app;
}
