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
  usage: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null };
};
