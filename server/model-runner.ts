import { executeMain, executeTool } from '../core/provider.js';
import type { Connection } from '../core/product.js';
import { executeProvider, type Json, type ProviderResult, type WireRecord } from '../core/transport.js';
import type { ModelInput, RunSnapshot, ToolEvent, Usage } from '../core/types.js';
import { createSolSession } from './sol-session.js';
import { createHash } from 'node:crypto';
import { attachMainHostContext, buildMainProviderRequest, nativeStorySubmissionEnabled, STORY_SUBMIT_MAX_CHARS } from './main-request.js';

export type MainResult = { status: 'completed' | 'refused' | 'partial' | 'error' | 'cancelled'; text: string; error: string | null; usage: Usage };
export type MainHooks = {
  signal: AbortSignal;
  onInput: (input: ModelInput) => void | Promise<void>;
  onToolEvent: (event: ToolEvent) => void | Promise<void>;
  approvedOrigins: readonly string[];
  timeoutMs?: number; vertexRequestTier?: 'standard' | 'flex';
  authorize: (connection: Connection) => Connection | Promise<Connection>;
  onAttemptStart: (request: WireRecord) => string | Promise<string>;
  onAttemptFinish: (id: string, result: ProviderResult) => void | Promise<void>;
};

function addUsage(total: Usage, result: ProviderResult) {
  for (const key of ['inputTokens', 'outputTokens', 'costUsd'] as const) {
    total[key] = total[key] === null || result.usage[key] === null ? null : total[key] + result.usage[key];
  }
}

/** One server-owned main run. A transport error/partial/refusal is terminal, never an implicit retry. */
export async function runMain(snapshot: RunSnapshot, hooks: MainHooks): Promise<MainResult> {
  const fixed = attachMainHostContext(structuredClone(snapshot));
  const target = fixed.profile?.models.main;
  if (!target) {
    const result = await executeMain(fixed, hooks);
    return { status: 'completed', ...result, error: null };
  }
  const results: ToolEvent[] = [];
  const sol = createSolSession(target, hooks.timeoutMs);
  const maxCalls = sol ? Math.min(fixed.settings.maxCalls, sol.maxCalls) : fixed.settings.maxCalls;
  const usage: Usage = { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  let opaqueState: Json | undefined;
  const fail = (error: string, text = '', status: MainResult['status'] = hooks.signal.aborted ? 'cancelled' : text ? 'partial' : 'error'): MainResult => ({ status, error, text, usage });
  while (true) {
    if (hooks.signal.aborted) return fail('CANCELLED');
    if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || usage.modelCalls >= maxCalls) return fail('MODEL_CALL_BUDGET_EXHAUSTED');
    if (sol && sol.remainingMs() === 0) return fail('TIMEOUT');
    let authorized: Connection;
    try { authorized = await hooks.authorize(structuredClone(target.connection)); }
    catch { return fail('CONNECTION_NOT_AUTHORIZED'); }
    if (!authorized.enabled || authorized.id !== target.connectionId || authorized.endpoint !== target.connection.endpoint || authorized.protocol !== target.connection.protocol) return fail('CONNECTION_NOT_AUTHORIZED');
    const built = buildMainProviderRequest(fixed,{results,...(sol?{sol:sol.options}:{}),...(opaqueState!==undefined?{opaqueState}:{})});
    const {input,request}=built;
    if(sol)input.tools=[...input.tools,...sol.toolNames];
    await hooks.onInput(structuredClone(input));
    let attemptId: string | undefined;
    const remainingTimeout = sol?.remainingMs();
    if (remainingTimeout === 0) return fail('TIMEOUT');
    const result = await executeProvider({ id: authorized.id, protocol: authorized.protocol, endpoint: authorized.endpoint, ...(authorized.credentialEnv ? { credentialEnv: authorized.credentialEnv } : {}), ...(authorized.requestTier ? { requestTier: authorized.requestTier } : {}) }, request, {
      approvedOrigins: hooks.approvedOrigins, signal: hooks.signal,
      vertexRequestTier: hooks.vertexRequestTier, timeoutMs: remainingTimeout ?? hooks.timeoutMs ?? target.timeoutMs ?? (target.connection.protocol === 'vertex-gemini-v1' ? 300_000 : undefined),
      onWire: async wire => {
        attemptId = await hooks.onAttemptStart(wire);
        // Persistence completes before fetch. A crash leaves an uncertain attempt, not a queued replay.
        usage.modelCalls++;
      },
    });
    if (attemptId !== undefined) await hooks.onAttemptFinish(attemptId, structuredClone(result));
    addUsage(usage, result);
    if (result.status !== 'tool_calls') return { status: result.status, text: result.text, error: result.refusal ?? result.error?.code ?? null, usage };
    // Validate the whole turn before executing: repeated IDs cannot alias earlier tool results.
    const callIds = new Set(results.map(event => event.callId));
    for (const call of result.toolCalls) {
      if (callIds.has(call.id)) return fail('DUPLICATE_TOOL_ID');
      callIds.add(call.id);
    }
    const terminals=result.toolCalls.filter(call=>call.name==='story.submit');
    if(terminals.length){
      const call=terminals[0],content=call.arguments.content;
      if(!nativeStorySubmissionEnabled(fixed)||terminals.length!==1||result.toolCalls.length!==1||result.refusal||result.error||Object.keys(call.arguments).some(key=>key!=='content')||typeof content!=='string'||!content.trim()||content.length>STORY_SUBMIT_MAX_CHARS)return fail('INVALID_STORY_SUBMISSION');
      if(hooks.signal.aborted)return fail('CANCELLED');
      const preset=fixed.profile?.promptPresets?.main;
      await hooks.onToolEvent({callId:call.id,name:call.name,args:{content},denied:false,result:{accepted:true,contentHash:createHash('sha256').update(content).digest('hex'),characters:content.length,host:{chatId:fixed.chatId,parentRevision:fixed.parentRevision,settingsRevision:fixed.settingsRevision,profileRevision:fixed.profile?.revision??null,promptPreset:preset?{id:preset.id,revision:preset.revision}:null}}});
      return {status:'completed',text:content,error:null,usage};
    }
    opaqueState = result.opaqueState;
    for (const call of result.toolCalls) {
      if (hooks.signal.aborted) return fail('CANCELLED');
      // Transport only decodes; this host read executor owns permissions and resource scope.
      const event = sol?.toolNames.includes(call.name) ? sol.execute(call) : executeTool(fixed, { callId: call.id, name: call.name, args: call.arguments }, hooks.signal);
      results.push(event);
      await hooks.onToolEvent(structuredClone(event));
      if (event.denied) return fail('READ_TOOL_DENIED');
    }
  }
}
