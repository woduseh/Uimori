import {
  MODEL_FAMILIES,
  type ModelFamily,
  type ModelGeneration,
  type ProviderProtocol,
} from './product.js';
import { providerDefinition } from './provider-definitions.js';

type GenerationKey = keyof ModelGeneration;
export type ModelFamilyProfile = Readonly<{
  label: string;
  optionKeys: readonly GenerationKey[];
}>;

const common = ['maxOutputTokens', 'temperature', 'structuredOutput', 'serviceTier'] as const;
const profiles: Record<ModelFamily, ModelFamilyProfile> = {
  openai: {
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
  },
  anthropic: {
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
  },
  google: {
    label: 'Google · Gemini',
    optionKeys: [...common, 'thinkingLevel', 'topP', 'stopSequences'],
  },
  deepseek: {
    label: 'DeepSeek',
    optionKeys: [...common, 'reasoningEffort', 'topP', 'stopSequences'],
  },
  xai: {
    label: 'xAI · Grok',
    optionKeys: [...common, 'reasoningEffort', 'topP', 'stopSequences'],
  },
};

export const MODEL_FAMILY_CHOICES = MODEL_FAMILIES.map((id) => ({ id, label: profiles[id].label }));

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
  return selected || inferModelFamily(protocol, modelId);
}

/** UI choices, not an API allowlist. Direct adapters keep their actual wire vocabulary. */
export function modelFamilyOptionKeys(
  protocol: ProviderProtocol,
  family?: ModelFamily
): readonly string[] {
  const keys = providerDefinition(protocol).optionKeys;
  if (protocol !== 'vercel-chat-v1') return keys;
  return family
    ? keys.filter((key) => profiles[family].optionKeys.includes(key as GenerationKey))
    : keys.filter(
        (key) => !['outputEffort', 'thinkingMode', 'thinkingLevel', 'verbosity'].includes(key)
      );
}
