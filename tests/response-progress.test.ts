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
].map((value) => ({ ...value, credentialRef: 'SYNTHETIC_STREAM_TOKEN' })) as ProviderConnection[];
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
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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

  test.each(variants.filter((connection) => connection.protocol !== 'fixture-sse-v1'))(
    '$protocol does not project public text without a permitted consumer',
    async (connection) => {
      const prototype =
        connection.protocol === 'openai-responses-v1'
          ? ResponsesDecoder.prototype
          : connection.protocol === 'anthropic-messages-v1'
            ? AnthropicDecoder.prototype
            : connection.protocol === 'vertex-gemini-v1'
              ? VertexDecoder.prototype
              : ChatDecoder.prototype;
      for (const mode of ['no-listener', 'forbidden']) {
        const input = request();
        if (mode === 'forbidden')
          input.stable.tools.push({
            name: 'story.submit',
            description: 'Final submission',
            inputSchema: { type: 'object' },
          });
        let body!: ReadableStreamDefaultController<Uint8Array>;
        const [first, final] = events(connection.protocol);
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            body = controller;
            controller.enqueue(encode(first));
          },
        });
        vi.stubGlobal(
          'fetch',
          vi.fn(
            async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
          )
        );
        const projected = vi.spyOn(prototype, 'publicText');
        const accepted = vi.spyOn(prototype, 'accept');
        const observed = vi.fn();
        const resultPromise = executeProvider(connection, input, {
          signal: new AbortController().signal,
          resolveCredential: () => 'synthetic-only',
          ...(mode === 'forbidden' ? { onProgress: observed } : {}),
        });
        try {
          await vi.waitFor(() => expect(accepted).toHaveBeenCalledTimes(first.length));
          expect(projected).not.toHaveBeenCalled();
        } finally {
          body.enqueue(encode(final));
          body.close();
          const result = await resultPromise;
          expect(result.status).toBe('completed');
          expect(result.text).toBe(publicText);
          expect(observed).not.toHaveBeenCalled();
          projected.mockRestore();
          accepted.mockRestore();
        }
      }
    }
  );

  test.each(['no-listener', 'forbidden'])(
    'Responses JSON does not project public text with %s',
    async (mode) => {
      const input = request();
      if (mode === 'forbidden')
        input.stable.tools.push({
          name: 'story.submit',
          description: 'Final submission',
          inputSchema: { type: 'object' },
        });
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          Response.json({ id: 'response-1', status: 'completed', output: [message(publicText)] })
        )
      );
      const projected = vi.spyOn(ResponsesDecoder.prototype, 'publicText');
      const observed = vi.fn();
      const result = await executeProvider(variants[1], input, {
        signal: new AbortController().signal,
        resolveCredential: () => 'synthetic-only',
        ...(mode === 'forbidden' ? { onProgress: observed } : {}),
      });
      expect(result.status).toBe('completed');
      expect(result.text).toBe(publicText);
      expect(projected).not.toHaveBeenCalled();
      expect(observed).not.toHaveBeenCalled();
    }
  );

  test.each(['story.submit', 'eval_submit_artifact', 'structured-output', 'codex-envelope'])(
    '%s withholds all unvalidated content',
    async (mode) => {
      const input = request();
      if (mode === 'structured-output') {
        input.role = 'translation';
        input.generation!.structuredOutput = true;
      } else
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
            parts: [{ functionCall: { name: 'knowledge.read', args: { ids: [privateText] } } }],
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

  test.each(['snapshot', 'append'])(
    'cancellation suppresses late %s updates and retains the observed prefix',
    async (mode) => {
      const controller = new AbortController();
      const observed: ProviderProgress[] = [];
      const progress = createPublicTextProgress(request(), 'fixture-sse-v1', {
        signal: controller.signal,
        onProgress: (delta) => {
          observed.push(delta);
        },
      });
      await progress(mode === 'append' ? { text: 'received', offset: 8 } : 'received');
      controller.abort();
      await progress(mode === 'append' ? { text: ' late', offset: 13 } : 'received late');
      expect(() => progress.finish('received late')).not.toThrow();
      expect(observed).toEqual([{ text: 'received', offset: 8 }]);
    }
  );
});

describe('append-only public text updates', () => {
  test('reconciles snapshots, ignores exact repeats, and rejects changed prefixes or offsets', async () => {
    const observed: ProviderProgress[] = [];
    const progress = createPublicTextProgress(request(), 'openai-chat-v1', {
      signal: new AbortController().signal,
      onProgress: (delta) => {
        observed.push(delta);
      },
    });
    await progress({ text: '등대 ', offset: 3 });
    await progress({ text: '등대 ', offset: 3 });
    await progress('등대 ');
    await progress({ text: '🌊', offset: 5 });
    await progress('등대 🌊 끝');
    await progress({ text: '', offset: 7 });
    expect(observed).toEqual([
      { text: '등대 ', offset: 3 },
      { text: '🌊', offset: 5 },
      { text: ' 끝', offset: 7 },
    ]);
    expect(() => progress.finish('등대 🌊 끝')).not.toThrow();
    await expect(progress('바뀐 앞부분')).rejects.toThrow('PUBLIC_TEXT_CHANGED');
    await expect(progress({ text: '잘못된 조각', offset: 7 })).rejects.toThrow(
      'PUBLIC_TEXT_CHANGED'
    );
    await expect(progress({ text: 'gap', offset: 100 })).rejects.toThrow('PUBLIC_TEXT_CHANGED');
    expect(() => progress.finish('등대 🌊')).toThrow('PUBLIC_TEXT_CHANGED');
    expect(() => progress.finish('등대 🌊 끝 누락')).toThrow('PUBLIC_TEXT_CHANGED');
  });

  test.each([
    'openai-responses-v1',
    'anthropic-messages-v1',
    'openai-chat-v1',
    'vertex-gemini-v1',
  ] as const)(
    '%s emits tiny deltas without cumulative projection and matches the final result',
    async (protocol) => {
      const input = request();
      const decoder =
        protocol === 'openai-responses-v1'
          ? new ResponsesDecoder(encodeResponses(input).context)
          : protocol === 'anthropic-messages-v1'
            ? new AnthropicDecoder(encodeAnthropic(input).context)
            : protocol === 'vertex-gemini-v1'
              ? new VertexDecoder(encodeVertex(input).context)
              : new ChatDecoder(encodeChat(input, protocol).context);
      const [first, final] = events(protocol);
      let observed = '';
      let offset = 0;
      let appends = 0;
      const progress = createPublicTextProgress(input, protocol, {
        signal: new AbortController().signal,
        onProgress: (delta) => {
          observed += delta.text;
          offset = delta.offset;
        },
      });
      const projected = vi.spyOn(decoder, 'publicText');
      if (protocol === 'openai-responses-v1' || protocol === 'anthropic-messages-v1')
        for (const event of first.slice(0, -1)) await progress(decoder.accept(event));
      const chunk = '한 문장입니다. ';
      for (let index = 0; index < 15000; index++) {
        const event =
          protocol === 'openai-responses-v1'
            ? {
                type: 'response.output_text.delta',
                output_index: 1,
                item_id: 'msg-1',
                content_index: 0,
                delta: chunk,
              }
            : protocol === 'anthropic-messages-v1'
              ? {
                  type: 'content_block_delta',
                  index: 1,
                  delta: { type: 'text_delta', text: chunk },
                }
              : protocol === 'vertex-gemini-v1'
                ? { candidates: [{ content: { parts: [{ text: chunk }] } }] }
                : { choices: [{ index: 0, delta: { content: chunk } }] };
        const update = decoder.accept(event);
        if (
          typeof update === 'object' &&
          update.text === chunk &&
          update.offset === (index + 1) * chunk.length
        )
          appends++;
        await progress(update);
      }
      expect(appends).toBe(15000);
      expect(projected).not.toHaveBeenCalled();
      const expected = chunk.repeat(15000);
      const terminal: Json[] =
        protocol === 'openai-responses-v1'
          ? [
              {
                type: 'response.completed',
                response: {
                  id: 'response-1',
                  status: 'completed',
                  output: [
                    { type: 'reasoning', id: 'reason-1', encrypted_content: privateText },
                    message(expected),
                  ],
                },
              },
            ]
          : protocol === 'anthropic-messages-v1'
            ? final.slice(1)
            : protocol === 'vertex-gemini-v1'
              ? [{ candidates: [{ finishReason: 'STOP' }] }]
              : [{ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, '[DONE]'];
      for (const event of terminal) await progress(decoder.accept(event));
      const result = decoder.finish();
      progress.finish(result.text);
      expect(result.status).toBe('completed');
      expect(result.text).toBe(expected);
      expect(observed).toBe(expected);
      expect(offset).toBe(expected.length);
    }
  );

  test.each(['openai-responses-v1', 'anthropic-messages-v1'] as const)(
    '%s reconciles an earlier open text part instead of treating an insertion as an append',
    async (protocol) => {
      const decoder =
        protocol === 'openai-responses-v1'
          ? new ResponsesDecoder(encodeResponses(request()).context)
          : new AnthropicDecoder(encodeAnthropic(request()).context);
      const progress = createPublicTextProgress(request(), protocol, {
        signal: new AbortController().signal,
        onProgress: () => {},
      });
      const setup =
        protocol === 'openai-responses-v1'
          ? [
              {
                type: 'response.output_item.added',
                output_index: 0,
                item: {
                  type: 'message',
                  id: 'msg-1',
                  role: 'assistant',
                  content: [
                    { type: 'output_text', text: 'first' },
                    { type: 'output_text', text: 'last' },
                  ],
                },
              },
            ]
          : [
              {
                type: 'message_start',
                message: { id: 'msg-1', type: 'message', role: 'assistant', content: [] },
              },
              {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'text', text: 'first' },
              },
              {
                type: 'content_block_start',
                index: 1,
                content_block: { type: 'text', text: 'last' },
              },
            ];
      for (const event of setup) await progress(decoder.accept(event));
      const update = decoder.accept(
        protocol === 'openai-responses-v1'
          ? {
              type: 'response.output_text.delta',
              output_index: 0,
              item_id: 'msg-1',
              content_index: 0,
              delta: '!',
            }
          : { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '!' } }
      );
      expect(update).toBe('first!last');
      await expect(progress(update)).rejects.toThrow('PUBLIC_TEXT_CHANGED');
    }
  );

  test.each([variants[3], variants[6]])(
    '$protocol rejects a final result that differs from emitted prose',
    async (connection) => {
      const prototype =
        connection.protocol === 'vertex-gemini-v1'
          ? VertexDecoder.prototype
          : ChatDecoder.prototype;
      const finish = prototype.finish;
      vi.spyOn(prototype, 'finish').mockImplementation(function (
        this: VertexDecoder & ChatDecoder
      ) {
        return { ...finish.call(this), text: 'changed final text' };
      });
      const [first, final] = events(connection.protocol);
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(encode([...first, ...final]), {
              headers: { 'content-type': 'text/event-stream' },
            })
        )
      );
      const result = await executeProvider(connection, request(), {
        signal: new AbortController().signal,
        resolveCredential: () => 'synthetic-only',
        onProgress: () => {},
      });
      expect(result.status).toBe('partial');
      expect(result.error?.code).toBe('PUBLIC_TEXT_CHANGED');
      expect(result.text).toBe(publicText);
    }
  );
});
