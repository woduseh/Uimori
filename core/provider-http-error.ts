/** Owner-facing diagnostics may contain echoed input. Shared reports must project safe fields only. */
export type ProviderHttpDiagnostic = {
  httpStatus: number;
  providerCode?: string | number;
  providerStatus?: string;
  requestId?: string;
  fields?: string[];
  message?: string;
  bodyState: 'parsed' | 'invalid' | 'too-large' | 'empty' | 'unavailable';
};

export const PROVIDER_ERROR_BODY_LIMIT = 16_384;
export const PROVIDER_ERROR_MESSAGE_LIMIT = 4000;
const diagnosticIdentifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/u.test(value);
const withoutControlCharacters = (value: string) =>
  [...value]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
    })
    .join('');
// Exact request credentials are removed before truncation so a cut cannot expose a key prefix.
function diagnosticMessage(value: unknown, secret?: string): string | undefined {
  if (typeof value !== 'string') return undefined;
  const redacted = withoutControlCharacters(
    (secret ? value.replaceAll(secret, '[REDACTED]') : value).replace(
      /\b(Bearer|Basic)\s+[^\s"'<>]+/giu,
      '$1 [REDACTED]'
    )
  ).trim();
  if (!redacted) return undefined;
  return redacted.length > PROVIDER_ERROR_MESSAGE_LIMIT
    ? redacted.slice(0, PROVIDER_ERROR_MESSAGE_LIMIT - 1) + '…'
    : redacted;
}
const fieldParts = new Set([
  'model',
  'messages',
  'role',
  'content',
  'input',
  'instructions',
  'contents',
  'parts',
  'text',
  'systemInstruction',
  'generationConfig',
  'responseMimeType',
  'responseSchema',
  'response_format',
  'json_schema',
  'schema',
  'tools',
  'tool_choice',
  'parameters',
  'temperature',
  'top_p',
  'topP',
  'topK',
  'max_tokens',
  'max_output_tokens',
  'max_completion_tokens',
  'maxOutputTokens',
  'thinkingConfig',
  'thinkingBudget',
  'thinkingLevel',
  'thinking',
  'type',
  'budget_tokens',
  'reasoning',
  'reasoning_effort',
  'effort',
  'mode',
  'context',
  'output_config',
  'verbosity',
  'stop_sequences',
  'stopSequences',
  'stop',
  'service_tier',
  'cache_control',
  'cachedContent',
  'prompt_cache_options',
  'prompt_cache_breakpoint',
  'prompt_cache_retention',
  'ttl',
]);
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** A bounded read participates in the same request timeout and cancellation as fetch. */
export async function readProviderHttpDiagnostic(
  response: Response,
  signal: AbortSignal,
  secret?: string
): Promise<ProviderHttpDiagnostic> {
  const diagnostic: ProviderHttpDiagnostic = { httpStatus: response.status, bodyState: 'empty' };
  const safe = (value: string) => !secret || !value.includes(secret);
  for (const header of ['x-request-id', 'request-id', 'x-goog-request-id']) {
    const value = response.headers.get(header);
    if (value && /^[a-zA-Z0-9_-]{1,128}$/u.test(value) && safe(value)) {
      diagnostic.requestId = value;
      break;
    }
  }
  if (!response.body) return diagnostic;
  const reader = response.body.getReader();
  const abortReader = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener('abort', abortReader, { once: true });
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > PROVIDER_ERROR_BODY_LIMIT) {
        diagnostic.bodyState = 'too-large';
        return diagnostic;
      }
      chunks.push(next.value);
    }
    if (!size) return diagnostic;
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let decoded: string;
    try {
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      diagnostic.bodyState = 'invalid';
      return diagnostic;
    }
    let root: Record<string, unknown> | undefined;
    try {
      root = object(JSON.parse(decoded));
    } catch {
      diagnostic.bodyState = 'invalid';
      const message = diagnosticMessage(decoded, secret);
      if (message) diagnostic.message = message;
      return diagnostic;
    }
    const error = object(root?.error);
    if (!error) {
      diagnostic.bodyState = 'invalid';
      const message = diagnosticMessage(root?.message ?? root?.error, secret);
      if (message) diagnostic.message = message;
      return diagnostic;
    }
    diagnostic.bodyState = 'parsed';
    const message = diagnosticMessage(error.message, secret);
    if (message) diagnostic.message = message;
    if (
      typeof error.code === 'number' &&
      Number.isInteger(error.code) &&
      error.code >= 100 &&
      error.code <= 599
    )
      diagnostic.providerCode = error.code;
    else if (diagnosticIdentifier(error.code) && safe(error.code))
      diagnostic.providerCode = error.code;
    else if (diagnosticIdentifier(error.type) && safe(error.type))
      diagnostic.providerCode = error.type;
    if (diagnosticIdentifier(error.status) && safe(error.status))
      diagnostic.providerStatus = error.status;
    const fields: string[] = [];
    const addField = (value: unknown) => {
      if (fields.length >= 8 || typeof value !== 'string' || value.length > 128 || !safe(value))
        return;
      if (
        !/^[A-Za-z_][A-Za-z0-9_-]*(?:\[\d{1,4}\])?(?:\.[A-Za-z_][A-Za-z0-9_-]*(?:\[\d{1,4}\])?)*$/u.test(
          value
        )
      )
        return;
      if (!fields.includes(value)) fields.push(value);
    };
    addField(error.param);
    // Explicit field paths may be new provider options. In prose, only known paths are
    // inferred: quoted allowed values such as 'low' must not be mistaken for field names.
    const inferField = (value: string) => {
      if (
        value
          .replace(/\[\d+\]/gu, '')
          .split('.')
          .every((part) => fieldParts.has(part))
      )
        addField(value);
    };
    if (typeof error.message === 'string' && error.message.length <= 4000) {
      const leading = /^\s*([A-Za-z_][A-Za-z0-9_.[\]]{0,127})\s*:/u.exec(error.message);
      if (leading) inferField(leading[1]);
      for (const quoted of error.message.matchAll(/['"`]([A-Za-z_][A-Za-z0-9_.[\]]{0,127})['"`]/gu))
        inferField(quoted[1]);
    }
    if (Array.isArray(error.details))
      for (const detail of error.details.slice(0, 8)) {
        const violations = object(detail)?.fieldViolations;
        if (Array.isArray(violations))
          for (const violation of violations.slice(0, 8)) addField(object(violation)?.field);
      }
    if (fields.length) diagnostic.fields = fields;
    return diagnostic;
  } catch (error) {
    if (signal.aborted) throw error;
    diagnostic.bodyState = 'unavailable';
    return diagnostic;
  } finally {
    signal.removeEventListener('abort', abortReader);
    // Never wait indefinitely for a remote source's cancellation acknowledgement.
    void reader.cancel().catch(() => undefined);
  }
}
