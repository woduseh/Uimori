import { Agent } from 'undici';

// Node fetch otherwise inherits Undici's 300-second header/body idle limits.
// Only these admitted provider requests use this dispatcher. Their existing
// AbortSignal still owns the total deadline and caller cancellation.
const providerDispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

export function providerFetchOptions(
  init: RequestInit & { signal: AbortSignal }
): RequestInit & { dispatcher: Agent } {
  return { ...init, dispatcher: providerDispatcher };
}

const transportCodes = new Set([
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/** Never expose remote messages, URLs, headers, bodies, stacks or arbitrary codes. */
export function transportFailureCode(error: unknown): string {
  const seen = new Set<unknown>();
  let current = error;
  try {
    for (
      let depth = 0;
      depth < 6 && current && typeof current === 'object' && !seen.has(current);
      depth++
    ) {
      seen.add(current);
      const candidate = current as { code?: unknown; cause?: unknown };
      if (typeof candidate.code === 'string' && transportCodes.has(candidate.code))
        return candidate.code;
      current = candidate.cause;
    }
  } catch {
    /* Unknown error properties are untrusted diagnostics. */
  }
  return 'TRANSPORT_ERROR';
}
