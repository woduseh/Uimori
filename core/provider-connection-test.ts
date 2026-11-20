export type ProviderConnectionTest = {
  id: string;
  modelId: string;
  modelRevision: number;
  providerModelId: string;
  connectionId: string;
  location?: string;
  createdAt: string;
  finishedAt: string | null;
  status: 'running' | 'completed' | 'refused' | 'partial' | 'error' | 'cancelled' | 'interrupted';
  text: string;
  truncated: boolean;
  latencyMs: number | null;
  error: string | null;
  rejection?: import('./provider-rejection.js').ProviderRejection;
  usage: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null };
  estimatedCost?: import('./pricing-types.js').CostEstimate;
};
