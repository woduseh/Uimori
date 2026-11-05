import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { canonicalJson } from '../core/canonical-json.js';
import { encodeResponses, ResponsesDecoder } from '../core/openai-protocol.js';
import { encodeChat, ChatDecoder } from '../core/openai-chat-protocol.js';
import { encodeAnthropic, decodeAnthropicMessage } from '../core/anthropic-protocol.js';
import { encodeVertex, VertexDecoder } from '../core/vertex-protocol.js';
import type { Json, ProviderRequest, ProviderResult } from '../core/transport.js';

type Codec = {
  name: string;
  encode(request: ProviderRequest): { body: Json; context: unknown };
  reply(context: any, id: string): ProviderResult;
};
const codecs: Codec[] = [
  {
    name: 'Responses',
    encode: encodeResponses,
    reply(context, id) {
      const decoder = new ResponsesDecoder(context);
      decoder.accept({
        type: 'response.completed',
        response: {
          id: `response-${id}`,
          status: 'completed',
          output: [
            {
              type: 'function_call',
              id: `item-${id}`,
              call_id: id,
              name: 'tool_0_knowledge_read',
              arguments: '{}',
              status: 'completed',
            },
          ],
        },
      });
      return decoder.finish();
    },
  },
  {
    name: 'Chat',
    encode: encodeChat,
    reply(context, id) {
      const decoder = new ChatDecoder(context);
      decoder.accept({
        id: `response-${id}`,
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id,
                  type: 'function',
                  function: { name: 'tool_0_knowledge_read', arguments: '{}' },
                },
              ],
            },
          },
        ],
      });
      decoder.accept('[DONE]');
      return decoder.finish();
    },
  },
  {
    name: 'Anthropic',
    encode: encodeAnthropic,
    reply: (context, id) =>
      decodeAnthropicMessage(
        {
          id: `response-${id}`,
          type: 'message',
          role: 'assistant',
          model: 'fixture',
          content: [{ type: 'tool_use', id, name: 'tool_0_knowledge_read', input: {} }],
          stop_reason: 'tool_use',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        context
      ),
  },
  {
    name: 'Vertex',
    encode: encodeVertex,
    reply(context, id) {
      const decoder = new VertexDecoder(context);
      decoder.accept({
        candidates: [
          {
            index: 0,
            finishReason: 'STOP',
            content: {
              role: 'model',
              parts: [{ functionCall: { id, name: 'knowledge.read', args: {} } }],
            },
          },
        ],
      });
      return decoder.finish();
    },
  },
];
const seal = (state: Record<string, Json>) => {
  const { stateHash: _previous, ...body } = state;
  return { ...body, stateHash: createHash('sha256').update(canonicalJson(body)).digest('hex') };
};

test.each(codecs)(
  '$name preserves one transcript and validates cumulative results without duplicating bodies',
  ({ encode, reply }) => {
    let request: ProviderRequest = {
      role: 'helper',
      modelId: 'fixture',
      generation: { maxOutputTokens: 1024, temperature: null },
      stable: {
        contract: 'Inspect exact source evidence.',
        tools: [
          {
            name: 'knowledge.read',
            description: 'Read.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          },
        ],
      },
      input: { task: 'Inspect.', controls: {}, results: [] },
    };
    const markers: string[] = [];
    for (let round = 0; round < 20; round++) {
      const encoded = encode(request);
      const wire = JSON.stringify(encoded.body);
      const result = reply(encoded.context, `call-${round}`);
      expect(result.status).toBe('tool_calls');
      const state = result.opaqueState as Record<string, Json>;
      expect(state.version).toMatch(/-turn-v2$/u);
      expect(state).not.toHaveProperty('completedResults');
      expect(state.completedResultCount).toBe(round);
      expect(state.completedResultsHash).toMatch(/^[a-f0-9]{64}$/u);
      const retained = JSON.stringify(state);
      for (const marker of markers) {
        expect(wire.split(marker)).toHaveLength(2);
        expect(retained.split(marker)).toHaveLength(2);
      }
      const marker = `EXACT_SOURCE_${round}_END`;
      markers.push(marker);
      request = {
        ...request,
        opaqueState: state,
        input: {
          ...request.input,
          results: [
            ...(request.input.results as Json[]),
            {
              callId: result.toolCalls[0].id,
              name: 'knowledge.read',
              args: {},
              denied: false,
              result: { text: marker + '원문을 그대로 보존해요 🌊\n'.repeat(400), revision: round },
            },
          ],
        },
      };
    }
    const altered = structuredClone(request);
    (altered.input.results as any[])[0].result.text = 'Changed past evidence';
    expect(() => encode(altered)).toThrow('TOOL_RESULT_MISMATCH');

    const reordered = structuredClone(request);
    (reordered.input.results as any[])[0].result = {
      revision: 0,
      text: (request.input.results as any[])[0].result.text,
    };
    expect(encode(reordered).body).toEqual(encode(request).body);

    const state = request.opaqueState as Record<string, Json>;
    expect(() =>
      encode({ ...request, opaqueState: { ...state, completedResultCount: 0 } })
    ).toThrow(/INVALID_.*CONTINUATION/u);
    const invalidStates: Record<string, Json>[] = [
      { completedResultCount: -1 },
      { completedResultCount: 1.5 },
      { completedResultsHash: 'invalid' },
      { version: String(state.version).replace('-v2', '-v1') },
    ];
    for (const change of invalidStates)
      expect(() => encode({ ...request, opaqueState: seal({ ...state, ...change }) })).toThrow(
        /INVALID_.*CONTINUATION/u
      );
  }
);
