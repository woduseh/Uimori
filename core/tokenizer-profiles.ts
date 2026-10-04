/** Host-only choices. These never change the model or fields sent to a provider. */
export const TOKENIZER_PROFILES = [
  {
    id: 'openai-o200k',
    label: 'OpenAI · o200k_base',
    kind: 'local',
    description: 'GPT-4o·4.1·5 및 o 계열의 공개 인코딩',
  },
  {
    id: 'openai-cl100k',
    label: 'OpenAI · cl100k_base',
    kind: 'local',
    description: 'GPT-3.5·기존 GPT-4의 공개 인코딩',
  },
  {
    id: 'gemini-gemma3',
    label: 'Gemini · Gemma 3 토크나이저',
    kind: 'local',
    description: 'Google 로컬 SDK의 Gemini 2.x·초기 3 preview 계열',
  },
  {
    id: 'gemini-gemma4',
    label: 'Gemini · Gemma 4 토크나이저',
    kind: 'local',
    description: 'Google 로컬 SDK의 Gemini 3.1·3.5 지원 모델',
  },
  {
    id: 'deepseek-v3',
    label: 'DeepSeek · V3.2',
    kind: 'local',
    description: '공개 V3.2 토크나이저',
  },
  {
    id: 'deepseek-v4',
    label: 'DeepSeek · V4 Pro',
    kind: 'local',
    description: '공개 V4 Pro 토크나이저',
  },
  {
    id: 'deepseek-v4.1',
    label: 'DeepSeek · V4.1 Flash',
    kind: 'local',
    description: '공개 V4.1 Flash 토크나이저',
  },
  {
    id: 'glm-4.7',
    label: 'GLM · 4.5 / 4.6 / 4.7',
    kind: 'local',
    description: '동일한 공개 토크나이저를 사용하는 GLM 4.5·4.6·4.7',
  },
  {
    id: 'glm-5',
    label: 'GLM · 5 / 5.1 / 5.2',
    kind: 'local',
    description: '공개 GLM 5·5.1·5.2 및 4.7 Flash 토크나이저',
  },
  {
    id: 'kimi-k2',
    label: 'Kimi · K2 / K2.5',
    kind: 'local',
    description: '공개 Kimi K2·K2.5 인코딩',
  },
  {
    id: 'claude-legacy',
    label: 'Claude · 근사',
    kind: 'approximate',
    description: '공개 구형 토크나이저 기반. Claude 3 이후와 정확히 일치하지 않아요.',
  },
  {
    id: 'grok-estimate',
    label: 'Grok · 근사',
    kind: 'approximate',
    description: '최신 모델의 공개 로컬 인코딩이 없어 o200k_base로 추정해요.',
  },
  {
    id: 'generic',
    label: '일반 · 근사',
    kind: 'approximate',
    description: '지원하지 않는 모델은 o200k_base로 추정해요.',
  },
] as const;

export type TokenizerProfileId = (typeof TOKENIZER_PROFILES)[number]['id'];

export function isTokenizerProfileId(value: unknown): value is TokenizerProfileId {
  return TOKENIZER_PROFILES.some((profile) => profile.id === value);
}

/** Auto resolves metadata only: no vocabularies, imports, disk reads or network. */
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
