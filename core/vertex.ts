import { redactDiagnosticJson } from './provider-diagnostic-json.js';
import { readProviderHttpDiagnostic, type ProviderHttpDiagnostic } from './provider-http-error.js';
import { createHash } from 'node:crypto';
import { isVertexAdcReference } from './credential-reference.js';
import { providerFetchOptions, transportFailureCode } from './provider-fetch.js';
import { isGeminiProtocol, validateProviderEndpoint, validateVertexEndpoint } from './product.js';
import { assertContextBudget, estimateContextTokens } from './context-budget.js';
import { tokenizerInfo } from './text-tokens.js';
import { createPublicTextProgress, publicProgressAllowed } from './provider-progress.js';
import { vertexAccessToken } from './vertex-auth.js';
import {
  encodeVertex,
  diagnosticVertexBody,
  VertexDecoder,
  VertexProtocolError,
} from './vertex-protocol.js';
import { ProviderContractError } from './provider-errors.js';
import { validateConnection, validateRequest } from './provider-request.js';
import type { ProviderConnection, ProviderExecutionOptions, ProviderResult } from './transport.js';

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

/** Strict SSE framing: byte boundaries, CRLF, comments and multiline data are independent of JSON. */
export async function consumeSse(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onData: (value: unknown) => boolean | Promise<boolean>,
  signal: AbortSignal,
  allowDone = false
): Promise<void> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let lineBuffer = '';
  let pendingLf = false;
  let data: string[] = [];
  let dataBytes = 0;
  let totalBytes = 0;
  const dispatch = async (): Promise<boolean> => {
    if (!data.length) return false;
    const payload = data.join('\n');
    data = [];
    dataBytes = 0;
    let value: unknown;
    try {
      value = allowDone && payload === '[DONE]' ? payload : JSON.parse(payload);
    } catch {
      throw new ProviderContractError('INVALID_EVENT');
    }
    return await onData(value);
  };
  const line = async (raw: string): Promise<boolean> => {
    if (!raw) return dispatch();
    if (raw.startsWith('data:')) {
      const part = raw.slice(5).replace(/^ /u, '');
      data.push(part);
      dataBytes += part.length;
      if (dataBytes > 1_000_000) throw new ProviderContractError('EVENT_TOO_LARGE');
    }
    return false;
  };
  const text = async (value: string): Promise<boolean> => {
    for (const character of value) {
      if (pendingLf) {
        pendingLf = false;
        if (character === '\n') continue;
      }
      if (character === '\r' || character === '\n') {
        const shouldStop = await line(lineBuffer);
        lineBuffer = '';
        if (shouldStop) return true;
        if (character === '\r') pendingLf = true;
      } else {
        lineBuffer += character;
        if (lineBuffer.length > 1_000_000) throw new ProviderContractError('EVENT_TOO_LARGE');
      }
    }
    return false;
  };
  // A response body may outlive fetch's abort propagation; close its pending read explicitly.
  const abortReader = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  const cancelAfterTerminal = async () => {
    try {
      await reader.cancel();
    } catch {
      /* The body may already have closed between the terminal event and cancellation. */
    }
  };
  signal.addEventListener('abort', abortReader, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) {
        try {
          if (await text(decoder.decode())) return;
        } catch {
          throw new ProviderContractError('INVALID_UTF8');
        }
        if (lineBuffer.length) {
          if (await line(lineBuffer)) return;
          lineBuffer = '';
        }
        if (await dispatch()) return;
        return;
      }
      totalBytes += next.value.byteLength;
      if (totalBytes > 8_000_000) throw new ProviderContractError('RESPONSE_TOO_LARGE');
      let decoded: string;
      try {
        decoded = decoder.decode(next.value, { stream: true });
      } catch {
        throw new ProviderContractError('INVALID_UTF8');
      }
      if (await text(decoded)) {
        await cancelAfterTerminal();
        return;
      }
    }
  } finally {
    signal.removeEventListener('abort', abortReader);
  }
}

/** One native Gemini HTTP request, using either Cloud credentials or a Studio API key. */
export async function executeGeminiProvider(
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
    const connection = validateConnection(connectionValue);
    if (!isGeminiProtocol(connection.protocol))
      throw new ProviderContractError('UNSUPPORTED_PROTOCOL');
    const vertex = connection.protocol === 'vertex-gemini-v1';
    const request = validateRequest(requestValue);
    const prepared = encodeVertex(request, connection.protocol);
    const requestedTier = request.generation?.serviceTier;
    const tier = (vertex ? options.vertexRequestTier : undefined) ?? requestedTier ?? 'standard';
    if (
      !(vertex ? ['standard', 'flex'] : ['standard', 'flex', 'priority']).includes(tier) ||
      (vertex &&
        options.vertexRequestTier !== undefined &&
        requestedTier !== undefined &&
        options.vertexRequestTier !== requestedTier)
    )
      throw new ProviderContractError(
        vertex ? 'INVALID_VERTEX_REQUEST_TIER' : 'INVALID_GEMINI_REQUEST_TIER'
      );
    decoder = new VertexDecoder(prepared.context);
    if (signal.aborted) return failure('CANCELLED');
    assertContextBudget(prepared.contextBody ?? prepared.body, request.contextBudget);
    const body = JSON.stringify(prepared.body);
    // Flex limits the complete inline payload, including base64 and native tool turns.
    if (
      request.generation?.pdfInput &&
      vertex &&
      tier === 'flex' &&
      Buffer.byteLength(body, 'utf8') > 20_000_000
    )
      throw new ProviderContractError('PDF_INPUT_PAYLOAD_TOO_LARGE');
    if (!vertex && !connection.credentialRef)
      throw new ProviderContractError('CREDENTIAL_UNAVAILABLE');
    // Google's well-known variable contains an ADC file path, never a bearer token.
    const token =
      vertex && isVertexAdcReference(connection.credentialRef)
        ? await vertexAccessToken(signal)
        : await (options.resolveCredential ?? ((name) => process.env[name]))(
            connection.credentialRef!,
            connection,
            signal
          );
    if (!token || /[\r\n]/u.test(token)) throw new ProviderContractError('CREDENTIAL_UNAVAILABLE');
    if (signal.aborted) return failure('CANCELLED');
    // Catalog names are models/{id}; presets store the bare model ID.
    const modelId = vertex ? request.modelId : request.modelId.replace(/^models\//u, '');
    if (!vertex && !/^gemini-[A-Za-z0-9._-]+$/u.test(modelId))
      throw new ProviderContractError('INVALID_GEMINI_MODEL_ID');
    const endpoint = vertex
      ? `${validateVertexEndpoint(connection.endpoint)}/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse`
      : `${validateProviderEndpoint(connection.protocol, connection.endpoint)}/models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse`;
    const tierHeaders: Record<string, string> =
      vertex && tier === 'flex'
        ? {
            'x-vertex-ai-llm-request-type': 'shared',
            'x-vertex-ai-llm-shared-request-type': 'flex',
            'x-server-timeout': String(Math.ceil(timeoutMs / 1000)),
          }
        : {};
    const authHeaders: Record<string, string> = vertex
      ? { authorization: `Bearer ${token}` }
      : { 'x-goog-api-key': token };
    const diagnosticAuth: Record<string, string> = vertex
      ? { authorization: '[REDACTED]' }
      : { 'x-goog-api-key': '[REDACTED]' };
    // The diagnostic view does not become the actual request. Signatures remain byte-for-byte in body.
    const diagnostic = redactDiagnosticJson(diagnosticVertexBody(prepared.body), token);
    await options.onWire?.(
      {
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
          ...diagnosticAuth,
        },
        body: diagnostic,
        ...(prepared.contextBody && request.contextBudget
          ? {
              requestContext: {
                estimatedInputTokens: estimateContextTokens(
                  prepared.contextBody,
                  request.contextBudget
                ),
                inputTokenLimit: request.contextBudget.inputTokenLimit,
                estimator: request.contextBudget.estimator,
                ...(request.contextBudget.estimator === 'model-local-v1'
                  ? {
                      tokenizer: request.contextBudget.tokenizer,
                      tokenizerFallback: tokenizerInfo(request.contextBudget.tokenizer).fallback,
                    }
                  : {}),
              },
            }
          : {}),
        bodySha256: sha(body),
        stablePrefixSha256: sha(JSON.stringify(request.stable)),
      },
      undefined,
      prepared.contextBody ? { contextBody: prepared.contextBody } : undefined
    );
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
          ...authHeaders,
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
    const progress =
      options.onProgress && publicProgressAllowed(request, connection.protocol)
        ? createPublicTextProgress(request, connection.protocol, { ...options, signal })
        : undefined;
    await consumeSse(
      reader,
      async (value) => {
        const update = decoder!.accept(value);
        await progress?.(update);
        return false;
      },
      signal
    );
    if (signal.aborted) return failure('CANCELLED');
    const result = decoder.finish();
    progress?.finish(result.text);
    const raw = result.usage.raw;
    if (
      vertex &&
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

// Preserve the existing transport entry point for callers of the Cloud adapter.
export const executeVertexProvider = executeGeminiProvider;
