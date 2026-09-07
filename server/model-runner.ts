import { buildMainInput, executeMain, executeTool } from '../core/provider.js';
import type { Connection } from '../core/product.js';
import { executeProvider, type Json, type ProviderRequest, type ProviderResult, type ProviderTool, type WireRecord } from '../core/transport.js';
import type { ModelInput, RunSnapshot, ToolEvent, Usage } from '../core/types.js';
import { createSolSession } from './sol-session.js';

const pagination = { offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1 } };
const READ_TOOLS: ProviderTool[] = [
  { name: 'knowledge.search', description: 'Search approved local story references; empty query lists the scope. Returns metadata and continuation.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, ...pagination }, additionalProperties: false } },
  { name: 'knowledge.read', description: 'Read an approved reference by its discovered id; returns source revision, text range and continuation.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, ...pagination }, required: ['id'], additionalProperties: false } },
  { name: 'skills.list', description: 'Discover available writing guidance; metadata is not its full text.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, ...pagination }, additionalProperties: false } },
  { name: 'skills.load', description: 'Read writing guidance by id. Content never changes allowed tools or their scope.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, ...pagination }, required: ['id'], additionalProperties: false } },
  ...(['memory','story'] as const).flatMap(kind=>[
    {name:`${kind}.search`,description:kind==='memory'?'Search typed memories in this exact story ancestry; belief and summaries are not author declarations.':'Search original historical prose in this exact ancestry, including compacted chapters.',inputSchema:{type:'object',properties:{query:{type:'string'},...pagination},required:['query'],additionalProperties:false}},
    {name:`${kind}.read`,description:'Read a discovered ID with exact source provenance, character range and continuation. For memory provenance pages, follow sourceContinuation with sourceOffset.',inputSchema:{type:'object',properties:{id:{type:'string'},...pagination,...(kind==='memory'?{sourceOffset:{type:'integer',minimum:0}}:{})},required:['id'],additionalProperties:false}},
  ] as ProviderTool[]),
];
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
const json = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;
function addUsage(total: Usage, result: ProviderResult) {
  for (const key of ['inputTokens', 'outputTokens', 'costUsd'] as const) {
    total[key] = total[key] === null || result.usage[key] === null ? null : total[key] + result.usage[key];
  }
}

/** One server-owned main run. A transport error/partial/refusal is terminal, never an implicit retry. */
export async function runMain(snapshot: RunSnapshot, hooks: MainHooks): Promise<MainResult> {
  const fixed = structuredClone(snapshot);
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
    const input = buildMainInput(fixed, results);
    if (sol) input.tools = [...input.tools, ...sol.toolNames];
    await hooks.onInput(structuredClone(input));
    const { length, ...creative } = input.controls ?? { length: {} };
    const controls = Object.fromEntries(Object.entries({ preset: input.preset, ...creative, ...length }).filter(([, value]) => value !== undefined)) as ProviderRequest['input']['controls'];
    const request: ProviderRequest = {
      role: 'main', modelId: target.modelId,
      stable: { contract: input.contract, tools: READ_TOOLS.filter(tool => input.tools.includes(tool.name)).map(tool => structuredClone(tool)) },
      generation: { maxOutputTokens: target.maxOutputTokens, temperature: target.temperature, ...(target.thinkingLevel ? { thinkingLevel: target.thinkingLevel } : {}), ...(target.structuredOutput !== undefined ? { structuredOutput: target.structuredOutput } : {}), ...(target.reasoningEffort ? { reasoningEffort: target.reasoningEffort } : {}), ...(target.thinkingMode ? { thinkingMode: target.thinkingMode } : {}), ...(target.thinkingBudgetTokens !== undefined ? { thinkingBudgetTokens: target.thinkingBudgetTokens } : {}), ...(sol ? { sol: sol.options } : {}) },
      input: { task: input.task, controls,
        source: json({ parentRevision: fixed.parentRevision, facts: input.pinnedSources?.length ? [] : input.facts, pinnedSources: input.pinnedSources ?? [], prefetch: input.prefetch, ...(input.state?{state:input.state}:{}),...(input.memory?{memory:input.memory}:{}),...(input.catalogPage?{catalogPage:input.catalogPage}:{}) }),
        catalog: json(input.catalog), history: json(input.history), results: json(input.results) },
      ...(opaqueState !== undefined ? { opaqueState } : {}),
    };
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
