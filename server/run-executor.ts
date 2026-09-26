import { Store } from './store.js';
import { readRunStatus } from './run-projections.js';
import { ResponseStreamStore } from './response-stream.js';
import { Controls } from './controls.js';
import { runMain, ModelRunError, type MainHooks } from './model-runner.js';
import { prepareInputContext, ContextCompactionError } from './context-compaction.js';
import {
  previousContextPlan,
  contextSourceRefs,
  validateContextPlan,
  persistedContextSnapshot,
} from './context-planning.js';
import { prepareNativeRisuRun, prepareNativeRisuOutput } from './risu-native-run.js';
import { createNativeRisuHost } from './risu-native-host.js';
import { disposeNativeRisuSession } from './risu-native-runtime.js';
import { nativeRisuSessionKey } from './risu-native-context.js';
import { prepareNativeRisuRequest } from './risu-native-request.js';
import { freezeLoreContext } from './lore-context.js';
import { compileSnapshotPrompt } from './prompt-snapshot.js';
import {
  loreSelectionPending,
  prepareLoreSelection,
  loreSelectionAttemptInputHashes,
} from './lore-selection.js';
import { JEV_ENDPOINT, JEV_MODEL, JevError } from './jev-judgment.js';
import { judgeMainRefusal, mainJudgmentInput, validateMainJudgmentWire } from './main-judgment.js';
import { JevCredentialStore } from './jev-credentials.js';
import { AnthropicBatchRun } from './anthropic-batch.js';
import type { Usage } from '../core/types.js';

function mergeUsage(left: Usage, right: Usage): Usage {
  const total: Usage = { ...left, modelCalls: left.modelCalls + right.modelCalls };
  for (const key of ['inputTokens', 'outputTokens', 'costUsd'] as const)
    total[key] = left[key] === null || right[key] === null ? null : left[key] + right[key];
  return total;
}
type RunExecutorDependencies = {
  store: Store;
  controls: Controls;
  streams: ResponseStreamStore;
  signal: AbortSignal;
  runs: Map<string, AbortController>;
  track: (work: Promise<void>) => void;
  requireModel: (target: unknown, role: string) => void;
  resolveCredential: MainHooks['resolveCredential'];
  executeCodex: MainHooks['executeCodex'];
  batchPollIntervalMs?: number;
  vertexRequestTier: MainHooks['vertexRequestTier'];
  jevCredential: JevCredentialStore['resolve'];
  publish: (chatId: string) => void;
  afterSource: (runId: string) => void;
};

/** Owns one run's preparation, model execution and atomic completion; no HTTP routing. */
export function createRunExecutor({
  store,
  controls,
  streams,
  signal,
  runs,
  track,
  requireModel,
  resolveCredential,
  executeCodex,
  batchPollIntervalMs = 10_000,
  vertexRequestTier,
  jevCredential,
  publish,
  afterSource,
}: RunExecutorDependencies) {
  const execute = (id: string, resume = false) => {
    const fixture = { ...controls.fixture };
    const controller = new AbortController();
    const anthropicBatch = new AnthropicBatchRun(store, id, batchPollIntervalMs);
    runs.set(id, controller);
    const onStop = () => controller.abort(new Error('Server stopping'));
    signal.addEventListener('abort', onStop, { once: true });
    track(
      (async () => {
        const run = store.run(id);
        const judgeResponse =
          run.snapshot.mainJudgmentEnabled === true &&
          !!run.snapshot.profile?.models.main &&
          run.snapshot.profile.models.main.connection.protocol !== 'fixture-sse-v1';
        let response: ReturnType<ResponseStreamStore['createWriter']> | undefined;
        // This Run's own calls only. Reusing a candidate's prepared state does not recharge it.
        let priorUsage: Usage = { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
        try {
          if (!store.startRun(id)) return;
          if (run.snapshot.judgmentRecovery)
            store.stageRunOutput(id, run.snapshot.mainJudgment!.response);
          response = streams.createWriter({
            taskKind: 'main',
            taskId: id,
            chatId: run.chatId,
            signal: controller.signal,
            isActive: () => readRunStatus(store, id) === 'running',
            resume,
            abortStatus: () => (signal.aborted ? 'interrupted' : 'cancelled'),
          });
          requireModel(run.snapshot.profile?.models.main, 'main');
          if (judgeResponse && !(await jevCredential()))
            throw new JevError('JEV_CREDENTIAL_REQUIRED');
          if (
            judgeResponse &&
            run.snapshot.settings.maxCalls < (run.snapshot.judgmentRecovery ? 1 : 2)
          )
            throw new JevError('MAIN_JUDGMENT_CALL_BUDGET');
          publish(run.chatId);
          await controls.wait('run', controller.signal);
          let requestOrdinal = 0;
          const hooks: MainHooks = {
            fixture,
            reserveCalls: Number(judgeResponse),
            prepareRequest: async (request, usage) => {
              const current = store.run(id).snapshot;
              const prepared = await prepareNativeRisuRequest(current, request, {
                requestOrdinal: requestOrdinal++,
                signal: controller.signal,
                host: createNativeRisuHost(
                  store,
                  id,
                  current,
                  usage,
                  hooks,
                  'editRequest',
                  1 + Number(judgeResponse)
                ),
              });
              if (prepared.snapshot !== current) {
                store.transaction(() => {
                  assertCurrent();
                  store.db
                    .prepare('UPDATE runs SET snapshot=? WHERE id=?')
                    .run(JSON.stringify(prepared.snapshot), id);
                });
                executionSnapshot.nativeRisuExecution = prepared.snapshot.nativeRisuExecution;
              }
              return prepared.request;
            },
            signal: controller.signal,
            onResponseProgress: response.progress,
            onInput: (input) => {
              store.input(id, input);
              if (run.snapshot.profile && !run.snapshot.profile.models.main)
                store.product.mockAttempt(run.chatId, id, null, 'main', input);
            },
            onToolEvent: (event) => store.tool(id, event),
            replayToolEvents: run.toolEvents,
            persistContext: (prepared, own) =>
              store.transaction(() => {
                if (controller.signal.aborted || readRunStatus(store, id) !== 'running')
                  throw new Error('Run cancelled');
                const published = store.context.publishPrepared(
                  store.context.rebase(prepared, own),
                  { origin: 'model' }
                );
                const checkpoint = published.contextPlan?.checkpoint;
                return {
                  snapshot: published,
                  activated: checkpoint ? store.context.checkpoint(checkpoint).activated : false,
                };
              }),

            resolveCredential,
            executeAnthropicBatch: (connection, request, execution) =>
              anthropicBatch.execute(connection, request, execution),
            executeCodex,
            authorize: (connection) => store.product.authorize(connection),
            vertexRequestTier,
            cancelRemoteOnAbort: () => controller.signal.aborted && !signal.aborted,
            onAttemptStart: (wire, resumeAttemptId) => {
              if (controller.signal.aborted || readRunStatus(store, id) !== 'running')
                throw new Error('Run cancelled');
              if (resumeAttemptId !== undefined) {
                if (
                  wire.judgment ||
                  wire.protocol !== 'anthropic-messages-v1' ||
                  wire.executionMode !== 'batch'
                )
                  throw new Error('Invalid Batch attempt recovery');
                const target = run.snapshot.profile?.models.main;
                if (
                  !target ||
                  target.executionMode !== 'batch' ||
                  target.modelId !== wire.modelId ||
                  target.connectionId !== wire.connectionId
                )
                  throw new Error('Invalid Batch attempt recovery');
                store.product.authorize(target.connection);
                return store.product.resumeAttempt(resumeAttemptId, id, wire);
              }
              if (wire.judgment) {
                const current = store.run(id).snapshot;
                if (wire.judgment.kind === 'main-refusal') {
                  if (!current.mainJudgment) throw new Error('Missing main judgment input');
                  validateMainJudgmentWire(current.mainJudgment, wire);
                  return store.product.startAttempt(run.chatId, id, null, wire);
                }
                if (
                  wire.judgment.kind !== 'lore-selection' ||
                  wire.protocol !== 'typesafe-systemone-v1' ||
                  wire.connectionId !== 'typesafe-judgment' ||
                  wire.modelId !== JEV_MODEL ||
                  wire.role !== 'context' ||
                  wire.url !== JEV_ENDPOINT ||
                  wire.method !== 'POST' ||
                  wire.agentId ||
                  !loreSelectionAttemptInputHashes(current).includes(wire.judgment.inputHash)
                )
                  throw new Error('Invalid judgment attempt');
                return store.product.startAttempt(run.chatId, id, null, wire);
              }
              let target =
                wire.agentId !== undefined
                  ? run.snapshot.profile?.collaborationModels?.[wire.agentId]
                  : wire.role === 'context'
                    ? run.snapshot.profile?.contextModel
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
            onAttemptFinish: (attempt, result) => {
              const batch = store.db
                .prepare('SELECT 1 FROM anthropic_batches WHERE attempt_id=?')
                .get(attempt);
              if (signal.aborted && batch) return;
              store.product.finishAttempt(attempt, result);
            },
          };
          const assertCurrent = () => {
            if (controller.signal.aborted || readRunStatus(store, id) !== 'running')
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
                store.story.notes.canonHash({
                  chatId: run.chatId,
                  history: run.snapshot.history,
                }) !== run.snapshot.story.canonHash)
            )
              throw new Error('CONTEXT_DEPENDENCIES_CHANGED');
          };
          hooks.initialUsage = structuredClone(priorUsage);
          let executionSnapshot = run.snapshot;
          let result: Awaited<ReturnType<typeof runMain>>;
          if (run.snapshot.judgmentRecovery) {
            const preserved = run.snapshot.mainJudgment!;
            result = {
              status: 'completed',
              text: preserved.response,
              usage: priorUsage,
              error: null,
            };
          } else {
            const reservedCompilationSnapshot = run.snapshot;
            let compilationSnapshot = reservedCompilationSnapshot;
            executionSnapshot = await prepareNativeRisuRun(executionSnapshot, {
              signal: controller.signal,
              host: createNativeRisuHost(
                store,
                id,
                executionSnapshot,
                priorUsage,
                hooks,
                'before-turn',
                1 + Number(judgeResponse)
              ),
            });
            hooks.initialUsage = structuredClone(priorUsage);
            compilationSnapshot =
              reservedCompilationSnapshot === run.snapshot
                ? executionSnapshot
                : {
                    ...compilationSnapshot,
                    nativeRisuExecution: executionSnapshot.nativeRisuExecution,
                    nativeRisuPresetProgram: executionSnapshot.nativeRisuPresetProgram,
                  };
            if (executionSnapshot.nativeRisuExecution) {
              store.transaction(() => {
                assertCurrent();
                store.db
                  .prepare('UPDATE runs SET snapshot=?,updated_at=? WHERE id=?')
                  .run(
                    JSON.stringify(
                      persistedContextSnapshot(store.run(id).snapshot, executionSnapshot)
                    ),
                    new Date().toISOString(),
                    id
                  );
              });
            }
            // The selection reads the reserved snapshot, exactly as archive validation recomputes its
            // inputs, and freezes before the lore context and the input plan measure what is pinned.
            if (loreSelectionPending(executionSnapshot)) {
              assertCurrent();
              const selection = await prepareLoreSelection(executionSnapshot, hooks, {
                jev: { credential: jevCredential },
                reserveCalls: 1 + Number(judgeResponse) + priorUsage.modelCalls,
              });
              priorUsage = mergeUsage(priorUsage, selection.usage);
              hooks.initialUsage = structuredClone(priorUsage);
              const receipt = selection.snapshot.loreSelection;
              executionSnapshot = { ...executionSnapshot, loreSelection: receipt };
              compilationSnapshot = { ...compilationSnapshot, loreSelection: receipt };
              store.transaction(() => {
                assertCurrent();
                store.db
                  .prepare('UPDATE runs SET snapshot=?,updated_at=? WHERE id=?')
                  .run(
                    JSON.stringify(
                      persistedContextSnapshot(store.run(id).snapshot, executionSnapshot)
                    ),
                    new Date().toISOString(),
                    id
                  );
                store.event(run.chatId, 'run.context.updated', id);
              });
              publish(run.chatId);
            }
            if (
              (executionSnapshot.nativeRisuExecution !== undefined ||
                executionSnapshot.loreSelection !== undefined) &&
              !executionSnapshot.contextPlan
            ) {
              assertCurrent();
              executionSnapshot = freezeLoreContext(store, executionSnapshot);
              compilationSnapshot =
                reservedCompilationSnapshot === run.snapshot
                  ? executionSnapshot
                  : freezeLoreContext(store, compilationSnapshot);
              const contextBase = run.snapshot.contextBase;
              executionSnapshot = store.context.prepareRun(executionSnapshot);
              compilationSnapshot =
                reservedCompilationSnapshot === run.snapshot
                  ? executionSnapshot
                  : store.context.prepareRun(compilationSnapshot);
              executionSnapshot.contextBase = contextBase;
              compilationSnapshot.contextBase = contextBase;
            }
            if (executionSnapshot.contextPlan) {
              assertCurrent();
              const reuse =
                executionSnapshot.candidateOf &&
                executionSnapshot.contextPlan.status === 'ready' &&
                executionSnapshot.promptCompilation;
              if (!reuse) {
                const prepared = await prepareInputContext(
                  compilationSnapshot,
                  {
                    ...hooks,
                    reserveCalls: 1 + Number(judgeResponse) + priorUsage.modelCalls,
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
                        store.db.prepare('UPDATE runs SET snapshot=?,updated_at=? WHERE id=?').run(
                          JSON.stringify(
                            persistedContextSnapshot(current.snapshot, {
                              ...executionSnapshot,
                              contextPlan: plan,
                            })
                          ),
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
                priorUsage = mergeUsage(priorUsage, prepared.usage);
                hooks.initialUsage = structuredClone(priorUsage);
                prepared.snapshot.branchId = executionSnapshot.branchId;
                store.transaction(() => {
                  assertCurrent();
                  prepared.snapshot = store.context.publishPrepared(prepared.snapshot, {
                    origin: 'automatic',
                  });
                  validateContextPlan(prepared.snapshot);
                  store.db
                    .prepare('UPDATE runs SET snapshot=?,updated_at=? WHERE id=?')
                    .run(
                      JSON.stringify(
                        persistedContextSnapshot(store.run(id).snapshot, prepared.snapshot)
                      ),
                      new Date().toISOString(),
                      id
                    );
                  store.event(run.chatId, 'run.context.updated', id);
                });
                executionSnapshot = prepared.snapshot;
              }
            }
            // Native preparation invalidates the old compilation even when a fixture has no
            // model/context plan. Persist the exact prepared prompt before any writer input.
            if (!executionSnapshot.promptCompilation) {
              executionSnapshot = {
                ...executionSnapshot,
                promptCompilation: compileSnapshotPrompt(compilationSnapshot).promptCompilation,
              };
              store.transaction(() => {
                assertCurrent();
                store.db
                  .prepare('UPDATE runs SET snapshot=? WHERE id=?')
                  .run(
                    JSON.stringify(
                      persistedContextSnapshot(store.run(id).snapshot, executionSnapshot)
                    ),
                    id
                  );
              });
            }
            result = await runMain(executionSnapshot, hooks);
          }
          response.flush();
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
          // Response hooks compute outside the source transaction; only verified state receipts
          // are adopted with the unchanged main text. Keep provider accounting on fatal host errors.
          priorUsage = structuredClone(result.usage);
          store.stageRunOutput(id, result.text);
          if (judgeResponse) {
            if (priorUsage.modelCalls >= run.snapshot.settings.maxCalls)
              throw new JevError('MAIN_JUDGMENT_CALL_BUDGET');
            const input = mainJudgmentInput(result.text, run.snapshot.mainJudgmentThreshold);
            store.transaction(() => {
              assertCurrent();
              store.db.prepare('UPDATE runs SET snapshot=? WHERE id=?').run(
                JSON.stringify({
                  ...store.run(id).snapshot,
                  mainJudgment: input,
                  mainJudgmentPending: true,
                }),
                id
              );
            });
            const judgment = await judgeMainRefusal(input, {
              signal: controller.signal,
              credential: jevCredential,
              onAttemptStart: async (wire) => {
                const attempt = await hooks.onAttemptStart(wire);
                priorUsage.modelCalls++;
                return attempt;
              },
              onAttemptFinish: async (attempt, outcome) => {
                priorUsage = mergeUsage(priorUsage, {
                  modelCalls: 0,
                  inputTokens: outcome.usage.inputTokens,
                  outputTokens: outcome.usage.outputTokens,
                  costUsd: outcome.usage.costUsd,
                });
                await hooks.onAttemptFinish(attempt, outcome);
              },
            });
            // A resolved verdict must not make later output-hook interruption rejudgable.
            store.db
              .prepare(
                "UPDATE runs SET snapshot=json_remove(snapshot,'$.mainJudgmentPending') WHERE id=?"
              )
              .run(id);
            if (judgment.verdict !== 'accepted') {
              store.finishRun(id, 'refused', 'MAIN_RESPONSE_REFUSED', result.text, priorUsage);
              publish(run.chatId);
              return;
            }
          }
          const nativeOutput = await prepareNativeRisuOutput(executionSnapshot, result.text, {
            signal: controller.signal,
            host: createNativeRisuHost(
              store,
              id,
              executionSnapshot,
              priorUsage,
              hooks,
              'after-turn'
            ),
          });
          store.transaction(() => {
            assertCurrent();
            if (nativeOutput.nativeRisuExecution)
              store.db.prepare('UPDATE runs SET snapshot=? WHERE id=?').run(
                JSON.stringify({
                  ...store.run(id).snapshot,
                  nativeRisuExecution: nativeOutput.nativeRisuExecution,
                }),
                id
              );
            store.completeRunInTransaction(
              id,
              nativeOutput.nativeRisuExecution?.output?.text ?? result.text,
              priorUsage,
              run.snapshot.settings,
              controls
            );
          });
          if (controls.crashAfterSourceCommit) process.exit(86);
          publish(run.chatId);
          afterSource(id);
        } catch (error) {
          if (!signal.aborted) {
            if (error instanceof ContextCompactionError) {
              const usage = mergeUsage(priorUsage, error.usage);
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
                undefined,
                usage
              );
              if (controller.signal.aborted) store.settleCancelledUsage(id, usage);
              publish(run.chatId);
              return;
            }
            if (error instanceof ModelRunError) {
              store.finishRun(
                id,
                controller.signal.aborted ? 'cancelled' : 'failed',
                controller.signal.aborted ? 'Run cancelled' : error.message,
                undefined,
                error.usage
              );
              if (controller.signal.aborted) store.settleCancelledUsage(id, error.usage);
              publish(run.chatId);
              return;
            }
            const message = error instanceof Error ? error.message : '';
            const safeError =
              message === 'Model call budget exhausted' ||
              message === 'TOOL_RESULT_MISMATCH' ||
              message === 'ANTHROPIC_CONTINUATION_MISMATCH' ||
              error instanceof JevError ||
              message.startsWith('Injected failure:') ||
              message.startsWith('MODEL_REQUIRED:') ||
              message.startsWith('CONTEXT_')
                ? message
                : controller.signal.aborted
                  ? 'Run cancelled'
                  : 'Scripted generation failed';
            store.finishRun(
              id,
              controller.signal.aborted ? 'cancelled' : 'failed',
              safeError,
              undefined,
              priorUsage.modelCalls ? priorUsage : undefined
            );
            if (controller.signal.aborted && priorUsage.modelCalls)
              store.settleCancelledUsage(id, priorUsage);
            publish(run.chatId);
          }
        } finally {
          const status = readRunStatus(store, id);
          if (status !== 'completed') disposeNativeRisuSession(nativeRisuSessionKey(run.snapshot));
          response?.finish(status === 'queued' || status === 'running' ? 'interrupted' : status);
          runs.delete(id);
          signal.removeEventListener('abort', onStop);
        }
      })()
    );
  };
  return execute;
}
