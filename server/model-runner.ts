import { createToolCorrectionPolicy } from '../core/tool-outcome.js';
import { executeMain, executeTool, type ToolAction } from '../core/provider.js';
import type { Connection } from '../core/product.js';
import {
  executeProvider,
  type Json,
  type ProviderResult,
  type WireRecord,
} from '../core/transport.js';
import type { ModelInput, RunSnapshot, ToolEvent, Usage } from '../core/types.js';
import { createEvaluationToolSession } from './evaluation-session.js';
import { createHash } from 'node:crypto';
import {
  attachMainHostContext,
  buildMainProviderRequest,
  storySubmissionEnabled,
  STORY_SUBMIT_MAX_CHARS,
} from './main-request.js';
import {
  assertBehaviorToolCapability,
  listBehaviorTools,
  type BehaviorToolBinding,
} from '../core/package-behavior-tools.js';
import { BehaviorError } from '../core/package-behavior.js';
import { createAgentCollaboration } from './agent-collaboration.js';

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
    action: ToolAction
  ) => ToolEvent | Promise<ToolEvent>;
  approvedOrigins: readonly string[];
  timeoutMs?: number;
  vertexRequestTier?: 'standard' | 'flex';
  authorize: (connection: Connection) => Connection | Promise<Connection>;
  onAttemptStart: (request: WireRecord) => string | Promise<string>;
  onAttemptFinish: (id: string, result: ProviderResult) => void | Promise<void>;
};

function addUsage(total: Usage, result: ProviderResult) {
  for (const key of ['inputTokens', 'outputTokens', 'costUsd'] as const) {
    total[key] =
      total[key] === null || result.usage[key] === null ? null : total[key] + result.usage[key];
  }
}

/** One server-owned main run. A transport error/partial/refusal is terminal, never an implicit retry. */
export async function runMain(snapshot: RunSnapshot, hooks: MainHooks): Promise<MainResult> {
  let behaviorTools: BehaviorToolBinding[];
  try {
    behaviorTools = listBehaviorTools(snapshot);
    assertBehaviorToolCapability(snapshot, behaviorTools);
  } catch (error) {
    if (!(error instanceof BehaviorError)) throw error;
    return {
      status: 'error',
      text: '',
      error: error.message,
      usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    };
  }
  const fixed = attachMainHostContext(structuredClone(snapshot));
  const target = fixed.profile?.models.main;
  if (!target) {
    const result = await executeMain(fixed, hooks);
    return { status: 'completed', ...result, error: null };
  }
  const results: ToolEvent[] = [];
  const correction = createToolCorrectionPolicy();
  const evaluation = createEvaluationToolSession(target, hooks.timeoutMs);
  const maxCalls = fixed.settings.maxCalls;
  const mainCallLimit = evaluation ? Math.min(maxCalls, evaluation.maxCalls) : maxCalls;
  let mainCalls = 0;
  const usage: Usage = structuredClone(
    hooks.initialUsage ?? { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }
  );
  let opaqueState: Json | undefined;
  const fail = (
    error: string,
    text = '',
    status: MainResult['status'] = hooks.signal.aborted ? 'cancelled' : text ? 'partial' : 'error'
  ): MainResult => ({ status, error, text, usage });
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1) return fail('MODEL_CALL_BUDGET_EXHAUSTED');
  const collaboration = createAgentCollaboration(fixed, hooks, usage);
  await collaboration?.prepare();
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
    const built = buildMainProviderRequest(fixed, {
      results,
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
      ...(opaqueState !== undefined ? { opaqueState } : {}),
      ...(collaboration ? { agentBootstrap: collaboration.bootstrap } : {}),
    });
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
    const result = await executeProvider(
      {
        id: authorized.id,
        protocol: authorized.protocol,
        endpoint: authorized.endpoint,
        ...(authorized.credentialEnv ? { credentialEnv: authorized.credentialEnv } : {}),
      },
      request,
      {
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
      }
    );
    if (attemptId !== undefined)
      await hooks.onAttemptFinish(
        attemptId,
        evaluation ? evaluation.diagnosticResult(result) : structuredClone(result)
      );
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
      [...results, ...(collaboration?.bootstrap ?? [])].map((event) => event.callId)
    );
    for (const call of result.toolCalls) {
      if (callIds.has(call.id)) return fail('DUPLICATE_TOOL_ID');
      callIds.add(call.id);
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
    for (const call of result.toolCalls) {
      if (hooks.signal.aborted) return fail('CANCELLED');
      // Transport only decodes. Exact frozen bindings separate state actions from read permissions.
      const binding = behaviorTools.find((item) => item.tool.name === call.name);
      const action = { callId: call.id, name: call.name, args: call.arguments };
      let event: ToolEvent;
      if (call.name === 'agents.consult' && collaboration) {
        event = await collaboration.consult(call.id, call.arguments);
      } else if (binding) {
        event = hooks.onBehaviorTool
          ? await hooks.onBehaviorTool(
              { instanceId: binding.instanceId, actionId: binding.actionId },
              action
            )
          : {
              callId: call.id,
              name: call.name,
              args: {},
              result: { code: 'BEHAVIOR_EXECUTOR_UNAVAILABLE' },
              denied: true,
            };
      } else
        event = evaluation?.allNames.includes(call.name as (typeof evaluation.allNames)[number])
          ? evaluation.execute(call)
          : executeTool(fixed, action, hooks.signal);
      results.push(event);
      await hooks.onToolEvent(structuredClone(event));
      const outcome = correction(event, call.arguments);
      if (outcome === 'exhausted') return fail('TOOL_CORRECTION_EXHAUSTED');
      if (outcome === 'denied')
        return fail(
          binding || call.name.startsWith('behavior_') ? 'ACTION_TOOL_DENIED' : 'READ_TOOL_DENIED'
        );
    }
  }
}
