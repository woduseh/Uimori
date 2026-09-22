import type { Connection, ModelFamily, ProviderProtocol } from './product.js';
import { effectiveModelFamily, modelFamilyProfile } from './model-family.js';
import {
  modelCapability,
  PROTOCOL_OPTION_VALUES,
  protocolOptionKeys,
  type ModelCapability,
} from './model-capabilities.js';

export type ThinkingField = 'thinkingLevel' | 'reasoningEffort' | 'outputEffort';
/** Where the shown option values and limits come from. Never an execution condition. */
export type HintSource = 'catalog' | 'reviewed' | 'none';
export type ModelHints = {
  source: HintSource;
  capability?: ModelCapability;
  maxOutputTokens?: number;
  inputTokenLimit?: number;
  /**
   * The protocol's thinking-strength field, the request field it is written to, and documented
   * values when a source names them. Through a gateway the request field is the gateway's; the
   * gateway maps it onto the model provider's own parameter.
   */
  thinking?: {
    field: ThinkingField;
    wire: string;
    gateway: boolean;
    known?: readonly string[];
    all: readonly string[];
  };
  thinkingModes?: { known?: readonly string[]; all: readonly string[] };
  family?: ModelFamily;
};
export function thinkingField(protocol: ProviderProtocol): ThinkingField | undefined {
  if (protocol === 'vercel-chat-v1') return 'reasoningEffort';
  const keys = protocolOptionKeys(protocol);
  return keys.includes('thinkingLevel')
    ? 'thinkingLevel'
    : keys.includes('outputEffort')
      ? 'outputEffort'
      : keys.includes('reasoningEffort')
        ? 'reasoningEffort'
        : undefined;
}
/** The request field each protocol's encoder writes the thinking strength into. */
export function thinkingWireField(protocol: ProviderProtocol): string | undefined {
  switch (protocol) {
    case 'openai-responses-v1':
      return 'reasoning.effort';
    case 'openai-chat-v1':
    case 'vercel-chat-v1':
      return 'reasoning_effort';
    case 'deepseek-chat-v1':
      return 'thinking.type · reasoning_effort';
    case 'anthropic-messages-v1':
      return 'output_config.effort';
    case 'vertex-gemini-v1':
      return 'generationConfig.thinkingConfig.thinkingLevel';
    case 'codex-app-server-v1':
      return 'effort';
    case 'fixture-sse-v1':
      return 'thinkingLevel';
    default:
      return undefined;
  }
}
/** Provider list metadata first, the reviewed table second, protocol vocabulary always. */
export function modelHints(
  connection: Pick<Connection, 'protocol' | 'catalog'>,
  modelId: string,
  selectedFamily?: ModelFamily | ''
): ModelHints {
  const family = effectiveModelFamily(connection.protocol, modelId, selectedFamily);
  const profile = family ? modelFamilyProfile(family) : undefined;
  const capability = modelCapability(connection.protocol, modelId);
  const listed = connection.catalog.find((item) => item.id === modelId);
  const fromList = listed?.limits !== undefined || listed?.options !== undefined;
  const protocolField = thinkingField(connection.protocol);
  const field =
    connection.protocol === 'vercel-chat-v1'
      ? ((['thinkingLevel', 'outputEffort', 'reasoningEffort'] as const).find((key) =>
          profile?.optionKeys.includes(key)
        ) ?? protocolField)
      : protocolField;
  const reviewedThinking =
    field === 'thinkingLevel'
      ? capability?.thinkingLevels
      : field === 'outputEffort'
        ? capability?.outputEfforts
        : capability?.reasoningEfforts;
  const maxOutputTokens = listed?.limits?.maxOutputTokens ?? capability?.maxOutputTokens;
  return {
    source: fromList ? 'catalog' : capability ? 'reviewed' : 'none',
    ...(capability ? { capability } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(listed?.limits?.inputTokenLimit !== undefined
      ? { inputTokenLimit: listed.limits.inputTokenLimit }
      : {}),
    ...(field
      ? {
          thinking: {
            field,
            wire:
              connection.protocol === 'vercel-chat-v1'
                ? family === 'anthropic'
                  ? 'providerOptions.anthropic.effort'
                  : family === 'google'
                    ? 'providerOptions.google.thinkingConfig.thinkingLevel'
                    : 'reasoning_effort'
                : (thinkingWireField(connection.protocol) ?? field),
            gateway: ['vercel-chat-v1', 'openai-chat-v1'].includes(connection.protocol),
            // A family template is not evidence that a particular model supports every value.
            // Gateway catalog effort describes its common Chat field, not a native family field.
            known:
              (field === protocolField ? listed?.options?.thinking : undefined) ?? reviewedThinking,
            all: PROTOCOL_OPTION_VALUES[field],
          },
        }
      : {}),
    ...(protocolOptionKeys(connection.protocol).includes('thinkingMode') &&
    (connection.protocol !== 'vercel-chat-v1' || profile?.optionKeys.includes('thinkingMode'))
      ? {
          thinkingModes: {
            known:
              connection.protocol === 'vercel-chat-v1'
                ? capability?.thinkingModes
                : (listed?.options?.thinkingModes ?? capability?.thinkingModes),
            all: PROTOCOL_OPTION_VALUES.thinkingMode,
          },
        }
      : {}),
    ...(family ? { family } : {}),
  };
}
