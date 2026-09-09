import type { Connection, ProviderProtocol } from './product.js';
import { PROTOCOL_OPTION_VALUES } from './model-capabilities.js';

type CatalogEntry = Connection['catalog'][number];
type Metadata = Pick<CatalogEntry, 'capabilities' | 'limits' | 'options'>;
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const supported = (value: unknown): boolean | null =>
  typeof object(value)?.supported === 'boolean' ? (object(value)!.supported as boolean) : null;
const limit = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 100_000_000
    ? value
    : undefined;
const values = (raw: unknown, vocabulary: readonly string[]): string[] | undefined => {
  if (!Array.isArray(raw)) return undefined;
  const found = raw.filter(
    (item): item is string => typeof item === 'string' && vocabulary.includes(item)
  );
  return found.length ? [...new Set(found)] : undefined;
};

/**
 * Metadata a provider's list API publishes about one model. Only limits and option values in
 * this protocol's vocabulary are kept; the rest of the entry stays with the provider.
 */
export function catalogEntryMetadata(
  protocol: ProviderProtocol,
  raw: Record<string, unknown>
): Metadata {
  const none: Metadata = { capabilities: { tools: null, structuredOutput: null } };
  if (protocol === 'anthropic-messages-v1') {
    const capabilities = object(raw.capabilities);
    const effort = object(capabilities?.effort);
    const thinking =
      supported(effort) === true
        ? PROTOCOL_OPTION_VALUES.outputEffort.filter((level) => supported(effort?.[level]) === true)
        : [];
    const thinkingModes =
      supported(object(object(capabilities?.thinking)?.types)?.adaptive) === true
        ? ['adaptive']
        : [];
    const limits = {
      ...(limit(raw.max_tokens) ? { maxOutputTokens: limit(raw.max_tokens) } : {}),
      ...(limit(raw.max_input_tokens) ? { inputTokenLimit: limit(raw.max_input_tokens) } : {}),
    };
    return {
      capabilities: { tools: null, structuredOutput: supported(capabilities?.structured_outputs) },
      ...(Object.keys(limits).length ? { limits } : {}),
      ...(thinking.length || thinkingModes.length
        ? {
            options: {
              ...(thinking.length ? { thinking } : {}),
              ...(thinkingModes.length ? { thinkingModes } : {}),
            },
          }
        : {}),
    };
  }
  if (protocol === 'vercel-chat-v1') {
    const tags = Array.isArray(raw.tags) ? raw.tags : [];
    const effort = Array.isArray(raw.reasoning_options)
      ? raw.reasoning_options.map(object).find((entry) => entry?.type === 'effort')
      : undefined;
    const thinking = values(effort?.values, PROTOCOL_OPTION_VALUES.reasoningEffort);
    const limits = {
      ...(limit(raw.max_tokens) ? { maxOutputTokens: limit(raw.max_tokens) } : {}),
      ...(limit(raw.context_window) ? { inputTokenLimit: limit(raw.context_window) } : {}),
    };
    return {
      capabilities: { tools: tags.includes('tool-use') ? true : null, structuredOutput: null },
      ...(Object.keys(limits).length ? { limits } : {}),
      ...(thinking ? { options: { thinking } } : {}),
    };
  }
  return none;
}

/**
 * One Gemini Developer API `models.list` entry as a catalog row. Only Gemini generation models
 * are kept; the `models/` prefix is dropped so the ID matches Agent Platform's model ID.
 */
export function geminiListEntry(raw: Record<string, unknown>): CatalogEntry | undefined {
  const name = typeof raw.name === 'string' ? raw.name : '';
  const methods = Array.isArray(raw.supportedGenerationMethods)
    ? raw.supportedGenerationMethods
    : [];
  if (!name.startsWith('models/gemini') || !methods.includes('generateContent')) return undefined;
  const id = name.slice('models/'.length);
  if (!id || id.length > 300) return undefined;
  const displayName = typeof raw.displayName === 'string' && raw.displayName ? raw.displayName : id;
  const limits = {
    ...(limit(raw.outputTokenLimit) ? { maxOutputTokens: limit(raw.outputTokenLimit) } : {}),
    ...(limit(raw.inputTokenLimit) ? { inputTokenLimit: limit(raw.inputTokenLimit) } : {}),
  };
  return {
    id,
    name: displayName.slice(0, 400),
    capabilities: { tools: null, structuredOutput: null },
    priceRevision: null,
    ...(Object.keys(limits).length ? { limits } : {}),
  };
}
