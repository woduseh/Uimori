import { readProviderHttpDiagnostic, type ProviderHttpDiagnostic } from './provider-http-error.js';
import { createHash } from 'node:crypto';
import { isVertexAdcReference } from './credential-reference.js';
import { providerFetchOptions, transportFailureCode } from './provider-fetch.js';
import { validateVertexEndpoint } from './product.js';
import { assertContextBudget } from './context-budget.js';
import { createPublicTextProgress } from './provider-progress.js';
import { vertexAccessToken } from './vertex-auth.js';
import {
  encodeVertex,
  diagnosticVertexBody,
  VertexDecoder,
  VertexProtocolError,
} from './vertex-protocol.js';
import { ProviderContractError } from './provider-errors.js';
import { validateConnection, validateRequest } from './provider-request.js';
import type {
  Json,
  ProviderConnection,
  ProviderExecutionOptions,
  ProviderResult,
} from './transport.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const emptyResult = (): ProviderResult => ({
  status: 'error',
  text: '',
  toolCalls: [],
  refusal: null,
  error: null,
  usage: { inputTokens: null, outputTokens: null, costUsd: null, raw: null, priceRevision: null },
  opaqueState: null,
});

function scrub(value: Json, token: string): Json {
  if (typeof value === 'string') return value.split(token).join('[REDACTED]');
  if (Array.isArray(value)) return value.map((item) => scrub(item, token));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /^(authorization|api[_-]?key|credential|secret|password|access[_-]?token)$/i.test(key)
          ? '[REDACTED]'
          : scrub(item, token),
      ])
    );
  return value;
}

/** Strict SSE framing: byte boundaries, CRLF, comments and multiline data are independent of JSON. */
export async function consumeSse(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onData: (value: unknown) => void | Promise<void>,
  signal: AbortSignal,
  allowDone = false
): Promise<void> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let data: string[] = [];
  let dataBytes = 0;
  let totalBytes = 0;
  const dispatch = async () => {
    if (!data.length) return;
    const payload = data.join('\n');
    data = [];
    dataBytes = 0;
    let value: unknown;
    try {
      value = allowDone && payload === '[DONE]' ? payload : JSON.parse(payload);
    } catch {
      throw new ProviderContractError('INVALID_EVENT');
    }
    await onData(value);
  };
  const line = async (raw: string) => {
    const value = raw.replace(/\r$/u, '');
    if (!value) await dispatch();
    else if (value.startsWith('data:')) {
      const part = value.slice(5).replace(/^ /u, '');
      data.push(part);
      dataBytes += part.length;
      if (dataBytes > 1_000_000) throw new ProviderContractError('EVENT_TOO_LARGE');
    }
  };
  // A response body may outlive fetch's abort propagation; close its pending read explicitly.
  const abortReader = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener('abort', abortReader, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) {
        try {
          buffer += decoder.decode();
        } catch {
          throw new ProviderContractError('INVALID_UTF8');
        }
        if (buffer.length) await line(buffer);
        await dispatch();
        return;
      }
      totalBytes += next.value.byteLength;
      if (totalBytes > 8_000_000) throw new ProviderContractError('RESPONSE_TOO_LARGE');
      try {
        buffer += decoder.decode(next.value, { stream: true });
      } catch {
        throw new ProviderContractError('INVALID_UTF8');
      }
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        await line(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
      if (buffer.length > 1_000_000) throw new ProviderContractError('EVENT_TOO_LARGE');
    }
  } finally {
    signal.removeEventListener('abort', abortReader);
  }
}

/** One Vertex model HTTP request. No SDK generation client, redirects or automatic retries. */
export async function executeVertexProvider(
  connectionValue: ProviderConnection,
  requestValue: unknown,
  options: ProviderExecutionOptions
): Promise<ProviderResult> {
  const timeoutMs = options.timeoutMs ?? 300_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1_800_000)
    throw new ProviderContractError('INVALID_TIMEOUT');
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([options.signal, timeout]);
  let decoder: VertexDecoder | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const failure = (code: string, diagnostic?: ProviderHttpDiagnostic) => {
    const result = decoder?.snapshot() ?? emptyResult();
    result.status = options.signal.aborted
      ? 'cancelled'
      : result.refusal
        ? 'refused'
        : result.text || result.toolCalls.length
          ? 'partial'
          : 'error';
    result.error = {
      code: options.signal.aborted ? 'CANCELLED' : timeout.aborted ? 'TIMEOUT' : code,
      ...(diagnostic ? { diagnostic } : {}),
    };
    return result;
  };
  try {
    const connection = validateConnection(connectionValue, options.approvedOrigins);
    const request = validateRequest(requestValue);
    const prepared = encodeVertex(request);
    const requestedTier = request.generation?.serviceTier;
    const tier = options.vertexRequestTier ?? requestedTier ?? 'standard';
    if (
      !['standard', 'flex'].includes(tier) ||
      (options.vertexRequestTier !== undefined &&
        requestedTier !== undefined &&
        options.vertexRequestTier !== requestedTier)
    )
      throw new ProviderContractError('INVALID_VERTEX_REQUEST_TIER');
    decoder = new VertexDecoder(prepared.context);
    if (signal.aborted) return failure('CANCELLED');
    assertContextBudget(prepared.body, request.contextBudget);
    // Google's well-known variable contains an ADC file path, never a bearer token.
    const token = isVertexAdcReference(connection.credentialEnv)
      ? await vertexAccessToken(signal)
      : await (options.resolveCredential ?? ((name) => process.env[name]))(
          connection.credentialEnv!,
          connection,
          signal
        );
    if (!token || /[\r\n]/u.test(token)) throw new ProviderContractError('CREDENTIAL_UNAVAILABLE');
    if (signal.aborted) return failure('CANCELLED');
    const endpoint = `${validateVertexEndpoint(connection.endpoint)}/${encodeURIComponent(request.modelId)}:streamGenerateContent?alt=sse`;
    const tierHeaders: Record<string, string> =
      tier === 'flex'
        ? {
            'x-vertex-ai-llm-request-type': 'shared',
            'x-vertex-ai-llm-shared-request-type': 'flex',
            'x-server-timeout': String(Math.ceil(timeoutMs / 1000)),
          }
        : {};
    const body = JSON.stringify(prepared.body);
    // The diagnostic view does not become the actual request. Signatures remain byte-for-byte in body.
    const diagnostic = scrub(diagnosticVertexBody(prepared.body), token);
    await options.onWire?.({
      connectionId: connection.id,
      protocol: connection.protocol,
      role: request.role,
      modelId: request.modelId,
      method: 'POST',
      url: endpoint,
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...tierHeaders,
        authorization: '[REDACTED]',
      },
      body: diagnostic,
      bodySha256: sha(body),
      stablePrefixSha256: sha(JSON.stringify(request.stable)),
    });
    // The persisted attempt completes before generation starts.
    if (signal.aborted) return failure('CANCELLED');
    const response = await fetch(
      endpoint,
      providerFetchOptions({
        method: 'POST',
        body,
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...tierHeaders,
          authorization: `Bearer ${token}`,
        },
        signal,
        redirect: 'error',
      })
    );
    if (!response.ok) {
      const diagnostic = await readProviderHttpDiagnostic(response, signal, token);
      return failure(`HTTP_${response.status}`, diagnostic);
    }
    if (
      !response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream') ||
      !response.body
    ) {
      await response.body?.cancel();
      return failure('INVALID_CONTENT_TYPE');
    }
    reader = response.body.getReader();
    const progress = createPublicTextProgress(request, connection.protocol, { ...options, signal });
    await consumeSse(
      reader,
      async (value) => {
        decoder!.accept(value);
        await progress(decoder!.publicText());
      },
      signal
    );
    if (signal.aborted) return failure('CANCELLED');
    const result = decoder.finish();
    const raw = result.usage.raw;
    if (
      tier === 'flex' &&
      ['completed', 'tool_calls'].includes(result.status) &&
      (!raw ||
        typeof raw !== 'object' ||
        Array.isArray(raw) ||
        raw.trafficType !== 'ON_DEMAND_FLEX')
    )
      return { ...result, status: 'error', error: { code: 'FLEX_NOT_CONFIRMED' } };
    return result;
  } catch (error) {
    return failure(
      error instanceof ProviderContractError || error instanceof VertexProtocolError
        ? error.code
        : transportFailureCode(error)
    );
  } finally {
    try {
      await reader?.cancel();
    } catch {
      /* A closed remote stream must not erase observed usage. */
    }
  }
}
