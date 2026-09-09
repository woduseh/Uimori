import { describe, expect, test } from 'vitest';
import { encodeResponses, ResponsesDecoder } from '../core/openai-protocol.js';
import { encodeChat, ChatDecoder } from '../core/openai-chat-protocol.js';
import { encodeAnthropic, AnthropicDecoder } from '../core/anthropic-protocol.js';
import { encodeVertex, VertexDecoder } from '../core/vertex-protocol.js';
import { VERTEX_GEMINI_MODEL_ID } from '../core/product.js';
import type { LogicalMessage, ProviderPrompt } from '../core/prompt-program.js';
import type { Json, ProviderRequest, ProviderResult } from '../core/transport.js';
import { planNativeMessages } from '../core/provider-messages.js';
const wire = (value: Json) => value as Record<string, any>;
const message = (id: string, role: LogicalMessage['role'], text: string): LogicalMessage => ({
  id,
  role,
  content: [{ type: 'text', text }],
  completion: 'complete',
  provenance: {
    blockId: id,
    origin: id === 'current' ? 'current' : id === 'history' ? 'history' : 'prompt',
  },
});
const prompt = (): ProviderPrompt => ({
  compilerVersion: 'uimori-prompt-1',
  values: { length: 'standard' },
  messages: [
    message('system', 'system', 'NATIVE_SYSTEM'),
    message('old-user', 'user', 'EARLIER_REQUEST'),
    message('history', 'assistant', 'COMPLETED_PROSE'),
    message('current', 'user', 'CURRENT_REQUEST'),
  ],
  cachePlan: [],
});
const request = (modelId = 'gpt-5.6'): ProviderRequest => ({
  role: 'main',
  modelId,
  stable: {
    contract: 'HOST_CONTRACT',
    tools: [
      {
        name: 'knowledge.read',
        description: 'read synthetic data',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
      },
    ],
  },
  input: {
    task: 'DUPLICATE_TASK_SENTINEL',
    controls: { flag: false },
    source: null,
    catalog: [],
    history: [{ text: 'DUPLICATE_HISTORY_SENTINEL' }],
    results: [],
  },
  prompt: prompt(),
});
const next = (original: ProviderRequest, result: ProviderResult): ProviderRequest => ({
  ...structuredClone(original),
  opaqueState: result.opaqueState,
  input: {
    ...structuredClone(original.input),
    results: [
      ...(original.input.results as Json[]),
      ...result.toolCalls.map((c) => ({
        callId: c.id,
        name: c.name,
        args: c.arguments,
        result: { found: false, count: 0 },
        denied: false,
      })),
    ],
  },
});
function responseRound(input: ProviderRequest, id: string) {
  const encoded = encodeResponses(input);
  const decoder = new ResponsesDecoder(encoded.context);
  const signed = {
    type: 'reasoning',
    id: `rs-${id}`,
    summary: [],
    encrypted_content: `signed-${id}`,
  };
  const call = {
    type: 'function_call',
    id: `fc-${id}`,
    call_id: `Call.${id}`,
    name: 'tool_0_knowledge_read',
    arguments: '{"id":"synthetic"}',
    status: 'completed',
  };
  decoder.accept({
    type: 'response.completed',
    response: { id: `r-${id}`, status: 'completed', output: [signed, call] },
  });
  return { result: decoder.finish(), signed, call };
}

describe('native provider wire (synthetic, no live calls)', () => {
  test('preserves roles/order and sends current/history once across four codecs', () => {
    const r = request();
    const before = structuredClone(r);
    const responses = wire(encodeResponses(r).body);
    expect(responses.input.map((m: any) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
    expect(responses.input[2].content[0].text).toBe('COMPLETED_PROSE');
    const chat = wire(encodeChat(r).body);
    expect(chat.messages.map((m: any) => m.role)).toEqual([
      'system',
      'system',
      'user',
      'assistant',
      'user',
    ]);
    const anthropic = wire(encodeAnthropic(request('claude-opus-5')).body);
    expect(anthropic.messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(anthropic.system.at(-1).text).toBe('NATIVE_SYSTEM');
    const vertex = wire(encodeVertex(request(VERTEX_GEMINI_MODEL_ID)).body);
    expect(vertex.contents.map((m: any) => m.role)).toEqual(['user', 'model', 'user']);
    expect(vertex.systemInstruction.parts.at(-1).text).toBe('NATIVE_SYSTEM');
    for (const body of [responses, chat, anthropic, vertex]) {
      const encoded = JSON.stringify(body);
      expect(encoded).not.toMatch(
        /DUPLICATE_TASK_SENTINEL|DUPLICATE_HISTORY_SENTINEL|Request data \(JSON\)/
      );
      expect(encoded.split('CURRENT_REQUEST')).toHaveLength(2);
    }
    expect(r).toEqual(before);
  });
  test('native cache is explicit for eligible Responses and Anthropic while compatible chat remains unsupported', () => {
    const r = request();
    r.prompt!.cachePlan = [{ blockId: 'cache', afterMessageId: 'system', policy: 'prefer' }];
    const responses = wire(encodeResponses(r).body);
    expect(responses.prompt_cache_options).toEqual({ mode: 'explicit' });
    expect(responses.input[0].content[0].prompt_cache_breakpoint).toEqual({ mode: 'explicit' });
    const a = wire(encodeAnthropic({ ...r, modelId: 'claude-opus-5' }).body);
    expect(a.system.at(-1).cache_control).toEqual({ type: 'ephemeral' });
    expect(wire(encodeChat(r).body)).not.toHaveProperty('prompt_cache_options');
    r.prompt!.cachePlan[0].policy = 'require';
    expect(() => encodeChat(r)).toThrow('PROMPT_CACHE_UNSUPPORTED');
  });
  test.each(['explicit', 'automatic'] as const)(
    'Responses %s cache mode retains authored points and selected 30m TTL',
    (cacheMode) => {
      const r = request();
      r.generation = { maxOutputTokens: 8192, temperature: null, cacheMode, cacheTtl: '30m' };
      r.prompt!.cachePlan = [{ blockId: 'cache', afterMessageId: 'system', policy: 'require' }];
      const before = structuredClone(r);
      const body = wire(encodeResponses(r).body);
      expect(body.prompt_cache_options).toEqual({
        mode: cacheMode === 'automatic' ? 'implicit' : 'explicit',
        ttl: '30m',
      });
      expect(body.input[0].content[0].prompt_cache_breakpoint).toEqual({ mode: 'explicit' });
      expect(r).toEqual(before);
    }
  );
  test.each(['5m', '1h', undefined] as const)(
    'Claude applies TTL %s to automatic caching and every authored point',
    (cacheTtl) => {
      const r = request('claude-fable-5-1');
      r.generation = {
        maxOutputTokens: 8192,
        temperature: null,
        cacheMode: 'automatic',
        ...(cacheTtl ? { cacheTtl } : {}),
      };
      r.prompt!.cachePlan = [
        { blockId: 'cache-system', afterMessageId: 'system', policy: 'require' },
        { blockId: 'cache-user', afterMessageId: 'old-user', policy: 'require' },
      ];
      const before = structuredClone(r);
      const body = wire(encodeAnthropic(r).body);
      const control = { type: 'ephemeral', ...(cacheTtl ? { ttl: cacheTtl } : {}) };
      expect(body.cache_control).toEqual(control);
      expect(body.system.at(-1).cache_control).toEqual(control);
      expect(body.messages[0].content[0].cache_control).toEqual(control);
      r.generation.cacheMode = 'explicit';
      const explicit = wire(encodeAnthropic(r).body);
      expect(explicit).not.toHaveProperty('cache_control');
      expect(explicit.system.at(-1).cache_control).toEqual(control);
      expect(explicit.messages).toEqual(body.messages);
      r.generation.cacheMode = 'automatic';
      expect(r).toEqual(before);
    }
  );
  test.each(['openai-responses-v1', 'anthropic-messages-v1'] as const)(
    '%s reserves one automatic slot and never silently displaces a preferred point',
    (protocol) => {
      const r = request(protocol === 'openai-responses-v1' ? 'gpt-5.6-sol' : 'claude-opus-5');
      const encode = protocol === 'openai-responses-v1' ? encodeResponses : encodeAnthropic;
      r.generation = { maxOutputTokens: 8192, temperature: null, cacheMode: 'automatic' };
      r.prompt!.cachePlan = r
        .prompt!.messages.slice(0, 3)
        .map((m) => ({ blockId: `cache-${m.id}`, afterMessageId: m.id, policy: 'prefer' }));
      expect(() => encode(r)).not.toThrow();
      r.prompt!.cachePlan.push({ ...r.prompt!.cachePlan[0], blockId: 'duplicate-point' });
      expect(() => encode(r)).not.toThrow();
      r.prompt!.cachePlan.push({
        blockId: 'cache-current',
        afterMessageId: 'current',
        policy: 'prefer',
      });
      expect(() => encode(r)).toThrow('PROMPT_CACHE_LIMIT');
      r.generation.cacheMode = 'explicit';
      expect(() => encode(r)).not.toThrow();
    }
  );
  test.each(['openai-responses-v1', 'anthropic-messages-v1'] as const)(
    '%s cache OFF overrides authored required points with explicit diagnostics',
    (protocol) => {
      const r = request(protocol === 'openai-responses-v1' ? 'gpt-6-astra' : 'claude-fable-5-1');
      const encode = protocol === 'openai-responses-v1' ? encodeResponses : encodeAnthropic;
      r.generation = { maxOutputTokens: 8192, temperature: null, cacheMode: 'disabled' };
      r.prompt!.cachePlan = r.prompt!.messages.map((m) => ({
        blockId: `cache-${m.id}`,
        afterMessageId: m.id,
        policy: 'require',
      }));
      const original = structuredClone(r);
      const body = wire(encode(r).body);
      const plan = planNativeMessages(r, protocol)!;
      expect(
        plan.diagnostics.filter((d) => d.code === 'PROMPT_CACHE_DISABLED_BY_MODEL')
      ).toHaveLength(4);
      expect(
        plan.diagnostics
          .filter((d) => d.code === 'PROMPT_CACHE_DISABLED_BY_MODEL')
          .every((d) => d.status === 'not-applied')
      ).toBe(true);
      expect(JSON.stringify(body)).not.toMatch(/"cache_control"|"prompt_cache_breakpoint"/);
      if (protocol === 'openai-responses-v1')
        expect(body.prompt_cache_options).toEqual({ mode: 'explicit' });
      else expect(body).not.toHaveProperty('prompt_cache_options');
      expect(r).toEqual(original);
    }
  );
  test('unreviewed model IDs do not inherit explicit cache support', () => {
    for (const [protocol, modelId] of [
      ['openai-responses-v1', 'gpt-future'],
      ['anthropic-messages-v1', 'claude-future'],
    ] as const) {
      const r = request(modelId);
      r.prompt!.cachePlan = [{ blockId: 'cache', afterMessageId: 'system', policy: 'require' }];
      expect(() => planNativeMessages(r, protocol)).toThrow('PROMPT_CACHE_UNSUPPORTED');
    }
  });
  test('rejects prefill and unsupported mid-system instead of flattening the prompt', () => {
    for (const [encoder, model] of [
      [encodeResponses, 'gpt-5.6'],
      [encodeChat, 'gpt-5.6'],
      [encodeAnthropic, 'claude-opus-5'],
      [encodeVertex, VERTEX_GEMINI_MODEL_ID],
    ] as const) {
      const r = request(model);
      r.prompt!.messages.at(-1)!.completion = 'prefill';
      expect(() => encoder(r)).toThrow('PROMPT_PREFILL_UNSUPPORTED');
    }
    const r = request('unverified-claude');
    r.prompt!.messages.splice(2, 0, message('middle', 'system', 'MIDDLE_RULE'));
    expect(() => encodeAnthropic(r)).toThrow('PROMPT_MID_SYSTEM_MODEL_UNSUPPORTED');
    expect(() => planNativeMessages(r, 'vertex-gemini-v1')).toThrow(
      'PROMPT_MID_SYSTEM_UNSUPPORTED'
    );
    const supported = wire(encodeAnthropic({ ...r, modelId: 'claude-opus-5' }).body);
    expect(supported.messages.map((m: any) => m.role)).toEqual([
      'user',
      'system',
      'assistant',
      'user',
    ]);
    r.prompt!.messages.splice(2, 1);
    r.prompt!.messages.splice(3, 0, message('bad-placement', 'system', 'MIDDLE_RULE'));
    expect(() => encodeAnthropic({ ...r, modelId: 'claude-opus-5' })).toThrow(
      'PROMPT_MID_SYSTEM_PLACEMENT_UNSUPPORTED'
    );
  });
  test.each([
    'gemini-3.8-flash',
    'gemini-3.1-pro-preview',
    'google/gemini-3.8-flash',
    'google/Gemini-3.8-flash',
  ])('maps every non-leading system to user only on the wire for %s', (modelId) => {
    const r = request(modelId);
    r.prompt!.messages = [
      message('s1', 'system', 'LEADING_ONE'),
      message('s2', 'system', 'LEADING_TWO'),
      message('u', 'user', 'USER'),
      message('m1', 'system', 'MID_ONE'),
      message('m2', 'system', 'MID_TWO'),
      message('a', 'assistant', 'ASSISTANT'),
      message('m3', 'system', 'MID_THREE'),
      message('last', 'system', 'TRAILING'),
    ];
    const before = structuredClone(r);
    const plan = planNativeMessages(r, 'vertex-gemini-v1')!;
    const body = modelId.includes('/')
      ? { systemInstruction: { parts: plan.system }, contents: plan.messages }
      : wire(encodeVertex(r).body);
    expect(body.systemInstruction.parts.slice(-2)).toEqual([
      { text: 'LEADING_ONE' },
      { text: 'LEADING_TWO' },
    ]);
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: 'USER' }, { text: 'MID_ONE' }, { text: 'MID_TWO' }] },
      { role: 'model', parts: [{ text: 'ASSISTANT' }] },
      { role: 'user', parts: [{ text: 'MID_THREE' }, { text: 'TRAILING' }] },
    ]);
    expect(
      planNativeMessages(r, 'vertex-gemini-v1')!
        .diagnostics.filter((d) => d.code === 'GEMINI_MID_SYSTEM_TO_USER')
        .map((d) => [d.blockId, d.logicalIndex, d.status])
    ).toEqual([
      ['m1', 3, 'mapped'],
      ['m2', 4, 'mapped'],
      ['m3', 6, 'mapped'],
      ['last', 7, 'mapped'],
    ]);
    for (const protocol of ['openai-chat-v1', 'openai-responses-v1', 'vercel-chat-v1'] as const) {
      const mapped = planNativeMessages(r, protocol)!.messages;
      expect(mapped.map((m) => wire(m).role)).toEqual([
        'system',
        'system',
        'user',
        'user',
        'user',
        'assistant',
        'user',
        'user',
      ]);
      const encoded =
        protocol === 'openai-responses-v1'
          ? wire(encodeResponses(r).body).input
          : wire(encodeChat(r, protocol).body).messages.slice(1);
      expect(encoded).toEqual(mapped);
      expect(encoded.map((m: any) => m.content[0].text)).toEqual(
        before.prompt!.messages.map((m) => m.content[0].text)
      );
    }
    for (const other of ['gpt-5.6', 'claude-opus-5', 'custom-gemini-proxy']) {
      expect(
        planNativeMessages({ ...r, modelId: other }, 'openai-chat-v1')!.messages.map(
          (m) => wire(m).role
        )
      ).toEqual(before.prompt!.messages.map((m) => m.role));
    }
    expect(r).toEqual(before);
  });
  test('Gemini normalization preserves precise prefill and native final-assistant failures', () => {
    for (const [protocol, modelId, encoder] of [
      ['vertex-gemini-v1', 'gemini-3.8-flash', encodeVertex],
      ['openai-responses-v1', 'google/gemini-3.8-flash', encodeResponses],
      ['openai-chat-v1', 'google/gemini-3.8-flash', encodeChat],
    ] as const) {
      const r = request(modelId);
      r.prompt!.messages.splice(2, 0, message('middle', 'system', 'MID_RULE'));
      r.prompt!.messages.push({
        ...message('prefix', 'assistant', 'PREFIX'),
        completion: 'prefill',
      });
      const before = structuredClone(r);
      expect(() => encoder(r)).toThrow(
        `PROMPT_PREFILL_UNSUPPORTED:block=prefix:index=5:protocol=${protocol}:model=${modelId}`
      );
      expect(r).toEqual(before);
    }
    const r = request('gemini-3.8-flash');
    r.prompt!.messages.push(message('final-history', 'assistant', 'COMPLETED_HISTORY'));
    const before = structuredClone(r);
    expect(() => encodeVertex(r)).toThrow(
      'PROMPT_COMPLETED_ASSISTANT_AT_END_UNSUPPORTED:block=final-history:index=4:protocol=vertex-gemini-v1:model=gemini-3.8-flash'
    );
    expect(r).toEqual(before);
  });
  test('Responses two tool rounds preserve native prefix, original signed items, cache and call IDs; altered prompt rejected', () => {
    const r = request();
    r.prompt!.cachePlan = [{ blockId: 'cache', afterMessageId: 'system', policy: 'prefer' }];
    const first = wire(encodeResponses(r).body);
    const one = responseRound(r, 'one');
    const secondRequest = next(r, one.result);
    const second = wire(encodeResponses(secondRequest).body);
    expect(second.input.slice(0, 4)).toEqual(first.input);
    expect(second.input.slice(4, 6)).toEqual([one.signed, one.call]);
    expect(second.input.at(-1)).toEqual({
      type: 'function_call_output',
      call_id: 'Call.one',
      output: '{"found":false,"count":0}',
    });
    const two = responseRound(secondRequest, 'two');
    const thirdRequest = next(secondRequest, two.result);
    const third = wire(encodeResponses(thirdRequest).body);
    expect(third.input.slice(0, second.input.length)).toEqual(second.input);
    expect(third.input.at(-1).call_id).toBe('Call.two');
    expect(third.prompt_cache_options).toEqual(first.prompt_cache_options);
    const changed = structuredClone(thirdRequest);
    changed.prompt!.values.length = 'long';
    expect(() => encodeResponses(changed)).toThrow('OPENAI_CONTINUATION_MISMATCH');
  });
  test('Chat native continuation retains provider reasoning and matches exact call IDs', () => {
    const r = request();
    const encoded = encodeChat(r);
    const d = new ChatDecoder(encoded.context);
    d.accept({
      id: 'chat',
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            reasoning_content: 'signed-chat',
            tool_calls: [
              {
                index: 0,
                id: 'Chat.Call',
                type: 'function',
                function: { name: 'tool_0_knowledge_read', arguments: '{"id":"synthetic"}' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
    d.accept({ id: 'chat', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    d.accept('[DONE]');
    const continued = next(r, d.finish());
    const result = wire(encodeChat(continued).body);
    expect(result.messages.slice(0, 5)).toEqual(wire(encoded.body).messages);
    expect(result.messages.at(-2).reasoning_content).toBe('signed-chat');
    expect(result.messages.at(-1).tool_call_id).toBe('Chat.Call');
    continued.prompt!.messages[0].content[0].text = 'changed';
    expect(() => encodeChat(continued)).toThrow('OPENAI_CONTINUATION_MISMATCH');
  });
  test('Anthropic signed content and Vertex thought signatures survive native continuation', () => {
    const r = request('claude-opus-5');
    const encoded = encodeAnthropic(r);
    const d = new AnthropicDecoder(encoded.context);
    d.accept({
      type: 'message_start',
      message: {
        id: 'm',
        type: 'message',
        role: 'assistant',
        model: r.modelId,
        content: [],
        stop_reason: null,
      },
    });
    const parts = [
      { type: 'thinking', thinking: 'private reasoning', signature: 'signed-thinking' },
      {
        type: 'tool_use',
        id: 'Anthropic.Call',
        name: 'tool_0_knowledge_read',
        input: { id: 'synthetic' },
      },
    ];
    for (const [index, part] of parts.entries()) {
      d.accept({ type: 'content_block_start', index, content_block: part });
      d.accept({ type: 'content_block_stop', index });
    }
    d.accept({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null } });
    d.accept({ type: 'message_stop' });
    const continued = next(r, d.finish());
    const a = wire(encodeAnthropic(continued).body);
    expect(a.messages.at(-2).content).toEqual(parts);
    expect(a.messages.at(-1).content[0].tool_use_id).toBe('Anthropic.Call');
    continued.prompt!.values.length = 'extra';
    expect(() => encodeAnthropic(continued)).toThrow('ANTHROPIC_CONTINUATION_MISMATCH');
    const v = request(VERTEX_GEMINI_MODEL_ID);
    const ve = encodeVertex(v);
    const vd = new VertexDecoder(ve.context);
    const signed = {
      functionCall: { id: 'Vertex.Call', name: 'knowledge.read', args: { id: 'synthetic' } },
      thoughtSignature: 'signed-vertex',
    };
    vd.accept({
      candidates: [{ index: 0, content: { role: 'model', parts: [signed] }, finishReason: 'STOP' }],
    });
    const vr = next(v, vd.finish());
    const vb = wire(encodeVertex(vr).body);
    expect(vb.contents.at(-2).parts).toEqual([signed]);
    expect(vb.contents.at(-1).parts[0].functionResponse.id).toBe('Vertex.Call');
    vr.prompt!.messages[0].content[0].text = 'changed';
    expect(() => encodeVertex(vr)).toThrow('VERTEX_CONTINUATION_MISMATCH');
  });
  test('Anthropic accepts state, context and helper roles without enabling a model call', () => {
    for (const role of ['state', 'context', 'helper'] as const)
      expect(
        wire(encodeAnthropic({ ...request('claude-opus-5'), role }).body).messages
      ).toHaveLength(3);
  });
});
