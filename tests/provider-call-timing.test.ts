import { afterEach, expect, test, vi } from 'vitest';
import {
  executeProvider,
  type Json,
  type ProviderConnection,
  type ProviderRequest,
} from '../core/transport.js';

const secret = 'synthetic-timing-secret';
const request = (modelId: string): ProviderRequest => ({
  role: 'main',
  modelId,
  generation: { maxOutputTokens: 512, temperature: null },
  stable: { contract: 'Write synthetic fiction.', tools: [] },
  input: { task: '등대를 써요.', controls: {}, history: [], catalog: [], results: [] },
});
const options = () => ({ signal: new AbortController().signal, resolveCredential: () => secret });

let clock = 0;
function sseResponse(events: Json[]) {
  const bytes = new TextEncoder().encode(
    events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join('')
  );
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of new TextDecoder()
        .decode(bytes)
        .split(/(?<=\r\n\r\n)/u)
        .filter(Boolean))
        controller.enqueue(new TextEncoder().encode(line));
      controller.close();
    },
  });
  return {
    bytes: bytes.byteLength,
    response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
  };
}
function stubFetch(response: Response) {
  const bodies: string[] = [];
  vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
    bodies.push(String(init?.body));
    return response;
  });
  return bodies;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('Vertex streams record first byte, first thought, first visible text, stream span and sizes', async () => {
  vi.spyOn(performance, 'now').mockImplementation(() => (clock += 10));
  const stream = sseResponse([
    { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: ' \n' }] } }] },
    {
      candidates: [
        { index: 0, content: { role: 'model', parts: [{ thought: true, text: 'PRIVATE' }] } },
      ],
    },
    { candidates: [{ index: 0, content: { role: 'model', parts: [{ text: '불빛이 켜졌다.' }] } }] },
    {
      candidates: [{ index: 0, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4, thoughtsTokenCount: 2 },
    },
  ]);
  const bodies = stubFetch(stream.response);
  const connection: ProviderConnection = {
    id: 'vertex-timing',
    protocol: 'vertex-gemini-v1',
    endpoint:
      'https://aiplatform.googleapis.com/v1/projects/synthetic/locations/global/publishers/google/models',
    credentialRef: 'UIMORI_PROVIDER_VERTEX_TIMING',
  };
  const result = await executeProvider(connection, request('gemini-3.8-flash'), options());
  expect(result.status).toBe('completed');
  const timing = result.timing!;
  expect(timing.requestBytes).toBe(Buffer.byteLength(bodies[0]!, 'utf8'));
  expect(timing.responseBytes).toBe(stream.bytes);
  expect(timing.firstByteMs).toBeGreaterThan(0);
  expect(timing.firstThoughtMs).toBeGreaterThan(timing.firstByteMs!);
  expect(timing.firstTextMs).toBeGreaterThan(timing.firstThoughtMs!);
  expect(timing.streamMs).toBeGreaterThan(timing.firstTextMs! - timing.firstByteMs! - 1);
  expect(JSON.stringify(timing)).not.toContain('PRIVATE');
});

test('Anthropic thinking deltas and HTTP failures carry only the timings they can know', async () => {
  const connection: ProviderConnection = {
    id: 'anthropic-timing',
    protocol: 'anthropic-messages-v1',
    endpoint: 'https://api.anthropic.com/v1',
    credentialRef: 'UIMORI_PROVIDER_ANTHROPIC_TIMING',
  };
  const stream = sseResponse([
    {
      type: 'message_start',
      message: {
        id: 'message-timing',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5',
        content: [],
        stop_reason: null,
        usage: { input_tokens: 5, output_tokens: 0 },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'PRIVATE' },
    },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 's' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '등대' } },
    { type: 'content_block_stop', index: 1 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 2 },
    },
    { type: 'message_stop' },
  ]);
  stubFetch(stream.response);
  const streamed = await executeProvider(connection, request('claude-opus-5'), options());
  expect(streamed.status).toBe('completed');
  expect(streamed.timing).toMatchObject({
    firstByteMs: expect.any(Number),
    firstThoughtMs: expect.any(Number),
    firstTextMs: expect.any(Number),
    streamMs: expect.any(Number),
    responseBytes: stream.bytes,
  });
  expect(streamed.timing!.firstTextMs).toBeGreaterThanOrEqual(streamed.timing!.firstThoughtMs!);

  stubFetch(new Response('{"error":{"type":"overloaded_error"}}', { status: 529 }));
  const failed = await executeProvider(connection, request('claude-opus-5'), options());
  expect(failed.error?.code).toBe('HTTP_529');
  expect(failed.timing).toMatchObject({
    firstByteMs: expect.any(Number),
    requestBytes: expect.any(Number),
  });
  expect(failed.timing).not.toHaveProperty('firstTextMs');
  expect(failed.timing).not.toHaveProperty('responseBytes');
});
