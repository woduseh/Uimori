/** Local connection diagnostics are excluded from story JSON archives. */
export type ProviderConnectionTest = {
  id: string;
  modelId: string;
  modelRevision: number;
  providerModelId: string;
  connectionId: string;
  createdAt: string;
  finishedAt: string | null;
  status: 'running' | 'completed' | 'refused' | 'partial' | 'error' | 'cancelled' | 'interrupted';
  text: string;
  truncated: boolean;
  latencyMs: number | null;
  error: string | null;
  /** Present when the provider rejected the request; names the app options it pointed at. */
  rejection?: import('./provider-rejection.js').ProviderRejection;
  usage: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null };
};
