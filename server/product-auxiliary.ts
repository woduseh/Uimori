import { prepareNativeRisuTranslationPrompt } from './risu-native-preset.js';
import {
  nativeRisuSnapshotNeedsRefresh,
  prepareNativeRisuReadOnly,
  supportedNativeRisuSnapshot,
} from './risu-native-readonly.js';
import { judgeImagePlacement } from './image-judgment.js';
import { nativeImageGuidance } from './risu-native-images.js';
import { generationFromModel } from '../core/model-capabilities.js';
import { contextBudgetForModel } from '../core/context-budget.js';
import { withNativeHostContext } from '../core/provider-messages.js';
import {
  compileTranslationPrompt,
  displayInput,
  executeAuxiliary,
  parseStructuredTranslation,
  presentationInput,
  scriptedAuxiliary,
  translationInput,
  validateDisplayAnnotation,
  validatePresentation,
  type AssetEntry,
  type AuxiliaryInput,
  type AuxiliarySource,
  type SourceTimeContext,
} from '../core/auxiliary.js';
import type { Connection, ModelSnapshot, TaskRole } from '../core/product.js';
import {
  executeProvider,
  type Json,
  type ProviderRequest,
  type ProviderResult,
  type ProviderTool,
  type WireRecord,
  transportConnection,
} from '../core/transport.js';
import type { ImageTarget, RunSnapshot, ToolEvent } from '../core/types.js';
import { createEvaluationToolSession } from './evaluation-session.js';
import { translationPolicy, type TranslationPolicy } from '../core/translation-settings.js';
import {
  translationReader,
  TRANSLATION_READ_NAMES,
  type TranslationReference,
} from '../core/translation-context.js';
import { RisuPromptError } from '../core/risu-prompt.js';
import type { AuxiliaryFailureDiagnostic } from '../core/auxiliary-diagnostic.js';
import { STORY_READ_TOOLS } from '../core/story-read-tools.js';
import { judgeTranslationRefusal } from './translation-judgment.js';
import { JevError, type JevHooks } from './jev-judgment.js';

type MaybePromise<T> = T | Promise<T>;
type JobKind = Exclude<TaskRole, 'main'>;
export type AuxiliaryBundle = {
  job: {
    id: string;
    kind: JobKind;
    status: string;
    sourceRevision: string;
    sourceHash: string;
    imageTarget?: ImageTarget;
  };
  source: AuxiliarySource;
  imageSource?: AuxiliarySource;
  snapshot: RunSnapshot;
  assets?: AssetEntry[];
  translationReferences?: TranslationReference[];
  translationPolicy?: TranslationPolicy;
  judgmentRecovery?: string;
};
export type AuxiliaryJobResult = {
  imageTarget?: ImageTarget;
  mock: boolean;
  sourceRevision: string;
  sourceHash: string;
  text?: string;
  label?: string;
  annotations?: {
    blockAnchor: string;
    assetRef: string;
    assetRevision: number;
    assetHash: string;
    presentationIntent: 'inline' | 'profile';
    caption?: string;
  }[];
  display?: { anchor: string; summary: string; mood: string }[];
};
export type AuxiliaryOutcome = {
  status: 'completed' | 'partial' | 'failed' | 'cancelled' | 'interrupted';
  result: AuxiliaryJobResult | null;
  error: string | null;
  diagnostic?: AuxiliaryFailureDiagnostic;
};
/** Every mutating bridge method must check owner+generation and the source dependency. */
export type AuxiliaryStoreBridge = {
  load: (jobId: string) => MaybePromise<AuxiliaryBundle>;
  claim: (
    jobId: string,
    owner: string,
    prepared: { input: AuxiliaryInput }
  ) => MaybePromise<number | null>;
  finish: (
    jobId: string,
    generation: number,
    owner: string,
    outcome: AuxiliaryOutcome
  ) => MaybePromise<void>;
};
export type AuxiliaryJobHooks = {
  /** Server injection for isolated transport tests; never part of persisted user settings. */
  jev?: Pick<JevHooks, 'credential' | 'fetch'>;
  executeCodex?: import('../core/transport.js').ProviderExecutionOptions['executeCodex'];
  resolveCredential?: import('../core/transport.js').ProviderExecutionOptions['resolveCredential'];
  signal: AbortSignal;

  authorize: (connection: Connection) => MaybePromise<Connection>;
  onAttemptStart: (wire: WireRecord) => MaybePromise<string>;
  onAttemptFinish: (id: string, result: ProviderResult) => MaybePromise<void>;
  onInput?: (jobId: string, input: AuxiliaryInput) => MaybePromise<void>;
  onToolEvent?: (jobId: string, event: ToolEvent) => MaybePromise<void>;
  onProgress?: () => MaybePromise<void>;
  timeoutMs?: number;
  vertexRequestTier?: 'standard' | 'flex';
  cancellationStatus?: 'cancelled' | 'interrupted';
};
const json = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;
class AuxiliaryExecutionError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean = false
  ) {
    super(code);
  }
}
const safeError = (error: unknown) => {
  if (error instanceof AuxiliaryExecutionError || error instanceof JevError) return error.code;
  if (error instanceof RisuPromptError) return error.code;
  if (error instanceof Error && error.name === 'BudgetError')
    return 'AUXILIARY_CALL_BUDGET_EXHAUSTED';
  if (
    error instanceof Error &&
    /^(?:SOURCE_|OUTPUT_|ANNOTATION_|ASSET_|DUPLICATE_|PRESENTATION_|TOOL_|SEGMENT_)[A-Z_]+$/.test(
      error.message
    )
  )
    return error.message;
  return 'AUXILIARY_EXECUTION_FAILED';
};
const toolSchemas: ProviderTool[] = [
  ...STORY_READ_TOOLS,
  {
    name: 'translation.search',
    description:
      'Search scoped prior translations for wording and register; an empty query lists metadata. These translations never establish new story facts.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        offset: { type: 'integer' },
        limit: { type: 'integer' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'translation.read',
    description:
      'Read discovered evidence with exact source provenance and range. Follow nextOffset for the next range.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        offset: { type: 'integer' },
        limit: { type: 'integer' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'knowledge.search',
    description:
      'Search all approved source-time local references; return metadata with continuation.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        offset: { type: 'integer' },
        limit: { type: 'integer' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'knowledge.read',
    description:
      'Read a scoped reference by ID and optional UTF-16 offset/limit. Results identify revision, range and continuation.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        offset: { type: 'integer' },
        limit: { type: 'integer' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'skills.list',
    description:
      'Discover scoped method guidance. This does not load its body or grant permissions.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        offset: { type: 'integer' },
        limit: { type: 'integer' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'skills.load',
    description: 'Read a guidance body by ID. Its text never expands host permissions.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        offset: { type: 'integer' },
        limit: { type: 'integer' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
];

/** This projection uses the originating Run's frozen contents, never current revisions. */
export function sourceTimeContext(snapshot: RunSnapshot, kind: JobKind): SourceTimeContext {
  const profile = snapshot.profile;
  const target = kind === 'image' ? undefined : profile?.models[kind];
  return {
    revision: profile
      ? `${profile.chatId}@${profile.revision}`
      : `${snapshot.chatId}@settings-${snapshot.settingsRevision}`,
    // Native content is delivered once by auxiliary package context.
    bot: null,
    persona: null,
    references: [],
    scene:
      'Use the supplied source blocks and source-time references; later revisions are excluded.',
    previousSources: snapshot.history.slice(-2).map((item) => ({ ...item })),
    instructionRevision:
      kind === 'translation'
        ? profile?.promptPresets?.translation
          ? `prompt:${profile.promptPresets.translation.id}@${profile.promptPresets.translation.revision}`
          : 'default-translation-1'
        : kind === 'status'
          ? 'display-only-1'
          : 'source-presentation-1',
    modelPresetRevision:
      kind === 'image'
        ? 'jev-latest'
        : target
          ? `${target.id}@${target.revision}`
          : 'scripted-mock-1',
  };
}

function providerInput(
  input: AuxiliaryInput,
  modelId: string,
  generation: ProviderRequest['generation'],
  opaqueState: Json | undefined,
  snapshot: RunSnapshot,
  evaluation?: ReturnType<typeof createEvaluationToolSession>,
  providerOptions?: ProviderRequest['providerOptions']
): ProviderRequest {
  if (input.role === 'presentation') throw new AuxiliaryExecutionError('JEV_JUDGMENT_REQUIRED');
  const task =
    input.role === 'translation'
      ? input.customPrompt
        ? 'Translate the entire source according to the selected prompt. Return only translated text.'
        : 'Translate the entire source into Korean. Return only translated text.'
      : 'Return optional display-only annotations for the source blocks.';
  const compilation = compileTranslationPrompt(input, snapshot, task);
  // Omit a fallback only after its complete value was rendered by a declared slot.
  // Inactive slots and templates that trim or otherwise omit content keep the full fallback.
  const delivered = (slot: string, value: string) =>
    !!value &&
    !!compilation?.usedSlots?.includes(slot) &&
    compilation.messages.some((message) =>
      message.content.some((part) => part.text.includes(value))
    );
  const notes = input.role === 'translation' ? snapshot.story?.notes : undefined;
  return withNativeHostContext({
    role: input.role,
    modelId,
    stable: {
      contract:
        (compilation ? '' : input.contract) +
        (input.referencePolicy ? '\n' + input.referencePolicy : '') +
        (evaluation
          ? '\nThe selected evaluation tool set is scoped to this model preset and this run. eval_submit_artifact returns content as the completed task output; userFacingNotice remains separate metadata.'
          : ''),
      tools: [
        ...toolSchemas
          .filter((tool) => input.tools.includes(tool.name))
          .map((tool) => structuredClone(tool)),
        ...(evaluation?.definitions.map((tool) => structuredClone(tool)) ?? []),
      ],
    },
    generation,
    ...(providerOptions !== undefined ? { providerOptions: structuredClone(providerOptions) } : {}),
    ...(evaluation?.bootstrap.length
      ? {
          bootstrap: evaluation.bootstrap.map((item) => ({
            callId: item.callId,
            name: item.name,
            args: json(item.args) as Record<string, Json>,
            result: json(item.result),
            denied: item.denied,
          })),
        }
      : {}),
    ...(evaluation?.toolChoice(Array.isArray(input.results) ? input.results.length : 0)
      ? {
          toolChoice: evaluation.toolChoice(
            Array.isArray(input.results) ? input.results.length : 0
          ),
        }
      : {}),
    ...(compilation
      ? {
          prompt: {
            compilerVersion: compilation.compilerVersion,
            messages: compilation.messages,
            cachePlan: compilation.cachePlan,
            values: compilation.values,
          },
        }
      : {}),
    input: {
      task,
      controls: {
        instructionRevision: input.context.instructionRevision,
        modelPresetRevision: input.context.modelPresetRevision,
        ...(input.customPrompt ? { customPrompt: true } : {}),
      },
      source: json({
        sourceRevision: input.sourceRevision,
        sourceHash: input.sourceHash,
        ...(!delivered('context', JSON.stringify(input.context)) ? { context: input.context } : {}),
        ...(input.role === 'translation'
          ? !delivered('source', input.sourceText ?? '')
            ? { text: input.sourceText }
            : {}
          : { blocks: input.blocks }),
        ...(notes?.length && !delivered('notes', JSON.stringify(notes)) ? { notes } : {}),
        ...(input.scenes ? { scenes: input.scenes } : {}),
        outputSchema: input.outputSchema,
      }),
      ...(!delivered('catalog', JSON.stringify(input.catalog))
        ? {
            catalog: json(input.catalog),
          }
        : {}),
      results: json(input.results),
    },
    ...(opaqueState !== undefined ? { opaqueState } : {}),
  });
}

/** Server job execution is separate from SQLite claim/finish transactions. */
export async function runAuxiliaryJob(
  store: AuxiliaryStoreBridge,
  jobId: string,
  owner: string,
  hooks: AuxiliaryJobHooks
): Promise<AuxiliaryOutcome | null> {
  const bundle = structuredClone(await store.load(jobId));
  const { source, job } = bundle;
  let snapshot = bundle.snapshot;
  if (
    job.sourceRevision !== source.id ||
    job.sourceHash !== source.hash ||
    source.chatId !== snapshot.chatId
  )
    throw new Error('SOURCE_DEPENDENCY_MISMATCH');
  let nativePreparationError: unknown;
  if (!bundle.judgmentRecovery && nativeRisuSnapshotNeedsRefresh(snapshot)) {
    try {
      // This is a new operation against frozen source-time inputs. The original receipt stays intact.
      snapshot = supportedNativeRisuSnapshot(snapshot);
      snapshot = await prepareNativeRisuReadOnly(snapshot, 'auxiliary');
    } catch (error) {
      nativePreparationError = error;
    }
  }
  let executionSnapshot = snapshot;
  const imageSource = bundle.imageSource ?? source;
  const context = sourceTimeContext(snapshot, job.kind);
  let nativeImagePreparationError: unknown;
  let imageGuidance = '';
  if (job.kind === 'image') {
    try {
      const guidance = await nativeImageGuidance(snapshot);
      imageGuidance = guidance ?? '';
      if (guidance)
        context.references.push({
          id: 'native-image-handoff',
          revision: snapshot.profile?.revision ?? 1,
          text: guidance,
        });
    } catch (error) {
      nativeImagePreparationError = error;
    }
  }
  const assets = bundle.assets ?? [];
  const policy = translationPolicy(bundle.translationPolicy);
  const input =
    job.kind === 'translation'
      ? translationInput(source, context, snapshot)
      : job.kind === 'status'
        ? displayInput(source, context, snapshot)
        : presentationInput(imageSource, context, snapshot, assets);
  const generation = await store.claim(jobId, owner, { input });
  if (generation === null) return null;
  await hooks.onProgress?.();
  const target = job.kind === 'image' ? undefined : snapshot.profile?.models[job.kind];
  let calls = 0;
  let contextBytes = 0;
  const readTranslation = translationReader(snapshot, bundle.translationReferences ?? []);
  const evaluation = createEvaluationToolSession(target, hooks.timeoutMs);
  // Fixture annotations remain explicitly marked; live output still requires artifact validation.
  const mock =
    !bundle.judgmentRecovery &&
    job.kind !== 'image' &&
    (!target || target.connection.protocol === 'fixture-sse-v1');
  const maxCalls = job.kind === 'translation' ? policy.maxCalls : snapshot.settings.maxCalls;
  let candidateText: string | undefined = bundle.judgmentRecovery;
  let stage: AuxiliaryFailureDiagnostic['stage'] = 'preparation';
  let lastAttemptId: string | undefined;
  const cancelState = () => hooks.cancellationStatus ?? 'cancelled';
  const callProvider = async (
    target: ModelSnapshot,
    body: ProviderRequest,
    diagnostics?: ReturnType<typeof createEvaluationToolSession>
  ) => {
    lastAttemptId = undefined;
    if (hooks.signal.aborted) throw new AuxiliaryExecutionError('AUXILIARY_CANCELLED');
    if (calls >= maxCalls)
      throw Object.assign(new Error('Auxiliary call budget exhausted'), { name: 'BudgetError' });
    calls++;
    let authorized: Connection;
    try {
      authorized = await hooks.authorize(structuredClone(target.connection));
    } catch {
      throw new AuxiliaryExecutionError('CONNECTION_NOT_AUTHORIZED');
    }
    if (
      !authorized.enabled ||
      authorized.id !== target.connectionId ||
      authorized.endpoint !== target.connection.endpoint ||
      authorized.protocol !== target.connection.protocol
    )
      throw new AuxiliaryExecutionError('CONNECTION_NOT_AUTHORIZED');
    let attemptId: string | undefined;
    const remainingTimeout = diagnostics?.remainingMs();
    if (remainingTimeout === 0) throw new AuxiliaryExecutionError('AUXILIARY_PROVIDER_TIMEOUT');
    const result = await executeProvider(transportConnection(authorized), body, {
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
        lastAttemptId = attemptId;
      },
    });
    // Keep diagnostic output and usage even when a refusal or malformed body cannot become an artifact.
    if (attemptId !== undefined)
      await hooks.onAttemptFinish(
        attemptId,
        diagnostics ? diagnostics.diagnosticResult(result) : structuredClone(result)
      );
    return result;
  };
  const runInput = async (packet: AuxiliaryInput) => {
    if (evaluation)
      packet = {
        ...packet,
        tools: [...packet.tools, ...evaluation.definitions.map((tool) => tool.name)],
      };
    let opaqueState: Json | undefined;
    const request = async (next: AuxiliaryInput) => {
      stage = 'preparation';
      lastAttemptId = undefined;
      if (calls >= maxCalls)
        throw Object.assign(new Error('Auxiliary call budget exhausted'), { name: 'BudgetError' });
      if (evaluation && evaluation.remainingMs() === 0)
        throw new AuxiliaryExecutionError('AUXILIARY_PROVIDER_TIMEOUT');
      if (!target) {
        calls++;
        return scriptedAuxiliary(next, hooks.signal);
      }
      const generation = generationFromModel(target);
      const completedToolResults = Array.isArray(next.results) ? next.results.length : 0;
      const body: ProviderRequest = {
        ...providerInput(
          next,
          target.modelId,
          evaluation ? evaluation.generation(generation, completedToolResults) : generation,
          opaqueState,
          executionSnapshot,
          evaluation,
          target.providerOptions
        ),
        contextBudget: contextBudgetForModel(target),
        pricingSnapshot: target.pricingSnapshot,
      };
      const generationBinding = evaluation?.generationBinding(generation, completedToolResults);
      if (generationBinding) body.generationBinding = generationBinding;
      stage = job.kind;
      const result = await callProvider(target, body, evaluation);
      if (result.status === 'tool_calls') {
        opaqueState = result.opaqueState;
        return {
          kind: 'tools',
          actions: result.toolCalls.map((call) => ({
            callId: call.id,
            name: call.name,
            args: call.arguments,
            ...(call.recoveredFromTruncation ? { recoveredFromTruncation: true } : {}),
          })),
        };
      }
      if (result.status !== 'completed')
        throw new AuxiliaryExecutionError(
          result.status === 'refused'
            ? 'AUXILIARY_PROVIDER_REFUSED'
            : result.status === 'partial'
              ? 'AUXILIARY_PROVIDER_PARTIAL'
              : result.status === 'cancelled'
                ? 'AUXILIARY_CANCELLED'
                : `AUXILIARY_PROVIDER_${result.error?.code ?? 'ERROR'}`,
          result.status === 'refused' && !result.error
        );
      const output =
        job.kind === 'translation' && target.structuredOutput === true
          ? parseStructuredTranslation(source, result.text)
          : result.text;
      if (job.kind === 'translation' && output) candidateText = output;
      return output;
    };
    return executeAuxiliary(packet, snapshot, request, {
      signal: hooks.signal,
      maxCalls: evaluation ? Math.min(maxCalls, evaluation.maxCalls) : maxCalls,
      localTools: {
        names: [
          ...(job.kind === 'translation' ? TRANSLATION_READ_NAMES : []),
          ...(evaluation?.allNames ?? []),
        ],
        execute: (action) => {
          if (TRANSLATION_READ_NAMES.includes(action.name)) return readTranslation(action);
          const call = {
            id: action.callId,
            name: action.name,
            arguments: json(action.args) as Record<string, Json>,
          };
          if (action.name !== 'eval_submit_artifact') return evaluation!.execute(call);
          const submitted = evaluation!.submit(call, action.recoveredFromTruncation === true);
          if (!submitted.ok) return submitted.event;
          return {
            event: {
              callId: action.callId,
              name: action.name,
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
            },
            terminalOutput: submitted.artifact.text,
          };
        },
      },
      onInput: (value) => hooks.onInput?.(jobId, value),
      onToolEvent: async (value) => {
        if (job.kind === 'translation') {
          contextBytes += Buffer.byteLength(JSON.stringify(value), 'utf8');
          if (contextBytes > 96000)
            throw new AuxiliaryExecutionError('TOOL_CONTEXT_BUDGET_EXHAUSTED');
        }
        await hooks.onToolEvent?.(jobId, value);
      },
    });
  };
  try {
    if (nativePreparationError) throw nativePreparationError;
    if (nativeImagePreparationError) throw nativeImagePreparationError;
    if (job.kind === 'image') {
      stage = 'image';
      if (calls >= maxCalls) throw new AuxiliaryExecutionError('AUXILIARY_CALL_BUDGET_EXHAUSTED');
      const output = await judgeImagePlacement(imageSource, assets, imageGuidance, {
        signal: hooks.signal,
        ...hooks.jev,
        onAttemptStart: async (wire) => {
          const id = await hooks.onAttemptStart(wire);
          lastAttemptId = id;
          return id;
        },
        onStarted: () => {
          calls++;
        },
        onAttemptFinish: hooks.onAttemptFinish,
      });
      const validated = validatePresentation(imageSource, output, assets);
      const outcome: AuxiliaryOutcome = {
        status: 'completed',
        error: null,
        result: {
          mock: false,
          sourceRevision: source.id,
          sourceHash: source.hash,
          ...(job.imageTarget ? { imageTarget: job.imageTarget } : {}),
          annotations: validated.entries.map((entry) => ({
            ...entry,
            caption: assets.find((asset) => asset.ref === entry.assetRef)?.caption,
          })),
        },
      };
      await store.finish(jobId, generation, owner, outcome);
      await hooks.onProgress?.();
      return outcome;
    }

    if (job.kind === 'translation') {
      if (!bundle.judgmentRecovery)
        executionSnapshot = await prepareNativeRisuTranslationPrompt(snapshot);
      for (let retry = 0; ; retry++) {
        if (hooks.signal.aborted) throw new AuxiliaryExecutionError('AUXILIARY_CANCELLED');
        try {
          const output = bundle.judgmentRecovery ?? (await runInput(input)).output;
          if (typeof output !== 'string' || !output.trim())
            throw new AuxiliaryExecutionError('AUXILIARY_PROVIDER_EMPTY');
          candidateText = output;
        } catch (error) {
          if (
            error instanceof AuxiliaryExecutionError &&
            error.code === 'AUXILIARY_PROVIDER_REFUSED' &&
            policy.judgment.enabled !== false &&
            error.retryable &&
            !hooks.signal.aborted
          ) {
            if (!bundle.judgmentRecovery && retry < policy.maxRetries) continue;
            throw new AuxiliaryExecutionError('TRANSLATION_REFUSAL_RETRIES_EXHAUSTED');
          }
          throw error;
        }
        let verdict: 'accepted' | 'refused' = 'accepted';
        if (!mock && policy.judgment.enabled !== false) {
          stage = 'translation-refusal';
          lastAttemptId = undefined;
          {
            if (calls >= maxCalls)
              throw Object.assign(new Error('Auxiliary call budget exhausted'), {
                name: 'BudgetError',
              });
            try {
              const judgment = await judgeTranslationRefusal(
                candidateText,
                source.hash,
                policy.judgment,
                {
                  signal: hooks.signal,
                  ...hooks.jev,
                  onAttemptStart: async (wire) => {
                    const id = await hooks.onAttemptStart(wire);
                    lastAttemptId = id;
                    return id;
                  },
                  onStarted: () => {
                    calls++;
                  },
                  onAttemptFinish: hooks.onAttemptFinish,
                }
              );
              verdict = judgment.verdict;
            } catch (error) {
              throw new AuxiliaryExecutionError(
                hooks.signal.aborted
                  ? 'AUXILIARY_CANCELLED'
                  : error instanceof JevError && error.code === 'JEV_INPUT_BUDGET'
                    ? error.code
                    : 'TRANSLATION_REFUSAL_CHECK_FAILED'
              );
            }
          }
        }
        if (hooks.signal.aborted) throw new AuxiliaryExecutionError('AUXILIARY_CANCELLED');
        if (verdict === 'refused') {
          if (!bundle.judgmentRecovery && retry < policy.maxRetries) continue;
          throw new AuxiliaryExecutionError('TRANSLATION_REFUSAL_RETRIES_EXHAUSTED');
        }
        const outcome: AuxiliaryOutcome = {
          status: 'completed',
          result: { mock, sourceRevision: source.id, sourceHash: source.hash, text: candidateText },
          error: null,
        };
        await store.finish(jobId, generation, owner, outcome);
        await hooks.onProgress?.();
        return outcome;
      }
    }
    const output = (await runInput(input)).output;
    const validated = validateDisplayAnnotation(source, output);
    const result: AuxiliaryJobResult = {
      mock,
      sourceRevision: source.id,
      sourceHash: source.hash,
      label: validated.entries.map((entry) => entry.summary).join(' · '),
      display: validated.entries,
    };
    const outcome: AuxiliaryOutcome = { status: 'completed', result, error: null };
    await store.finish(jobId, generation, owner, outcome);
    await hooks.onProgress?.();
    return outcome;
  } catch (error) {
    const code = hooks.signal.aborted ? 'AUXILIARY_CANCELLED' : safeError(error);
    // IDs are local authored identifiers, not error messages or provider response excerpts.
    const identifier = (value: unknown) =>
      typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : undefined;
    const outcome: AuxiliaryOutcome = {
      status: hooks.signal.aborted ? cancelState() : 'failed',
      result:
        job.kind === 'translation' && candidateText
          ? { mock, sourceRevision: source.id, sourceHash: source.hash, text: candidateText }
          : null,
      error: code,
      diagnostic: {
        stage,
        code,
        ...(lastAttemptId ? { attemptId: lastAttemptId } : {}),
        ...(error instanceof RisuPromptError
          ? { blockId: identifier(error.blockId), slotName: identifier(error.slotName) }
          : {}),
      },
    };
    await store.finish(jobId, generation, owner, outcome);
    await hooks.onProgress?.();
    return outcome;
  }
}
