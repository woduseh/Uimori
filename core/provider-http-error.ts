/** HTTP error diagnostics deliberately exclude messages, echoed input and arbitrary metadata. */
export type ProviderHttpDiagnostic = {
  httpStatus: number;
  providerCode?: string | number;
  providerStatus?: string;
  requestId?: string;
  fields?: string[];
  bodyState: 'parsed' | 'invalid' | 'too-large' | 'empty' | 'unavailable';
};

export const PROVIDER_ERROR_BODY_LIMIT = 16_384;
const codes = new Set([
  'invalid_request_error',
  'invalid_request',
  'invalid_argument',
  'unsupported_parameter',
  'unsupported_value',
  'model_not_found',
  'context_length_exceeded',
  'rate_limit_exceeded',
  'insufficient_quota',
  'authentication_error',
  'permission_error',
  'not_found_error',
  'rate_limit_error',
  'api_error',
  'overloaded_error',
  'server_error',
  'invalid_api_key',
]);
const statuses = new Set([
  'INVALID_ARGUMENT',
  'UNAUTHENTICATED',
  'PERMISSION_DENIED',
  'NOT_FOUND',
  'RESOURCE_EXHAUSTED',
  'FAILED_PRECONDITION',
  'INTERNAL',
  'UNAVAILABLE',
  'DEADLINE_EXCEEDED',
  'CANCELLED',
  'OUT_OF_RANGE',
  'UNIMPLEMENTED',
  'UNKNOWN',
]);
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
    let root: Record<string, unknown> | undefined;
    try {
      root = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    } catch {
      diagnostic.bodyState = 'invalid';
      return diagnostic;
    }
    const error = object(root?.error);
    if (!error) {
      diagnostic.bodyState = 'invalid';
      return diagnostic;
    }
    diagnostic.bodyState = 'parsed';
    if (
      typeof error.code === 'number' &&
      Number.isInteger(error.code) &&
      error.code >= 100 &&
      error.code <= 599
    )
      diagnostic.providerCode = error.code;
    else if (typeof error.code === 'string' && codes.has(error.code) && safe(error.code))
      diagnostic.providerCode = error.code;
    else if (typeof error.type === 'string' && codes.has(error.type) && safe(error.type))
      diagnostic.providerCode = error.type;
    if (typeof error.status === 'string' && statuses.has(error.status) && safe(error.status))
      diagnostic.providerStatus = error.status;
    const fields: string[] = [];
    const addField = (value: unknown) => {
      if (fields.length >= 8 || typeof value !== 'string' || value.length > 128 || !safe(value))
        return;
      if (!/^[a-zA-Z_]+(?:\[\d{1,4}\])?(?:\.[a-zA-Z_]+(?:\[\d{1,4}\])?)*$/u.test(value)) return;
      if (
        value
          .replace(/\[\d+\]/gu, '')
          .split('.')
          .every((part) => fieldParts.has(part)) &&
        !fields.includes(value)
      )
        fields.push(value);
    };
    addField(error.param);
    // Messages are never stored; only a leading `path:` or a quoted identifier that is entirely
    // whitelisted field names is kept, so a provider that names the rejected field in prose still
    // yields a field.
    if (typeof error.message === 'string' && error.message.length <= 4000) {
      const leading = /^\s*([A-Za-z_][A-Za-z0-9_.[\]]{0,127})\s*:/u.exec(error.message);
      if (leading) addField(leading[1]);
      for (const quoted of error.message.matchAll(/['"`]([A-Za-z_][A-Za-z0-9_.[\]]{0,127})['"`]/gu))
        addField(quoted[1]);
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
