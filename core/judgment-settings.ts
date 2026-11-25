import type { Connection } from './product.js';
import type { ModelPricing, PricingSnapshot, TokenRates } from './pricing-types.js';

export const OFFICIAL_JUDGMENT_MODELS = {
  openai: 'gpt-6-luna',
  gemini: 'gemini-decision-1',
} as const;

export type ExternalJudgmentProvider =
  | keyof typeof OFFICIAL_JUDGMENT_MODELS
  | 'openai-compatible'
  | 'typesafe-compatible';
export type JudgmentProvider = 'typesafe' | ExternalJudgmentProvider;

export type JudgmentPricing = Extract<ModelPricing, { mode: 'manual' }>;

export type JudgmentSelection =
  | { provider: 'typesafe'; pricing?: JudgmentPricing }
  | {
      provider: ExternalJudgmentProvider;
      connectionId: string;
      modelId: string;
      images: boolean;
      pricing?: JudgmentPricing;
    };

export const DEFAULT_JUDGMENT_SELECTION: Readonly<
  Extract<JudgmentSelection, { provider: 'typesafe' }>
> = { provider: 'typesafe' };
export const TYPESAFE_JUDGMENT_MODEL = 'jev-latest';

export const JUDGMENT_PROTOCOLS = [
  'typesafe-systemone-v1',
  'typesafe-compatible-systemone-v1',
  'openai-decisions-v1',
  'openai-compatible-decisions-v1',
  'gemini-decisions-v1',
] as const;
export type JudgmentProtocol = (typeof JUDGMENT_PROTOCOLS)[number];

export function judgmentProtocol(provider: JudgmentProvider): JudgmentProtocol {
  return provider === 'typesafe'
    ? 'typesafe-systemone-v1'
    : provider === 'typesafe-compatible'
      ? 'typesafe-compatible-systemone-v1'
      : provider === 'openai'
        ? 'openai-decisions-v1'
        : provider === 'gemini'
          ? 'gemini-decisions-v1'
          : 'openai-compatible-decisions-v1';
}

export function judgmentPricingRates(provider: JudgmentProvider): (keyof TokenRates)[] {
  return provider === 'openai' || provider === 'openai-compatible'
    ? ['input', 'cacheRead', 'output']
    : ['input', 'output'];
}

export function judgmentPricingSnapshot(
  selection: JudgmentSelection,
  now = new Date().toISOString()
): PricingSnapshot | undefined {
  const pricing = selection.pricing;
  if (!pricing) return undefined;
  return {
    version: 1,
    protocol: judgmentProtocol(selection.provider),
    modelId: selection.provider === 'typesafe' ? TYPESAFE_JUDGMENT_MODEL : selection.modelId,
    source: 'manual',
    checkedAt: pricing.checkedAt ?? now,
    ...(pricing.sourceUrl ? { sourceUrl: pricing.sourceUrl } : {}),
    serviceTier: 'default',
    rates: pricing.rates,
    notes: [],
  };
}

export function isJudgmentConnection(
  provider: ExternalJudgmentProvider,
  connection: Pick<Connection, 'enabled' | 'protocol' | 'endpoint'>
): boolean {
  if (!connection.enabled) return false;
  const endpoint = connection.endpoint.replace(/\/+$/u, '');
  const openAIProtocol =
    connection.protocol === 'openai-responses-v1' || connection.protocol === 'openai-chat-v1';
  if (provider === 'openai') return openAIProtocol && endpoint === 'https://api.openai.com/v1';
  if (provider === 'gemini')
    return (
      connection.protocol === 'google-gemini-v1' &&
      endpoint === 'https://generativelanguage.googleapis.com/v1beta'
    );
  return openAIProtocol || connection.protocol === 'vercel-chat-v1';
}
