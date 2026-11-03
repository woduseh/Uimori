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

export class ProviderBodyLimitError extends Error {}

/** Read a provider body without depending on fetch forwarding abort after headers. */
export async function readProviderBody(
  response: Response,
  signal: AbortSignal,
  maximum = Infinity
): Promise<Buffer> {
  if (signal.aborted) {
    // fetch can resolve with a body after the request was already cancelled.
    void response.body?.cancel(signal.reason).catch(() => undefined);
    signal.throwIfAborted();
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const abortReader = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener('abort', abortReader, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) return Buffer.concat(chunks, size);
      size += part.value.byteLength;
      if (size > maximum) throw new ProviderBodyLimitError();
      chunks.push(part.value);
    }
  } finally {
    signal.removeEventListener('abort', abortReader);
    // Do not wait for a stalled source to acknowledge cancellation.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
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
