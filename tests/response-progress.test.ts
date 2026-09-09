import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  executeProvider,
  type Json,
  type ProviderConnection,
  type ProviderRequest,
} from '../core/transport.js';
import { createPublicTextProgress, type ProviderProgress } from '../core/provider-progress.js';
import { encodeResponses, ResponsesDecoder } from '../core/openai-protocol.js';
import { encodeChat, ChatDecoder } from '../core/openai-chat-protocol.js';
import { encodeVertex, VertexDecoder } from '../core/vertex-protocol.js';
import { encodeAnthropic, AnthropicDecoder } from '../core/anthropic-protocol.js';

const request = (): ProviderRequest => ({
  role: 'main',
  modelId: 'synthetic-model',
  generation: { maxOutputTokens: 512, temperature: null },
  stable: {
    contract: 'Synthetic public prose test.',
    tools: [
      {
        name: 'knowledge.read',
        description: 'Read synthetic data',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
      },
    ],
  },
  input: { task: 'Continue.', controls: {}, results: [] },
});
const variants: ProviderConnection[] = [
  { id: 'fixture', protocol: 'fixture-sse-v1', endpoint: 'http://127.0.0.1:44999/turn' },
  { id: 'responses', protocol: 'openai-responses-v1', endpoint: 'https://api.openai.com/v1' },
  { id: 'messages', protocol: 'anthropic-messages-v1', endpoint: 'https://api.anthropic.com/v1' },
  { id: 'chat', protocol: 'openai-chat-v1', endpoint: 'https://synthetic.invalid/v1' },
  { id: 'vercel', protocol: 'vercel-chat-v1', endpoint: 'https://ai-gateway.vercel.sh/v1' },
  { id: 'deepseek', protocol: 'deepseek-chat-v1', endpoint: 'https://api.deepseek.com/v1' },
  {
    id: 'vertex',
    protocol: 'vertex-gemini-v1',
    endpoint:
      'https://aiplatform.googleapis.com/v1/projects/synthetic/locations/global/publishers/google/models',
  },
].map((value) => ({ ...value, credentialEnv: 'SYNTHETIC_STREAM_TOKEN' })) as ProviderConnection[];
const publicText = '등대 🌊';
const privateText = 'PRIVATE_REASONING_SIGNATURE_OPAQUE';
const message = (text: string): Json => ({
  type: 'message',
  id: 'msg-1',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text }],
});

function events(protocol: ProviderConnection['protocol']): [Json[], Json[]] {
  if (protocol === 'fixture-sse-v1')
    return [
      [
        { type: 'opaque_state', state: privateText },
        { type: 'text_delta', delta: '등대 ' },
      ],
      [
        { type: 'text_delta', delta: '🌊' },
        { type: 'done', reason: 'stop' },
      ],
    ];
  if (protocol === 'vertex-gemini-v1')
    return [
      [
        {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  { text: privateText, thought: true },
                  { thoughtSignature: privateText },
                  { text: '등대 ' },
                ],
              },
            },
          ],
        },
      ],
      [
        {
          candidates: [
            { content: { role: 'model', parts: [{ text: '🌊' }] }, finishReason: 'STOP' },
          ],
        },
      ],
    ];
  if (protocol === 'openai-responses-v1')
    return [
      [
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'reasoning', id: 'reason-1', encrypted_content: privateText },
        },
        { type: 'response.reasoning_text.delta', delta: privateText },
        {
          type: 'response.output_item.added',
          output_index: 1,
          item: { type: 'message', id: 'msg-1', role: 'assistant', content: [] },
        },
        {
          type: 'response.content_part.added',
          output_index: 1,
          item_id: 'msg-1',
          content_index: 0,
          part: { type: 'output_text', text: '' },
        },
        {
          type: 'response.output_text.delta',
          output_index: 1,
          item_id: 'msg-1',
          content_index: 0,
          delta: '등대 ',
        },
      ],
      [
        {
          type: 'response.output_text.delta',
          output_index: 1,
          item_id: 'msg-1',
          content_index: 0,
          delta: '🌊',
        },
        {
          type: 'response.completed',
          response: {
            id: 'response-1',
            status: 'completed',
            output: [
              { type: 'reasoning', id: 'reason-1', encrypted_content: privateText },
              message(publicText),
            ],
          },
        },
      ],
    ];
  if (protocol === 'anthropic-messages-v1')
    return [
      [
        {
          type: 'message_start',
          message: { id: 'msg-1', type: 'message', role: 'assistant', content: [] },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: privateText },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'signature_delta', signature: privateText },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '등대 ' } },
      ],
      [
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '🌊' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null } },
        { type: 'message_stop' },
      ],
    ];
  return [
    [
      {
        id: 'chat-1',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', reasoning_content: privateText, content: '등대 ' },
          },
        ],
      },
    ],
    [
      { id: 'chat-1', choices: [{ index: 0, delta: { content: '🌊' }, finish_reason: 'stop' }] },
      '[DONE]',
    ],
  ];
}
function encode(items: Json[]) {
  return new TextEncoder().encode(
    items.map((item) => `data: ${item === '[DONE]' ? item : JSON.stringify(item)}\n\n`).join('')
  );
}
afterEach(() => vi.unstubAllGlobals());

describe('public response progress through real decoders and synthetic HTTP', () => {
  test.each(variants)(
    '$protocol emits actual text before completion and excludes private parts',
    async (connection) => {
      let body!: ReadableStreamDefaultController<Uint8Array>;
      const [first, final] = events(connection.protocol);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          body = controller;
          controller.enqueue(encode(first));
        },
      });
      const fetch = vi.fn(
        async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
      );
      vi.stubGlobal('fetch', fetch);
      const deltas: ProviderProgress[] = [];
      let wireRecorded = false;
      let completed = false;
      const resultPromise = executeProvider(connection, request(), {
        approvedOrigins: [new URL(connection.endpoint).origin],
        signal: new AbortController().signal,
        resolveCredential: () => 'synthetic-only',
        onWire: () => {
          wireRecorded = true;
        },
        onProgress: (delta) => {
          expect(wireRecorded).toBe(true);
          deltas.push(delta);
        },
      }).then((result) => {
        completed = true;
        return result;
      });
      await vi.waitFor(() => expect(deltas).toEqual([{ text: '등대 ', offset: 3 }]));
      expect(completed).toBe(false);
      body.enqueue(encode(final));
      body.close();
      const result = await resultPromise;
      expect(result.status).toBe('completed');
      expect(deltas).toEqual([
        { text: '등대 ', offset: 3 },
        { text: '🌊', offset: 5 },
      ]);
      expect(result.text).toBe(publicText);
      expect(JSON.stringify(deltas)).not.toContain(privateText);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  );

  test.each(['story.submit', 'eval_submit_artifact', 'structured-output', 'codex-envelope'])(
    '%s withholds all unvalidated content',
    async (mode) => {
      const input = request();
      if (mode === 'structured-output') input.generation!.structuredOutput = true;
      else
        input.stable.tools.push({
          name: mode,
          description: 'Final submission',
          inputSchema: { type: 'object' },
        });
      const observed = vi.fn();
      const progress = createPublicTextProgress(
        input,
        mode === 'codex-envelope' ? 'codex-app-server-v1' : 'fixture-sse-v1',
        { signal: new AbortController().signal, onProgress: observed }
      );
      await progress('{"content":"UNVALIDATED"}');
      expect(observed).not.toHaveBeenCalled();
    }
  );

  test('tool argument channels never appear in decoder public text', () => {
    const input = request();
    const vertex = new VertexDecoder(encodeVertex(input).context);
    vertex.accept({
      candidates: [
        {
          content: {
            parts: [{ functionCall: { name: 'knowledge.read', args: { id: privateText } } }],
          },
        },
      ],
    });
    const responses = new ResponsesDecoder(encodeResponses(input).context);
    responses.accept({
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        type: 'function_call',
        id: 'fc-1',
        call_id: 'call-1',
        name: 'tool_0_knowledge_read',
        arguments: '',
      },
    });
    responses.accept({
      type: 'response.function_call_arguments.delta',
      output_index: 0,
      item_id: 'fc-1',
      delta: `{"id":"${privateText}"}`,
    });
    const chat = new ChatDecoder(encodeChat(input, 'openai-chat-v1').context);
    chat.accept({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call-1',
                type: 'function',
                function: { name: 'tool_0_knowledge_read', arguments: `{"id":"${privateText}"}` },
              },
            ],
          },
        },
      ],
    });
    const encoded = encodeAnthropic(input);
    const anthropic = new AnthropicDecoder(encoded.context);
    const wireName = (encoded.body as { tools: { name: string }[] }).tools[0].name;
    anthropic.accept({
      type: 'message_start',
      message: { id: 'msg-1', type: 'message', role: 'assistant', content: [] },
    });
    anthropic.accept({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'call-1', name: wireName, input: {} },
    });
    anthropic.accept({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: `{"id":"${privateText}"}` },
    });
    for (const decoder of [vertex, responses, chat, anthropic])
      expect(decoder.publicText()).toBe('');
    vertex.accept({ candidates: [{ finishReason: 'STOP' }] });
    responses.accept({
      type: 'response.completed',
      response: {
        id: 'response-1',
        status: 'completed',
        output: [
          {
            type: 'function_call',
            id: 'fc-1',
            call_id: 'call-1',
            name: 'tool_0_knowledge_read',
            arguments: `{"id":"${privateText}"}`,
            status: 'completed',
          },
        ],
      },
    });
    chat.accept({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    chat.accept('[DONE]');
    anthropic.accept({ type: 'content_block_stop', index: 0 });
    anthropic.accept({ type: 'message_delta', delta: { stop_reason: 'tool_use' } });
    anthropic.accept({ type: 'message_stop' });
    const encoders = [
      encodeVertex,
      encodeResponses,
      (value: ProviderRequest) => encodeChat(value, 'openai-chat-v1'),
      encodeAnthropic,
    ];
    for (const [index, decoder] of [vertex, responses, chat, anthropic].entries()) {
      const old = decoder.finish();
      expect(old.status).toBe('tool_calls');
      const next = request();
      next.input.task = 'New compacted segment with receipts supplied by the host.';
      expect(() => encoders[index]({ ...next, opaqueState: old.opaqueState })).toThrow();
      const fresh = encoders[index](next);
      expect(JSON.stringify(fresh)).not.toContain(privateText);
      expect(JSON.stringify(fresh.context)).not.toContain('call-1');
    }
  });

  test('cancellation suppresses late public deltas and retains the already observed prefix', async () => {
    const controller = new AbortController();
    const observed: ProviderProgress[] = [];
    const progress = createPublicTextProgress(request(), 'fixture-sse-v1', {
      signal: controller.signal,
      onProgress: (delta) => {
        observed.push(delta);
      },
    });
    await progress('received');
    controller.abort();
    await progress('received late');
    expect(observed).toEqual([{ text: 'received', offset: 8 }]);
  });
});
