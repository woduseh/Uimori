export const TOKENIZER_PROFILES = [
  { id: 'openai-o200k', kind: 'local' },
  { id: 'openai-cl100k', kind: 'local' },
  { id: 'gemini-gemma3', kind: 'local' },
  { id: 'gemini-gemma4', kind: 'local' },
  { id: 'deepseek-v3', kind: 'local' },
  { id: 'deepseek-v4', kind: 'local' },
  { id: 'deepseek-v4.1', kind: 'local' },
  { id: 'glm-4.7', kind: 'local' },
  { id: 'glm-5', kind: 'local' },
  { id: 'kimi-k2', kind: 'local' },
  { id: 'claude-legacy', kind: 'approximate' },
  { id: 'grok-estimate', kind: 'approximate' },
  { id: 'generic', kind: 'approximate' },
] as const;

export type TokenizerProfileId = (typeof TOKENIZER_PROFILES)[number]['id'];

export function isTokenizerProfileId(value: unknown): value is TokenizerProfileId {
  return TOKENIZER_PROFILES.some((profile) => profile.id === value);
}

export function resolveTokenizerProfile(model: {
  tokenizer?: TokenizerProfileId;
  modelId: string;
  connection?: { protocol: string };
}): TokenizerProfileId {
  if (model.tokenizer !== undefined) return model.tokenizer;
  let id = model.modelId.trim().toLowerCase().split('/').at(-1) ?? '';
  if (id.startsWith('ft:')) id = id.split(':')[1] ?? '';
  if (/^(?:gpt-4(?:o|\.1|\.5)|gpt-5|chatgpt-4o|o1|o3|o4-mini)(?:$|[.-])/u.test(id))
    return 'openai-o200k';
  if (/^(?:gpt-4|gpt-3\.5(?:-turbo)?|gpt-35-turbo)(?:$|-)/u.test(id)) return 'openai-cl100k';
  if (['gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemini-3.1-pro-preview'].includes(id))
    return 'gemini-gemma4';
  if (
    /^gemini-2\.(?:0|5)-(?:pro|flash(?:-lite)?)(?:$|-001$|-preview-[0-9]{2}-[0-9]{2}$)/u.test(id) ||
    ['gemini-3-pro-preview', 'gemini-3-flash-preview'].includes(id)
  )
    return 'gemini-gemma3';
  if (/^deepseek-v3\.2(?:$|-exp$)/u.test(id)) return 'deepseek-v3';
  if (id === 'deepseek-v4-pro') return 'deepseek-v4';
  if (['deepseek-v4.1-flash', 'deepseek-flash', 'deepseek-v4-flash'].includes(id))
    return 'deepseek-v4.1';
  if (/^glm-4\.[567]$/u.test(id)) return 'glm-4.7';
  if (/^glm-5(?:\.[12])?$/u.test(id) || id === 'glm-4.7-flash') return 'glm-5';
  if (/^kimi-k2(?:\.5)?(?:$|-instruct(?:-0905)?$)/u.test(id)) return 'kimi-k2';
  if (/^claude(?:$|-)/u.test(id)) return 'claude-legacy';
  if (/^grok(?:$|-)/u.test(id)) return 'grok-estimate';
  return 'generic';
}
