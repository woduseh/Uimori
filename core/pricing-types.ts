import type { ProviderProtocol } from './product.js';

/** USD per million tokens. Null means unknown or inapplicable, never free. */
export type TokenRates = {
  input: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  output: number | null;
  cacheWrite1h?: number | null;
};
export type ModelPricing =
  | { mode: 'official' }
  | { mode: 'manual'; rates: TokenRates; flexRates?: TokenRates };
/** Host-only, frozen when a model is reserved; never a provider request parameter. */
export type PricingSnapshot = {
  version: 1;
  protocol: ProviderProtocol;
  modelId: string;
  source: 'official' | 'manual' | 'catalog';
  sourceUrl?: string;
  checkedAt: string;
  serviceTier: string;
  rates: TokenRates;
  standardRates?: TokenRates;
  flexRates?: TokenRates;
  flexLongContext?: { aboveInputTokens: number; rates: TokenRates };
  longContext?: { aboveInputTokens: number; rates: TokenRates };
  schedule?: { peakRates: TokenRates; weekdays: number[]; utcHours: [number, number][] };
  cacheTtl?: string;
  notes: string[];
};
export type PricingLine = {
  kind: 'input' | 'cacheRead' | 'cacheWrite' | 'cacheWrite1h' | 'output';
  tokens: number | null;
  rate: number | null;
  usd: number | null;
};
export type CostEstimate = {
  status: 'estimated' | 'partial' | 'unavailable';
  usd: number | null;
  subtotalUsd: number;
  lines: PricingLine[];
  notes: string[];
};
