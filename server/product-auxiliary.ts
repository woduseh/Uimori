import {
  aggregateTranslation, BUILTIN_ASSETS, createTranslationPlan, displayInput, executeAuxiliary,
  presentationInput, scriptedAuxiliary, translationInput, validateDisplayAnnotation,
  validatePresentation, validateTranslationChunk, validateTranslationPlan,
  type AssetEntry, type AuxiliaryInput, type AuxiliarySource, type SourceTimeContext,
  type TranslationPlan, type TranslationResult,
} from '../core/auxiliary.js';
import type { Connection, TaskRole } from '../core/product.js';
import { executeProvider, type Json, type ProviderRequest, type ProviderResult, type ProviderTool, type WireRecord } from '../core/transport.js';
import type { RunSnapshot, ToolEvent } from '../core/types.js';

type MaybePromise<T> = T | Promise<T>;
type JobKind = Exclude<TaskRole, 'main'>;
export type AuxiliaryChunkRecord = { id: string; status: string; attempt: number; result: TranslationResult | null; error?: string | null };
export type AuxiliaryBundle = {
  job: { id: string; kind: JobKind; status: string; sourceRevision: string; sourceHash: string };
  source: AuxiliarySource; snapshot: RunSnapshot; assets?: AssetEntry[];
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
  signal: AbortSignal; approvedOrigins: readonly string[];
  authorize: (connection: Connection) => MaybePromise<Connection>;
  onAttemptStart: (wire: WireRecord) => MaybePromise<string>;
  onAttemptFinish: (id: string, result: ProviderResult) => MaybePromise<void>;
  onInput?: (jobId: string, input: AuxiliaryInput) => MaybePromise<void>;
  onToolEvent?: (jobId: string, event: ToolEvent) => MaybePromise<void>;
  onProgress?: () => MaybePromise<void>;
  maxChunkChars?: number; timeoutMs?: number; cancellationStatus?: 'cancelled' | 'interrupted';
};
const json = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;
class AuxiliaryExecutionError extends Error { constructor(readonly code: string, readonly stop: boolean = false) { super(code); } }
const safeError = (error: unknown) => {
  if (error instanceof AuxiliaryExecutionError) return error.code;
  if (error instanceof Error && error.name === 'BudgetError') return 'AUXILIARY_CALL_BUDGET_EXHAUSTED';
  if (error instanceof Error && /^(?:SOURCE_|CHUNK_|OUTPUT_|PROTECTED_|UNPROTECTED_|ANNOTATION_|ASSET_|DUPLICATE_|PRESENTATION_|TOOL_)[A-Z_]+$/.test(error.message)) return error.message;
  return 'AUXILIARY_EXECUTION_FAILED';
};
const toolSchemas: ProviderTool[] = [
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
    instructionRevision: kind === 'translation' ? 'hermeneia-native-1' : kind === 'status' ? 'display-only-1' : 'source-presentation-1',
    modelPresetRevision: target ? `${target.id}@${target.revision}` : 'scripted-mock-1',
  };
}

function providerInput(input: AuxiliaryInput, modelId: string, generation: ProviderRequest['generation'], opaqueState: Json | undefined): ProviderRequest {
  return {
    role: input.role === 'presentation' ? 'image' : input.role, modelId,
    stable: { contract: input.contract, tools: toolSchemas.filter(tool => input.tools.includes(tool.name)).map(tool => structuredClone(tool)) }, generation,
    input: {
      task: input.role === 'translation' ? 'Translate the requested blocks into Korean and return the specified JSON.' : input.role === 'status' ? 'Return optional display-only annotations for the source blocks.' : 'Select appropriate existing assets or return no images.',
      controls: { instructionRevision: input.context.instructionRevision, modelPresetRevision: input.context.modelPresetRevision },
      source: json({ sourceRevision: input.sourceRevision, sourceHash: input.sourceHash, ...(input.chunkId ? { chunkId: input.chunkId } : {}), context: input.context, blocks: input.blocks, ...(input.neighborBlocks ? { neighborBlocks: input.neighborBlocks } : {}), ...(input.scenes ? { scenes: input.scenes } : {}), outputSchema: input.outputSchema }),
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
  // A selected transport is still a fixture. The protocol does not assert live quality.
  const mock = !target || target.connection.protocol === 'fixture-sse-v1';
  const successful = new Map<string, TranslationResult>();
  for (const chunk of bundle.chunks ?? []) if (chunk.status === 'completed' && chunk.result) successful.set(chunk.id, structuredClone(chunk.result));
  let lastError: string | null = null; let stopped = false;
  const cancelState = () => hooks.cancellationStatus ?? 'cancelled';
  const runInput = async (packet: AuxiliaryInput) => {
    let opaqueState: Json | undefined;
    const request = async (next: AuxiliaryInput) => {
      if (calls >= snapshot.settings.maxCalls) throw Object.assign(new Error('Auxiliary call budget exhausted'), { name: 'BudgetError' });
      calls++;
      if (!target) return scriptedAuxiliary(next, hooks.signal);
      let authorized: Connection;
      try { authorized = await hooks.authorize(structuredClone(target.connection)); }
      catch { throw new AuxiliaryExecutionError('CONNECTION_NOT_AUTHORIZED', true); }
      if (!authorized.enabled || authorized.id !== target.connectionId || authorized.endpoint !== target.connection.endpoint || authorized.protocol !== target.connection.protocol) throw new AuxiliaryExecutionError('CONNECTION_NOT_AUTHORIZED', true);
      const body = providerInput(next, target.modelId, { maxOutputTokens: target.maxOutputTokens, temperature: target.temperature }, opaqueState);
      let attemptId: string | undefined;
      const result = await executeProvider({ id: authorized.id, protocol: authorized.protocol, endpoint: authorized.endpoint, ...(authorized.credentialEnv ? { credentialEnv: authorized.credentialEnv } : {}) }, body, {
        approvedOrigins: hooks.approvedOrigins, signal: hooks.signal, ...(hooks.timeoutMs ? { timeoutMs: hooks.timeoutMs } : {}),
        onWire: async wire => { attemptId = await hooks.onAttemptStart(wire); },
      });
      // Keep diagnostic output and usage even when a refusal or malformed body cannot become an artifact.
      if (attemptId !== undefined) await hooks.onAttemptFinish(attemptId, structuredClone(result));
      if (result.status === 'tool_calls') {
        opaqueState = result.opaqueState;
        return { kind: 'tools', actions: result.toolCalls.map(call => ({ callId: call.id, name: call.name, args: call.arguments })) };
      }
      if (result.status !== 'completed') throw new AuxiliaryExecutionError(result.status === 'refused' ? 'AUXILIARY_PROVIDER_REFUSED' : result.status === 'partial' ? 'AUXILIARY_PROVIDER_PARTIAL' : result.status === 'cancelled' ? 'AUXILIARY_CANCELLED' : `AUXILIARY_PROVIDER_${result.error?.code ?? 'ERROR'}`, result.status === 'refused' || result.status === 'cancelled');
      return result.text;
    };
    return executeAuxiliary(packet, snapshot, request, {
      signal: hooks.signal, maxCalls: snapshot.settings.maxCalls,
      onInput: value => hooks.onInput?.(jobId, value), onToolEvent: value => hooks.onToolEvent?.(jobId, value),
    });
  };
  try {
    if (plan) {
      for (const chunk of plan.chunks) {
        if (successful.has(chunk.id)) continue;
        if (bundle.retryChunkIds && !bundle.retryChunkIds.includes(chunk.id)) continue;
        if (hooks.signal.aborted || stopped) break;
        await store.beginChunk(jobId, chunk.id, generation, owner); await hooks.onProgress?.();
        try {
          const result = await runInput(translationInput(plan, chunk.id, snapshot));
          const validated = validateTranslationChunk(plan, chunk.id, result.output);
          await store.completeChunk(jobId, chunk.id, generation, owner, validated); successful.set(chunk.id, validated);
        } catch (error) {
          lastError = hooks.signal.aborted ? 'AUXILIARY_CANCELLED' : safeError(error);
          await store.failChunk(jobId, chunk.id, generation, owner, lastError, hooks.signal.aborted ? cancelState() : 'failed');
          stopped = hooks.signal.aborted || error instanceof AuxiliaryExecutionError && error.stop || error instanceof Error && error.name === 'BudgetError';
        }
        await hooks.onProgress?.();
      }
      const combined = aggregateTranslation(plan, [...successful.values()]);
      const result: AuxiliaryJobResult = { mock, sourceRevision: source.id, sourceHash: source.hash, segments: combined.segments, text: combined.segments.map(segment => segment.text).join('\n\n'), completedChunks: combined.completedChunks, totalChunks: combined.totalChunks };
      const outcome: AuxiliaryOutcome = { status: hooks.signal.aborted ? cancelState() : combined.status === 'completed' ? 'completed' : combined.status === 'partial' ? 'partial' : 'failed', result: combined.completedChunks ? result : null, error: lastError ?? (combined.status === 'completed' ? null : hooks.signal.aborted ? 'AUXILIARY_CANCELLED' : 'AUXILIARY_INCOMPLETE') };
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
