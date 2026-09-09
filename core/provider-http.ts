import { readProviderHttpDiagnostic, type ProviderHttpDiagnostic } from './provider-http-error.js';
import { createHash } from 'node:crypto';
import { providerFetchOptions, transportFailureCode } from './provider-fetch.js';
import { validateProviderEndpoint } from './product.js';
import { validateModelOptions } from './model-capabilities.js';
import { assertContextBudget } from './context-budget.js';
import { consumeSse } from './vertex.js';
import {
  encodeResponses,
  ResponsesDecoder,
  diagnosticResponsesBody,
  OpenAIProtocolError,
} from './openai-protocol.js';
import {
  encodeChat,
  ChatDecoder,
  diagnosticChatBody,
  OpenAIChatProtocolError,
} from './openai-chat-protocol.js';
import {
  encodeAnthropic,
  AnthropicDecoder,
  diagnosticAnthropicBody,
  AnthropicProtocolError,
} from './anthropic-protocol.js';
import {
  ProviderContractError,
  validateConnection,
  validateRequest,
  type Json,
  type ProviderConnection,
  type ProviderExecutionOptions,
  type ProviderResult,
} from './transport.js';

type Decoder = {
  accept(value: unknown): void;
  snapshot(): ProviderResult;
  finish(): ProviderResult;
};
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const empty = (): ProviderResult => ({
  status: 'error',
  text: '',
  toolCalls: [],
  refusal: null,
  error: null,
  usage: { inputTokens: null, outputTokens: null, costUsd: null, raw: null, priceRevision: null },
  opaqueState: null,
});
function scrub(value: Json, secret?: string): Json {
  if (typeof value === 'string') return secret ? value.split(secret).join('[REDACTED]') : value;
  if (Array.isArray(value)) return value.map((item) => scrub(item, secret));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /^(authorization|x-api-key|api[_-]?key|credential|secret|password|access[_-]?token)$/i.test(
          key
        )
          ? '[REDACTED]'
          : scrub(item, secret),
      ])
    );
  return value;
}

/** One user-admitted provider request. The adapters never retry, redirect or change models. */
export async function executeNativeProvider(
  connectionValue: ProviderConnection,
  requestValue: unknown,
  options: ProviderExecutionOptions
): Promise<ProviderResult> {
  const timeoutMs = options.timeoutMs ?? 300_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1_800_000)
    throw new ProviderContractError('INVALID_TIMEOUT');
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([options.signal, timeout]);
  let decoder: Decoder | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const failure = (code: string, diagnostic?: ProviderHttpDiagnostic) => {
    const result = decoder?.snapshot() ?? empty();
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
    result.toolCalls = [];
    result.opaqueState = null;
    return result;
  };
  try {
    const connection = validateConnection(connectionValue, options.approvedOrigins);
    const request = validateRequest(requestValue);
    if (request.generation) validateModelOptions(request.generation, connection.protocol);
    let bodyValue: Json;
    let diagnostic: Json;
    let path: string;
    let allowDone = false;
    if (connection.protocol === 'openai-responses-v1') {
      const prepared = encodeResponses(request);
      decoder = new ResponsesDecoder(prepared.context);
      bodyValue = prepared.body;
      diagnostic = diagnosticResponsesBody(bodyValue);
      path = '/responses';
    } else if (connection.protocol === 'anthropic-messages-v1') {
      const prepared = encodeAnthropic(request);
      decoder = new AnthropicDecoder(prepared.context);
      bodyValue = prepared.body;
      diagnostic = diagnosticAnthropicBody(bodyValue);
      path = '/messages';
    } else if (
      connection.protocol === 'vercel-chat-v1' ||
      connection.protocol === 'openai-chat-v1' ||
      connection.protocol === 'deepseek-chat-v1'
    ) {
      const prepared = encodeChat(request, connection.protocol);
      decoder = new ChatDecoder(prepared.context);
      bodyValue = prepared.body;
      diagnostic = diagnosticChatBody(bodyValue);
      path = '/chat/completions';
      allowDone = true;
    } else throw new ProviderContractError('UNSUPPORTED_PROTOCOL');
    if (signal.aborted) return failure('CANCELLED');
    assertContextBudget(bodyValue, request.contextBudget);
    const secret = connection.credentialEnv
      ? await (options.resolveCredential ?? ((name) => process.env[name]))(
          connection.credentialEnv,
          connection,
          signal
        )
      : undefined;
    if (
      (connection.credentialEnv || connection.protocol !== 'openai-chat-v1') &&
      (!secret || /[\r\n]/u.test(secret))
    )
      throw new ProviderContractError('CREDENTIAL_UNAVAILABLE');
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
    };
    if (connection.protocol === 'anthropic-messages-v1') {
      headers['anthropic-version'] = '2023-06-01';
      headers['x-api-key'] = secret!;
    } else if (secret) headers.authorization = `Bearer ${secret}`;
    const url = validateProviderEndpoint(connection.protocol, connection.endpoint) + path;
    const body = JSON.stringify(bodyValue);
    await options.onWire?.({
      connectionId: connection.id,
      protocol: connection.protocol,
      role: request.role,
      modelId: request.modelId,
      method: 'POST',
      url,
      headers: Object.fromEntries(
        Object.entries(headers).map(([key, value]) => [
          key,
          ['authorization', 'x-api-key'].includes(key) ? '[REDACTED]' : value,
        ])
      ),
      body: scrub(diagnostic, secret),
      bodySha256: sha(body),
      stablePrefixSha256: sha(JSON.stringify(request.stable)),
    });
    if (signal.aborted) return failure('CANCELLED');
    const response = await fetch(
      url,
      providerFetchOptions({ method: 'POST', headers, body, signal, redirect: 'error' })
    );
    if (!response.ok) {
      const diagnostic = await readProviderHttpDiagnostic(response, signal, secret);
      return failure(`HTTP_${response.status}`, diagnostic);
    }
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!response.body) return failure('INVALID_CONTENT_TYPE');
    if (contentType.startsWith('text/event-stream')) {
      reader = response.body.getReader();
      await consumeSse(reader, (value) => decoder!.accept(value), signal, allowDone);
    } else if (
      connection.protocol === 'openai-responses-v1' &&
      contentType.startsWith('application/json')
    ) {
      const value: unknown = await response.json();
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        !['completed', 'incomplete', 'failed'].includes(
          String((value as Record<string, unknown>).status)
        )
      )
        return failure('INVALID_JSON_RESPONSE');
      decoder.accept({
        type: `response.${String((value as Record<string, unknown>).status)}`,
        response: value,
      });
    } else {
      await response.body.cancel();
      return failure('INVALID_CONTENT_TYPE');
    }
    if (signal.aborted) return failure('CANCELLED');
    return decoder.finish();
  } catch (error) {
    return failure(
      error instanceof ProviderContractError ||
        error instanceof OpenAIProtocolError ||
        error instanceof OpenAIChatProtocolError ||
        error instanceof AnthropicProtocolError
        ? error.code
        : transportFailureCode(error)
    );
  } finally {
    try {
      await reader?.cancel();
    } catch {
      /* Keep the recorded terminal result. */
    }
  }
}
