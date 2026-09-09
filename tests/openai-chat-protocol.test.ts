import { describe, expect, test } from 'vitest';
import { encodeChat, ChatDecoder, diagnosticChatBody } from '../core/openai-chat-protocol.js';
import { encodeResponses, ResponsesDecoder } from '../core/openai-protocol.js';
import type { Json, ProviderRequest, ProviderResult } from '../core/transport.js';
const record = (value: Json) => value as Record<string, any>;
const request = (): ProviderRequest => ({
  role: 'main',
  modelId: 'provider/user-selected-model',
  generation: { maxOutputTokens: 321, temperature: 0, reasoningEffort: 'none' },
  stable: {
    contract: 'Write the story using scoped references.',
    tools: [
      {
        name: 'knowledge.read',
        description: 'Read an approved reference',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            enabled: { type: 'boolean' },
            offset: { type: 'number' },
          },
          required: ['id'],
          additionalProperties: false,
        },
      },
    ],
  },
  input: {
    task: 'Continue.',
    controls: { enabled: false, offset: 0 },
    source: { revision: 'source-1' },
    history: [],
    catalog: [],
    results: [],
  },
});
const first = (input = request()) => {
  const encoded = encodeChat(input);
  return { ...encoded, decoder: new ChatDecoder(encoded.context) };
};
const chunk = (delta: Json, finishReason: string | null = null, usage: Json = null): Json => ({
  id: 'chat-A',
  choices: [{ index: 0, delta, finish_reason: finishReason }],
  usage,
});
test('DeepSeek uses max_tokens and preserves thinking across tool continuation', () => {
  const input = request();
  input.modelId = 'deepseek-v4-pro';
  input.generation = { maxOutputTokens: 321, temperature: null, reasoningEffort: 'high' };
  const encoded = encodeChat(input, 'deepseek-chat-v1');
  expect(record(encoded.body)).toMatchObject({
    max_tokens: 321,
    thinking: { type: 'enabled' },
    reasoning_effort: 'high',
  });
  expect(record(encoded.body)).not.toHaveProperty('max_completion_tokens');
  const decoder = new ChatDecoder(encoded.context);
  decoder.accept(
    chunk({ reasoning_content: 'opaque reasoning', tool_calls: [tool()] }, 'tool_calls')
  );
  decoder.accept('[DONE]');
  const result = decoder.finish();
  expect(result.text).toBe('');
  const continued = encodeChat(next(input, result), 'deepseek-chat-v1');
  expect(record(continued.body).messages).toContainEqual(
    expect.objectContaining({ reasoning_content: 'opaque reasoning' })
  );
  expect(JSON.stringify(diagnosticChatBody(continued.body))).not.toContain('opaque reasoning');
  input.generation = { maxOutputTokens: 321, temperature: 0.7, reasoningEffort: 'none' };
  const disabled = record(encodeChat(input, 'deepseek-chat-v1').body);
  expect(disabled).toMatchObject({ thinking: { type: 'disabled' }, temperature: 0.7 });
  expect(disabled).not.toHaveProperty('reasoning_effort');
});
test('DeepSeek normalizes authored text parts and bootstrap assistant reasoning', () => {
  const input = request();
  input.modelId = 'deepseek-v4-flash';
  input.bootstrap = [
    {
      callId: 'bootstrap-1',
      name: 'knowledge.read',
      args: { id: 'lore-1' },
      result: 'known',
      denied: false,
    },
  ];
  const encoded = record(encodeChat(input, 'deepseek-chat-v1').body);
  expect(encoded.messages).toContainEqual(
    expect.objectContaining({ role: 'assistant', reasoning_content: '' })
  );
});
const tool = (
  index = 0,
  id = 'Call-A.Original',
  args = '{"id":"lore-1","enabled":false,"offset":0}'
): Json => ({
  index,
  id,
  type: 'function',
  function: { name: 'tool_0_knowledge_read', arguments: args },
});
function next(input: ProviderRequest, result: ProviderResult): ProviderRequest {
  return {
    ...structuredClone(input),
    opaqueState: result.opaqueState,
    input: {
      ...structuredClone(input.input),
      results: [
        ...(input.input.results as Json[]),
        ...result.toolCalls.map((item, index) => ({
          callId: item.id,
          name: item.name,
          args: item.arguments,
          result: index ? false : 0,
          denied: false,
        })),
      ],
    },
  };
}
function called(input = request()) {
  const run = first(input);
  run.decoder.accept(chunk({ tool_calls: [tool()] }, 'tool_calls'));
  run.decoder.accept('[DONE]');
  return run.decoder.finish();
}

describe('OpenAI-compatible Chat pure protocol (no live calls)', () => {
  test.each([
    { verbosity: 'low' },
    { reasoningMode: 'pro' },
    { reasoningContext: 'all_turns' },
    { outputEffort: 'high' },
    { thinkingLevel: 'HIGH' },
  ])('does not silently send or discard foreign native option %j', (options) => {
    const input = request();
    Object.assign(input.generation!, options);
    expect(() => encodeChat(input)).toThrow();
  });
  test('registered GPT Chat models retain Flex across exact tool continuation', () => {
    const input = request();
    input.modelId = 'gpt-5.6-sol';
    input.generation = {
      maxOutputTokens: 8192,
      temperature: null,
      reasoningEffort: 'high',
      serviceTier: 'flex',
    };
    const wire = record(encodeChat(input).body);
    expect(wire.service_tier).toBe('flex');
    expect(wire.reasoning_effort).toBe('high');
    const continued = next(input, called(input));
    expect(record(encodeChat(continued).body).service_tier).toBe('flex');
    continued.generation!.serviceTier = 'default';
    expect(() => encodeChat(continued)).toThrow('OPENAI_CONTINUATION_MISMATCH');
  });
  test('encodes the selected model and explicit options without assuming native structured output support', () => {
    const input = request();
    const original = structuredClone(input);
    const wire = record(encodeChat(input).body);
    expect(wire).toMatchObject({
      model: input.modelId,
      max_completion_tokens: 321,
      temperature: 0,
      reasoning_effort: 'none',
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(wire.tools[0]).toMatchObject({
      type: 'function',
      function: {
        name: 'tool_0_knowledge_read',
        strict: false,
        parameters: input.stable.tools[0].inputSchema,
      },
    });
    expect(wire.messages[0]).toMatchObject({ role: 'system' });
    expect(wire.messages[1]).toMatchObject({ role: 'user' });
    expect(wire).not.toHaveProperty('response_format');
    expect(wire).not.toHaveProperty('max_tokens');
    expect(input).toEqual(original);
  });

  test('assembles interleaved indexed calls, retains reasoning extensions, and matches results by exact original IDs', () => {
    const input = request();
    const run = first(input);
    run.decoder.accept(
      chunk({
        role: 'assistant',
        content: 'Observed. ',
        reasoning_content: 'PRIVATE_',
        reasoning_details: [{ type: 'reasoning.encrypted', data: 'ENCRYPTED_A', index: 0 }],
      })
    );
    run.decoder.accept(
      chunk({
        tool_calls: [
          tool(1, 'Call-B.Original', '{"id":"lore-2",'),
          tool(0, 'Call-A.Original', '{"id":"lore-1",'),
        ],
      })
    );
    run.decoder.accept(
      chunk({
        tool_calls: [
          { index: 0, function: { arguments: '"enabled":false,"offset":0}' } },
          { index: 1, function: { arguments: '"enabled":false,"offset":0}' } },
        ],
        reasoning_content: 'REASONING',
      })
    );
    expect(run.decoder.snapshot().toolCalls).toEqual([]);
    run.decoder.accept(chunk({}, 'tool_calls'));
    run.decoder.accept({
      id: 'chat-A',
      choices: [],
      usage: {
        prompt_tokens: 9,
        completion_tokens: 7,
        completion_tokens_details: { reasoning_tokens: 3 },
        total_tokens: 16,
      },
    });
    expect(() => run.decoder.finish()).toThrow('UNEXPECTED_EOF');
    run.decoder.accept('[DONE]');
    const result = run.decoder.finish();
    expect(result).toMatchObject({
      status: 'tool_calls',
      text: 'Observed. ',
      toolCalls: [
        {
          id: 'Call-A.Original',
          name: 'knowledge.read',
          arguments: { id: 'lore-1', enabled: false, offset: 0 },
        },
        { id: 'Call-B.Original', name: 'knowledge.read' },
      ],
      usage: { inputTokens: 9, outputTokens: 7, costUsd: null },
    });
    const continued = next(input, result);
    (continued.input.results as Json[]).reverse();
    const wire = record(encodeChat(continued).body);
    const assistant = wire.messages[2];
    expect(assistant).toMatchObject({
      role: 'assistant',
      content: 'Observed. ',
      reasoning_content: 'PRIVATE_REASONING',
      reasoning_details: [{ type: 'reasoning.encrypted', data: 'ENCRYPTED_A', index: 0 }],
    });
    expect(assistant.tool_calls.map((item: any) => item.id)).toEqual([
      'Call-A.Original',
      'Call-B.Original',
    ]);
    expect(assistant.tool_calls[0]).not.toHaveProperty('index');
    expect(wire.messages.slice(-2)).toEqual([
      { role: 'tool', tool_call_id: 'Call-A.Original', content: '0' },
      { role: 'tool', tool_call_id: 'Call-B.Original', content: 'false' },
    ]);
    expect(JSON.stringify(diagnosticChatBody(wire))).not.toMatch(/PRIVATE_REASONING|ENCRYPTED_A/);
    expect(assistant.reasoning_content).toBe('PRIVATE_REASONING');
    const second = first(continued);
    second.decoder.accept(chunk({ content: 'Final story.' }, 'stop'));
    second.decoder.accept('[DONE]');
    expect(second.decoder.finish()).toMatchObject({ status: 'completed', text: 'Final story.' });
  });

  test('requires both finish_reason and DONE; missing usage remains unknown', () => {
    const run = first();
    run.decoder.accept(chunk({ content: '등대 🌊' }));
    expect(() => run.decoder.accept('[DONE]')).toThrow('MISSING_FINISH_REASON');
    expect(() => run.decoder.finish()).toThrow('UNEXPECTED_EOF');
    const completed = first();
    completed.decoder.accept(chunk({ content: '등대 🌊' }, 'stop'));
    completed.decoder.accept('[DONE]');
    expect(completed.decoder.finish()).toMatchObject({
      status: 'completed',
      text: '등대 🌊',
      usage: { inputTokens: null, outputTokens: null, costUsd: null, raw: null },
    });
    expect(() => completed.decoder.accept(chunk({ content: ' late' }))).toThrow(
      'EVENT_AFTER_TERMINAL'
    );
  });

  test.each(['length', 'content_filter', 'refusal', 'error'] as const)(
    'preserves observed text and zero usage through %s',
    (mode) => {
      const run = first();
      run.decoder.accept(
        chunk({ content: 'Kept prefix' }, null, {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        })
      );
      if (mode === 'error')
        run.decoder.accept({ error: { message: 'PRIVATE_PROVIDER_DETAIL', type: 'server_error' } });
      else {
        run.decoder.accept(
          chunk(
            mode === 'refusal' ? { refusal: 'Cannot continue.' } : {},
            mode === 'refusal' ? 'stop' : mode
          )
        );
        run.decoder.accept('[DONE]');
      }
      expect(run.decoder.finish()).toMatchObject({
        status: mode === 'content_filter' || mode === 'refusal' ? 'refused' : 'partial',
        text: 'Kept prefix',
        usage: { inputTokens: 0, outputTokens: 0 },
      });
      expect(JSON.stringify(run.decoder.finish())).not.toContain('PRIVATE_PROVIDER_DETAIL');
    }
  );

  test.each([
    'missing-id',
    'unknown-name',
    'wrong-index',
    'duplicate-id',
    'array-args',
    'null-args',
    'scalar-args',
    'invalid-json',
    'stop-with-tools',
    'empty-tools',
    'legacy-call',
  ] as const)('rejects %s rather than inventing a tool identity', (mode) => {
    const run = first();
    const value = record(tool());
    let tools: Json[] = [value];
    let reason = 'tool_calls';
    if (mode === 'missing-id') delete value.id;
    if (mode === 'unknown-name') value.function.name = 'knowledge.read';
    if (mode === 'wrong-index') value.index = 2;
    if (mode === 'duplicate-id') tools.push({ ...value, index: 1 });
    if (mode === 'array-args') value.function.arguments = '[]';
    if (mode === 'null-args') value.function.arguments = 'null';
    if (mode === 'scalar-args') value.function.arguments = '0';
    if (mode === 'invalid-json') value.function.arguments = '{';
    if (mode === 'stop-with-tools') reason = 'stop';
    if (mode === 'empty-tools') tools = [];
    expect(() =>
      run.decoder.accept(
        chunk(
          mode === 'legacy-call'
            ? { function_call: { name: 'tool_0_knowledge_read', arguments: '{}' } }
            : { tool_calls: tools },
          reason
        )
      )
    ).toThrow();
  });

  test('rejects changed IDs and names for an already indexed tool delta', () => {
    const run = first();
    run.decoder.accept(chunk({ tool_calls: [tool(0, 'Call-A.Original', '')] }));
    expect(() =>
      run.decoder.accept(chunk({ tool_calls: [{ index: 0, id: 'Different' }] }))
    ).toThrow('TOOL_ID_MISMATCH');
    expect(() =>
      run.decoder.accept(chunk({ tool_calls: [{ index: 0, function: { name: 'Different' } }] }))
    ).toThrow('INVALID_TOOL_NAME');
  });

  test.each(['source', 'history', 'controls', 'stable', 'generation', 'model'] as const)(
    'binds continuation to original %s',
    (field) => {
      const input = request();
      const continued = next(input, called(input));
      if (field === 'stable') continued.stable.contract += ' changed';
      else if (field === 'generation') continued.generation!.maxOutputTokens++;
      else if (field === 'model') continued.modelId += '-other';
      else if (field === 'controls') continued.input.controls.extra = true;
      else continued.input[field] = { changed: true };
      expect(() => encodeChat(continued)).toThrow('OPENAI_CONTINUATION_MISMATCH');
    }
  );

  test('rejects wrong result names, reused call IDs, old-result mutation and cross-protocol continuation', () => {
    const input = request();
    const continued = next(input, called(input));
    const wrong = structuredClone(continued);
    record((wrong.input.results as Json[])[0]).name = 'wrong';
    expect(() => encodeChat(wrong)).toThrow('TOOL_RESULT_MISMATCH');
    const repeated = first(continued);
    expect(() => repeated.decoder.accept(chunk({ tool_calls: [tool()] }, 'tool_calls'))).toThrow(
      'DUPLICATE_TOOL_ID'
    );
    const second = first(continued);
    second.decoder.accept(chunk({ tool_calls: [tool(0, 'Call-B.Original')] }, 'tool_calls'));
    second.decoder.accept('[DONE]');
    const third = next(continued, second.decoder.finish());
    record((third.input.results as Json[])[0]).result = 'rewritten';
    expect(() => encodeChat(third)).toThrow('TOOL_RESULT_MISMATCH');
    const responses = encodeResponses(input);
    const decoder = new ResponsesDecoder(responses.context);
    decoder.accept({
      type: 'response.completed',
      response: {
        status: 'completed',
        output: [
          {
            type: 'function_call',
            call_id: 'responses-call',
            name: 'tool_0_knowledge_read',
            arguments: '{}',
          },
        ],
      },
    });
    expect(() => encodeChat(next(input, decoder.finish()))).toThrow('OPENAI_CONTINUATION_MISMATCH');
  });

  test('plain translation keeps tools and complete source across continuation without a JSON format', () => {
    const input = request();
    input.role = 'translation';
    input.input.source = {
      sourceRevision: 'source-1',
      sourceHash: 'hash-1',
      text: 'Turn LEFT. He served forty years.',
    };
    input.generation!.structuredOutput = true;
    const wire = record(encodeChat(input).body);
    expect(wire).not.toHaveProperty('response_format');
    expect(JSON.stringify(wire.messages)).toContain('Turn LEFT.');
    expect(wire.messages[0].content).toContain('complete translated text only');
    expect(wire.messages[0].content).not.toContain('Korean number words');
    const continued = next(input, called(input));
    expect(record(encodeChat(continued).body)).not.toHaveProperty('response_format');
    record(continued.input.source!).text = 'Different source';
    expect(() => encodeChat(continued)).toThrow('OPENAI_CONTINUATION_MISMATCH');
  });
  test('refusal classification does not receive translation output instructions', () => {
    const input = request();
    input.role = 'translation';
    input.input.controls.purpose = 'translation-refusal';
    input.stable.contract = 'Classify whether this response refused the task.';
    const wire = record(encodeChat(input).body);
    expect(JSON.stringify(wire.messages)).not.toContain('complete translated text only');
    expect(JSON.stringify(wire.messages)).toContain(input.stable.contract);
    expect(wire).not.toHaveProperty('response_format');
  });

  test.each(['thinkingLevel', 'thinkingMode', 'thinkingBudgetTokens'])(
    'rejects foreign generation option %s',
    (key) => {
      const input = request();
      Object.assign(input.generation!, { [key]: key === 'thinkingBudgetTokens' ? 1024 : 'LOW' });
      expect(() => encodeChat(input)).toThrow('UNSUPPORTED_GENERATION_OPTIONS');
    }
  );

  test('rejects multiple choices, swapped response IDs, negative usage and data after finish', () => {
    expect(() =>
      first().decoder.accept({
        choices: [
          { index: 0, delta: {} },
          { index: 1, delta: {} },
        ],
      })
    ).toThrow('UNSUPPORTED_MULTIPLE_CHOICES');
    const run = first();
    run.decoder.accept(chunk({ content: 'text' }));
    expect(() =>
      run.decoder.accept({ id: 'other', choices: [], usage: { prompt_tokens: 1 } })
    ).toThrow('RESPONSE_ID_MISMATCH');
    expect(() => run.decoder.accept(chunk({}, null, { completion_tokens: -1 }))).toThrow(
      'INVALID_USAGE'
    );
    const stopped = first();
    stopped.decoder.accept(chunk({ content: 'text' }, 'stop'));
    expect(() => stopped.decoder.accept(chunk({ content: 'extra' }))).toThrow('EVENT_AFTER_FINISH');
  });
});
