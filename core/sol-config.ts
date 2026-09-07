/** Persisted Sol settings; this module is also used by the browser. */
export type SolOptions = {
  contextMode: 'model-selected' | 'preloaded';
  maximumToolRounds: number;
  terminalLateCorrections: boolean;
  serviceTier?: 'auto' | 'default' | 'flex' | 'priority';
  verbosity?: 'low' | 'medium' | 'high';
  reasoningSummary?: 'auto' | 'concise' | 'detailed';
  includeEncryptedReasoning?: boolean;
};

export const SOL_GATEWAYS = [
  { id: 'vercel', label: 'Vercel AI Gateway', endpoint: 'https://ai-gateway.vercel.sh/v1', credentialEnv: 'NARRATIVE_PROVIDER_VERCEL' },
  { id: 'llm-gateway', label: 'LLM Gateway', endpoint: 'https://api.llmgateway.io/v1', credentialEnv: 'NARRATIVE_PROVIDER_LLM_GATEWAY' },
  { id: 'openai', label: 'OpenAI Official', endpoint: 'https://api.openai.com/v1', credentialEnv: 'NARRATIVE_PROVIDER_OPENAI' },
] as const;

export function defaultSolOptions(): SolOptions {
  return { contextMode: 'model-selected', maximumToolRounds: 8, terminalLateCorrections: false, includeEncryptedReasoning: true };
}

export function validateSolOptions(value: unknown): SolOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_SOL_OPTIONS');
  const input = value as Record<string, unknown>;
  const keys = ['contextMode', 'maximumToolRounds', 'terminalLateCorrections', 'serviceTier', 'verbosity', 'reasoningSummary', 'includeEncryptedReasoning'];
  if (Object.keys(input).some(key => !keys.includes(key)) ||
    ['contextMode', 'maximumToolRounds', 'terminalLateCorrections'].some(key => !Object.hasOwn(input, key)) ||
    !['model-selected', 'preloaded'].includes(input.contextMode as string) ||
    !Number.isInteger(input.maximumToolRounds) || Number(input.maximumToolRounds) < 0 || Number(input.maximumToolRounds) > 32 ||
    typeof input.terminalLateCorrections !== 'boolean') throw new Error('INVALID_SOL_OPTIONS');
  const choices = { serviceTier: ['auto', 'default', 'flex', 'priority'], verbosity: ['low', 'medium', 'high'], reasoningSummary: ['auto', 'concise', 'detailed'] };
  for (const [key, values] of Object.entries(choices)) {
    if (Object.hasOwn(input, key) && (typeof input[key] !== 'string' || !values.includes(input[key]))) throw new Error('INVALID_SOL_OPTIONS');
  }
  if (Object.hasOwn(input, 'includeEncryptedReasoning') && typeof input.includeEncryptedReasoning !== 'boolean') throw new Error('INVALID_SOL_OPTIONS');
  return { ...input } as SolOptions;
}

export function validateSolEndpoint(value: string): string {
  if (typeof value !== 'string' || value.trim() !== value || value.includes('\\')) throw new Error('INVALID_SOL_ENDPOINT');
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('INVALID_SOL_ENDPOINT'); }
  if (url.username || url.password || url.search || url.hash || !/^\/v1\/?$/.test(url.pathname)) throw new Error('INVALID_SOL_ENDPOINT');
  const normalized = url.origin + '/v1';
  // Match the literal authority as well: URL parsing otherwise normalizes shorthand or integer IPv4.
  const local = /^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::[0-9]+)?\/v1\/?$/.test(value);
  if (!local && !SOL_GATEWAYS.some(gateway => gateway.endpoint === normalized && /^https:\/\/[^/]+\/v1\/?$/.test(value))) throw new Error('INVALID_SOL_ENDPOINT');
  return normalized;
}

export function solGatewayForEndpoint(value: string): typeof SOL_GATEWAYS[number]['id'] | 'local' {
  const endpoint = validateSolEndpoint(value);
  return SOL_GATEWAYS.find(gateway => gateway.endpoint === endpoint)?.id ?? 'local';
}
