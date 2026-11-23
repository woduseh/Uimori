import { modelRequestFields } from '../core/model-request-fields.js';
import { requestLore } from './request-lore.js';
import { measureProviderRequest } from './main-request.js';
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
import { textTokenExcerpt } from '../core/text-tokens.js';
import { withNativeHostContext } from '../core/provider-messages.js';
import {
  compileTranslationPrompt,
  executeAuxiliary,
  parseStructuredTranslation,
  presentationInput,
  scriptedAuxiliary,
  translationInput,
  translationPromptContext,
  validatePresentation,
  type AssetEntry,
  type AuxiliaryInput,
  type AuxiliarySource,
  type SourceTimeContext,
} from '../core/auxiliary.js';
import {
  isGeminiProtocol,
  type Connection,
  type ModelSnapshot,
  type TaskRole,
} from '../core/product.js';
import {
  executeProvider,
  type Json,
  type ProviderRequest,
  type ProviderResult,
  type ProviderTool,
  type WireRecord,
  transportConnection,
} from '../core/transport.js';
import type { ImageTarget, RunSnapshot, ToolEvent, ToolEventTiming } from '../core/types.js';
import { createEvaluationToolSession } from './evaluation-session.js';
import { EVALUATION_TOOL_ROUND_LIMIT } from '../core/evaluation-tool-config.js';
import {
  translationContextMode,
  translationPolicy,
  type TranslationPolicy,
} from '../core/translation-settings.js';
import { modelAuthorNotes } from '../core/notes.js';
import {
  translationReader,
  TRANSLATION_READ_NAMES,
  translationSnapshot,
  type TranslationReference,
} from '../core/translation-context.js';
import { RisuPromptError } from '../core/risu-prompt.js';
import type { AuxiliaryFailureDiagnostic } from '../core/auxiliary-diagnostic.js';
import { MAIN_READ_TOOLS } from '../core/read-tools.js';
import { judgeTranslationRefusal } from './translation-judgment.js';
import { projectStoryUiText } from '../core/story-ui.js';
import { prepareStoryUiTranslation } from '../core/story-ui-translation.js';
import { JudgmentError, type JudgmentHooks } from './judgment.js';
import { uncertainAttemptResult } from './usage-accounting.js';
import type { ResponseProgress, ResponseStreamStatus } from '../core/response-stream.js';

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
  judgmentPending?: true;
  annotations?: {
    blockAnchor: string;
    assetRef: string;
    assetRevision: number;
    assetHash: string;
    presentationIntent: 'inline' | 'profile';
    caption?: string;
  }[];
};
export type AuxiliaryOutcome = {
  status: 'completed' | 'partial' | 'failed' | 'cancelled' | 'interrupted';
  result: AuxiliaryJobResult | null;
  error: string | null;
  diagnostic?: AuxiliaryFailureDiagnostic;
};
export type AuxiliaryStoreBridge = {
  captureTranslationReferences?: (snapshot: RunSnapshot) => Disposable & {
    load: (id?: string) => readonly TranslationReference[];
  };
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
  stageTranslationJudgment: (
    jobId: string,
    generation: number,
    owner: string,
    candidate: string,
    pending: boolean
  ) => MaybePromise<void>;
};
export type AuxiliaryJobHooks = {
  jev?: Pick<JudgmentHooks, 'credential' | 'fetch' | 'settings' | 'readImage' | 'target'>;
  executeCodex?: import('../core/transport.js').ProviderExecutionOptions['executeCodex'];
  resolveCredential?: import('../core/transport.js').ProviderExecutionOptions['resolveCredential'];
  signal: AbortSignal;

  authorize: (connection: Connection) => MaybePromise<Connection>;
  onAttemptStart: (wire: WireRecord) => MaybePromise<string>;
  onAttemptFinish: (id: string, result: ProviderResult) => MaybePromise<void>;
  onInput?: (jobId: string, input: AuxiliaryInput) => MaybePromise<void>;
  onScriptedInput?: (input: AuxiliaryInput) => MaybePromise<void>;
  onToolStart?: (
    jobId: string,
    event: Pick<ToolEvent, 'callId' | 'name' | 'args'>,
    generation: number
  ) => MaybePromise<void>;
  onToolEvent?: (
    jobId: string,
    event: ToolEvent,
    timing: ToolEventTiming | undefined,
    generation: number
  ) => MaybePromise<void>;
  onProgress?: () => MaybePromise<void>;
  openResponseStream?: () => AuxiliaryResponseStream;
  timeoutMs?: number;
  vertexRequestTier?: 'standard' | 'flex';
  cancellationStatus?: 'cancelled' | 'interrupted';
};
export type AuxiliaryResponseStream = {
  progress: (progress: ResponseProgress) => void;
  finish: (status: Exclude<ResponseStreamStatus, 'running'>) => void;
};
const json = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;
class AuxiliaryExecutionError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, retryable: boolean = false) {
    super(code);
    this.code = code;
    this.retryable = retryable;
  }
}
const safeError = (error: unknown) => {
  if (error instanceof AuxiliaryExecutionError || error instanceof JudgmentError) return error.code;
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
  ...MAIN_READ_TOOLS,
  {
    name: 'translation.search',
    description:
      'Search the earlier translations available to this job to see how a name, term or tone was rendered before, so the new translation stays consistent. Every whitespace-separated term must occur in the original or its translation; omit query to list the available translations. Results are metadata with ids for translation.read. Earlier translations are a wording reference only and never establish new story facts.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          maxLength: 512,
          description: 'Terms to find, all required. Omit to list the available translations.',
        },
        offset: {
          type: 'integer',
          minimum: 0,
          description: 'Result offset. Pass the previous nextOffset.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: 'Maximum results per page. Default 20.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'translation.read',
    description:
      'Read one earlier translation found by translation.search, with its exact source provenance and the range that was returned. Follow nextOffset for the rest of a long text.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id from translation.search.' },
        offset: {
          type: 'integer',
          minimum: 0,
          description:
            'Start position in the text, in UTF-16 code units. Pass nextOffset to continue.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 4096,
          description:
            'Optional hard cap on the returned text, in UTF-16 code units. Normally omit it and size the read with maxTokens.',
        },
        maxTokens: {
          type: 'integer',
          minimum: 1,
          maximum: 2048,
          description: 'Text budget in locally estimated tokens. Default 2048.',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
];

export function sourceTimeContext(
  snapshot: RunSnapshot,
  kind: JobKind,
  previousSceneTokens?: number
): SourceTimeContext {
  const profile = snapshot.profile;
  const target = kind === 'image' ? undefined : profile?.models[kind];
  const previousSources: SourceTimeContext['previousSources'] = [];
  let remaining = previousSceneTokens;
  for (const item of snapshot.history.slice(-2).reverse()) {
    if (remaining === 0) break;
    const text = projectStoryUiText(item.text);
    if (remaining === undefined) {
      previousSources.unshift({ ...item, text });
    } else {
      const excerpt = textTokenExcerpt(text, remaining, {
        side: 'end',
        marker: '…',
        profile: target?.tokenizer,
      });
      if (excerpt.text && !(excerpt.truncated && excerpt.text === '…'))
        previousSources.unshift({ revision: item.revision, text: excerpt.text });
      remaining -= excerpt.tokens;
    }
  }
  return {
    revision: profile
      ? `${profile.chatId}@${profile.revision}`
      : `${snapshot.chatId}@settings-${snapshot.settingsRevision}`,
    bot: null,
    persona: null,
    references: [],
    scene:
      'Use the supplied source blocks and source-time references; later revisions are excluded.',
    previousSources,
    instructionRevision:
      kind === 'translation'
        ? profile?.promptPresets?.translation
          ? `prompt:${profile.promptPresets.translation.id}@${profile.promptPresets.translation.revision}`
          : 'default-translation-1'
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
  modelFields: ReturnType<typeof modelRequestFields>,
  generation: ProviderRequest['generation'],
  opaqueState: Json | undefined,
  snapshot: RunSnapshot,
  evaluation?: ReturnType<typeof createEvaluationToolSession>
): ProviderRequest {
  if (input.role === 'presentation') throw new AuxiliaryExecutionError('JEV_JUDGMENT_REQUIRED');
  const task = input.customPrompt
    ? 'Translate the entire source according to the selected prompt. Return only translated text.'
    : 'Translate the entire source into Korean. Return only translated text.';
  const compilation = compileTranslationPrompt(input, snapshot, task);
  const delivered = (slot: string, value: string) =>
    !!value &&
    !!compilation?.usedSlots?.includes(slot) &&
    compilation.messages.some((message) =>
      message.content.some((part) => part.type === 'text' && part.text.includes(value))
    );
  const sourceOnly = input.contextMode === 'source-only';
  const context = translationPromptContext(input);
  const notes =
    input.role === 'translation' && !sourceOnly
      ? modelAuthorNotes(snapshot.story?.notes ?? [])
      : undefined;
  return withNativeHostContext({
    role: input.role,
    ...modelFields,
    stable: {
      contract:
        input.contract +
        (input.referencePolicy ? '\n' + input.referencePolicy : '') +
        (evaluation
          ? '\nThe selected evaluation tool set is scoped to this model preset and this source-time task. Finish by calling eval_submit_artifact alone with the complete task output in content, preserving the requested output format and source identity. userFacingNotice remains separate metadata. Ordinary final text does not complete the task.'
          : ''),
      tools: [
        ...toolSchemas
          .filter((tool) => input.tools.includes(tool.name))
          .map((tool) => structuredClone(tool)),
        ...(evaluation?.definitions.map((tool) => structuredClone(tool)) ?? []),
      ],
    },
    generation,
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
      controls: sourceOnly
        ? input.customPrompt
          ? { customPrompt: true }
          : {}
        : {
            instructionRevision: input.context.instructionRevision,
            modelPresetRevision: input.context.modelPresetRevision,
            ...(input.customPrompt ? { customPrompt: true } : {}),
          },
      source: json({
        sourceRevision: input.sourceRevision,
        sourceHash: input.sourceHash,
        ...(!delivered('context', JSON.stringify(context)) ? { context } : {}),
        ...(input.role === 'translation'
          ? !delivered('source', input.sourceText ?? '')
            ? { text: input.sourceText }
            : {}
          : { blocks: input.blocks }),
        ...(notes?.length && !delivered('notes', JSON.stringify(notes)) ? { notes } : {}),
        ...(input.catalogPage ? { catalogPage: input.catalogPage } : {}),
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

export async function runAuxiliaryJob(
  store: AuxiliaryStoreBridge,
  jobId: string,
  owner: string,
  hooks: AuxiliaryJobHooks
): Promise<AuxiliaryOutcome | null> {
  const bundle = structuredClone(await store.load(jobId));
  const { source, job } = bundle;
  const policy = translationPolicy(bundle.translationPolicy);
  const mode = job.kind === 'translation' ? translationContextMode(policy.contextMode) : 'full';
  let snapshot = translationSnapshot(bundle.snapshot, mode);
  if (
    job.sourceRevision !== source.id ||
    job.sourceHash !== source.hash ||
    source.chatId !== snapshot.chatId
  )
    throw new Error('SOURCE_DEPENDENCY_MISMATCH');
  using references =
    job.kind === 'translation' && mode === 'full' && !bundle.judgmentRecovery
      ? store.captureTranslationReferences?.(snapshot)
      : undefined;
  let nativePreparationError: unknown;
  if (!bundle.judgmentRecovery && nativeRisuSnapshotNeedsRefresh(snapshot)) {
    try {
      snapshot = supportedNativeRisuSnapshot(snapshot);
      snapshot = await prepareNativeRisuReadOnly(snapshot, 'auxiliary');
    } catch (error) {
      nativePreparationError = error;
    }
  }
  let executionSnapshot = snapshot;
  const imageSource = bundle.imageSource ?? source;
  const context = sourceTimeContext(
    snapshot,
    job.kind,
    job.kind === 'translation' ? policy.previousSceneTokens : undefined
  );
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
  const input =
    job.kind === 'translation'
      ? translationInput(source, context, snapshot, mode)
      : presentationInput(imageSource, context, snapshot, assets);
  const protectedTranslation =
    job.kind === 'translation' ? prepareStoryUiTranslation(source.text) : undefined;
  if (protectedTranslation?.protected) {
    input.sourceText = protectedTranslation.text;
    input.contract +=
      '\nTranslate the prose and the human text strings in each UIMORI_UI_TRANSLATION tag. Preserve each tag exactly once and return its contents as a JSON array of strings in the same order and length. Do not add or remove entries.';
  }
  const generation = await store.claim(jobId, owner, { input });
  if (generation === null) return null;
  const responseStream = job.kind === 'translation' ? hooks.openResponseStream?.() : undefined;
  const publicTextStream = protectedTranslation?.protected ? undefined : responseStream;
  let translationRound = 0;
  await hooks.onProgress?.();
  const target = job.kind === 'image' ? undefined : snapshot.profile?.models[job.kind];
  let calls = 0;
  let readTranslation: ReturnType<typeof translationReader> | undefined;
  const evaluation = createEvaluationToolSession(target, hooks.timeoutMs);
  let evaluationRounds = 0;
  const mock =
    !bundle.judgmentRecovery &&
    job.kind !== 'image' &&
    (!target || target.connection.protocol === 'fixture-sse-v1');
  const maxCalls = job.kind === 'translation' ? policy.maxCalls : snapshot.settings.maxCalls;
  let candidateText: string | undefined = bundle.judgmentRecovery;
  let judgmentPending = false;
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
    let result: ProviderResult;
    try {
      result = await executeProvider(transportConnection(authorized), body, {
        signal: hooks.signal,
        resolveCredential: hooks.resolveCredential,
        executeCodex: hooks.executeCodex,
        vertexRequestTier: hooks.vertexRequestTier,
        timeoutMs:
          remainingTimeout ??
          hooks.timeoutMs ??
          target.timeoutMs ??
          (isGeminiProtocol(target.connection.protocol) ? 300_000 : undefined),
        onWire: async (wire) => {
          attemptId = await hooks.onAttemptStart(
            job.kind === 'translation'
              ? {
                  ...wire,
                  requestLore: requestLore(executionSnapshot, body, wire, {
                    pinned: input.context.packages?.pinned ?? [],
                    catalog: input.catalog,
                    sourceOnly: mode === 'source-only',
                  }),
                }
              : wire
          );
          lastAttemptId = attemptId;
        },
        onProgress:
          publicTextStream &&
          ((progress) => {
            if (attemptId !== undefined && !hooks.signal.aborted)
              publicTextStream.progress({ ...progress, attemptId, segment: translationRound });
          }),
      });
    } catch (error) {
      if (attemptId !== undefined) {
        try {
          await hooks.onAttemptFinish(attemptId, uncertainAttemptResult(hooks.signal.aborted));
        } catch {}
      }
      throw error;
    }
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
    const providerRequest = (next: AuxiliaryInput, model: ModelSnapshot) => {
      const generation = generationFromModel(model);
      const completedToolResults = Array.isArray(next.results) ? next.results.length : 0;
      const body: ProviderRequest = {
        ...providerInput(
          next,
          modelRequestFields(model),
          evaluation ? evaluation.generation(generation, completedToolResults) : generation,
          opaqueState,
          executionSnapshot,
          evaluation
        ),
        contextBudget: contextBudgetForModel(model),
      };
      const generationBinding = evaluation?.generationBinding(generation, completedToolResults);
      if (generationBinding) body.generationBinding = generationBinding;
      return body;
    };
    const request = async (next: AuxiliaryInput) => {
      stage = 'preparation';
      lastAttemptId = undefined;
      if (calls >= maxCalls)
        throw Object.assign(new Error('Auxiliary call budget exhausted'), { name: 'BudgetError' });
      if (evaluation && evaluation.remainingMs() === 0)
        throw new AuxiliaryExecutionError('AUXILIARY_PROVIDER_TIMEOUT');
      if (!target) {
        await hooks.onScriptedInput?.(structuredClone(next));
        calls++;
        return scriptedAuxiliary(next, hooks.signal);
      }
      const body = providerRequest(next, target);
      stage = job.kind;
      const result = await callProvider(target, body, evaluation);
      if (result.status === 'tool_calls') {
        if (evaluation && ++evaluationRounds > EVALUATION_TOOL_ROUND_LIMIT) {
          if (result.toolCalls.length !== 1 || result.toolCalls[0].name !== 'eval_submit_artifact')
            throw Object.assign(new Error('Auxiliary call budget exhausted'), {
              name: 'BudgetError',
            });
        }
        if (
          evaluation?.requiresSubmission &&
          result.toolCalls.some((call) => call.name === 'eval_submit_artifact') &&
          result.toolCalls.length !== 1
        )
          throw new AuxiliaryExecutionError('INVALID_EVALUATION_ARTIFACT');
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
      if (evaluation?.requiresSubmission)
        throw new AuxiliaryExecutionError('EVALUATION_SUBMISSION_REQUIRED');
      const output =
        job.kind === 'translation' && target.structuredOutput === true
          ? parseStructuredTranslation(source, result.text)
          : result.text;
      if (job.kind === 'translation' && output && !protectedTranslation?.protected)
        candidateText = output;
      return output;
    };
    const { onInput } = hooks;
    return executeAuxiliary(packet, snapshot, request, {
      signal: hooks.signal,
      captureInputs: false,
      maxCalls: evaluation ? Math.min(maxCalls, evaluation.maxCalls) : maxCalls,
      localTools: {
        names: [
          ...(job.kind === 'translation' ? TRANSLATION_READ_NAMES : []),
          ...(evaluation?.allNames ?? []),
        ],
        execute: (action) => {
          if (TRANSLATION_READ_NAMES.includes(action.name)) {
            readTranslation ??= translationReader(
              snapshot,
              references?.load ?? bundle.translationReferences ?? []
            );
            return readTranslation(action);
          }
          const call = {
            id: action.callId,
            name: action.name,
            arguments: json(action.args) as Record<string, Json>,
          };
          if (action.name !== 'eval_submit_artifact') return evaluation!.execute(call);
          const submitted = evaluation!.submit(call, action.recoveredFromTruncation === true);
          if (!submitted.ok) {
            if (evaluationRounds > EVALUATION_TOOL_ROUND_LIMIT)
              throw Object.assign(new Error('Auxiliary call budget exhausted'), {
                name: 'BudgetError',
              });
            return submitted.event;
          }
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
            terminalOutput:
              evaluation!.requiresSubmission &&
              job.kind === 'translation' &&
              target?.structuredOutput === true
                ? parseStructuredTranslation(source, submitted.artifact.text)
                : submitted.artifact.text,
          };
        },
      },
      onInput: onInput && ((value) => onInput(jobId, value)),
      onToolStart: (value) => hooks.onToolStart?.(jobId, value, generation),
      prepareToolEvent: (event, next, remainingActions) => {
        if (
          !target ||
          job.kind !== 'translation' ||
          event.denied ||
          evaluation?.allNames.some((name) => name === event.name)
        )
          return event;
        const tooLarge = (event: ToolEvent): ToolEvent => ({
          ...event,
          denied: true,
          errorKind: 'recoverable',
          result: {
            code: 'TOOL_CONTEXT_LIMIT_EXCEEDED',
            returned: false,
            guidance:
              'This optional read was not supplied. Request a narrower range or finish translating the complete current source with the evidence already available.',
          },
        });
        const body = providerRequest(
          {
            ...next,
            results: [
              ...(next.results ?? []),
              ...remainingActions.map((action) =>
                tooLarge({
                  callId: action.callId,
                  name: action.name,
                  args: action.args,
                  result: null,
                  denied: false,
                })
              ),
            ],
          },
          target
        );
        if (
          measureProviderRequest(body, target).estimatedInputTokens <=
          body.contextBudget!.inputTokenLimit
        )
          return event;
        return tooLarge(event);
      },
      onToolEvent: (value, timing) => hooks.onToolEvent?.(jobId, value, timing, generation),
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
      const judgeRefusal = async (text: string) => {
        if (calls >= maxCalls)
          throw Object.assign(new Error('Auxiliary call budget exhausted'), {
            name: 'BudgetError',
          });
        try {
          const judgment = await judgeTranslationRefusal(
            projectStoryUiText(text),
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
          return judgment.verdict;
        } catch (error) {
          throw new AuxiliaryExecutionError(
            hooks.signal.aborted
              ? 'AUXILIARY_CANCELLED'
              : error instanceof JudgmentError &&
                  (error.code === 'JEV_INPUT_BUDGET' || error.code === 'JUDGMENT_INPUT_BUDGET')
                ? error.code
                : 'TRANSLATION_REFUSAL_CHECK_FAILED'
          );
        }
      };
      for (let retry = 0; ; retry++) {
        translationRound = retry;
        if (hooks.signal.aborted) throw new AuxiliaryExecutionError('AUXILIARY_CANCELLED');
        try {
          const output = bundle.judgmentRecovery ?? (await runInput(input)).output;
          if (typeof output !== 'string' || !output.trim())
            throw new AuxiliaryExecutionError('AUXILIARY_PROVIDER_EMPTY');
          try {
            candidateText = bundle.judgmentRecovery
              ? output
              : (protectedTranslation?.restore(output) ?? output);
          } catch (restoreError) {
            if (mock || policy.judgment.enabled === false) throw restoreError;
            stage = 'translation-refusal';
            lastAttemptId = undefined;
            if ((await judgeRefusal(output)) === 'accepted') throw restoreError;
            if (hooks.signal.aborted) throw new AuxiliaryExecutionError('AUXILIARY_CANCELLED');
            if (retry < policy.maxRetries) continue;
            throw new AuxiliaryExecutionError('TRANSLATION_REFUSAL_RETRIES_EXHAUSTED');
          }
        } catch (error) {
          if (
            error instanceof AuxiliaryExecutionError &&
            error.code === 'AUXILIARY_PROVIDER_REFUSED' &&
            (policy.retryProviderRefusal ?? policy.judgment.enabled !== false) &&
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
          await store.stageTranslationJudgment(jobId, generation, owner, candidateText, true);
          judgmentPending = true;
          verdict = await judgeRefusal(candidateText);
        }
        if (hooks.signal.aborted) throw new AuxiliaryExecutionError('AUXILIARY_CANCELLED');
        if (verdict === 'refused') {
          await store.stageTranslationJudgment(jobId, generation, owner, candidateText, false);
          judgmentPending = false;
          if (!bundle.judgmentRecovery && retry < policy.maxRetries) continue;
          throw new AuxiliaryExecutionError('TRANSLATION_REFUSAL_RETRIES_EXHAUSTED');
        }
        const outcome: AuxiliaryOutcome = {
          status: 'completed',
          result: { mock, sourceRevision: source.id, sourceHash: source.hash, text: candidateText },
          error: null,
        };
        await store.finish(jobId, generation, owner, outcome);
        responseStream?.finish('completed');
        await hooks.onProgress?.();
        return outcome;
      }
    }
    throw new AuxiliaryExecutionError('AUXILIARY_KIND_INVALID');
  } catch (error) {
    const code = hooks.signal.aborted ? 'AUXILIARY_CANCELLED' : safeError(error);
    const identifier = (value: unknown) =>
      typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : undefined;
    const outcome: AuxiliaryOutcome = {
      status: hooks.signal.aborted ? cancelState() : 'failed',
      result:
        job.kind === 'translation' && candidateText
          ? {
              mock,
              sourceRevision: source.id,
              sourceHash: source.hash,
              text: candidateText,
              ...(judgmentPending ? { judgmentPending: true as const } : {}),
            }
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
    responseStream?.finish('failed');
    await hooks.onProgress?.();
    return outcome;
  }
}
