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
import type { Store } from './store.js';
import type { MainHooks } from './model-runner.js';
import type { NativeRisuExecutionOptions } from './risu-native-runtime.js';
import { requestNativeInteraction } from './risu-native-interactions.js';
import { HttpError, record } from './request-validation.js';

type Hooks = Pick<MainHooks, 'resolveCredential' | 'executeCodex' | 'vertexRequestTier'>;
export function nativeScriptModel(snapshot: RunSnapshot, method: string) {
  return method === 'axLLM'
    ? (snapshot.profile?.scriptModel ?? snapshot.profile?.models.main)
    : snapshot.profile?.models.main;
}
export function validateNativeScriptAttempt(snapshot: RunSnapshot, wire: WireRecord): void {
  const attribution = wire.nativeScript;
  if (
    !attribution ||
    !['LLM', 'axLLM', 'simpleLLM'].includes(attribution.method) ||
    typeof attribution.event !== 'string' ||
    attribution.event.length > 100 ||
    !snapshot.profile?.packages?.some((pkg) => pkg.nativeRisu) ||
    wire.role !== 'script' ||
    wire.agentId ||
    wire.judgment
  )
    throw new HttpError(400, 'RISU_NATIVE_ATTEMPT_IDENTITY');
  const target = nativeScriptModel(snapshot, attribution.method);
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
    if (usage.modelCalls >= snapshot.settings.maxCalls - reserveCalls)
      throw new Error('RISU_NATIVE_MODEL_BUDGET');
    const target = nativeScriptModel(snapshot, method);
    if (!target) throw new Error('RISU_NATIVE_MODEL_REQUIRED');
    const args = record(raw);
    const prompt: unknown = args.prompt;
    const authored = typeof prompt === 'string' ? [{ role: 'user', content: prompt }] : prompt;
    if (!Array.isArray(authored) || authored.length > 200 || !authored.length)
      throw new Error('RISU_NATIVE_MODEL_PROMPT');
    let size = 0;
    const messages = authored.map((raw, index) => {
      const item = record(raw),
        role = item.role === 'char' ? 'assistant' : item.role;
      if (
        !['system', 'user', 'assistant'].includes(String(role)) ||
        typeof item.content !== 'string'
      )
        throw new Error('RISU_NATIVE_MODEL_PROMPT');
      size += item.content.length;
      return {
        id: `native:${index}`,
        role: role as 'system' | 'user' | 'assistant',
        content: [{ type: 'text' as const, text: item.content }],
        completion: 'complete' as const,
        provenance: { blockId: `native:${index}`, origin: 'prompt' as const },
      };
    });
    if (size > 500_000) throw new Error('RISU_NATIVE_MODEL_PROMPT_LIMIT');
    const authorize = () => {
      signal.throwIfAborted();
      if (store.run(runId).status !== 'running') throw new Error('RISU_NATIVE_ACTION_INACTIVE');
      return store.product.authorize(target.connection);
    };
    const connection = authorize();
    const request: ProviderRequest = {
      role: 'script',
      modelId: target.modelId,
      pricingSnapshot: target.pricingSnapshot,
      ...(target.providerOptions ? { providerOptions: target.providerOptions } : {}),
      generation: generationFromModel(target),
      contextBudget: contextBudgetForModel(target),
      stable: { contract: '', tools: [] },
      input: { task: messages.at(-1)!.content[0].text || 'Script request', controls: {} },
      prompt: { compilerVersion: PROMPT_COMPILER_VERSION, messages, cachePlan: [], values: {} },
    };
    let attemptId: string | undefined;
    const result = await executeProvider(transportConnection(connection), request, {
      ...hooks,
      signal,
      timeoutMs: target.timeoutMs,
      beforeTurn: async () => {
        authorize();
      },
      onWire: async (wire) => {
        authorize();
        const attributed: WireRecord = {
          ...wire,
          nativeScript: { method: method as 'LLM' | 'axLLM' | 'simpleLLM', event },
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
