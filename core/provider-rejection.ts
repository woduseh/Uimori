import type { ProviderHttpDiagnostic } from './provider-http-error.js';

/** App-level option the provider rejected, derived from whitelisted wire field names only. */
export type RejectedOption =
  | 'thinking'
  | 'temperature'
  | 'topP'
  | 'maxOutputTokens'
  | 'stopSequences'
  | 'serviceTier'
  | 'cache'
  | 'structuredOutput'
  | 'verbosity'
  | 'reasoningMode'
  | 'reasoningContext'
  | 'model'
  | 'tools'
  | 'input';
export type ProviderRejection = {
  httpStatus: number;
  providerCode?: string;
  options: RejectedOption[];
};
const byField: Record<string, RejectedOption> = {
  effort: 'thinking',
  reasoning: 'thinking',
  reasoning_effort: 'thinking',
  thinking: 'thinking',
  type: 'thinking',
  budget_tokens: 'thinking',
  thinkingConfig: 'thinking',
  thinkingBudget: 'thinking',
  thinkingLevel: 'thinking',
  output_config: 'thinking',
  mode: 'reasoningMode',
  context: 'reasoningContext',
  verbosity: 'verbosity',
  temperature: 'temperature',
  top_p: 'topP',
  topP: 'topP',
  topK: 'topP',
  max_tokens: 'maxOutputTokens',
  max_output_tokens: 'maxOutputTokens',
  max_completion_tokens: 'maxOutputTokens',
  maxOutputTokens: 'maxOutputTokens',
  stop_sequences: 'stopSequences',
  stopSequences: 'stopSequences',
  stop: 'stopSequences',
  service_tier: 'serviceTier',
  cache_control: 'cache',
  cachedContent: 'cache',
  prompt_cache_options: 'cache',
  prompt_cache_breakpoint: 'cache',
  prompt_cache_retention: 'cache',
  ttl: 'cache',
  response_format: 'structuredOutput',
  json_schema: 'structuredOutput',
  schema: 'structuredOutput',
  responseMimeType: 'structuredOutput',
  responseSchema: 'structuredOutput',
  model: 'model',
  tools: 'tools',
  tool_choice: 'tools',
  parameters: 'tools',
};
const inputParts = new Set([
  'messages',
  'input',
  'instructions',
  'contents',
  'parts',
  'text',
  'role',
  'content',
  'systemInstruction',
  'generationConfig',
]);
/**
 * A cache container claims its whole path (`prompt_cache_options.mode` is cache, not reasoning);
 * otherwise the last recognised segment decides so `reasoning.mode` defers to its leaf.
 */
function optionOf(path: string): RejectedOption | undefined {
  const parts = path.replace(/\[\d+\]/gu, '').split('.');
  if (parts.some((part) => byField[part] === 'cache')) return 'cache';
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index];
    if (byField[part]) return byField[part];
    if (inputParts.has(part)) return 'input';
  }
  return undefined;
}
/** Only 4xx request rejections name options; server failures and rate limits are not option verdicts. */
export function providerRejection(
  diagnostic: ProviderHttpDiagnostic | undefined
): ProviderRejection | undefined {
  if (!diagnostic || diagnostic.httpStatus < 400 || diagnostic.httpStatus >= 500) return undefined;
  if ([401, 403, 429].includes(diagnostic.httpStatus)) return undefined;
  const options: RejectedOption[] = [];
  for (const field of diagnostic.fields ?? []) {
    const option = optionOf(field);
    if (option && !options.includes(option)) options.push(option);
  }
  return {
    httpStatus: diagnostic.httpStatus,
    ...(typeof diagnostic.providerCode === 'string'
      ? { providerCode: diagnostic.providerCode }
      : {}),
    options,
  };
}
