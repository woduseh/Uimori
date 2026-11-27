import type { ProviderProtocol } from './product.js';

export type TokenRates = {
  input: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  output: number | null;
  cacheWrite1h?: number | null;
};
export type ContextRates = { aboveInputTokens: number; rates: TokenRates };
export type ModelPricing =
  | { mode: 'official' }
  | {
      mode: 'manual';
      rates: TokenRates;
      flexRates?: TokenRates;
      batchRates?: TokenRates;
      longContext?: ContextRates;
      flexLongContext?: ContextRates;
      batchLongContext?: ContextRates;
      sourceUrl?: string;
      checkedAt?: string;
    };
export type PricingSnapshot = {
  version: 1;
  protocol: ProviderProtocol | import('./judgment-settings.js').JudgmentProtocol;
  modelId: string;
  source: 'official' | 'manual' | 'catalog';
  sourceUrl?: string;
  checkedAt: string;
  serviceTier: string;
  rates: TokenRates;
  standardRates?: TokenRates;
  standardLongContext?: ContextRates;
  flexRates?: TokenRates;
  flexLongContext?: { aboveInputTokens: number; rates: TokenRates };
  longContext?: { aboveInputTokens: number; rates: TokenRates };
  cacheTtl?: string;
  notes: string[];
};
export type { CostEstimate, PricingLine } from '#contracts';
