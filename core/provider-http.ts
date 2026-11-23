import { redactDiagnosticJson } from './provider-diagnostic-json.js';
import { readProviderHttpDiagnostic, type ProviderHttpDiagnostic } from './provider-http-error.js';
import { createHash } from 'node:crypto';
import { providerFetchOptions, readProviderBody, transportFailureCode } from './provider-fetch.js';
import { validateProviderEndpoint } from './product.js';
import { assertContextBudget } from './context-budget.js';
import {
  createPublicTextProgress,
  publicProgressAllowed,
  type ProviderTextUpdate,
} from './provider-progress.js';
import { consumeSse, startProviderCallTiming } from './vertex.js';
import {
  encodeResponses,
  ResponsesDecoder,
  diagnosticResponsesBody,
  OpenAIProtocolError,
} from './openai-protocol.js';
import { encodeChat, ChatDecoder, diagnosticChatBody } from './openai-chat-protocol.js';
import {
  encodeAnthropic,
  AnthropicDecoder,
  diagnosticAnthropicBody,
  AnthropicProtocolError,
} from './anthropic-protocol.js';
import { ProviderContractError } from './provider-errors.js';
import { providerCacheBoundaries } from './provider-cache-diagnostics.js';
import { validateConnection, validateRequest } from './provider-request.js';
import { materializeProviderImages } from './provider-images.js';
import { materializeProviderFiles } from './provider-files.js';
import type {
  Json,
  ProviderConnection,
  ProviderExecutionOptions,
  ProviderResult,
  ProviderToolArgumentDiagnostic,
} from './transport.js';

type Decoder = {
  accept(value: unknown): ProviderTextUpdate;
  isTerminal(): boolean;
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
const field = (value: unknown, key: string): unknown =>
  value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;

function thoughtEvent(protocol: ProviderConnection['protocol'], value: unknown): boolean {
  const type = field(value, 'type');
  if (protocol === 'anthropic-messages-v1')
    return (
      (type === 'content_block_delta' &&
        field(field(value, 'delta'), 'type') === 'thinking_delta') ||
      (type === 'content_block_start' &&
        ['thinking', 'redacted_thinking'].includes(
          String(field(field(value, 'content_block'), 'type'))
        ))
    );
  if (protocol === 'openai-responses-v1')
    return (
      (typeof type === 'string' && type.startsWith('response.reasoning_')) ||
      (type === 'response.output_item.added' && field(field(value, 'item'), 'type') === 'reasoning')
    );
  const choices = field(value, 'choices');
  return (
    Array.isArray(choices) &&
    choices.some((choice) => {
      const delta = field(choice, 'delta');
      return ['reasoning_content', 'reasoning'].some((key) => {
        const text = field(delta, key);
        return typeof text === 'string' && text.length > 0;
      });
    })
  );
}

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
  let timing: ReturnType<typeof startProviderCallTiming> | undefined;
  const failure = (
    code: string,
    diagnostic?: ProviderHttpDiagnostic,
    toolArgumentDiagnostic?: ProviderToolArgumentDiagnostic
  ) => {
    const result = decoder?.snapshot() ?? empty();
    if (timing) result.timing = timing.finish();
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
      ...(toolArgumentDiagnostic ? { toolArgumentDiagnostic } : {}),
    };
    result.toolCalls = [];
    result.opaqueState = null;
    return result;
  };
  try {
    const connection = validateConnection(connectionValue);
    const request = validateRequest(requestValue);
    const progress =
      options.onProgress && publicProgressAllowed(request, connection.protocol)
        ? createPublicTextProgress(request, connection.protocol, { ...options, signal })
        : undefined;
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
    const secret = connection.credentialRef
      ? await (options.resolveCredential ?? ((name) => process.env[name]))(
          connection.credentialRef,
          connection,
          signal
        )
      : undefined;
    if (
      (connection.credentialRef || connection.protocol !== 'openai-chat-v1') &&
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
    const imageBody = await materializeProviderImages(bodyValue, request, options, signal);
    const wireBody = await materializeProviderFiles(
      imageBody,
      request,
      options,
      connection.protocol,
      signal
    );
    const body = JSON.stringify(wireBody);
    const cacheBoundaries = providerCacheBoundaries(connection.protocol, wireBody);
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
      body: redactDiagnosticJson(diagnostic, secret),
      bodySha256: sha(body),
      stablePrefixSha256: sha(JSON.stringify(request.stable)),
      ...(cacheBoundaries.length ? { cacheBoundaries } : {}),
    });
    if (signal.aborted) return failure('CANCELLED');
    const callTiming = startProviderCallTiming(body);
    timing = callTiming;
    const response = await fetch(
      url,
      providerFetchOptions({ method: 'POST', headers, body, signal, redirect: 'error' })
    );
    callTiming.headers();
    if (!response.ok) {
      const diagnostic = await readProviderHttpDiagnostic(response, signal, secret);
      return failure(`HTTP_${response.status}`, diagnostic);
    }
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!response.body) return failure('INVALID_CONTENT_TYPE');
    if (contentType.startsWith('text/event-stream')) {
      reader = response.body.getReader();
      await consumeSse(
        reader,
        async (value) => {
          if (thoughtEvent(connection.protocol, value)) callTiming.thought();
          const update = decoder!.accept(value);
          callTiming.text(update);
          await progress?.(update);
          return decoder!.isTerminal();
        },
        signal,
        allowDone,
        callTiming.received
      );
    } else if (
      connection.protocol === 'openai-responses-v1' &&
      contentType.startsWith('application/json')
    ) {
      const responseBody = await readProviderBody(response, signal);
      callTiming.received(responseBody.byteLength);
      const value: unknown = JSON.parse(new TextDecoder().decode(responseBody));
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        !['completed', 'incomplete', 'failed'].includes(
          String((value as Record<string, unknown>).status)
        )
      )
        return failure('INVALID_JSON_RESPONSE');
      const update = decoder.accept({
        type: `response.${String((value as Record<string, unknown>).status)}`,
        response: value,
      });
      await progress?.(update);
    } else {
      void response.body.cancel().catch(() => undefined);
      return failure('INVALID_CONTENT_TYPE');
    }
    if (signal.aborted) return failure('CANCELLED');
    const result: ProviderResult = { ...decoder.finish(), timing: callTiming.finish() };
    progress?.finish(result.text);
    return result;
  } catch (error) {
    const code =
      error instanceof ProviderContractError ||
      error instanceof OpenAIProtocolError ||
      error instanceof AnthropicProtocolError
        ? error.code
        : transportFailureCode(error);
    return failure(
      code,
      undefined,
      error instanceof AnthropicProtocolError ? error.toolArgumentDiagnostic : undefined
    );
  } finally {
    void reader?.cancel().catch(() => undefined);
  }
}
