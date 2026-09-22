import type { ModelFamily, ModelGeneration, ProviderProtocol } from './product.js';

export const MODEL_FAMILY_CHOICES: readonly {
  id: ModelFamily;
  label: string;
  description: string;
}[] = [
  { id: 'openai', label: 'OpenAI · GPT', description: 'GPT 계열의 추론·출력 옵션을 사용해요.' },
  {
    id: 'anthropic',
    label: 'Anthropic · Claude',
    description: 'Claude 계열의 effort·thinking 옵션을 사용해요.',
  },
  {
    id: 'google',
    label: 'Google · Gemini',
    description: 'Gemini 계열의 thinking level 옵션을 사용해요.',
  },
  { id: 'deepseek', label: 'DeepSeek', description: 'DeepSeek 계열의 사고 강도 옵션을 사용해요.' },
  { id: 'xai', label: 'xAI · Grok', description: 'Grok 계열의 추론 옵션을 사용해요.' },
] as const;

type GenerationKey = keyof ModelGeneration;
export type ModelFamilyProfile = Readonly<{
  id: ModelFamily;
  label: string;
  optionKeys: readonly GenerationKey[];
  thinking?: {
    field: 'thinkingLevel' | 'reasoningEffort' | 'outputEffort';
    values: readonly string[];
  };
  thinkingModes?: readonly NonNullable<ModelGeneration['thinkingMode']>[];
}>;

const common = ['maxOutputTokens', 'temperature', 'structuredOutput', 'serviceTier'] as const;
const profiles: Record<ModelFamily, ModelFamilyProfile> = {
  openai: {
    id: 'openai',
    label: 'OpenAI · GPT',
    optionKeys: [
      ...common,
      'reasoningEffort',
      'verbosity',
      'reasoningMode',
      'reasoningContext',
      'topP',
      'stopSequences',
      'cacheMode',
      'cacheTtl',
    ],
    thinking: {
      field: 'reasoningEffort',
      values: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    },
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic · Claude',
    optionKeys: [
      ...common,
      'outputEffort',
      'thinkingMode',
      'topP',
      'stopSequences',
      'cacheMode',
      'cacheTtl',
    ],
    thinking: { field: 'outputEffort', values: ['low', 'medium', 'high', 'xhigh', 'max'] },
    thinkingModes: ['disabled', 'adaptive'],
  },
  google: {
    id: 'google',
    label: 'Google · Gemini',
    optionKeys: [...common, 'thinkingLevel', 'topP', 'stopSequences'],
    thinking: { field: 'thinkingLevel', values: ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'] },
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    optionKeys: [...common, 'reasoningEffort', 'topP', 'stopSequences'],
    thinking: {
      field: 'reasoningEffort',
      values: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    },
  },
  xai: {
    id: 'xai',
    label: 'xAI · Grok',
    optionKeys: [...common, 'reasoningEffort', 'topP', 'stopSequences'],
    thinking: { field: 'reasoningEffort', values: ['low', 'medium', 'high'] },
  },
};

export function modelFamilyProfile(family: ModelFamily): ModelFamilyProfile {
  return profiles[family];
}

export function defaultModelFamily(protocol: ProviderProtocol): ModelFamily | undefined {
  switch (protocol) {
    case 'openai-responses-v1':
    case 'openai-chat-v1':
    case 'codex-app-server-v1':
      return 'openai';
    case 'anthropic-messages-v1':
      return 'anthropic';
    case 'vertex-gemini-v1':
      return 'google';
    case 'deepseek-chat-v1':
      return 'deepseek';
    default:
      return undefined;
  }
}

export function inferModelFamily(
  protocol: ProviderProtocol,
  modelId: string
): ModelFamily | undefined {
  const direct = defaultModelFamily(protocol);
  if (protocol !== 'vercel-chat-v1') return direct;
  const creator = modelId.trim().toLowerCase().split('/', 1)[0];
  if (creator === 'openai') return 'openai';
  if (creator === 'anthropic') return 'anthropic';
  if (creator === 'google' || creator === 'google-vertex') return 'google';
  if (creator === 'deepseek') return 'deepseek';
  if (creator === 'xai' || creator === 'spacexai') return 'xai';
  return undefined;
}

export function effectiveModelFamily(
  protocol: ProviderProtocol,
  modelId: string,
  selected?: ModelFamily | ''
): ModelFamily | undefined {
  return selected || inferModelFamily(protocol, modelId) || defaultModelFamily(protocol);
}
