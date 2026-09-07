import {
  aggregateTranslation, BUILTIN_ASSETS, compileTranslationPrompt, createTranslationPlan, displayInput, executeAuxiliary,
  presentationInput, scriptedAuxiliary, translationInput, validateDisplayAnnotation,
  validatePresentation, validateTranslationChunk, validateTranslationPlan,
  type AssetEntry, type AuxiliaryInput, type AuxiliarySource, type SourceTimeContext,
  type TranslationPlan, type TranslationResult,
} from '../core/auxiliary.js';
import type { Connection, TaskRole } from '../core/product.js';
import { executeProvider, type Json, type ProviderRequest, type ProviderResult, type ProviderTool, type WireRecord } from '../core/transport.js';
import type { RunSnapshot, ToolEvent } from '../core/types.js';
import { createEvaluationToolSession } from './evaluation-session.js';
import { validateHiddenTranslation } from '../core/hidden-story.js';
import { translationReader, TRANSLATION_READ_NAMES, type TranslationReference } from '../core/translation-context.js';
import { PromptProgramError } from '../core/prompt-program.js';

type MaybePromise<T> = T | Promise<T>;
type JobKind = Exclude<TaskRole, 'main'>;
export type AuxiliaryChunkRecord = { id: string; status: string; attempt: number; result: TranslationResult | null; error?: string | null };
export type AuxiliaryBundle = {
  job: { id: string; kind: JobKind; status: string; sourceRevision: string; sourceHash: string };
  source: AuxiliarySource; snapshot: RunSnapshot; assets?: AssetEntry[];
  translationReferences?: TranslationReference[];
  plan?: TranslationPlan; chunks?: AuxiliaryChunkRecord[]; retryChunkIds?: string[];
};
export type AuxiliaryJobResult = {
  mock: boolean; sourceRevision: string; sourceHash: string; text?: string; label?: string;
  segments?: { anchors: string[]; text: string }[];
  annotations?: { blockAnchor: string; assetRef: string; assetRevision: number; presentationIntent: 'inline' | 'profile'; caption?: string }[];
  display?: { anchor: string; summary: string; mood: string }[];
  completedChunks?: number; totalChunks?: number;
};
export type AuxiliaryOutcome = { status: 'completed' | 'partial' | 'failed' | 'cancelled' | 'interrupted'; result: AuxiliaryJobResult | null; error: string | null };
/** Every mutating bridge method must check owner+generation and the source dependency. */
export type AuxiliaryStoreBridge = {
  load: (jobId: string) => MaybePromise<AuxiliaryBundle>;
  claim: (jobId: string, owner: string, prepared: { input: AuxiliaryInput; plan?: TranslationPlan }) => MaybePromise<number | null>;
  beginChunk: (jobId: string, chunkId: string, generation: number, owner: string) => MaybePromise<void>;
  completeChunk: (jobId: string, chunkId: string, generation: number, owner: string, result: TranslationResult) => MaybePromise<void>;
  failChunk: (jobId: string, chunkId: string, generation: number, owner: string, code: string, status: 'failed' | 'cancelled' | 'interrupted') => MaybePromise<void>;
  finish: (jobId: string, generation: number, owner: string, outcome: AuxiliaryOutcome) => MaybePromise<void>;
};
export type AuxiliaryJobHooks = {
  executeCodex?: import('../core/transport.js').ProviderExecutionOptions['executeCodex'];
  resolveCredential?: import('../core/transport.js').ProviderExecutionOptions['resolveCredential'];
  signal: AbortSignal; approvedOrigins: readonly string[];
  authorize: (connection: Connection) => MaybePromise<Connection>;
  onAttemptStart: (wire: WireRecord) => MaybePromise<string>;
  onAttemptFinish: (id: string, result: ProviderResult) => MaybePromise<void>;
  onInput?: (jobId: string, input: AuxiliaryInput) => MaybePromise<void>;
  onToolEvent?: (jobId: string, event: ToolEvent) => MaybePromise<void>;
  onProgress?: () => MaybePromise<void>;
  maxChunkChars?: number; timeoutMs?: number; vertexRequestTier?: 'standard' | 'flex'; cancellationStatus?: 'cancelled' | 'interrupted';
};
const json = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;
class AuxiliaryExecutionError extends Error { constructor(readonly code: string, readonly stop: boolean = false, readonly retryable: boolean = false) { super(code); } }
const safeError = (error: unknown) => {
  if (error instanceof AuxiliaryExecutionError) return error.code;
  if (error instanceof PromptProgramError) return error.code;
  if (error instanceof Error && error.name === 'BudgetError') return 'AUXILIARY_CALL_BUDGET_EXHAUSTED';
  if (error instanceof Error && /^(?:SOURCE_|CHUNK_|OUTPUT_|PROTECTED_|UNPROTECTED_|ANNOTATION_|ASSET_|DUPLICATE_|PRESENTATION_|TOOL_|HIDDEN_)[A-Z_]+$/.test(error.message)) return error.message;
  return 'AUXILIARY_EXECUTION_FAILED';
};
const toolSchemas: ProviderTool[] = [
  ...(['story', 'memory', 'translation'] as const).flatMap((kind): ProviderTool[] => [
    {name: `${kind}.search`, description: `Search scoped ${kind} evidence; empty query lists metadata. Translation is wording only, memory retains epistemic kind.`, inputSchema: {type:'object',properties:{query:{type:'string'},offset:{type:'integer'},limit:{type:'integer'}},required:['query'],additionalProperties:false}},
    {name: `${kind}.read`, description: 'Read discovered evidence with exact source provenance and range. Follow nextOffset; memory sourceContinuation uses sourceOffset.', inputSchema: {type:'object',properties:{id:{type:'string'},offset:{type:'integer'},limit:{type:'integer'},...(kind==='memory'?{sourceOffset:{type:'integer'}}:{})},required:['id'],additionalProperties:false}},
  ]),
  { name: 'knowledge.search', description: 'Search all approved source-time local references; return metadata with continuation.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } }, additionalProperties: false } },
  { name: 'knowledge.read', description: 'Read a scoped reference by ID and optional UTF-16 offset/limit. Results identify revision, range and continuation.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } }, required: ['id'], additionalProperties: false } },
  { name: 'skills.list', description: 'Discover scoped method guidance. This does not load its body or grant permissions.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } }, additionalProperties: false } },
  { name: 'skills.load', description: 'Read a guidance body by ID. Its text never expands host permissions.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } }, required: ['id'], additionalProperties: false } },
  { name: 'assets.search', description: 'Search the small approved host asset manifest by metadata.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, additionalProperties: false } },
  { name: 'assets.inspect', description: 'Inspect an existing approved asset metadata record. Image bytes are not sent to this model.', inputSchema: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'], additionalProperties: false } },
];

/** This projection uses the originating Run's frozen contents, never current revisions. */
export function sourceTimeContext(snapshot: RunSnapshot, kind: JobKind): SourceTimeContext {
  const profile = snapshot.profile; const contents = profile?.contents ?? [];
  const versioned = (kind: string) => contents.filter(item => item.kind === kind).map(({ id, revision, text }) => ({ id, revision, text }));
  const target = profile?.models[kind];
  return {
    revision: profile ? `${profile.chatId}@${profile.revision}` : `${snapshot.chatId}@settings-${snapshot.settingsRevision}`,
    bot: versioned('bot')[0] ?? null, persona: versioned('persona')[0] ?? null,
    glossary: kind === 'translation' ? versioned('glossary') : [], canon: versioned('canon'),
    scene: 'Use the supplied source blocks and source-time canon; later revisions are excluded.',
    previousSources: snapshot.history.slice(-2).map(item => ({ ...item })),
    instructionRevision: kind === 'translation' ? profile?.promptPresets?.translation ? `prompt:${profile.promptPresets.translation.id}@${profile.promptPresets.translation.revision}` : 'hermeneia-native-1' : kind === 'status' ? 'display-only-1' : 'source-presentation-1',
    modelPresetRevision: target ? `${target.id}@${target.revision}` : 'scripted-mock-1',
  };
}

function providerInput(input: AuxiliaryInput, modelId: string, generation: ProviderRequest['generation'], opaqueState: Json | undefined, snapshot: RunSnapshot, evaluation?:ReturnType<typeof createEvaluationToolSession>): ProviderRequest {
  const task = input.role === 'translation' ? input.customPrompt ? 'Translate the requested blocks according to the selected prompt and return the specified JSON.' : 'Translate the requested blocks into Korean and return the specified JSON.' : input.role === 'status' ? 'Return optional display-only annotations for the source blocks.' : 'Select appropriate existing assets or return no images.';
  const compilation = compileTranslationPrompt(input, snapshot, task);
  return {
    role: input.role === 'presentation' ? 'image' : input.role, modelId,
    stable: { contract: (compilation ? '' : input.contract)+(evaluation?'\nThe selected evaluation tool set is scoped to this model preset and this run. eval_submit_artifact returns content as the completed task output; userFacingNotice remains separate metadata.':''), tools: [...toolSchemas.filter(tool => input.tools.includes(tool.name)).map(tool => structuredClone(tool)),...(evaluation?.definitions.map(tool=>structuredClone(tool))??[])] }, generation,
    ...(evaluation?.bootstrap.length?{bootstrap:evaluation.bootstrap.map(item=>({callId:item.callId,name:item.name,args:json(item.args) as Record<string,Json>,result:json(item.result),denied:item.denied}))}:{}),
    ...(evaluation?.toolChoice(Array.isArray(input.results)?input.results.length:0)?{toolChoice:evaluation.toolChoice(Array.isArray(input.results)?input.results.length:0)}:{}),
    ...(compilation ? { prompt: { compilerVersion: compilation.compilerVersion, messages: compilation.messages, cachePlan: compilation.cachePlan, values: compilation.values } } : {}),
    input: {
      task,
      controls: { instructionRevision: input.context.instructionRevision, modelPresetRevision: input.context.modelPresetRevision, ...(input.customPrompt ? { customPrompt: true } : {}) },
      source: json({ sourceRevision: input.sourceRevision, sourceHash: input.sourceHash, ...(input.chunkId ? { chunkId: input.chunkId } : {}), context: input.context, ...(input.referencePolicy ? {referencePolicy:input.referencePolicy} : {}), blocks: input.blocks, ...(input.neighborBlocks ? { neighborBlocks: input.neighborBlocks } : {}), ...(input.scenes ? { scenes: input.scenes } : {}), outputSchema: input.outputSchema }),
      catalog: json(input.role === 'presentation' ? input.assets ?? [] : input.catalog), results: json(input.results),
    }, ...(opaqueState !== undefined ? { opaqueState } : {}),
  };
}

/** Server job execution is separate from SQLite claim/finish transactions. */
export async function runAuxiliaryJob(store: AuxiliaryStoreBridge, jobId: string, owner: string, hooks: AuxiliaryJobHooks): Promise<AuxiliaryOutcome | null> {
  const bundle = structuredClone(await store.load(jobId)); const { source, snapshot, job } = bundle;
  if (job.sourceRevision !== source.id || job.sourceHash !== source.hash || source.chatId !== snapshot.chatId) throw new Error('SOURCE_DEPENDENCY_MISMATCH');
  const context = sourceTimeContext(snapshot, job.kind); const assets = bundle.assets ?? [...BUILTIN_ASSETS];
  const plan = job.kind === 'translation' ? bundle.plan ? validateTranslationPlan(source, context, bundle.plan) : createTranslationPlan(source, context, hooks.maxChunkChars) : undefined;
  if (plan && (plan.sourceRevision !== source.id || plan.sourceHash !== source.hash || plan.chatId !== source.chatId)) throw new Error('SOURCE_DEPENDENCY_MISMATCH');
  if (bundle.retryChunkIds && (!plan || !bundle.retryChunkIds.length || new Set(bundle.retryChunkIds).size !== bundle.retryChunkIds.length || bundle.retryChunkIds.some(id => !plan.chunks.some(chunk => chunk.id === id)))) throw new Error('CHUNK_UNAVAILABLE');
  const input = job.kind === 'translation' ? translationInput(plan!, plan!.chunks[0].id, snapshot) : job.kind === 'status' ? displayInput(source, context, snapshot) : presentationInput(source, context, snapshot, assets);
  const generation = await store.claim(jobId, owner, { input, ...(plan ? { plan } : {}) });
  if (generation === null) return null;
  await hooks.onProgress?.();
  const target = snapshot.profile?.models[job.kind]; let calls = 0;
  let contextBytes = 0;
  const readTranslation = translationReader(snapshot,bundle.translationReferences ?? []);
  const evaluation = createEvaluationToolSession(target, hooks.timeoutMs);
  // Fixture annotations remain explicitly marked; live output still requires artifact validation.
  const mock = !target || target.connection.protocol === 'fixture-sse-v1';
  const successful = new Map<string, TranslationResult>();
  for (const chunk of bundle.chunks ?? []) if (chunk.status === 'completed' && chunk.result) successful.set(chunk.id, structuredClone(chunk.result));
  let lastError: string | null = null; let stopped = false;
  const cancelState = () => hooks.cancellationStatus ?? 'cancelled';
  const runInput = async (packet: AuxiliaryInput) => {
    if (evaluation) packet = { ...packet, tools: [...packet.tools, ...evaluation.definitions.map(tool=>tool.name)] };
    let opaqueState: Json | undefined;
    const request = async (next: AuxiliaryInput) => {
      if (calls >= snapshot.settings.maxCalls) throw Object.assign(new Error('Auxiliary call budget exhausted'), { name: 'BudgetError' });
      if (evaluation && evaluation.remainingMs() === 0) throw new AuxiliaryExecutionError('AUXILIARY_PROVIDER_TIMEOUT', true);
      calls++;
      if (!target) return scriptedAuxiliary(next, hooks.signal);
      let authorized: Connection;
      try { authorized = await hooks.authorize(structuredClone(target.connection)); }
      catch { throw new AuxiliaryExecutionError('CONNECTION_NOT_AUTHORIZED', true); }
      if (!authorized.enabled || authorized.id !== target.connectionId || authorized.endpoint !== target.connection.endpoint || authorized.protocol !== target.connection.protocol) throw new AuxiliaryExecutionError('CONNECTION_NOT_AUTHORIZED', true);
      const generation = { maxOutputTokens: target.maxOutputTokens, temperature: target.temperature, ...(target.thinkingLevel ? { thinkingLevel: target.thinkingLevel } : {}), ...(target.structuredOutput !== undefined ? { structuredOutput: target.structuredOutput } : {}), ...(target.reasoningEffort ? { reasoningEffort: target.reasoningEffort } : {}), ...(target.thinkingMode ? { thinkingMode: target.thinkingMode } : {}), ...(target.thinkingBudgetTokens !== undefined ? { thinkingBudgetTokens: target.thinkingBudgetTokens } : {}) };
      const completedToolResults=Array.isArray(next.results)?next.results.length:0;
      const body = providerInput(next, target.modelId, evaluation?evaluation.generation(generation,completedToolResults):generation, opaqueState, snapshot,evaluation);
      const generationBinding=evaluation?.generationBinding(generation,completedToolResults);if(generationBinding)body.generationBinding=generationBinding;
      let attemptId: string | undefined;
      const remainingTimeout = evaluation?.remainingMs();
      if (remainingTimeout === 0) throw new AuxiliaryExecutionError('AUXILIARY_PROVIDER_TIMEOUT', true);
      const result = await executeProvider({ id: authorized.id, protocol: authorized.protocol, endpoint: authorized.endpoint, ...(authorized.credentialEnv ? { credentialEnv: authorized.credentialEnv } : {}), ...(authorized.requestTier ? { requestTier: authorized.requestTier } : {}) }, body, {
        approvedOrigins: hooks.approvedOrigins, signal: hooks.signal, resolveCredential: hooks.resolveCredential, executeCodex: hooks.executeCodex, vertexRequestTier: hooks.vertexRequestTier, timeoutMs: remainingTimeout ?? hooks.timeoutMs ?? target.timeoutMs ?? (target.connection.protocol === 'vertex-gemini-v1' ? 300_000 : undefined),
        onWire: async wire => { attemptId = await hooks.onAttemptStart(wire); },
      });
      // Keep diagnostic output and usage even when a refusal or malformed body cannot become an artifact.
      if (attemptId !== undefined) await hooks.onAttemptFinish(attemptId, evaluation?evaluation.diagnosticResult(result):structuredClone(result));
      if (result.status === 'tool_calls') {
        opaqueState = result.opaqueState;
        return { kind: 'tools', actions: result.toolCalls.map(call => ({ callId: call.id, name: call.name, args: call.arguments, ...(call.recoveredFromTruncation?{recoveredFromTruncation:true}:{}) })) };
      }
      if (result.status !== 'completed') throw new AuxiliaryExecutionError(result.status === 'refused' ? 'AUXILIARY_PROVIDER_REFUSED' : result.status === 'partial' ? 'AUXILIARY_PROVIDER_PARTIAL' : result.status === 'cancelled' ? 'AUXILIARY_CANCELLED' : `AUXILIARY_PROVIDER_${result.error?.code ?? 'ERROR'}`, result.status === 'refused' || result.status === 'cancelled', result.status === 'refused' && !result.error || result.status === 'error' && ['EMPTY_COMPLETION', 'EMPTY_RESPONSE'].includes(result.error?.code ?? ''));
      return result.text;
    };
    return executeAuxiliary(packet, snapshot, request, {
      signal: hooks.signal, maxCalls: evaluation ? Math.min(snapshot.settings.maxCalls, evaluation.maxCalls) : snapshot.settings.maxCalls,
      localTools: { names: [...(job.kind==='translation'?TRANSLATION_READ_NAMES:[]),...(evaluation?.allNames ?? [])], execute: action => {
        if(TRANSLATION_READ_NAMES.includes(action.name))return readTranslation(action);
        const call={id:action.callId,name:action.name,arguments:json(action.args) as Record<string,Json>};
        if(action.name!=='eval_submit_artifact')return evaluation!.execute(call);
        const submitted=evaluation!.submit(call,action.recoveredFromTruncation===true);if(!submitted.ok)return submitted.event;
        return{event:{callId:action.callId,name:action.name,args:{},denied:false,result:{accepted:true,sha256:submitted.artifact.sha256,characters:submitted.artifact.text.length,utf8Bytes:submitted.artifact.utf8Bytes,noticeProvided:submitted.artifact.noticeProvided,noticeCharacters:submitted.artifact.noticeCharacters,correctionCount:submitted.artifact.correctionCount}},terminalOutput:submitted.artifact.text};
      } },
      onInput: value => hooks.onInput?.(jobId, value), onToolEvent: async value => {
        if(job.kind==='translation') {
          contextBytes += Buffer.byteLength(JSON.stringify(value),'utf8');
          if(contextBytes > 96000) throw new AuxiliaryExecutionError('TOOL_CONTEXT_BUDGET_EXHAUSTED',true);
        }
        await hooks.onToolEvent?.(jobId,value);
      },
    });
  };
  try {
    if (plan) {
      for (const chunk of plan.chunks) {
        if (successful.has(chunk.id)) continue;
        if (bundle.retryChunkIds && !bundle.retryChunkIds.includes(chunk.id)) continue;
        if (hooks.signal.aborted || stopped) break;
        // Only confirmed refusals, empty completions and validated terminal artifacts can be replayed.
        // Each replay starts fresh tool/opaque state while sharing the job's call budget.
        for (let attempt = 0; attempt < 3; attempt++) {
          if (hooks.signal.aborted) break;
          await store.beginChunk(jobId, chunk.id, generation, owner); await hooks.onProgress?.();
          try {
            const result = await runInput(translationInput(plan, chunk.id, snapshot, [...successful.values()]));
            let validated: TranslationResult;
            try { validated = validateTranslationChunk(plan, chunk.id, result.output); }
            catch (error) {
              const code = safeError(error);
              throw new AuxiliaryExecutionError(code, false, ['OUTPUT_SCHEMA_INVALID', 'CHUNK_COVERAGE_INVALID', 'PROTECTED_SPAN_INVALID', 'UNPROTECTED_SYNTAX_RETURNED', 'SOURCE_DEPENDENCY_MISMATCH'].includes(code));
            }
            await store.completeChunk(jobId, chunk.id, generation, owner, validated); successful.set(chunk.id, validated);
            await hooks.onProgress?.();
            break;
          } catch (error) {
            const code = hooks.signal.aborted ? 'AUXILIARY_CANCELLED' : safeError(error);
            await store.failChunk(jobId, chunk.id, generation, owner, code, hooks.signal.aborted ? cancelState() : 'failed');
            await hooks.onProgress?.();
            const retry = !hooks.signal.aborted && error instanceof AuxiliaryExecutionError && error.retryable && attempt < 2;
            if (retry) continue;
            lastError = code;
            stopped = hooks.signal.aborted || error instanceof AuxiliaryExecutionError && error.stop || error instanceof Error && error.name === 'BudgetError';
            break;
          }
        }
      }
      const combined = aggregateTranslation(plan, [...successful.values()]);
      const result: AuxiliaryJobResult = { mock, sourceRevision: source.id, sourceHash: source.hash, segments: combined.segments, text: combined.segments.map(segment => segment.text).join('\n\n'), completedChunks: combined.completedChunks, totalChunks: combined.totalChunks };
      if (combined.status === 'completed' && !hooks.signal.aborted) {
        const validation = validateHiddenTranslation({ sourceRevision: source.id, sourceHash: source.hash, text: source.text }, result.text!);
        if (!validation.ok) throw new Error(validation.diagnostics.find(item => item.severity === 'error')?.code ?? 'HIDDEN_TRANSLATION_INVALID');
      }
      const outcome: AuxiliaryOutcome = { status: hooks.signal.aborted ? cancelState() : combined.status === 'completed' ? 'completed' : combined.status === 'partial' ? 'partial' : 'failed', result: combined.completedChunks ? result : null, error: combined.status === 'completed' && !hooks.signal.aborted ? null : lastError ?? (hooks.signal.aborted ? 'AUXILIARY_CANCELLED' : 'AUXILIARY_INCOMPLETE') };
      await store.finish(jobId, generation, owner, outcome); await hooks.onProgress?.(); return outcome;
    }
    const output = (await runInput(input)).output;
    let result: AuxiliaryJobResult;
    if (job.kind === 'status') {
      const validated = validateDisplayAnnotation(source, output);
      result = { mock, sourceRevision: source.id, sourceHash: source.hash, label: validated.entries.map(entry => entry.summary).join(' · '), display: validated.entries };
    } else {
      const validated = validatePresentation(source, output, assets);
      result = { mock, sourceRevision: source.id, sourceHash: source.hash, annotations: validated.entries.map(entry => ({ ...entry, caption: assets.find(asset => asset.ref === entry.assetRef)?.caption })) };
    }
    const outcome: AuxiliaryOutcome = { status: 'completed', result, error: null };
    await store.finish(jobId, generation, owner, outcome); await hooks.onProgress?.(); return outcome;
  } catch (error) {
    const outcome: AuxiliaryOutcome = { status: hooks.signal.aborted ? cancelState() : 'failed', result: null, error: hooks.signal.aborted ? 'AUXILIARY_CANCELLED' : safeError(error) };
    await store.finish(jobId, generation, owner, outcome); await hooks.onProgress?.(); return outcome;
  }
}
