import { modelRequestFields } from '../core/model-request-fields.js';
import { generationFromModel } from '../core/model-capabilities.js';
import { contextBudgetForModel } from '../core/context-budget.js';
import { PROMPT_COMPILER_VERSION } from '../core/risu-prompt.js';
import {
  executeProvider,
  transportConnection,
  type ProviderRequest,
  type WireRecord,
} from '../core/transport.js';
import type { RunSnapshot, Usage } from '../core/types.js';
import type { LogicalMessage } from '../core/risu-prompt.js';
import type { Store } from './store.js';
import type { MainHooks } from './model-runner.js';
import type { NativeRisuExecutionOptions } from './risu-native-runtime.js';
import { requestNativeInteraction } from './risu-native-interactions.js';
import { NativeScriptImageError, nativeScriptImages } from './risu-native-script-images.js';
import { HttpError, record } from './request-validation.js';

type Hooks = Pick<MainHooks, 'resolveCredential' | 'executeCodex' | 'vertexRequestTier'>;
type ScriptMode = NonNullable<NonNullable<WireRecord['nativeScript']>['mode']>;
export function nativeScriptModel(
  snapshot: RunSnapshot,
  method: string,
  mode: ScriptMode = 'otherAx'
) {
  if (method !== 'axLLM') return snapshot.profile?.models.main;
  if (mode === 'memory') return snapshot.profile?.contextModel;
  if (mode === 'translate') return snapshot.profile?.models.translation;
  return snapshot.profile?.scriptModel ?? snapshot.profile?.models.main;
}
export function validateNativeScriptAttempt(snapshot: RunSnapshot, wire: WireRecord): void {
  const attribution = wire.nativeScript;
  if (
    !attribution ||
    !['LLM', 'axLLM', 'simpleLLM'].includes(attribution.method) ||
    typeof attribution.event !== 'string' ||
    attribution.event.length > 100 ||
    (attribution.mode !== undefined &&
      (attribution.method !== 'axLLM' ||
        !['otherAx', 'memory', 'translate'].includes(attribution.mode))) ||
    !snapshot.profile?.packages?.some((pkg) => pkg.nativeRisu) ||
    wire.role !== 'script' ||
    wire.agentId ||
    wire.judgment
  )
    throw new HttpError(400, 'RISU_NATIVE_ATTEMPT_IDENTITY');
  const target = nativeScriptModel(snapshot, attribution.method, attribution.mode);
  if (
    !target ||
    wire.modelId !== target.modelId ||
    wire.connectionId !== target.connectionId ||
    wire.protocol !== target.connection.protocol
  )
    throw new HttpError(400, 'RISU_NATIVE_ATTEMPT_MODEL');
}

/** Script prompts are preserved; credentials, model identities, budgets and attempts stay host-owned. */
export function createNativeRisuHost(
  store: Store,
  runId: string,
  snapshot: RunSnapshot,
  usage: Usage,
  hooks: Hooks,
  event: string,
  reserveCalls = 0
): NonNullable<NativeRisuExecutionOptions['host']> {
  return async (method, raw, signal) => {
    if (['alertInput', 'alertSelect', 'alertConfirm'].includes(method))
      return requestNativeInteraction(store, runId, method, raw, signal);
    if (!['LLM', 'axLLM', 'simpleLLM'].includes(method))
      throw new Error(`RISU_NATIVE_API_UNSUPPORTED:${method}`);
    const args = record(raw);
    // Risu's JSON parser treats absent/non-object options as an empty object.
    const options = args.options && typeof args.options === 'object' ? args.options : {};
    let mode: ScriptMode | undefined;
    if (method === 'axLLM') {
      const requested = options.mode ?? 'otherAx';
      if (!['emotion', 'memory', 'otherAx', 'submodel', 'translate'].includes(requested))
        return { success: false, result: `Error: Invalid axLLM mode: ${String(requested)}` };
      if (requested === 'emotion' || requested === 'submodel')
        return { success: false, result: `Error: RISU_NATIVE_MODEL_MODE_UNSUPPORTED:${requested}` };
      mode = requested as ScriptMode;
    }
    // Every current provider transport streams internally; the Lua result is returned only
    // after collection. Explicit false cannot be honored by that transport.
    if (options.streaming !== undefined && options.streaming !== true)
      return { success: false, result: 'Error: RISU_NATIVE_NONSTREAMING_UNSUPPORTED' };
    if (usage.modelCalls >= snapshot.settings.maxCalls - reserveCalls)
      throw new Error('RISU_NATIVE_MODEL_BUDGET');
    const target = nativeScriptModel(snapshot, method, mode);
    if (!target)
      return { success: false, result: `Error: RISU_NATIVE_MODEL_REQUIRED:${mode ?? 'main'}` };
    if (target.enabled === false)
      return { success: false, result: `Error: RISU_NATIVE_MODEL_DISABLED:${mode ?? 'main'}` };
    const prompt: unknown = args.prompt;
    const authored = typeof prompt === 'string' ? [{ role: 'user', content: prompt }] : prompt;
    if (!Array.isArray(authored) || !authored.length) throw new Error('RISU_NATIVE_MODEL_PROMPT');
    let messages: LogicalMessage[] = authored.map((raw, index) => {
      const item = record(raw),
        role =
          item.role === 'sys'
            ? 'system'
            : item.role === 'char' || item.role === 'bot'
              ? 'assistant'
              : item.role;
      if (
        !['system', 'user', 'assistant'].includes(String(role)) ||
        typeof item.content !== 'string'
      )
        throw new Error('RISU_NATIVE_MODEL_PROMPT');
      return {
        id: `native:${index}`,
        role: role as 'system' | 'user' | 'assistant',
        content: [{ type: 'text' as const, text: item.content }],
        completion: 'complete' as const,
        provenance: { blockId: `native:${index}`, origin: 'prompt' as const },
      };
    });
    const authorize = () => {
      signal.throwIfAborted();
      if (store.run(runId).status !== 'running') throw new Error('RISU_NATIVE_ACTION_INACTIVE');
      return store.product.authorize(target.connection);
    };
    const connection = authorize();
    let resolveImage: Awaited<ReturnType<typeof nativeScriptImages>>['resolveImage'] | undefined;
    if (
      args.useMultimodal !== undefined &&
      args.useMultimodal !== null &&
      args.useMultimodal !== false
    ) {
      try {
        const prepared = await nativeScriptImages(store, snapshot, messages, signal);
        messages = prepared.messages;
        resolveImage = prepared.resolveImage;
        authorize();
      } catch (error) {
        if (error instanceof NativeScriptImageError)
          return { success: false, result: `Error: ${error.message}` };
        throw error;
      }
    }
    const task = messages.at(-1)!.content.find((part) => part.type === 'text');
    const request: ProviderRequest = {
      role: 'script',
      ...modelRequestFields(target),
      generation: generationFromModel(target),
      contextBudget: contextBudgetForModel(target),
      stable: { contract: '', tools: [] },
      input: { task: task?.text || 'Script request', controls: {} },
      prompt: { compilerVersion: PROMPT_COMPILER_VERSION, messages, cachePlan: [], values: {} },
    };
    let attemptId: string | undefined;
    const result = await executeProvider(transportConnection(connection), request, {
      ...hooks,
      resolveImage,
      signal,
      timeoutMs: target.timeoutMs,
      beforeTurn: async () => {
        authorize();
      },
      onWire: async (wire) => {
        authorize();
        const attributed: WireRecord = {
          ...wire,
          nativeScript: {
            method: method as 'LLM' | 'axLLM' | 'simpleLLM',
            event,
            ...(mode ? { mode } : {}),
          },
        };
        validateNativeScriptAttempt(snapshot, attributed);
        attemptId = store.product.startAttempt(snapshot.chatId, runId, null, attributed);
        usage.modelCalls++;
      },
    });
    if (attemptId) {
      for (const key of ['inputTokens', 'outputTokens', 'costUsd'] as const)
        usage[key] =
          usage[key] === null || result.usage[key] === null ? null : usage[key] + result.usage[key];
      store.product.finishAttempt(attemptId, { ...result, opaqueState: null });
    }
    signal.throwIfAborted();
    return {
      success: result.status === 'completed',
      result: result.text || result.error?.code || result.status,
    };
  };
}
