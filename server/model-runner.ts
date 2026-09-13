import { createToolCorrectionPolicy } from '../core/tool-outcome.js';
import { estimateContextTokens } from '../core/context-budget.js';
import {
  CONTEXT_TOOL_NAMES,
  CONTEXT_WINDOW_RESULT_TOOLS,
  contextToolsEnabled,
  contextWindowStatus,
  type ContextWindowStatus,
} from '../core/context-tools.js';
import { executeMain, executeTool, type ToolAction } from '../core/provider.js';
import type { Connection } from '../core/product.js';
import {
  executeProvider,
  type Json,
  type ProviderResult,
  type WireRecord,
  type ProviderProgress,
  transportConnection,
} from '../core/transport.js';
import type { ModelInput, RunSnapshot, ToolEvent, Usage } from '../core/types.js';
import { createEvaluationToolSession } from './evaluation-session.js';
import { createHash } from 'node:crypto';
import { attachMainHostContext } from './main-host-context.js';
import {
  buildMainProviderRequest,
  MAIN_READ_TOOLS,
  encodeMainPreview,
  storySubmissionEnabled,
  STORY_SUBMIT_MAX_CHARS,
} from './main-request.js';
import {
  executeContextTool,
  type ContextPersistence,
  type ContextToolState,
} from './context-tools.js';
import {
  admitBehaviorTools,
  listBehaviorTools,
  type BehaviorToolBinding,
} from '../core/package-behavior-tools.js';
import { createAgentCollaboration } from './agent-collaboration.js';
import { createExtensionModelService } from './extension-model.js';
import type { ExtensionModelBinding } from '../core/extension-model.js';
import type { RuntimeValue } from '../core/prompt-values.js';
import { compactableRead, compactToolReads } from './context-tool-compaction.js';
import { BehaviorError } from '../core/package-behavior.js';
import { PromptEvaluationError } from '../core/prompt-values.js';

export type MainResult = {
  status: 'completed' | 'refused' | 'partial' | 'error' | 'cancelled';
  text: string;
  error: string | null;
  usage: Usage;
};
export type MainHooks = {
  initialUsage?: Usage;
  executeCodex?: import('../core/transport.js').ProviderExecutionOptions['executeCodex'];
  resolveCredential?: import('../core/transport.js').ProviderExecutionOptions['resolveCredential'];
  signal: AbortSignal;
  onInput: (input: ModelInput) => void | Promise<void>;
  onToolEvent: (event: ToolEvent) => void | Promise<void>;
  onBehaviorTool?: (
    binding: Pick<BehaviorToolBinding, 'instanceId' | 'actionId'>,
    action: ToolAction,
    host?: {
      modelGenerate: (args: RuntimeValue, signal: AbortSignal) => Promise<RuntimeValue>;
      assertModelAccess: () => void | Promise<void>;
      hostWaitMs: number;
    }
  ) => ToolEvent | Promise<ToolEvent>;
  /** User-owned live grant/connection checks, separate from the frozen authored capability. */
  authorizeExtensionModel?: (binding: ExtensionModelBinding) => void | Promise<void>;
  /** Durable owner of model-written context checkpoints; absent owners deny context.write/new. */
  persistContext?: ContextPersistence;
  approvedOrigins: readonly string[];
  timeoutMs?: number;
  vertexRequestTier?: 'standard' | 'flex';
  authorize: (connection: Connection) => Connection | Promise<Connection>;
  onAttemptStart: (request: WireRecord) => string | Promise<string>;
  onAttemptFinish: (id: string, result: ProviderResult) => void | Promise<void>;
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

/** Denials describe an unexecuted operation, never echo the rejected input or host diagnostics. */
function compactBehaviorDenial(event: ToolEvent, action: ToolAction): ToolEvent {
  const raw = (event.result as { code?: unknown } | null)?.code;
  const code =
    typeof raw === 'string' && /^(BEHAVIOR|PROMPT)_[A-Z0-9_]{1,100}$/u.test(raw)
      ? raw
      : 'BEHAVIOR_ACTION_DENIED';
  const recoverable = event.errorKind === 'recoverable' || code === 'BEHAVIOR_TOOL_NOT_ALLOWED';
  return {
    callId: action.callId,
    name: action.name,
    args: {},
    denied: true,
    ...(recoverable ? { errorKind: 'recoverable' as const } : {}),
    result: { code, ...(recoverable ? { unavailable: true, continueWithoutAction: true } : {}) },
  };
}

/** One server-owned main run. A transport error/partial/refusal is terminal, never an implicit retry. */
export async function runMain(snapshot: RunSnapshot, hooks: MainHooks): Promise<MainResult> {
  snapshot = admitBehaviorTools(snapshot);
  const behaviorTools = listBehaviorTools(snapshot);
  const disabledBehaviorTools = new Set<string>(
    hooks.onBehaviorTool ? [] : behaviorTools.map((binding) => binding.tool.name)
  );
  // Reassigned only at a model-requested window boundary; every segment is one frozen projection.
  let fixed = attachMainHostContext(structuredClone(snapshot));
  const target = fixed.profile?.models.main;
  if (!target) {
    const result = await executeMain(fixed, hooks);
    return { status: 'completed', ...result, error: null };
  }
  const contextTools = contextToolsEnabled(fixed);
  const contextState: ContextToolState = {
    workingSummary: fixed.contextPlan?.summary ?? null,
    checkpoint: fixed.contextPlan?.checkpoint ?? null,
  };
  let segmentBootstrap: ToolEvent[] = [];
  let completedToolHistory: ToolEvent[] = [];
  let lastUnhelpfulRead: string | undefined;
  const resultWindows = new Map<string, ContextWindowStatus>();
  const results: ToolEvent[] = [];
  const correction = createToolCorrectionPolicy();
  const evaluation = createEvaluationToolSession(target, hooks.timeoutMs);
  const maxCalls = fixed.settings.maxCalls;
  const mainCallLimit = evaluation ? Math.min(maxCalls, evaluation.maxCalls) : maxCalls;
  let mainCalls = 0;
  const completedCallIds = new Set<string>();
  const usage: Usage = structuredClone(
    hooks.initialUsage ?? { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }
  );
  const extensionModels = createExtensionModelService(snapshot, hooks, usage);
  let opaqueState: Json | undefined;
  const fail = (
    error: string,
    text = '',
    status: MainResult['status'] = hooks.signal.aborted ? 'cancelled' : text ? 'partial' : 'error'
  ): MainResult => ({ status, error, text, usage });
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1) return fail('MODEL_CALL_BUDGET_EXHAUSTED');
  const collaboration = createAgentCollaboration(fixed, hooks, usage);
  await collaboration?.prepare();
  // Explicit cross-advisor references outlive provider compaction and context.new. Keep the
  // original completed receipts separate from the mutable projection sent to the main model.
  const advisorContext = new Map(
    (collaboration?.bootstrap ?? []).map((event) => [event.callId, structuredClone(event)])
  );
  const contextReadNames = new Set(MAIN_READ_TOOLS.map((tool) => tool.name));
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
    const build = (freshHistory?: ToolEvent[]) => {
      const fresh = freshHistory !== undefined;
      const history = freshHistory ?? completedToolHistory;
      return buildMainProviderRequest(fixed, {
        disabledBehaviorTools: [
          ...disabledBehaviorTools,
          ...(usage.modelCalls + 1 >= maxCalls || mainCalls + 1 >= mainCallLimit
            ? behaviorTools.map((binding) => binding.tool.name)
            : []),
        ],
        results: (fresh ? [] : results).map((event) => {
          const contextWindow = resultWindows.get(event.callId);
          return contextWindow
            ? { ...event, result: { ...(event.result as Record<string, unknown>), contextWindow } }
            : event;
        }),
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
        ...(!fresh && segmentBootstrap.length ? { segmentBootstrap } : {}),
        ...(history.length ? { completedToolHistory: history } : {}),
      });
    };
    let built = build();
    const latestRead = results.findLast(compactableRead)?.callId;
    if (!evaluation && fixed.contextPlan && latestRead) {
      const before = estimateContextTokens(encodeMainPreview(built.request, target).body);
      const inputLimit = fixed.contextPlan.budget.inputTokenLimit;
      if (latestRead === lastUnhelpfulRead && before > inputLimit)
        return fail('CONTEXT_TOOL_COMPACTION_NO_PROGRESS');
      if (before > inputLimit * 0.85 && latestRead !== lastUnhelpfulRead) {
        try {
          const history = [...completedToolHistory, ...segmentBootstrap, ...results];
          const compacted = await compactToolReads(fixed, history, hooks, usage, (projection) =>
            estimateContextTokens(encodeMainPreview(build(projection).request, target).body)
          );
          // Completed work becomes ordinary host reference data, not unsigned native tool calls.
          const candidate = build(compacted);
          const after = estimateContextTokens(encodeMainPreview(candidate.request, target).body);
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
            resultWindows.clear();
            completedToolHistory = compacted;
            segmentBootstrap = [];
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
            authorized.credentialEnv !== target.connection.credentialEnv
          )
            return fail('CONNECTION_NOT_AUTHORIZED');
        } catch (error) {
          return fail(error instanceof Error ? error.message : 'CONTEXT_TOOL_COMPACTION_FAILED');
        }
      }
    }
    const { input, request } = built;
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
    const result = await executeProvider(transportConnection(authorized), request, {
      approvedOrigins: hooks.approvedOrigins,
      signal: hooks.signal,
      resolveCredential: hooks.resolveCredential,
      executeCodex: hooks.executeCodex,
      vertexRequestTier: hooks.vertexRequestTier,
      timeoutMs:
        remainingTimeout ??
        hooks.timeoutMs ??
        target.timeoutMs ??
        (target.connection.protocol === 'vertex-gemini-v1' ? 300_000 : undefined),
      onWire: async (wire) => {
        attemptId = await hooks.onAttemptStart(wire);
        // Persistence completes before fetch. A crash leaves an uncertain attempt, not a queued replay.
        usage.modelCalls++;
        mainCalls++;
      },
      onProgress: async (progress) => {
        if (attemptId !== undefined && !hooks.signal.aborted)
          await hooks.onResponseProgress?.({ ...progress, attemptId, segment: 0 });
      },
    });
    if (attemptId !== undefined) {
      // The attempt is saved before tool authorization. Preserve actual arguments only in a
      // successful ToolEvent; a rejected operation must not leak them through this earlier copy.
      const diagnostic = evaluation ? evaluation.diagnosticResult(result) : structuredClone(result);
      diagnostic.toolCalls = diagnostic.toolCalls.map((call) => {
        const registered = behaviorTools.some((binding) => binding.tool.name === call.name);
        return registered || call.name.startsWith('behavior_')
          ? { ...call, name: registered ? call.name : 'unapproved', arguments: {} }
          : call;
      });
      await hooks.onAttemptFinish(attemptId, diagnostic);
    }
    addUsage(usage, result);
    if (result.status !== 'tool_calls')
      return {
        status: result.status,
        text: result.text,
        error: result.refusal ?? result.error?.code ?? null,
        usage,
      };
    // Validate the whole turn before executing: repeated IDs cannot alias earlier tool results.
    const callIds = new Set(
      [...results, ...(collaboration?.bootstrap ?? []), ...segmentBootstrap].map(
        (event) => event.callId
      )
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
      if (hooks.signal.aborted) return fail('CANCELLED');
      const preset = fixed.profile?.promptPresets?.main;
      await hooks.onToolEvent({
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
      });
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
        await hooks.onToolEvent(structuredClone(event));
      }
      const submitted = evaluation.submit(
        evaluationTerminals[0],
        evaluationTerminals[0].recoveredFromTruncation === true
      );
      if (!submitted.ok) {
        results.push(submitted.event);
        await hooks.onToolEvent(structuredClone(submitted.event));
        opaqueState = result.opaqueState;
        continue;
      }
      if (hooks.signal.aborted) return fail('CANCELLED');
      await hooks.onToolEvent({
        callId: evaluationTerminals[0].id,
        name: 'eval_submit_artifact',
        args: {},
        denied: false,
        result: {
          accepted: true,
          sha256: submitted.artifact.sha256,
          characters: submitted.artifact.text.length,
          utf8Bytes: submitted.artifact.utf8Bytes,
          noticeProvided: submitted.artifact.noticeProvided,
          noticeCharacters: submitted.artifact.noticeCharacters,
          correctionCount: submitted.artifact.correctionCount,
        },
      });
      return { status: 'completed', text: submitted.artifact.text, error: null, usage };
    }
    opaqueState = result.opaqueState;
    let boundary: { snapshot: RunSnapshot; event: ToolEvent } | undefined;
    const batchStart = results.length;
    for (const call of result.toolCalls) {
      if (hooks.signal.aborted) return fail('CANCELLED');
      // Transport only decodes. Exact frozen bindings separate state actions from read permissions.
      const binding = behaviorTools.find((item) => item.tool.name === call.name);
      const action = { callId: call.id, name: call.name, args: call.arguments };
      let event: ToolEvent;
      if (call.name === 'agents.consult' && collaboration) {
        event = await collaboration.consult(call.id, call.arguments, [...advisorContext.values()]);
      } else if (contextTools && (CONTEXT_TOOL_NAMES as readonly string[]).includes(call.name)) {
        const outcome = await executeContextTool(fixed, action, {
          state: contextState,
          alone: result.toolCalls.length === 1,
          pendingResults: results.length,
          reservedBootstrap: collaboration?.bootstrap.length ?? 0,
          persist: hooks.persistContext,
        });
        event = outcome.event;
        if (outcome.switched) boundary = { snapshot: outcome.switched, event };
      } else if (binding) {
        try {
          event = !hooks.onBehaviorTool
            ? {
                callId: call.id,
                name: call.name,
                args: {},
                denied: true,
                errorKind: 'recoverable',
                result: { code: 'BEHAVIOR_EXECUTOR_UNAVAILABLE' },
              }
            : disabledBehaviorTools.has(call.name)
              ? {
                  callId: call.id,
                  name: call.name,
                  args: {},
                  denied: true,
                  errorKind: 'recoverable',
                  result: {
                    code: 'BEHAVIOR_DISABLED_FOR_RUN',
                    unavailable: true,
                    continueWithoutAction: true,
                  },
                }
              : await hooks.onBehaviorTool(
                  { instanceId: binding.instanceId, actionId: binding.actionId },
                  action,
                  {
                    modelGenerate: (args, signal) =>
                      extensionModels.generate(binding, args, signal),
                    assertModelAccess: () => hooks.authorizeExtensionModel?.(binding),
                    hostWaitMs: extensionModels.hostWaitMs,
                  }
                );
        } catch (error) {
          // Fatal host/ownership/cancellation errors still terminate this run. Returning the
          // accumulated usage lets the caller settle a cancelled run without losing accounting.
          if (error instanceof BehaviorError || error instanceof PromptEvaluationError)
            return fail(error.message);
          throw new ModelRunError(error, structuredClone(usage));
        }
        if (event.denied) event = compactBehaviorDenial(event, action);
        if (event.denied && event.errorKind === 'recoverable') disabledBehaviorTools.add(call.name);
      } else if (call.name.startsWith('behavior_')) {
        event = compactBehaviorDenial(
          {
            ...action,
            args: {},
            denied: true,
            errorKind: 'recoverable',
            result: { code: 'BEHAVIOR_TOOL_NOT_ALLOWED' },
          },
          { ...action, name: 'unapproved', args: {} }
        );
      } else
        event = evaluation?.allNames.includes(call.name as (typeof evaluation.allNames)[number])
          ? evaluation.execute(call)
          : executeTool(fixed, action, hooks.signal);
      results.push(event);
      if (collaboration && (event.name === 'agents.consult' || contextReadNames.has(event.name)))
        advisorContext.set(event.callId, structuredClone(event));
      // Persist each real result immediately, before the next action or any request preview.
      await hooks.onToolEvent(structuredClone(event));
      const outcome = correction(event, call.arguments);
      if (outcome === 'denied')
        return fail(
          binding || call.name.startsWith('behavior_') ? 'ACTION_TOOL_DENIED' : 'READ_TOOL_DENIED'
        );
    }
    if (contextTools && !boundary) {
      const batch = results
        .slice(batchStart)
        .filter(
          (event) =>
            !event.denied &&
            CONTEXT_WINDOW_RESULT_TOOLS.has(event.name) &&
            event.result &&
            typeof event.result === 'object' &&
            !Array.isArray(event.result)
        );
      if (batch.length) {
        // Native continuation validation needs every pending result. Only the completed batch
        // receives new wire annotations; durable receipts and prior continuation results stay fixed.
        const measure = () =>
          estimateContextTokens(encodeMainPreview(build().request, target).body);
        const reserve = 128 * batch.length;
        const annotate = (tokens: number) => {
          const status = contextWindowStatus(tokens, fixed.contextPlan!.budget.inputTokenLimit);
          for (const event of batch) resultWindows.set(event.callId, status);
        };
        const projected = measure() + reserve;
        annotate(projected);
        // Include the actual annotations with a bounded second measurement, not a fixed-point loop.
        const annotated = measure();
        if (annotated > projected) annotate(annotated + reserve);
      }
    }
    if (boundary) {
      // A new window is a fresh provider request: no opaque continuation, no prior results.
      // The completed context.new exchange is the only carried-over tool history.
      fixed = boundary.snapshot;
      results.length = 0;
      resultWindows.clear();
      opaqueState = undefined;
      segmentBootstrap = [structuredClone(boundary.event)];
      completedToolHistory = [];
      lastUnhelpfulRead = undefined;
    }
  }
}
