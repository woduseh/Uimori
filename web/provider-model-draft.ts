import type { Connection, ModelPreset, VertexRequestTier } from '../core/product.js';
import type { ModelPricing, TokenRates } from '../core/pricing-types.js';
import { validateModelPricing } from '../core/model-pricing.js';
import {
  generationFromModel,
  modelCapability,
  validateModelOptions,
} from '../core/model-capabilities.js';
import {
  defaultEvaluationToolOptions,
  validateEvaluationToolOptions,
  type EvaluationToolOptions,
} from '../core/evaluation-tool-config.js';

export type RateDraft = Record<keyof Required<TokenRates>, string>;
export type PricingDraft = {
  mode: 'official' | 'manual';
  rates: RateDraft;
  flexEnabled: boolean;
  flexRates: RateDraft;
};
export const emptyRateDraft = (): RateDraft => ({
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
  return {
    mode: pricing?.mode ?? 'official',
    rates: rateDraft(pricing?.mode === 'manual' ? pricing.rates : undefined),
    flexEnabled: pricing?.mode === 'manual' && pricing.flexRates !== undefined,
    flexRates: rateDraft(pricing?.mode === 'manual' ? pricing.flexRates : undefined),
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
      };
}

export type ModelDraft = {
  title: string;
  connectionRef: string;
  modelId: string;
  maxOutputTokens: string;
  inputTokenLimit: string;
  temperature: string;
  topP: string;
  stopSequences: string[];
  thinkingLevel: string;
  timeoutSeconds: string;
  structuredOutput: 'default' | 'on' | 'off';
  reasoningEffort: string;
  outputEffort: string;
  verbosity: string;
  reasoningMode: string;
  reasoningContext: string;
  serviceTier: string;
  cacheMode: string;
  cacheTtl: string;
  thinkingMode: string;
  enabled: boolean;
  evaluationToolsEnabled: boolean;
  evaluationTools: Omit<EvaluationToolOptions, 'maximumToolRounds'> & { maximumToolRounds: string };
  pricing: PricingDraft;
};
export const initialModel = (): ModelDraft => ({
  title: '',
  connectionRef: '',
  modelId: '',
  maxOutputTokens: '8192',
  inputTokenLimit: '',
  temperature: '',
  topP: '',
  stopSequences: [],
  thinkingLevel: '',
  timeoutSeconds: '300',
  structuredOutput: 'default',
  reasoningEffort: '',
  outputEffort: '',
  verbosity: '',
  reasoningMode: '',
  reasoningContext: '',
  serviceTier: '',
  cacheMode: '',
  cacheTtl: '',
  thinkingMode: '',
  enabled: true,
  evaluationToolsEnabled: false,
  evaluationTools: {
    ...defaultEvaluationToolOptions(),
    maximumToolRounds: String(defaultEvaluationToolOptions().maximumToolRounds),
  },
  pricing: pricingDraft(),
});
export function modelDraft(value: ModelPreset): ModelDraft {
  return {
    title: value.title,
    connectionRef: value.connectionId,
    modelId: value.modelId,
    maxOutputTokens: String(value.maxOutputTokens),
    inputTokenLimit: value.inputTokenLimit === undefined ? '' : String(value.inputTokenLimit),
    temperature: value.temperature === null ? '' : String(value.temperature),
    topP: value.topP === undefined ? '' : String(value.topP),
    stopSequences: [...(value.stopSequences ?? [])],
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
    cacheMode: value.cacheMode ?? '',
    cacheTtl: value.cacheTtl ?? '',
    thinkingMode: value.thinkingMode ?? '',
    enabled: value.enabled !== false,
    evaluationToolsEnabled: value.evaluationTools !== undefined,
    evaluationTools: {
      ...structuredClone(value.evaluationTools ?? defaultEvaluationToolOptions()),
      maximumToolRounds: String(
        (value.evaluationTools ?? defaultEvaluationToolOptions()).maximumToolRounds
      ),
    },
    pricing: pricingDraft(value.pricing),
  };
}
export function selectModelConnection(draft: ModelDraft, connection: Connection): ModelDraft {
  // Switching a connection does not silently rewrite the user's generation choices.
  return { ...draft, connectionRef: connection.id, modelId: '' };
}
export function modelPayload(draft: ModelDraft, connection: Connection) {
  return {
    title: draft.title,
    connectionId: connection.id,
    modelId: draft.modelId,
    maxOutputTokens: Number(draft.maxOutputTokens),
    ...(draft.inputTokenLimit !== '' ? { inputTokenLimit: Number(draft.inputTokenLimit) } : {}),
    temperature: draft.temperature === '' ? null : Number(draft.temperature),
    enabled: draft.enabled,
    ...(draft.topP !== '' ? { topP: Number(draft.topP) } : {}),
    ...(draft.stopSequences.length ? { stopSequences: [...draft.stopSequences] } : {}),
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
    ...(draft.cacheMode ? { cacheMode: draft.cacheMode } : {}),
    ...(draft.cacheTtl ? { cacheTtl: draft.cacheTtl } : {}),
    ...(draft.thinkingMode ? { thinkingMode: draft.thinkingMode } : {}),
    ...(draft.evaluationToolsEnabled
      ? {
          evaluationTools: {
            ...structuredClone(draft.evaluationTools),
            maximumToolRounds: Number(draft.evaluationTools.maximumToolRounds),
          },
        }
      : {}),
    pricing: pricingPayload(draft.pricing),
  };
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
    ? `서버에서 Service Tier를 ${forcedVertexTier === 'flex' ? 'Flex' : 'Standard'}로 제한해요. 모델 기본값이나 서버와 같은 값을 선택하세요.`
    : '';
}
export function modelDraftError(
  draft: ModelDraft,
  connection: Connection,
  forcedVertexTier?: VertexRequestTier
): string {
  try {
    validateModelPricing(pricingPayload(draft.pricing));
    if (!draft.maxOutputTokens.trim()) return '최대 출력 토큰을 입력해 주세요.';
    if (draft.evaluationToolsEnabled) {
      if (!draft.evaluationTools.maximumToolRounds.trim())
        return '최대 평가 도구 라운드를 입력해 주세요.';
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
      return '이 모델은 문맥을 먼저 제공하는 평가 방식을 지원하지 않아요. 고급에서 평가 문맥을 모델이 도구를 선택하는 방식으로 변경하세요.';
    return '';
  } catch (error) {
    return `생성 설정을 확인해 주세요. ${error instanceof Error ? error.message : '모델이 지원하지 않는 옵션이에요.'}`;
  }
}
