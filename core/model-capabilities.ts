import type { ModelGeneration, ProviderProtocol } from './product.js';
import { GEMINI_SAFETY_CATEGORIES, GEMINI_SAFETY_THRESHOLDS } from './gemini-safety.js';
import { providerDefinition } from './provider-definitions.js';
import { ProviderContractError } from './provider-errors.js';
import { MODEL_FAMILIES } from './product.js';

export const GENERATION_KEYS = [
  'modelFamily',
  'maxOutputTokens',
  'temperature',
  'thinkingLevel',
  'structuredOutput',
  'reasoningEffort',
  'outputEffort',
  'thinkingMode',
  'verbosity',
  'reasoningMode',
  'reasoningContext',
  'topP',
  'stopSequences',
  'safetySettings',
  'serviceTier',
  'cacheMode',
  'cacheTtl',
] as const;
export type ModelCapability = Readonly<{
  id: string;
  name: string;
  protocol: ProviderProtocol;
  preview?: boolean;
  releasedAt?: string;
  forcedTools?: boolean;
  maxOutputTokens: number;
  temperature: boolean;
  topP: boolean;
  stopSequences: boolean;
  thinkingLevels?: readonly NonNullable<ModelGeneration['thinkingLevel']>[];
  reasoningEfforts?: readonly NonNullable<ModelGeneration['reasoningEffort']>[];
  outputEfforts?: readonly NonNullable<ModelGeneration['outputEffort']>[];
  thinkingModes?: readonly NonNullable<ModelGeneration['thinkingMode']>[];
  verbosities?: readonly NonNullable<ModelGeneration['verbosity']>[];
  reasoningModes?: readonly NonNullable<ModelGeneration['reasoningMode']>[];
  reasoningContexts?: readonly NonNullable<ModelGeneration['reasoningContext']>[];
  serviceTiers?: readonly string[];
  cacheModes?: readonly NonNullable<ModelGeneration['cacheMode']>[];
  cacheTtls?: readonly NonNullable<ModelGeneration['cacheTtl']>[];
  defaultThinkingLevel?: string;
  defaultReasoningEffort?: string;
  defaultOutputEffort?: string;
  sources: readonly string[];
}>;
const openai = (id: string, name: string, rejectsNone = false): ModelCapability => ({
  id,
  name,
  protocol: 'openai-responses-v1',
  maxOutputTokens: 128_000,
  temperature: false,
  topP: false,
  stopSequences: false,
  reasoningEfforts: rejectsNone
    ? ['low', 'medium', 'high', 'xhigh', 'max']
    : ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  defaultReasoningEffort: 'medium',
  verbosities: ['low', 'medium', 'high'],
  reasoningModes: ['standard', 'pro'],
  reasoningContexts: ['auto', 'all_turns', 'current_turn'],
  serviceTiers: ['auto', 'default', 'flex', 'priority'],
  cacheModes: ['disabled', 'explicit', 'automatic'],
  cacheTtls: ['30m'],
  sources: [
    `https://developers.openai.com/api/docs/models/${id}`,
    'https://developers.openai.com/api/docs/guides/reasoning',
  ],
});
const capabilities: readonly ModelCapability[] = [
  {
    id: 'spacexai/grok-4.6',
    name: 'Grok 4.6',
    protocol: 'vercel-chat-v1',
    maxOutputTokens: 500_000,
    temperature: true,
    topP: false,
    stopSequences: false,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    defaultReasoningEffort: 'high',
    sources: ['https://vercel.com/ai-gateway/models/grok-4.6'],
  },
  {
    id: 'openai/gpt-5.6-sol',
    name: 'GPT-5.6 Sol',
    protocol: 'vercel-chat-v1',
    maxOutputTokens: 128_000,
    temperature: false,
    topP: false,
    stopSequences: false,
    reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh'],
    defaultReasoningEffort: 'medium',
    serviceTiers: ['default', 'flex'],
    sources: [
      'https://vercel.com/ai-gateway/models/gpt-5.6-sol',
      'https://vercel.com/docs/ai-gateway/models-and-providers/service-tiers',
    ],
  },
  ...(
    [
      // https://api-docs.deepseek.com/quick_start/pricing/ (2026-11-25): DeepSeek V4.1 Flash is
      // served under the model ID deepseek-flash; no deepseek-v4.1-flash ID is documented.
      ['deepseek-flash', 'DeepSeek V4.1 Flash'],
      ['deepseek-v4-pro', 'DeepSeek V4 Pro'],
    ] as const
  ).map(
    ([id, name]): ModelCapability => ({
      id,
      name,
      protocol: 'deepseek-chat-v1',
      maxOutputTokens: 384_000,
      temperature: true,
      topP: false,
      stopSequences: false,
      reasoningEfforts: ['none', 'low', 'high', 'max'],
      defaultReasoningEffort: 'high',
      sources: [
        'https://api-docs.deepseek.com/quick_start/pricing/',
        'https://api-docs.deepseek.com/guides/thinking_mode/',
        'https://api-docs.deepseek.com/api/create-chat-completion/',
      ],
    })
  ),
  {
    id: 'gemini-4-hydrogen',
    name: 'Gemini 4 Hydrogen',
    protocol: 'vertex-gemini-v1',
    maxOutputTokens: 65_536,
    temperature: false,
    topP: false,
    // https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-4-hydrogen (2026-11-25):
    // the guide documents neither stop sequences nor service tiers.
    stopSequences: false,
    thinkingLevels: ['LOW', 'MEDIUM', 'HIGH', 'XHIGH'],
    defaultThinkingLevel: 'HIGH',
    sources: [
      'https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-4-hydrogen',
      'https://aistudio.google.com/docs/models/gemini-4-hydrogen',
    ],
  },
  {
    id: 'gemini-4-neon',
    name: 'Gemini 4 Neon',
    protocol: 'vertex-gemini-v1',
    maxOutputTokens: 65_536,
    temperature: false,
    topP: false,
    // https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-4-neon (2026-11-20):
    // the guide does not document stop sequences.
    stopSequences: false,
    thinkingLevels: ['LOW', 'MEDIUM', 'HIGH', 'XHIGH'],
    defaultThinkingLevel: 'HIGH',
    serviceTiers: ['standard', 'flex'],
    sources: [
      'https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-4-neon',
      'https://aistudio.google.com/docs/models/gemini-4-neon',
    ],
  },
  {
    id: 'gemini-4-carbon',
    name: 'Gemini 4 Carbon',
    protocol: 'vertex-gemini-v1',
    maxOutputTokens: 65_536,
    temperature: false,
    topP: false,
    // https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-4-carbon (2026-11-20):
    // the guide documents neither stop sequences nor service tiers.
    stopSequences: false,
    thinkingLevels: ['LOW', 'MEDIUM', 'HIGH'],
    defaultThinkingLevel: 'MEDIUM',
    sources: [
      'https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-4-carbon',
      'https://aistudio.google.com/docs/whats-new-gemini-4-carbon',
      'https://aistudio.google.com/docs/models/gemini-4-carbon',
    ],
  },
  openai('gpt-5.6-sol', 'GPT-5.6 Sol'),
  openai('gpt-6-astra', 'GPT-6 Astra', true),
  ...(['astra', 'sol'] as const).map(
    (variant): ModelCapability => ({
      id: `gpt-6.2-${variant}`,
      name: `GPT-6.2 ${variant === 'astra' ? 'Astra' : 'Sol'}`,
      protocol: 'openai-responses-v1',
      maxOutputTokens: 128_000,
      temperature: false,
      topP: false,
      stopSequences: false,
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      cacheModes: ['disabled', 'explicit', 'automatic'],
      cacheTtls: ['30m'],
      sources: [
        `https://developers.openai.com/api/docs/models/gpt-6.2-${variant}`,
        'https://developers.openai.com/api/docs/guides/latest-model',
        'https://developers.openai.com/api/docs/guides/reasoning',
        'https://developers.openai.com/api/docs/guides/prompt-caching',
      ],
    })
  ),
  {
    id: 'claude-fable-5-2',
    name: 'Claude Fable 5.2',
    releasedAt: '2026-11-09',
    protocol: 'anthropic-messages-v1',
    maxOutputTokens: 128_000,
    temperature: false,
    topP: false,
    stopSequences: true,
    outputEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultOutputEffort: 'high',
    thinkingModes: ['adaptive'],
    serviceTiers: ['auto', 'standard_only'],
    cacheModes: ['disabled', 'explicit', 'automatic'],
    cacheTtls: ['5m', '1h'],
    forcedTools: false,
    sources: [
      'https://platform.claude.com/docs/en/models/fable-5-2/overview',
      'https://platform.claude.com/docs/en/models/fable-5-2/whats-new-fable-5-2',
      'https://platform.claude.com/docs/en/models/fable-5-2/migration-guide',
    ],
  },
  {
    id: 'claude-opus-5-5',
    name: 'Claude Opus 5.5',
    releasedAt: '2026-09-22',
    protocol: 'anthropic-messages-v1',
    maxOutputTokens: 128_000,
    temperature: false,
    topP: false,
    stopSequences: true,
    outputEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultOutputEffort: 'medium',
    thinkingModes: ['adaptive'],
    serviceTiers: ['auto', 'standard_only'],
    cacheModes: ['disabled', 'explicit', 'automatic'],
    cacheTtls: ['5m', '1h'],
    forcedTools: false,
    sources: [
      'https://platform.claude.com/docs/en/models/opus-5-5/overview',
      'https://platform.claude.com/docs/en/models/opus-5-5/whats-new-opus-5-5',
    ],
  },
];
const geminiMidConversationSystemRule = {
  modelId: /(?:^|\/)gemini-[^/]+$/iu,
  reviewedAt: '2026-11-20',
  sources: [
    'https://aistudio.google.com/api-reference/generate-content',
    'https://docs.cloud.google.com/vertex-ai/generative-ai/docs/model-reference/inference',
  ],
} as const;
export function acceptsMidConversationSystem(modelId: string): boolean {
  return !geminiMidConversationSystemRule.modelId.test(modelId);
}
export function supportedModels(protocol: ProviderProtocol): readonly ModelCapability[] {
  if (protocol === 'google-gemini-v1')
    return capabilities
      .filter((item) => item.protocol === 'vertex-gemini-v1')
      .map((item) => ({ ...item, protocol, serviceTiers: ['standard', 'flex', 'priority'] }));
  if (protocol === 'openai-chat-v1')
    return capabilities
      .filter((item) => item.protocol === 'openai-responses-v1')
      .map((item) => ({
        ...item,
        protocol,
        reasoningModes: undefined,
        reasoningContexts: undefined,
        verbosities: undefined,
        cacheModes: undefined,
        cacheTtls: undefined,
      }));
  return capabilities.filter((item) => item.protocol === protocol);
}
export function modelCapability(
  protocol: ProviderProtocol,
  modelId: string
): ModelCapability | undefined {
  return supportedModels(protocol).find((item) => item.id === modelId);
}
export function generationFromModel(model: ModelGeneration): ModelGeneration {
  return structuredClone(
    Object.fromEntries(
      GENERATION_KEYS.filter((key) => model[key] !== undefined).map((key) => [key, model[key]])
    )
  ) as ModelGeneration;
}
export function helperGenerationFromModel(
  model: ModelGeneration & { modelId: string },
  protocol: ProviderProtocol
): ModelGeneration {
  const generation = generationFromModel(model);
  return generation.cacheMode === undefined &&
    protocol === 'anthropic-messages-v1' &&
    modelCapability(protocol, model.modelId)?.cacheModes?.includes('automatic')
    ? { ...generation, cacheMode: 'automatic' }
    : generation;
}
const reject = (code = 'UNSUPPORTED_GENERATION_OPTIONS'): never => {
  throw new ProviderContractError(code);
};
export const PROTOCOL_OPTION_VALUES = {
  thinkingLevel: ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH', 'XHIGH'],
  reasoningEffort: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  outputEffort: ['low', 'medium', 'high', 'xhigh', 'max'],
  thinkingMode: ['disabled', 'adaptive'],
  verbosity: ['low', 'medium', 'high'],
  reasoningMode: ['standard', 'pro'],
  reasoningContext: ['auto', 'all_turns', 'current_turn'],
  cacheMode: ['disabled', 'explicit', 'automatic'],
} as const;
const cacheTtls: Partial<
  Record<ProviderProtocol, readonly NonNullable<ModelGeneration['cacheTtl']>[]>
> = {
  'openai-responses-v1': ['30m'],
  'anthropic-messages-v1': ['5m', '1h'],
};
export function protocolOptionKeys(protocol: ProviderProtocol): readonly string[] {
  return providerDefinition(protocol).optionKeys.filter((key) => key !== 'timeoutMs');
}
export function protocolCacheTtls(
  protocol: ProviderProtocol
): readonly NonNullable<ModelGeneration['cacheTtl']>[] | undefined {
  return cacheTtls[protocol];
}
export function protocolServiceTiers(protocol: ProviderProtocol): readonly string[] | undefined {
  return protocol === 'vertex-gemini-v1'
    ? ['standard', 'flex']
    : protocol === 'google-gemini-v1'
      ? ['standard', 'flex', 'priority']
      : protocol === 'anthropic-messages-v1'
        ? ['auto', 'standard_only']
        : ['openai-responses-v1', 'openai-chat-v1', 'vercel-chat-v1', 'deepseek-chat-v1'].includes(
              protocol
            )
          ? ['auto', 'default', 'flex', 'priority']
          : undefined;
}

export function validateGenerationShape(value: unknown): asserts value is ModelGeneration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject();
  const g = value as ModelGeneration;
  if (
    Object.keys(g).some((key) => !GENERATION_KEYS.includes(key as (typeof GENERATION_KEYS)[number]))
  )
    reject();
  if (g.modelFamily !== undefined && !MODEL_FAMILIES.includes(g.modelFamily)) reject();
  if (
    !Number.isSafeInteger(g.maxOutputTokens) ||
    g.maxOutputTokens < 1 ||
    g.maxOutputTokens > 500_000
  )
    reject();
  if (
    g.temperature !== null &&
    (typeof g.temperature !== 'number' ||
      !Number.isFinite(g.temperature) ||
      g.temperature < 0 ||
      g.temperature > 2)
  )
    reject();
  if (g.structuredOutput !== undefined && typeof g.structuredOutput !== 'boolean') reject();
  const enums = { ...PROTOCOL_OPTION_VALUES, cacheTtl: ['5m', '30m', '1h'] } as const;
  for (const [key, values] of Object.entries(enums))
    if (
      g[key as keyof ModelGeneration] !== undefined &&
      !(values as readonly unknown[]).includes(g[key as keyof ModelGeneration])
    )
      reject();
  if (
    g.topP !== undefined &&
    (typeof g.topP !== 'number' || !Number.isFinite(g.topP) || g.topP < 0 || g.topP > 1)
  )
    reject();
  if (
    g.stopSequences !== undefined &&
    (!Array.isArray(g.stopSequences) ||
      g.stopSequences.length > 4 ||
      g.stopSequences.some(
        (item) => typeof item !== 'string' || !item.length || item.length > 1000
      ))
  )
    reject();
  if (g.safetySettings !== undefined) {
    const settings = g.safetySettings;
    if (
      settings === null ||
      typeof settings !== 'object' ||
      Array.isArray(settings) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(settings)) ||
      Object.entries(settings).some(
        ([category, threshold]) =>
          !GEMINI_SAFETY_CATEGORIES.includes(
            category as (typeof GEMINI_SAFETY_CATEGORIES)[number]
          ) ||
          !GEMINI_SAFETY_THRESHOLDS.includes(threshold as (typeof GEMINI_SAFETY_THRESHOLDS)[number])
      )
    )
      reject();
  }
  if (
    g.serviceTier !== undefined &&
    (typeof g.serviceTier !== 'string' || !g.serviceTier.length || g.serviceTier.length > 40)
  )
    reject();
}
export function validateModelOptions(g: ModelGeneration, protocol: ProviderProtocol): void {
  validateGenerationShape(g);
  if (
    protocol === 'google-gemini-v1' &&
    g.serviceTier !== undefined &&
    !['standard', 'flex', 'priority'].includes(g.serviceTier)
  )
    reject();
  const keys = protocolOptionKeys(protocol);
  for (const key of Object.keys(g)) {
    if (key === 'modelFamily' || key === 'maxOutputTokens' || key === 'temperature') continue;
    if (!keys.includes(key)) reject();
  }
  if (g.temperature !== null && !keys.includes('temperature')) reject();
  if (g.cacheTtl !== undefined) {
    if (!['explicit', 'automatic'].includes(g.cacheMode ?? ''))
      reject('CACHE_TTL_REQUIRES_CACHE_MODE');
    if (!cacheTtls[protocol]?.includes(g.cacheTtl)) reject();
  }
}
