import { formatNumber, formatMessage, registerMessage, type MessageValues } from './i18n.js';

// Validation callers retain canonical error strings; only presentation follows UI language.
function validationMessage(key: string, values?: MessageValues): string {
  const raw = formatMessage(key, 'ko', values);
  registerMessage(raw, key, values);
  return raw;
}
import type { GeminiSafetySettings } from '../core/gemini-safety.js';
import type {
  Connection,
  ModelExecutionMode,
  ModelFamily,
  ModelPreset,
  VertexRequestTier,
} from '../core/product.js';
import { effectiveModelFamily, modelFamilyOptionKeys } from '../core/model-family.js';
import { TOKENIZER_PROFILES, type TokenizerProfileId } from '../core/tokenizer-profiles.js';
import type { ModelPricing, TokenRates } from '../core/pricing-types.js';
import { validateModelPricing } from '../core/model-pricing.js';
import {
  GENERATION_KEYS,
  generationFromModel,
  modelCapability,
  validateModelOptions,
} from '../core/model-capabilities.js';
import {
  defaultEvaluationToolOptions,
  readEvaluationToolOptions,
  validateEvaluationToolOptions,
  type EvaluationToolOptions,
} from '../core/evaluation-tool-config.js';
import {
  ProviderOptionsError,
  parseProviderOptionsText,
  PROVIDER_OPTIONS_MAX_CHARS,
} from '../core/provider-options.js';

export type RateDraft = Record<keyof Required<TokenRates>, string>;
type PricingDraft = {
  mode: 'official' | 'manual';
  rates: RateDraft;
  flexEnabled: boolean;
  flexRates: RateDraft;
  batchEnabled: boolean;
  batchRates: RateDraft;
  longContext: { aboveInputTokens: string; rates: RateDraft };
  flexLongContext: { aboveInputTokens: string; rates: RateDraft };
  batchLongContext: { aboveInputTokens: string; rates: RateDraft };
  sourceUrl: string;
  checkedAt: string;
};
const emptyRateDraft = (): RateDraft => ({
  input: '',
  cacheRead: '',
  cacheWrite: '',
  output: '',
  cacheWrite1h: '',
});
function rateDraft(rates?: TokenRates): RateDraft {
  const draft = emptyRateDraft();
  for (const key of Object.keys(draft) as (keyof RateDraft)[])
    draft[key] = rates?.[key] === undefined || rates[key] === null ? '' : String(rates[key]);
  return draft;
}
export function pricingDraft(pricing?: ModelPricing): PricingDraft {
  const manual = pricing?.mode === 'manual' ? pricing : undefined;
  const context = (value?: { aboveInputTokens: number; rates: TokenRates }) => ({
    aboveInputTokens: value ? String(value.aboveInputTokens) : '',
    rates: rateDraft(value?.rates),
  });
  return {
    mode: pricing?.mode ?? 'official',
    rates: rateDraft(pricing?.mode === 'manual' ? pricing.rates : undefined),
    flexEnabled: pricing?.mode === 'manual' && pricing.flexRates !== undefined,
    flexRates: rateDraft(manual?.flexRates),
    batchEnabled: manual?.batchRates !== undefined,
    batchRates: rateDraft(manual?.batchRates),
    longContext: context(manual?.longContext),
    flexLongContext: context(manual?.flexLongContext),
    batchLongContext: context(manual?.batchLongContext),
    sourceUrl: manual?.sourceUrl ?? '',
    checkedAt: manual?.checkedAt ?? '',
  };
}
export function pricingPayload(draft: PricingDraft): ModelPricing {
  const rates = (value: RateDraft): TokenRates => {
    const amount = (key: keyof RateDraft) => (value[key].trim() === '' ? null : Number(value[key]));
    return {
      input: amount('input'),
      cacheRead: amount('cacheRead'),
      cacheWrite: amount('cacheWrite'),
      output: amount('output'),
      ...(value.cacheWrite1h.trim() ? { cacheWrite1h: amount('cacheWrite1h') } : {}),
    };
  };
  return draft.mode === 'official'
    ? { mode: 'official' }
    : {
        mode: 'manual',
        rates: rates(draft.rates),
        ...(draft.flexEnabled ? { flexRates: rates(draft.flexRates) } : {}),
        ...(draft.batchEnabled ? { batchRates: rates(draft.batchRates) } : {}),
        ...Object.fromEntries(
          (['longContext', 'flexLongContext', 'batchLongContext'] as const)
            .filter(
              (key) =>
                draft[key].aboveInputTokens.trim() &&
                (key !== 'flexLongContext' || draft.flexEnabled) &&
                (key !== 'batchLongContext' || draft.batchEnabled)
            )
            .map((key) => [
              key,
              {
                aboveInputTokens: Number(draft[key].aboveInputTokens),
                rates: rates(draft[key].rates),
              },
            ])
        ),
        ...(draft.sourceUrl.trim() ? { sourceUrl: draft.sourceUrl.trim() } : {}),
        ...(draft.checkedAt.trim() ? { checkedAt: draft.checkedAt.trim() } : {}),
      };
}

export type ModelDraft = {
  title: string;
  connectionRef: string;
  modelId: string;
  modelFamily: ModelFamily | '';
  maxOutputTokens: string;
  inputTokenLimit: string;
  tokenizer: TokenizerProfileId | '';
  temperature: string;
  topP: string;
  stopSequences: string[];
  safetySettings: GeminiSafetySettings;
  thinkingLevel: string;
  timeoutSeconds: string;
  structuredOutput: 'default' | 'on' | 'off';
  reasoningEffort: string;
  outputEffort: string;
  verbosity: string;
  reasoningMode: string;
  reasoningContext: string;
  serviceTier: string;
  executionMode: ModelExecutionMode;
  cacheMode: string;
  cacheTtl: string;
  thinkingMode: string;
  enabled: boolean;
  evaluationToolsEnabled: boolean;
  evaluationTools: EvaluationToolOptions;
  providerOptions: string;
  pricing: PricingDraft;
};
export const initialModel = (): ModelDraft => ({
  title: '',
  connectionRef: '',
  modelId: '',
  modelFamily: '',
  maxOutputTokens: '8192',
  inputTokenLimit: '',
  tokenizer: '',
  temperature: '',
  topP: '',
  stopSequences: [],
  safetySettings: {},
  thinkingLevel: '',
  timeoutSeconds: '600',
  structuredOutput: 'default',
  reasoningEffort: '',
  outputEffort: '',
  verbosity: '',
  reasoningMode: '',
  reasoningContext: '',
  serviceTier: '',
  executionMode: 'realtime',
  cacheMode: '',
  cacheTtl: '',
  thinkingMode: '',
  enabled: true,
  evaluationToolsEnabled: false,
  evaluationTools: defaultEvaluationToolOptions(),
  providerOptions: '',
  pricing: pricingDraft(),
});
export function modelDraft(value: ModelPreset): ModelDraft {
  const evaluationTools =
    value.evaluationTools === undefined
      ? undefined
      : readEvaluationToolOptions(value.evaluationTools);
  return {
    title: value.title,
    connectionRef: value.connectionId,
    modelId: value.modelId,
    modelFamily: value.modelFamily ?? '',
    maxOutputTokens: String(value.maxOutputTokens),
    inputTokenLimit: value.inputTokenLimit === undefined ? '' : String(value.inputTokenLimit),
    tokenizer: value.tokenizer ?? '',
    temperature: value.temperature === null ? '' : String(value.temperature),
    topP: value.topP === undefined ? '' : String(value.topP),
    stopSequences: [...(value.stopSequences ?? [])],
    safetySettings: { ...(value.safetySettings ?? {}) },
    thinkingLevel: value.thinkingLevel ?? '',
    timeoutSeconds: value.timeoutMs === undefined ? '' : String(value.timeoutMs / 1000),
    structuredOutput:
      value.structuredOutput === undefined ? 'default' : value.structuredOutput ? 'on' : 'off',
    reasoningEffort: value.reasoningEffort ?? '',
    outputEffort: value.outputEffort ?? '',
    verbosity: value.verbosity ?? '',
    reasoningMode: value.reasoningMode ?? '',
    reasoningContext: value.reasoningContext ?? '',
    serviceTier: value.serviceTier ?? '',
    executionMode: value.executionMode ?? 'realtime',
    cacheMode: value.cacheMode ?? '',
    cacheTtl: value.cacheTtl ?? '',
    thinkingMode: value.thinkingMode ?? '',
    enabled: value.enabled !== false,
    evaluationToolsEnabled: evaluationTools !== undefined,
    evaluationTools: {
      ...defaultEvaluationToolOptions(),
      ...evaluationTools,
    },
    providerOptions:
      value.providerOptions === undefined ? '' : JSON.stringify(value.providerOptions, null, 2),
    pricing: pricingDraft(value.pricing),
  };
}
/** Switching an option profile clears only controls the new profile cannot represent. */
function supportedDraft(draft: ModelDraft, connection: Connection): ModelDraft {
  const family = effectiveModelFamily(connection.protocol, draft.modelId, draft.modelFamily);
  const keys = modelFamilyOptionKeys(connection.protocol, family);
  const defaults = initialModel();
  const next = { ...draft };
  for (const key of GENERATION_KEYS) {
    if (key === 'modelFamily' || key === 'maxOutputTokens' || !(key in next) || keys.includes(key))
      continue;
    Object.assign(next, { [key]: defaults[key as keyof ModelDraft] });
  }
  if (connection.protocol !== 'vercel-chat-v1') next.providerOptions = '';
  if (connection.protocol !== 'anthropic-messages-v1') next.executionMode = 'realtime';
  return next;
}
export function selectModelConnection(draft: ModelDraft, connection: Connection): ModelDraft {
  return supportedDraft(
    { ...draft, connectionRef: connection.id, modelId: '', modelFamily: '' },
    connection
  );
}
export function selectModelFamily(
  draft: ModelDraft,
  modelFamily: ModelFamily | '',
  connection: Connection
): ModelDraft {
  return supportedDraft({ ...draft, modelFamily }, connection);
}
export function modelPayload(draft: ModelDraft, connection: Connection) {
  const providerOptions =
    connection.protocol === 'vercel-chat-v1'
      ? parseProviderOptionsText(draft.providerOptions)
      : undefined;
  return {
    title: draft.title,
    connectionId: connection.id,
    modelId: draft.modelId,
    ...(draft.modelFamily ? { modelFamily: draft.modelFamily } : {}),
    maxOutputTokens: Number(draft.maxOutputTokens),
    ...(draft.inputTokenLimit !== '' ? { inputTokenLimit: Number(draft.inputTokenLimit) } : {}),
    ...(draft.tokenizer ? { tokenizer: draft.tokenizer } : {}),
    temperature: draft.temperature === '' ? null : Number(draft.temperature),
    enabled: draft.enabled,
    ...(draft.topP !== '' ? { topP: Number(draft.topP) } : {}),
    ...(draft.stopSequences.length ? { stopSequences: [...draft.stopSequences] } : {}),
    ...(Object.keys(draft.safetySettings).length
      ? { safetySettings: { ...draft.safetySettings } }
      : {}),
    ...(draft.thinkingLevel ? { thinkingLevel: draft.thinkingLevel } : {}),
    ...(draft.timeoutSeconds !== ''
      ? { timeoutMs: Math.round(Number(draft.timeoutSeconds) * 1000) }
      : {}),
    ...(draft.structuredOutput !== 'default'
      ? { structuredOutput: draft.structuredOutput === 'on' }
      : {}),
    ...(draft.reasoningEffort ? { reasoningEffort: draft.reasoningEffort } : {}),
    ...(draft.outputEffort ? { outputEffort: draft.outputEffort } : {}),
    ...(draft.verbosity ? { verbosity: draft.verbosity } : {}),
    ...(draft.reasoningMode ? { reasoningMode: draft.reasoningMode } : {}),
    ...(draft.reasoningContext ? { reasoningContext: draft.reasoningContext } : {}),
    ...(draft.serviceTier ? { serviceTier: draft.serviceTier } : {}),
    ...(connection.protocol === 'anthropic-messages-v1' && draft.executionMode === 'batch'
      ? { executionMode: 'batch' as const }
      : {}),
    ...(draft.cacheMode ? { cacheMode: draft.cacheMode } : {}),
    ...(draft.cacheTtl ? { cacheTtl: draft.cacheTtl } : {}),
    ...(draft.thinkingMode ? { thinkingMode: draft.thinkingMode } : {}),
    ...(draft.evaluationToolsEnabled
      ? {
          evaluationTools: structuredClone(draft.evaluationTools),
        }
      : {}),
    ...(providerOptions !== undefined ? { providerOptions } : {}),
    pricing: pricingPayload(draft.pricing),
  };
}

export function providerOptionsDraftError(draft: ModelDraft, connection: Connection): string {
  if (connection.protocol !== 'vercel-chat-v1') return '';
  try {
    parseProviderOptionsText(draft.providerOptions);
    return '';
  } catch (error) {
    switch (error instanceof ProviderOptionsError ? error.code : undefined) {
      case 'PROVIDER_OPTIONS_OBJECT':
      case 'PROVIDER_OPTIONS_JSON':
        return validationMessage('providers.m322');
      case 'PROVIDER_OPTIONS_TOO_LARGE':
        return validationMessage('providers.m575', {
          value0: formatNumber(PROVIDER_OPTIONS_MAX_CHARS),
        });
      case 'PROVIDER_OPTIONS_SENSITIVE_FIELD':
        return validationMessage('providers.m323');
      default:
        return validationMessage('providers.m324');
    }
  }
}
export function forcedServiceTierError(
  draft: ModelDraft,
  connection: Connection | undefined,
  forcedVertexTier?: VertexRequestTier
): string {
  return connection?.protocol === 'vertex-gemini-v1' &&
    forcedVertexTier &&
    draft.serviceTier &&
    draft.serviceTier !== forcedVertexTier
    ? validationMessage('providers.m576', {
        value0: forcedVertexTier === 'flex' ? 'Flex' : 'Standard',
      })
    : '';
}
export function modelDraftError(
  draft: ModelDraft,
  connection: Connection,
  forcedVertexTier?: VertexRequestTier
): string {
  const providerError = providerOptionsDraftError(draft, connection);
  if (providerError) return providerError;
  if (draft.tokenizer && !TOKENIZER_PROFILES.some((profile) => profile.id === draft.tokenizer))
    return validationMessage('providers.m325');
  try {
    validateModelPricing(pricingPayload(draft.pricing));
    if (!draft.maxOutputTokens.trim()) return validationMessage('providers.m326');
    if (draft.evaluationToolsEnabled) {
      validateEvaluationToolOptions(modelPayload(draft, connection).evaluationTools);
    }
    validateModelOptions(
      generationFromModel(modelPayload(draft, connection) as ModelPreset),
      connection.protocol
    );
    const tierError = forcedServiceTierError(draft, connection, forcedVertexTier);
    if (tierError) return tierError;
    if (
      draft.evaluationToolsEnabled &&
      draft.evaluationTools.contextMode === 'preloaded' &&
      modelCapability(connection.protocol, draft.modelId)?.forcedTools === false
    )
      return validationMessage('providers.m327');
    return '';
  } catch (error) {
    return validationMessage('providers.m577', {
      value0: error instanceof Error ? error.message : validationMessage('providers.m328'),
    });
  }
}
