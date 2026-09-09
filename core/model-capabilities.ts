import type { ModelGeneration, ProviderProtocol } from './product.js';
import { providerDefinition } from './provider-definitions.js';
import { ProviderContractError } from './provider-errors.js';

/** Operating guideline for reviewing the hint table; it never blocks execution. */
export const MODEL_SUPPORT_POLICY = {
  supportWindowMonths: 6,
  checkedAt: '2026-09-09',
  exceptions: [
    {
      id: 'gemini-3.1-pro-preview',
      reason: 'User-selected baseline model',
      releasedAt: '2026-02-19',
    },
  ],
} as const;
export const GENERATION_KEYS = [
  'maxOutputTokens',
  'temperature',
  'thinkingLevel',
  'structuredOutput',
  'reasoningEffort',
  'outputEffort',
  'thinkingMode',
  'thinkingBudgetTokens',
  'verbosity',
  'reasoningMode',
  'reasoningContext',
  'topP',
  'stopSequences',
  'serviceTier',
  'cacheMode',
  'cacheTtl',
] as const;
/**
 * Reviewed per-model hints: which options a known model documents and their allowed values.
 * The UI uses them to order choices and prefill limits. Execution never requires an entry;
 * the provider's own response is the verdict for unknown models and unlisted values.
 */
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
  midSystem?: boolean;
  sources: readonly string[];
}>;
const openai = (id: string, name: string, astra = false): ModelCapability => ({
  id,
  name,
  protocol: 'openai-responses-v1',
  maxOutputTokens: 128_000,
  temperature: false,
  topP: false,
  stopSequences: false,
  reasoningEfforts: astra
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
    id: 'gemini-3.5-flash-lite',
    name: 'Gemini 3.5 Flash-Lite',
    releasedAt: '2026-07-21',
    protocol: 'vertex-gemini-v1',
    maxOutputTokens: 65_536,
    temperature: false,
    topP: false,
    stopSequences: true,
    thinkingLevels: ['MINIMAL', 'MEDIUM', 'HIGH'],
    defaultThinkingLevel: 'MINIMAL',
    serviceTiers: ['standard', 'flex'],
    sources: [
      'https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-5-flash-lite',
    ],
  },
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
  ...(['pro', 'flash'] as const).map(
    (variant): ModelCapability => ({
      id: `deepseek-v4-${variant}`,
      name: `DeepSeek V4 ${variant === 'pro' ? 'Pro' : 'Flash'}`,
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
    id: 'gemini-3.8-flash',
    name: 'Gemini 3.8 Flash',
    protocol: 'vertex-gemini-v1',
    maxOutputTokens: 65_536,
    temperature: false,
    topP: false,
    stopSequences: true,
    thinkingLevels: ['LOW', 'MEDIUM', 'HIGH'],
    defaultThinkingLevel: 'MEDIUM',
    serviceTiers: ['standard', 'flex'],
    sources: [
      'https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-3-8-flash',
    ],
  },
  {
    id: 'gemini-3.1-pro-preview',
    name: 'Gemini 3.1 Pro (Preview)',
    preview: true,
    protocol: 'vertex-gemini-v1',
    maxOutputTokens: 65_536,
    temperature: true,
    topP: true,
    stopSequences: true,
    thinkingLevels: ['LOW', 'MEDIUM', 'HIGH'],
    defaultThinkingLevel: 'HIGH',
    serviceTiers: ['standard', 'flex'],
    sources: [
      'https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-1-pro',
    ],
  },
  ...[
    openai('gpt-5.6-sol', 'GPT-5.6 Sol'),
    openai('gpt-5.6-terra', 'GPT-5.6 Terra'),
    openai('gpt-5.6-luna', 'GPT-5.6 Luna'),
    openai('gpt-5.6', 'GPT-5.6 (Sol alias)'),
    openai('gpt-6-astra', 'GPT-6 Astra', true),
  ],
  {
    id: 'claude-fable-5-1',
    name: 'Claude Fable 5.1',
    releasedAt: '2026-09-01',
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
    midSystem: true,
    forcedTools: false,
    sources: [
      'https://platform.claude.com/docs/en/models/fable-5-1/overview',
      'https://platform.claude.com/docs/en/models/fable-5-1/whats-new-fable-5-1',
    ],
  },
  {
    id: 'claude-opus-5',
    name: 'Claude Opus 5',
    protocol: 'anthropic-messages-v1',
    maxOutputTokens: 128_000,
    temperature: false,
    topP: false,
    stopSequences: true,
    outputEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultOutputEffort: 'high',
    thinkingModes: ['adaptive', 'disabled'],
    serviceTiers: ['auto', 'standard_only'],
    cacheModes: ['disabled', 'explicit', 'automatic'],
    cacheTtls: ['5m', '1h'],
    midSystem: true,
    sources: [
      'https://platform.claude.com/docs/en/models/opus-5/whats-new-opus-5',
      'https://platform.claude.com/docs/en/api/http/messages/create',
    ],
  },
];
export function supportedModels(protocol: ProviderProtocol): readonly ModelCapability[] {
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
const reject = (code = 'UNSUPPORTED_GENERATION_OPTIONS'): never => {
  throw new ProviderContractError(code);
};
/** Values each protocol's encoder can express. A model may reject a value; the provider says so. */
export const PROTOCOL_OPTION_VALUES = {
  thinkingLevel: ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'],
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
/** Generation option keys the protocol's encoder sends. Everything else cannot reach the provider. */
export function protocolOptionKeys(protocol: ProviderProtocol): readonly string[] {
  return providerDefinition(protocol).optionKeys.filter((key) => key !== 'timeoutMs');
}
/** Cache retention values the protocol's API accepts. */
export function protocolCacheTtls(
  protocol: ProviderProtocol
): readonly NonNullable<ModelGeneration['cacheTtl']>[] | undefined {
  return cacheTtls[protocol];
}
/** Service tiers to suggest; Gemini's two tiers are enforced by its transport, the rest are provider strings. */
export function protocolServiceTiers(protocol: ProviderProtocol): readonly string[] | undefined {
  return protocol === 'vertex-gemini-v1'
    ? ['standard', 'flex']
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
    g.thinkingBudgetTokens !== undefined &&
    (!Number.isSafeInteger(g.thinkingBudgetTokens) ||
      g.thinkingBudgetTokens < 1024 ||
      g.thinkingBudgetTokens >= g.maxOutputTokens)
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
  if (
    g.serviceTier !== undefined &&
    (typeof g.serviceTier !== 'string' || !g.serviceTier.length || g.serviceTier.length > 40)
  )
    reject();
}
/**
 * Protocol-level validation only: the option must be one the encoder sends and the value one it
 * can express. Model-specific support is not checked here; an unsupported combination is answered
 * by the provider and surfaced as a rejected option.
 */
export function validateModelOptions(g: ModelGeneration, protocol: ProviderProtocol): void {
  validateGenerationShape(g);
  const keys = protocolOptionKeys(protocol);
  for (const key of Object.keys(g))
    if (key !== 'maxOutputTokens' && key !== 'temperature' && !keys.includes(key)) reject();
  if (g.temperature !== null && !keys.includes('temperature')) reject();
  if (g.cacheTtl !== undefined) {
    if (!['explicit', 'automatic'].includes(g.cacheMode ?? ''))
      reject('CACHE_TTL_REQUIRES_CACHE_MODE');
    if (!cacheTtls[protocol]?.includes(g.cacheTtl)) reject();
  }
}
