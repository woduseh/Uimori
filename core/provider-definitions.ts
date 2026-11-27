import { JEV_PROVIDER_DEFINITION } from './jev-provider.js';
import type { ProviderProtocol } from './product.js';

export type ProviderDefinition = Readonly<{
  id: ProviderProtocol;
  revision: 1;
  endpointDefault: string;
  credentialRefDefault: string;
  auth: 'none' | 'bearer' | 'api-key' | 'adc-or-bearer' | 'codex-login';
  catalog: 'remote' | 'agent-runtime';
  optionKeys: readonly string[];
  source: Readonly<{ kind: 'adapter'; reference: string; checkedAt: '2026-09-07' | '2026-10-08' }>;
  modelCapabilities: Readonly<{ tools: null; structuredOutput: null }>;
  price: 'unknown';
}>;

type DefinitionInput = Pick<
  ProviderDefinition,
  'id' | 'endpointDefault' | 'credentialRefDefault' | 'auth' | 'catalog' | 'optionKeys'
> & { reference: string; checkedAt?: ProviderDefinition['source']['checkedAt'] };
function definition({
  reference,
  checkedAt = '2026-09-07',
  ...input
}: DefinitionInput): ProviderDefinition {
  return Object.freeze({
    ...input,
    revision: 1,
    optionKeys: Object.freeze([...input.optionKeys]),
    source: Object.freeze({ kind: 'adapter', reference, checkedAt }),
    modelCapabilities: Object.freeze({ tools: null, structuredOutput: null }),
    price: 'unknown',
  });
}
const responsesOptions = [
  'maxOutputTokens',
  'temperature',
  'timeoutMs',
  'structuredOutput',
  'reasoningEffort',
];

export const PROVIDER_DEFINITIONS: readonly ProviderDefinition[] = Object.freeze([
  definition({
    id: 'codex-app-server-v1',
    endpointDefault: 'codex://local',
    credentialRefDefault: '',
    auth: 'codex-login',
    catalog: 'agent-runtime',
    optionKeys: ['maxOutputTokens', 'timeoutMs', 'reasoningEffort'],
    reference: 'core/codex-protocol.ts#buildCodexTurn',
  }),
  definition({
    id: 'fixture-sse-v1',
    endpointDefault: '',
    credentialRefDefault: '',
    auth: 'none',
    catalog: 'remote',
    optionKeys: ['maxOutputTokens', 'temperature', 'timeoutMs', 'thinkingLevel'],
    reference: 'core/transport.ts#executeProvider',
  }),
  definition({
    id: 'vertex-gemini-v1',
    endpointDefault: '',
    credentialRefDefault: '',
    auth: 'adc-or-bearer',
    catalog: 'remote',
    optionKeys: [
      'maxOutputTokens',
      'temperature',
      'timeoutMs',
      'thinkingLevel',
      'topP',
      'stopSequences',
      'safetySettings',
      'serviceTier',
    ],
    reference: 'core/vertex.ts#executeGeminiProvider',
  }),
  definition({
    id: 'google-gemini-v1',
    checkedAt: '2026-10-08',
    endpointDefault: 'https://generativelanguage.googleapis.com/v1beta',
    credentialRefDefault: 'GEMINI_API_KEY',
    auth: 'api-key',
    catalog: 'remote',
    optionKeys: [
      'maxOutputTokens',
      'temperature',
      'timeoutMs',
      'thinkingLevel',
      'topP',
      'stopSequences',
      'safetySettings',
      'serviceTier',
    ],
    reference: 'core/vertex.ts#executeGeminiProvider',
  }),
  definition({
    id: 'openai-responses-v1',
    endpointDefault: 'https://api.openai.com/v1',
    credentialRefDefault: 'OPENAI_API_KEY',
    auth: 'bearer',
    catalog: 'remote',
    optionKeys: [
      ...responsesOptions,
      'verbosity',
      'reasoningMode',
      'reasoningContext',
      'serviceTier',
      'cacheMode',
      'cacheTtl',
    ],
    reference: 'core/openai-protocol.ts#encodeResponses',
  }),
  definition({
    id: 'anthropic-messages-v1',
    endpointDefault: 'https://api.anthropic.com/v1',
    credentialRefDefault: 'ANTHROPIC_API_KEY',
    auth: 'api-key',
    catalog: 'remote',
    optionKeys: [
      'maxOutputTokens',
      'timeoutMs',
      'structuredOutput',
      'outputEffort',
      'thinkingMode',
      'stopSequences',
      'serviceTier',
      'cacheMode',
      'cacheTtl',
    ],
    reference: 'core/anthropic-protocol.ts#encodeAnthropic',
  }),
  definition({
    id: 'vercel-chat-v1',
    endpointDefault: 'https://ai-gateway.vercel.sh/v1',
    credentialRefDefault: 'VERCEL_API_KEY',
    auth: 'bearer',
    catalog: 'remote',
    optionKeys: [
      ...responsesOptions,
      'serviceTier',
      'topP',
      'stopSequences',
      'outputEffort',
      'thinkingMode',
      'thinkingLevel',
      'verbosity',
    ],
    reference: 'core/openai-chat-protocol.ts#encodeChat',
  }),
  definition({
    id: 'deepseek-chat-v1',
    endpointDefault: 'https://api.deepseek.com/v1',
    credentialRefDefault: 'DEEPSEEK_API_KEY',
    auth: 'bearer',
    catalog: 'remote',
    optionKeys: [
      'maxOutputTokens',
      'temperature',
      'timeoutMs',
      'reasoningEffort',
      'stopSequences',
      'serviceTier',
    ],
    reference: 'core/openai-chat-protocol.ts#encodeChat',
  }),
  definition({
    id: 'openai-chat-v1',
    endpointDefault: '',
    credentialRefDefault: 'PROVIDER_API_KEY',
    auth: 'bearer',
    catalog: 'remote',
    optionKeys: [...responsesOptions, 'serviceTier'],
    reference: 'core/openai-chat-protocol.ts#encodeChat',
  }),
]);

export function providerDefinition(protocol: ProviderProtocol): ProviderDefinition {
  const found = PROVIDER_DEFINITIONS.find((item) => item.id === protocol);
  if (!found) throw new Error('UNSUPPORTED_PROTOCOL');
  return found;
}

export const PROVIDER_CHOICES = Object.freeze([
  ...PROVIDER_DEFINITIONS.map((provider) => ({ ...provider, kind: 'generation' as const })),
  JEV_PROVIDER_DEFINITION,
]);
