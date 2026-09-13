import { contextBudgetForModel } from '../core/context-budget.js';
import { extensionModelTarget, type ExtensionModelBinding } from '../core/extension-model.js';
import { ExtensionProgramError } from '../core/extension-program.js';
import { generationFromModel } from '../core/model-capabilities.js';
import type { Connection } from '../core/product.js';
import type { RuntimeValue } from '../core/prompt-values.js';
import {
  executeProvider,
  transportConnection,
  type ProviderResult,
  type ProviderRequest,
} from '../core/transport.js';
import type { RunSnapshot, Usage } from '../core/types.js';
import { HttpError } from './request-validation.js';
import type { MainHooks } from './model-runner.js';

const DEFAULT_CALL_TIMEOUT_MS = 120_000;
const MAX_HOST_WAIT_MS = 1_800_000;
const MAX_PROMPT_CHARS = 16_000;
const MAX_TEXT_CHARS = 6_000;

function fail(code: string): never {
  throw new ExtensionProgramError(code);
}

function argumentsFor(value: RuntimeValue): { prompt: string } {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !Object.hasOwn(value, 'prompt') ||
    typeof value.prompt !== 'string' ||
    !value.prompt.length ||
    value.prompt.length > MAX_PROMPT_CHARS
  )
    fail('BEHAVIOR_HOST_ARGUMENTS');
  return { prompt: value.prompt };
}

function addUsage(total: Usage, result: ProviderResult) {
  for (const key of ['inputTokens', 'outputTokens', 'costUsd'] as const) {
    const value = result.usage[key];
    total[key] = total[key] === null || value === null ? null : total[key] + value;
  }
}

function boundedText(text: string) {
  let value = text.slice(0, MAX_TEXT_CHARS);
  if (value.length < text.length && /[\uD800-\uDBFF]$/u.test(value)) value = value.slice(0, -1);
  return { text: value, truncated: value.length < text.length };
}

function publicResult(result: ProviderResult): RuntimeValue {
  const output = boundedText(result.text);
  if (result.status === 'completed') return { status: 'completed', ...output, error: null };
  if (result.status === 'refused')
    return { status: 'refused', ...output, error: 'BEHAVIOR_HOST_MODEL_REFUSED' };
  if (result.status === 'tool_calls')
    return {
      status: 'error',
      text: '',
      truncated: false,
      error: 'BEHAVIOR_HOST_MODEL_UNEXPECTED_TOOL',
    };
  const timedOut = result.error?.code === 'TIMEOUT';
  return {
    status: result.status === 'partial' ? 'partial' : 'error',
    ...output,
    error: timedOut ? 'BEHAVIOR_HOST_MODEL_TIMEOUT' : 'BEHAVIOR_HOST_MODEL_FAILED',
  };
}

function callTimeout(targetTimeout: number | undefined) {
  const timeout = targetTimeout ?? DEFAULT_CALL_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1) return DEFAULT_CALL_TIMEOUT_MS;
  return Math.min(timeout, MAX_HOST_WAIT_MS);
}

function sameConnection(current: Connection, frozen: Connection) {
  return (
    current.enabled &&
    current.id === frozen.id &&
    current.protocol === frozen.protocol &&
    current.endpoint === frozen.endpoint &&
    current.credentialEnv === frozen.credentialEnv
  );
}

/**
 * Binds extension model calls to one frozen Run. The guest supplies only a prompt; model identity,
 * generation, context budget, credentials, attempt ownership and aggregate usage stay host-owned.
 */
export function createExtensionModelService(
  snapshot: RunSnapshot,
  hooks: MainHooks,
  totalUsage: Usage,
  options: { phase?: 'generation' | 'after-response' } = {}
): {
  generate(
    binding: ExtensionModelBinding,
    args: RuntimeValue,
    signal: AbortSignal
  ): Promise<RuntimeValue>;
  hostWaitMs: number;
} {
  const phase = options.phase ?? 'generation';
  const reservedMainCalls = phase === 'generation' ? 1 : 0;
  let pendingReservations = 0;
  const remainingAtCreation = Math.max(
    1,
    snapshot.settings.maxCalls - totalUsage.modelCalls - reservedMainCalls
  );
  const previewTarget = snapshot.profile?.extensionModel;
  const perCallTimeout = callTimeout(previewTarget?.timeoutMs);
  const hostWaitMs = Math.min(MAX_HOST_WAIT_MS, perCallTimeout * remainingAtCreation);

  const generate = async (
    binding: ExtensionModelBinding,
    value: RuntimeValue,
    runtimeSignal: AbortSignal
  ): Promise<RuntimeValue> => {
    const args = argumentsFor(value);
    if ((binding.trigger === 'after-turn') !== (phase === 'after-response'))
      fail('BEHAVIOR_HOST_MODEL_DENIED');
    const { target, attribution } = extensionModelTarget(snapshot, binding);
    if (!hooks.authorizeExtensionModel) fail('BEHAVIOR_HOST_MODEL_DENIED');
    if (
      totalUsage.modelCalls + pendingReservations >=
      snapshot.settings.maxCalls - reservedMainCalls
    )
      fail('BEHAVIOR_HOST_MODEL_BUDGET_EXHAUSTED');
    pendingReservations++;
    let reserved = true;
    const releaseReservation = () => {
      if (!reserved) return;
      reserved = false;
      pendingReservations--;
    };
    const signal = AbortSignal.any([hooks.signal, runtimeSignal]);
    const authorize = async () => {
      signal.throwIfAborted();
      await hooks.authorizeExtensionModel!(binding);
      signal.throwIfAborted();
      let current: Connection;
      try {
        current = await hooks.authorize(structuredClone(target.connection));
      } catch (error) {
        if (error instanceof HttpError && [403, 404].includes(error.statusCode))
          fail('BEHAVIOR_HOST_MODEL_DENIED');
        throw error;
      }
      if (!sameConnection(current, target.connection)) fail('BEHAVIOR_HOST_MODEL_DENIED');
      signal.throwIfAborted();
      return current;
    };
    let attemptId: string | undefined;
    let hostBoundaryError: unknown;
    const authorizeBoundary = async () => {
      try {
        return await authorize();
      } catch (error) {
        hostBoundaryError = error;
        throw error;
      }
    };
    try {
      const connection = await authorizeBoundary();
      const request: ProviderRequest = {
        role: 'state',
        modelId: target.modelId,
        pricingSnapshot: target.pricingSnapshot,
        generation: generationFromModel(target),
        contextBudget: contextBudgetForModel(target),
        stable: {
          contract:
            'Return the text requested by the supplied prompt. The output is a separate extension result and does not itself commit prose, change stored state, or grant permissions. Do not call tools.',
          tools: [],
        },
        input: { task: args.prompt, controls: {} },
      };
      const result = await executeProvider(transportConnection(connection), request, {
        approvedOrigins: hooks.approvedOrigins,
        signal,
        resolveCredential: hooks.resolveCredential,
        executeCodex: hooks.executeCodex,
        vertexRequestTier: hooks.vertexRequestTier,
        timeoutMs: callTimeout(target.timeoutMs),
        beforeTurn: authorizeBoundary,
        onWire: async (wire) => {
          await authorizeBoundary();
          try {
            attemptId = await hooks.onAttemptStart({ ...wire, extensionAction: attribution });
          } catch (error) {
            hostBoundaryError = error;
            throw error;
          }
          totalUsage.modelCalls++;
          releaseReservation();
          await authorizeBoundary();
        },
      });
      if (attemptId !== undefined) {
        addUsage(totalUsage, result);
        await hooks.onAttemptFinish(attemptId, { ...structuredClone(result), opaqueState: null });
      }
      if (hostBoundaryError !== undefined) throw hostBoundaryError;
      signal.throwIfAborted();
      await authorizeBoundary();
      return publicResult(result);
    } finally {
      releaseReservation();
    }
  };

  return { generate, hostWaitMs };
}
