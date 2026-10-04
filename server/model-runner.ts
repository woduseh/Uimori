import { buildCodexNativeRequest } from '../core/codex-protocol.js';
import { ProviderContractError, type ProviderExecutionOptions } from '../core/transport.js';
import type { CodexAgentExecutionOptions } from './codex-runtime.js';
import { MAIN_READ_TOOLS } from '../core/read-tools.js';
import { createToolCorrectionPolicy } from '../core/tool-outcome.js';
import { estimateContextTokens } from '../core/context-budget.js';
import { executeTool } from '../core/provider.js';
import { executeFixtureMain, type FixtureGeneration } from '../core/fixture-provider.js';
import type { Connection } from '../core/product.js';
import {
  executeProvider,
  type Json,
  type ProviderResult,
  type WireRecord,
  type ProviderProgress,
  type ProviderRequest,
  transportConnection,
} from '../core/transport.js';
import type { ModelInput, RunSnapshot, ToolEvent, Usage } from '../core/types.js';
import { createEvaluationToolSession } from './evaluation-session.js';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { attachMainHostContext } from './main-host-context.js';
import {
  buildMainProviderRequest,
  encodeMainPreview,
  storySubmissionEnabled,
  STORY_SUBMIT_MAX_CHARS,
} from './main-request.js';
import { createAgentCollaboration } from './agent-collaboration.js';
import { compactableRead, compactToolReads } from './context-tool-compaction.js';
import { requestLore } from './request-lore.js';

export type MainResult = {
  status: 'completed' | 'refused' | 'partial' | 'error' | 'cancelled';
  text: string;
  error: string | null;
  usage: Usage;
};
export type MainHooks = {
  /** Explicit deterministic behavior for the no-model test path only. */
  fixture?: FixtureGeneration;
  prepareRequest?: (request: ProviderRequest, usage: Usage) => Promise<ProviderRequest>;
  initialUsage?: Usage;
  /** Calls owned by the host after the writer completes (for example response judgment). */
  reserveCalls?: number;
  executeAnthropicBatch?: import('../core/transport.js').ProviderExecutionOptions['executeAnthropicBatch'];
  executeCodex?: import('../core/transport.js').ProviderExecutionOptions['executeCodex'];
  /** Explicitly wired for real writing Runs, not helper-generated hypothetical scenes. */
  executeCodexAgent?: import('./codex-runtime.js').CodexRuntimeService['executeAgent'];
  resolveCredential?: import('../core/transport.js').ProviderExecutionOptions['resolveCredential'];
  signal: AbortSignal;
  onInput: (input: ModelInput) => void | Promise<void>;
  onToolEvent: (event: ToolEvent) => void | Promise<void>;
  /** Durable tool receipts used only when resuming a recoverable Batch Run. */
  replayToolEvents?: readonly ToolEvent[];
  /** Stable reservation identity for evaluation tool receipts during Batch recovery. */
  evaluationRunId?: string;
  timeoutMs?: number;
  vertexRequestTier?: 'standard' | 'flex';
  authorize: (connection: Connection) => Connection | Promise<Connection>;
  onAttemptStart: (request: WireRecord, resumeAttemptId?: string) => string | Promise<string>;
  onAttemptFinish: (id: string, result: ProviderResult) => void | Promise<void>;
  cancelRemoteOnAbort?: () => boolean;
  onResponseProgress?: (
    progress: ProviderProgress & { attemptId: string; segment: number }
  ) => void | Promise<void>;
};

/** Carries accounting out of fatal host failures without exposing the host exception to guests. */
export class ModelRunError extends Error {
  constructor(
    cause: unknown,
    readonly usage: Usage
  ) {
    super('MODEL_EXECUTION_FAILED', { cause });
    this.name = 'ModelRunError';
  }
}

function addUsage(total: Usage, result: ProviderResult) {
  for (const key of ['inputTokens', 'outputTokens', 'costUsd'] as const) {
    total[key] =
      total[key] === null || result.usage[key] === null ? null : total[key] + result.usage[key];
  }
}

/** One server-owned main run. A transport error/partial/refusal is terminal, never an implicit retry. */
export async function runMain(snapshot: RunSnapshot, hooks: MainHooks): Promise<MainResult> {
  const fixed = attachMainHostContext(structuredClone(snapshot));
  if (hooks.reserveCalls) fixed.settings.maxCalls -= hooks.reserveCalls;
  const target = fixed.profile?.models.main;
  if (!target) {
    const result = await executeFixtureMain(fixed, hooks, hooks.fixture);
    return { status: 'completed', ...result, error: null };
  }
  let completedToolHistory: ToolEvent[] = [];
  let lastUnhelpfulRead: string | undefined;
  const results: ToolEvent[] = [];
  const correction = createToolCorrectionPolicy();
  const evaluation = createEvaluationToolSession(
    target,
    hooks.timeoutMs,
    hooks.evaluationRunId && fixed.executionClock
      ? { id: hooks.evaluationRunId, issuedAt: fixed.executionClock.iso }
      : undefined
  );
  const maxCalls = fixed.settings.maxCalls;
  const mainCallLimit = evaluation ? Math.min(maxCalls, evaluation.maxCalls) : maxCalls;
  let mainCalls = 0;
  const completedCallIds = new Set<string>();
  const usage: Usage = structuredClone(
    hooks.initialUsage ?? { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }
  );
  let opaqueState: Json | undefined;
  let continuationPrompt: ProviderRequest['prompt'];
  const fail = (
    error: string,
    text = '',
    status: MainResult['status'] = hooks.signal.aborted ? 'cancelled' : text ? 'partial' : 'error'
  ): MainResult => ({ status, error, text, usage });
  const replayEvents = new Map<string, ToolEvent>();
  let replayInvalid = false;
  for (const event of hooks.replayToolEvents ?? []) {
    if (event.callId.startsWith('__advisor_before_')) continue;
    const key = JSON.stringify([event.callId, event.name]);
    if (replayEvents.has(key)) replayInvalid = true;
    replayEvents.set(key, structuredClone(event));
  }
  const takeReplay = (callId: string, name: string) => {
    const key = JSON.stringify([callId, name]);
    const event = replayEvents.get(key);
    if (event) replayEvents.delete(key);
    return event ? structuredClone(event) : undefined;
  };
  const persistOrReplay = async (expected: ToolEvent): Promise<boolean> => {
    const saved = takeReplay(expected.callId, expected.name);
    if (!saved) {
      await hooks.onToolEvent(structuredClone(expected));
      return true;
    }
    return isDeepStrictEqual(saved, expected);
  };
  if (replayInvalid) return fail('BATCH_RECOVERY_TOOL_MISMATCH');
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1) return fail('MODEL_CALL_BUDGET_EXHAUSTED');
  const collaboration = createAgentCollaboration(fixed, hooks, usage);
  try {
    await collaboration?.prepare();
  } catch (error) {
    throw new ModelRunError(error, structuredClone(usage));
  }
  // Explicit cross-advisor references outlive provider compaction. Keep the
  // original completed receipts separate from the mutable projection sent to the main model.
  const advisorContext = new Map(
    (collaboration?.bootstrap ?? []).map((event) => [event.callId, structuredClone(event)])
  );
  const contextReadNames = new Set(MAIN_READ_TOOLS.map((tool) => tool.name));
  const executeCalls = async (
    result: ProviderResult,
    signal: AbortSignal = hooks.signal,
    native = false
  ): Promise<MainResult | undefined> => {
    // Validate the whole turn before executing: repeated IDs cannot alias earlier tool results.
    const callIds = new Set(
      [...results, ...(collaboration?.bootstrap ?? [])].map((event) => event.callId)
    );
    for (const call of result.toolCalls) {
      if (callIds.has(call.id) || completedCallIds.has(call.id)) return fail('DUPLICATE_TOOL_ID');
      callIds.add(call.id);
      completedCallIds.add(call.id);
    }
    const terminals = result.toolCalls.filter((call) => call.name === 'story.submit');
    if (terminals.length) {
      const call = terminals[0],
        content = call.arguments.content;
      if (
        !storySubmissionEnabled(fixed) ||
        terminals.length !== 1 ||
        result.toolCalls.length !== 1 ||
        result.refusal ||
        result.error ||
        Object.keys(call.arguments).some((key) => key !== 'content') ||
        typeof content !== 'string' ||
        !content.trim() ||
        content.length > STORY_SUBMIT_MAX_CHARS
      )
        return fail('INVALID_STORY_SUBMISSION');
      if (signal.aborted) return fail('CANCELLED');
      const preset = fixed.profile?.promptPresets?.main;
      const event: ToolEvent = {
        callId: call.id,
        name: call.name,
        args: { content },
        denied: false,
        result: {
          accepted: true,
          contentHash: createHash('sha256').update(content).digest('hex'),
          characters: content.length,
          host: {
            chatId: fixed.chatId,
            parentRevision: fixed.parentRevision,
            settingsRevision: fixed.settingsRevision,
            profileRevision: fixed.profile?.revision ?? null,
            promptPreset: preset ? { id: preset.id, revision: preset.revision } : null,
          },
        },
      };
      if (!(await persistOrReplay(event))) return fail('BATCH_RECOVERY_TOOL_MISMATCH');
      return { status: 'completed', text: content, error: null, usage };
    }
    const evaluationTerminals = result.toolCalls.filter(
      (call) => call.name === 'eval_submit_artifact'
    );
    if (evaluationTerminals.length) {
      if (
        !evaluation ||
        evaluationTerminals.length !== 1 ||
        result.toolCalls.some(
          (call) => !evaluation.allNames.includes(call.name as (typeof evaluation.allNames)[number])
        ) ||
        result.refusal ||
        result.error
      )
        return fail('INVALID_EVALUATION_ARTIFACT');
      for (const call of result.toolCalls.filter((call) => call.name !== 'eval_submit_artifact')) {
        const event = evaluation.execute(call);
        results.push(event);
        if (!(await persistOrReplay(event))) return fail('BATCH_RECOVERY_TOOL_MISMATCH');
      }
      // Old submitted Batches may already have a durable refusal-retry receipt.
      // Replay that result without reinstating the retired prose classifier.
      const terminalCall = evaluationTerminals[0];
      const savedTerminal = replayEvents.get(JSON.stringify([terminalCall.id, terminalCall.name]));
      if (
        target.connection.protocol === 'anthropic-messages-v1' &&
        target.executionMode === 'batch' &&
        hooks.evaluationRunId &&
        savedTerminal
      ) {
        const retiredFailure: ToolEvent = {
          callId: terminalCall.id,
          name: terminalCall.name,
          args: {},
          denied: false,
          result: {
            error: {
              code: 'OUTPUT_VALIDATION_FAILED',
              requiredAction: 'submit-completed-artifact',
            },
          },
        };
        if (isDeepStrictEqual(savedTerminal, retiredFailure)) {
          if (signal.aborted) return fail('CANCELLED');
          results.push(takeReplay(terminalCall.id, terminalCall.name)!);
          opaqueState = result.opaqueState;
          return undefined;
        }
      }
      const submitted = evaluation.submit(
        evaluationTerminals[0],
        evaluationTerminals[0].recoveredFromTruncation === true
      );
      if (!submitted.ok) {
        results.push(submitted.event);
        if (!(await persistOrReplay(submitted.event))) return fail('BATCH_RECOVERY_TOOL_MISMATCH');
        opaqueState = result.opaqueState;
        return undefined;
      }
      if (signal.aborted) return fail('CANCELLED');
      const event: ToolEvent = {
        callId: evaluationTerminals[0].id,
        name: 'eval_submit_artifact',
        args: {},
        denied: false,
        result: {
          accepted: true,
          sha256: submitted.artifact.sha256,
          characters: submitted.artifact.text.length,
          utf8Bytes: submitted.artifact.utf8Bytes,
          ...(evaluation.requiresSubmission
            ? {
                processingNoteProvided: submitted.artifact.processingNoteProvided,
                processingNoteCharacters: submitted.artifact.processingNoteCharacters,
              }
            : {
                noticeProvided: submitted.artifact.noticeProvided,
                noticeCharacters: submitted.artifact.noticeCharacters,
              }),
          correctionCount: submitted.artifact.correctionCount,
        },
      };
      if (!(await persistOrReplay(event))) return fail('BATCH_RECOVERY_TOOL_MISMATCH');
      return { status: 'completed', text: submitted.artifact.text, error: null, usage };
    }
    opaqueState = result.opaqueState;
    for (const call of result.toolCalls) {
      if (signal.aborted) return fail('CANCELLED');
      // Transport only decodes. Exact frozen bindings separate state actions from read permissions.
      const action = { callId: call.id, name: call.name, args: call.arguments };
      const saved = takeReplay(call.id, call.name);
      let event: ToolEvent;
      if (saved) {
        if (call.name === 'agents.consult' && collaboration) {
          event = collaboration.replay(saved);
        } else if (
          evaluation?.allNames.includes(call.name as (typeof evaluation.allNames)[number])
        ) {
          const restored = evaluation.execute(call);
          if (!isDeepStrictEqual(restored, saved)) return fail('BATCH_RECOVERY_TOOL_MISMATCH');
          event = saved;
        } else {
          event = saved;
        }
      } else if (call.name === 'agents.consult' && collaboration) {
        event = await collaboration.consult(call.id, call.arguments, [...advisorContext.values()], {
          signal,
          reserveWriterCall: native ? 0 : 1,
        });
      } else
        event = evaluation?.allNames.includes(call.name as (typeof evaluation.allNames)[number])
          ? evaluation.execute(call)
          : executeTool(fixed, action, signal);
      results.push(event);
      if (collaboration && (event.name === 'agents.consult' || contextReadNames.has(event.name)))
        advisorContext.set(event.callId, structuredClone(event));
      // Persist each real result immediately. Recovery reuses the durable receipt instead.
      if (!saved) await hooks.onToolEvent(structuredClone(event));
      const outcome = correction(event, call.arguments);
      if (outcome === 'denied') return fail('READ_TOOL_DENIED');
    }
    return undefined;
  };
  while (true) {
    if (hooks.signal.aborted) return fail('CANCELLED');
    if (
      !Number.isSafeInteger(maxCalls) ||
      maxCalls < 1 ||
      usage.modelCalls >= maxCalls ||
      mainCalls >= mainCallLimit
    )
      return fail('MODEL_CALL_BUDGET_EXHAUSTED');
    if (evaluation && evaluation.remainingMs() === 0) return fail('TIMEOUT');
    let authorized: Connection;
    try {
      authorized = await hooks.authorize(structuredClone(target.connection));
    } catch {
      return fail('CONNECTION_NOT_AUTHORIZED');
    }
    if (
      !authorized.enabled ||
      authorized.id !== target.connectionId ||
      authorized.endpoint !== target.connection.endpoint ||
      authorized.protocol !== target.connection.protocol
    )
      return fail('CONNECTION_NOT_AUTHORIZED');
    // The economized evaluation bootstrap remains a single old-style low-effort request.
    const economizedBootstrap =
      evaluation?.options.contextMode === 'preloaded' &&
      evaluation.options.approvalReasoningMode === 'economized' &&
      results.length === 0;
    const native =
      authorized.protocol === 'codex-app-server-v1' &&
      hooks.executeCodexAgent &&
      !economizedBootstrap
        ? hooks.executeCodexAgent
        : undefined;
    const build = (freshHistory?: ToolEvent[]) => {
      const fresh = freshHistory !== undefined;
      const history = freshHistory ?? completedToolHistory;
      return buildMainProviderRequest(fixed, {
        results: fresh ? [] : results,
        ...(evaluation
          ? {
              evaluation: {
                definitions: evaluation.definitions,
                bootstrap: evaluation.bootstrap,
                ...(evaluation.toolChoice(results.length)
                  ? { toolChoice: evaluation.toolChoice(results.length) }
                  : {}),
              },
            }
          : {}),
        ...(!fresh && opaqueState !== undefined ? { opaqueState } : {}),
        ...(collaboration ? { agentBootstrap: collaboration.bootstrap } : {}),
        ...(history.length ? { completedToolHistory: history } : {}),
      });
    };
    // Continuation preflight must use the prompt actually sent after editRequest.
    // Do not execute authored callbacks for estimates; the next real send is still
    // prepared once and validated against the provider's continuation binding.
    const preview = (request: ProviderRequest) =>
      encodeMainPreview(
        request.opaqueState != null ? { ...request, prompt: continuationPrompt } : request,
        target,
        { codexNative: !!native }
      );
    let built = build();
    const latestRead = results.findLast(compactableRead)?.callId;
    if (!native && !evaluation && fixed.contextPlan && latestRead) {
      const before = estimateContextTokens(preview(built.request).body);
      const inputLimit = fixed.contextPlan.budget.inputTokenLimit;
      if (latestRead === lastUnhelpfulRead && before > inputLimit)
        return fail('CONTEXT_TOOL_COMPACTION_NO_PROGRESS');
      if (before > inputLimit * 0.85 && latestRead !== lastUnhelpfulRead) {
        try {
          const history = [...completedToolHistory, ...results];
          const compacted = await compactToolReads(fixed, history, hooks, usage, (projection) =>
            estimateContextTokens(preview(build(projection).request).body)
          );
          // Completed work becomes ordinary host reference data, not unsigned native tool calls.
          const candidate = build(compacted);
          const after = estimateContextTokens(preview(candidate.request).body);
          // 85% is a soft trigger, not a second admission limit. Keep a valid original
          // continuation when summarization fails to reduce it; never admit an oversized body.
          const applied = after < before && after <= inputLimit;
          await hooks.onToolEvent({
            callId: `host-compaction-${usage.modelCalls}`,
            name: 'context.compact',
            args: {},
            denied: false,
            result: {
              reason: 'tool-results',
              applied,
              beforeTokens: before,
              afterTokens: after,
              compactedReads: results.filter(compactableRead).length,
            },
          });
          if (applied) {
            // Discard opaque continuation only after adopting the replacement history.
            opaqueState = undefined;
            results.length = 0;
            completedToolHistory = compacted;
            lastUnhelpfulRead = undefined;
            built = candidate;
          } else {
            // The same reads must not repeatedly spend summary calls after unrelated writes.
            lastUnhelpfulRead = latestRead;
            if (before > inputLimit) return fail('CONTEXT_TOOL_COMPACTION_NO_PROGRESS');
          }
          // Compaction can take several provider calls; refresh main authorization afterwards.
          authorized = await hooks.authorize(structuredClone(target.connection));
          if (
            !authorized.enabled ||
            authorized.id !== target.connectionId ||
            authorized.endpoint !== target.connection.endpoint ||
            authorized.protocol !== target.connection.protocol ||
            authorized.credentialRef !== target.connection.credentialRef
          )
            return fail('CONNECTION_NOT_AUTHORIZED');
        } catch (error) {
          return fail(error instanceof Error ? error.message : 'CONTEXT_TOOL_COMPACTION_FAILED');
        }
      }
    }
    const { input } = built;
    let { request } = built;
    if (hooks.prepareRequest) {
      try {
        request = await hooks.prepareRequest(request, usage);
      } catch (error) {
        throw new ModelRunError(error, structuredClone(usage));
      }
    }
    // Native request hooks may themselves call a model. Recheck the reserved host budget
    // after those calls, before sending a writer request that could not be judged.
    if (usage.modelCalls >= maxCalls) return fail('MODEL_CALL_BUDGET_EXHAUSTED');
    if (evaluation && request.generation) {
      const configured = request.generation;
      request.generation = evaluation.generation(configured, results.length);
      const binding = evaluation.generationBinding(configured, results.length);
      if (binding) request.generationBinding = binding;
    }
    await hooks.onInput(structuredClone(input));
    let attemptId: string | undefined;
    const remainingTimeout = evaluation?.remainingMs();
    if (remainingTimeout === 0) return fail('TIMEOUT');
    const execution: ProviderExecutionOptions = {
      signal: hooks.signal,
      resolveCredential: hooks.resolveCredential,
      executeAnthropicBatch: hooks.executeAnthropicBatch,
      executeCodex: hooks.executeCodex,
      vertexRequestTier: hooks.vertexRequestTier,
      executionMode: target.executionMode,
      cancelRemoteOnAbort: hooks.cancelRemoteOnAbort,
      timeoutMs:
        remainingTimeout ??
        hooks.timeoutMs ??
        target.timeoutMs ??
        (target.connection.protocol === 'vertex-gemini-v1' ? 300_000 : undefined),
      onWire: async (wire, resumeAttemptId) => {
        attemptId = await hooks.onAttemptStart(
          {
            ...wire,
            ...(request.contextBudget
              ? {
                  requestContext: {
                    estimatedInputTokens: estimateContextTokens(wire.body),
                    inputTokenLimit: request.contextBudget.inputTokenLimit,
                  },
                }
              : {}),
            requestLore: requestLore(fixed, request, wire, {
              pinned: input.pinnedSources ?? [],
              catalog: input.catalog,
            }),
          },
          resumeAttemptId
        );
        // Persistence completes before fetch. A crash leaves an uncertain attempt, not a queued replay.
        usage.modelCalls++;
        mainCalls++;
        return attemptId;
      },
      onProgress: async (progress) => {
        if (attemptId !== undefined && !hooks.signal.aborted)
          await hooks.onResponseProgress?.({ ...progress, attemptId, segment: 0 });
      },
    };
    let nativeHostError: unknown;
    let nativeFinished = false;
    let nativeExchanges = 0;
    let pendingTools = Promise.resolve();
    const onToolCall: CodexAgentExecutionOptions['onToolCall'] = (call, nativeSignal) => {
      const pending = pendingTools
        .then(async () => {
          const signal = AbortSignal.any([hooks.signal, nativeSignal]);
          signal.throwIfAborted();
          if (nativeFinished) throw new ProviderContractError('CODEX_TURN_FINISHED');
          if (
            !call.arguments ||
            typeof call.arguments !== 'object' ||
            Array.isArray(call.arguments)
          )
            throw new ProviderContractError('CODEX_INVALID_TOOL_ARGUMENTS');
          const submission = ['story.submit', 'eval_submit_artifact'].includes(call.name);
          if (!submission && evaluation && nativeExchanges >= evaluation.options.maximumToolRounds)
            throw new ProviderContractError('MODEL_CALL_BUDGET_EXHAUSTED');
          const prior = results.length;
          const terminal = await executeCalls(
            {
              status: 'tool_calls',
              text: '',
              toolCalls: [{ id: call.callId, name: call.name, arguments: call.arguments }],
              refusal: null,
              error: null,
              opaqueState: null,
              usage: {
                inputTokens: null,
                outputTokens: null,
                costUsd: null,
                raw: null,
                priceRevision: null,
              },
            },
            signal,
            true
          );
          if (terminal) {
            nativeFinished = true;
            if (terminal.status !== 'completed')
              throw new ProviderContractError(terminal.error ?? 'CODEX_TOOL_FAILED');
            return { complete: true as const, success: true as const, text: terminal.text };
          }
          // Invalid submissions are correctable but not an unlimited sequence of free retries.
          if (++nativeExchanges > (evaluation?.options.maximumToolRounds ?? Infinity))
            throw new ProviderContractError('MODEL_CALL_BUDGET_EXHAUSTED');
          const event = results[prior];
          if (!event) throw new ProviderContractError('CODEX_TOOL_RESULT_MISSING');
          return { success: !event.denied, text: JSON.stringify(event.result) };
        })
        .catch((error) => {
          if (
            !(error instanceof ProviderContractError) &&
            !hooks.signal.aborted &&
            !nativeSignal.aborted
          )
            nativeHostError = error;
          throw error;
        });
      pendingTools = pending.then(
        () => {},
        () => {}
      );
      return pending;
    };
    let result: ProviderResult;
    try {
      result = native
        ? await native(transportConnection(authorized), buildCodexNativeRequest(request), {
            ...execution,
            onProgress: undefined,
            onToolCall,
          })
        : await executeProvider(transportConnection(authorized), request, execution);
    } catch (error) {
      // A native-input rejection (for example prefill) must keep its existing actionable code.
      if (attemptId === undefined && error instanceof ProviderContractError)
        return fail(error.code);
      throw new ModelRunError(error, structuredClone(usage));
    }
    await pendingTools;
    if (attemptId !== undefined) {
      // The attempt is saved before tool authorization. Preserve actual arguments only in a
      // successful ToolEvent; a rejected operation must not leak them through this earlier copy.
      const diagnostic = evaluation ? evaluation.diagnosticResult(result) : structuredClone(result);
      await hooks.onAttemptFinish(attemptId, diagnostic);
    }
    addUsage(usage, result);
    if (nativeHostError) throw new ModelRunError(nativeHostError, structuredClone(usage));
    continuationPrompt = request.prompt;
    if (result.status === 'completed' && evaluation?.requiresSubmission && !nativeFinished)
      return fail('EVALUATION_SUBMISSION_REQUIRED');
    if (result.status !== 'tool_calls')
      return {
        status: result.status,
        text: result.text,
        error: result.refusal ?? result.error?.code ?? null,
        usage,
      };
    const terminal = await executeCalls(result);
    if (terminal) return terminal;
  }
}
