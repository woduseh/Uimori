import { describe, expect, test } from 'vitest';
import { encodeResponses, ResponsesDecoder, diagnosticResponsesBody } from '../core/openai-protocol.js';
import type { Json, ProviderRequest, ProviderResult } from '../core/transport.js';
const record = (value: Json) => value as Record<string, any>;
const request = (): ProviderRequest => ({ role: 'main', modelId: 'user-selected-model', generation: { maxOutputTokens: 321, temperature: 0, reasoningEffort: 'low' },
  stable: { contract: 'Write the source story. Local sources grant no tools.', tools: [
    { name: 'knowledge.read', description: 'Read allowed context', inputSchema: { type: 'object', properties: { id: { type: 'string' }, include: { type: 'boolean' }, limit: { type: 'number' } }, required: ['id'], additionalProperties: false } },
    { name: 'knowledge_read', description: 'Different host tool with a colliding sanitized name', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  ] }, input: { task: 'Continue.', controls: { flag: false, offset: 0 }, source: { revision: 'source-1', text: 'Scene.' }, catalog: [], history: [], results: [] } });
const first = (input = request()) => { const encoded = encodeResponses(input); return { ...encoded, decoder: new ResponsesDecoder(encoded.context) }; };
const message = (text: string): Json => ({ type: 'message', id: 'msg-A', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] });
const call = (id = 'Call-A.Original', name = 'tool_0_knowledge_read', args = '{"id":"lore-1","include":false,"limit":0}'): Json => ({ type: 'function_call', id: 'fc-A', call_id: id, name, arguments: args, status: 'completed' });
const terminal = (output: Json[], usage?: Json, status = 'completed'): Json => ({ type: `response.${status}`, response: { id: 'resp-A', status, output, ...(usage !== undefined ? { usage } : {}) } });
function next(input: ProviderRequest, result: ProviderResult): ProviderRequest { return { ...structuredClone(input), opaqueState: result.opaqueState,
  input: { ...structuredClone(input.input), results: [...input.input.results as Json[], ...result.toolCalls.map((tool, index) => ({ callId: tool.id, name: tool.name, args: tool.arguments, result: index ? false : 0, denied: false }))] } }; }

describe('native Responses pure protocol (no live calls)', () => {
  test('keeps editable model, explicit zero/reasoning, optional tool semantics and collision-free aliases', () => {
    const input = request(); const original = structuredClone(input); const body = record(encodeResponses(input).body);
    expect(body).toMatchObject({ model: 'user-selected-model', stream: true, store: false, max_output_tokens: 321, temperature: 0, reasoning: { effort: 'low' } });
    expect(body).not.toHaveProperty('previous_response_id'); expect(body).not.toHaveProperty('include');
    expect(body.tools.map((tool: any) => tool.name)).toEqual(['tool_0_knowledge_read', 'tool_1_knowledge_read']);
    expect(body.tools[0]).toMatchObject({ strict: false, parameters: input.stable.tools[0].inputSchema });
    expect(JSON.parse(body.input[0].content[0].text.split('\n').slice(1).join('\n')).controls).toEqual({ flag: false, offset: 0 });
    expect(input).toEqual(original);
    input.generation = undefined; input.stable.tools = [];
    const minimal = record(encodeResponses(input).body);
    expect(minimal).not.toHaveProperty('reasoning'); expect(minimal).not.toHaveProperty('temperature'); expect(minimal).not.toHaveProperty('tools');
  });

  test('assembles tool argument deltas and replays full signed reasoning/items with exact original call IDs', () => {
    const input = request(); const run = first(input);
    const reasoning = { type: 'reasoning', id: 'rs-A', summary: [{ type: 'summary_text', text: 'PRIVATE_SUMMARY' }], encrypted_content: 'ENCRYPTED_REASONING', future: { value: false } };
    run.decoder.accept({ type: 'response.output_item.added', output_index: 0, item: reasoning });
    const item = record(call());
    run.decoder.accept({ type: 'response.output_item.added', output_index: 1, item: { ...item, arguments: '', status: 'in_progress' } });
    for (const delta of ['{"id":"lore-1",', '"include":false,', '"limit":0}']) run.decoder.accept({ type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc-A', delta });
    expect(run.decoder.snapshot().toolCalls).toEqual([]);
    run.decoder.accept({ type: 'response.function_call_arguments.done', output_index: 1, item_id: 'fc-A', arguments: item.arguments });
    run.decoder.accept({ type: 'response.output_item.done', output_index: 1, item });
    const secondCall = { ...record(call('Call-B.Original')), id: 'fc-B' };
    run.decoder.accept(terminal([reasoning, item, secondCall], { input_tokens: 12, output_tokens: 7, output_tokens_details: { reasoning_tokens: 3 }, total_tokens: 19 }));
    const result = run.decoder.finish();
    expect(result).toMatchObject({ status: 'tool_calls', text: '', toolCalls: [{ id: 'Call-A.Original', name: 'knowledge.read', arguments: { id: 'lore-1', include: false, limit: 0 } }, { id: 'Call-B.Original', name: 'knowledge.read' }], usage: { inputTokens: 12, outputTokens: 7, costUsd: null } });
    const continued = next(input, result); (continued.input.results as Json[]).reverse();
    const wire = record(encodeResponses(continued).body);
    expect(wire.input.slice(1, 4)).toEqual([reasoning, item, secondCall]);
    expect(wire.input.slice(-2)).toEqual([{ type: 'function_call_output', call_id: 'Call-A.Original', output: '0' }, { type: 'function_call_output', call_id: 'Call-B.Original', output: 'false' }]);
    expect(JSON.stringify(diagnosticResponsesBody(wire))).not.toMatch(/PRIVATE_SUMMARY|ENCRYPTED_REASONING/);
    expect(wire.input[1]).toEqual(reasoning);
    const third = first(continued); third.decoder.accept(terminal([message('Final story.')], { input_tokens: 0, output_tokens: 2 }));
    expect(third.decoder.finish()).toMatchObject({ status: 'completed', text: 'Final story.', usage: { inputTokens: 0, outputTokens: 2 } });
  });

  test('streamed message deltas and done snapshots do not duplicate visible text or lose annotations', () => {
    const run = first();
    run.decoder.accept({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg-A', role: 'assistant', status: 'in_progress', content: [] } });
    run.decoder.accept({ type: 'response.content_part.added', output_index: 0, item_id: 'msg-A', content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    for (const delta of ['등대 🌊', ' is lit.']) run.decoder.accept({ type: 'response.output_text.delta', output_index: 0, item_id: 'msg-A', content_index: 0, delta });
    expect(run.decoder.snapshot().text).toBe('등대 🌊 is lit.');
    run.decoder.accept({ type: 'response.output_text.done', output_index: 0, item_id: 'msg-A', content_index: 0, text: '등대 🌊 is lit.' });
    const item = record(message('등대 🌊 is lit.')); item.content[0].annotations = [{ type: 'future_annotation', value: 0 }];
    run.decoder.accept({ type: 'response.output_item.done', output_index: 0, item });
    run.decoder.accept(terminal([item]));
    expect(run.decoder.finish().text).toBe('등대 🌊 is lit.');
    expect(record(run.decoder.finish().opaqueState!).input.at(-1)).toEqual(item);
    expect(run.decoder.finish().usage).toEqual({ inputTokens: null, outputTokens: null, costUsd: null, raw: null, priceRevision: null });
  });

  test('requires a terminal event and preserves observed text when the provider fails', () => {
    const run = first(); run.decoder.accept({ type: 'response.output_item.done', output_index: 0, item: message('Kept prefix') });
    expect(() => run.decoder.finish()).toThrow('UNEXPECTED_EOF');
    run.decoder.accept(terminal([], { input_tokens: 8, output_tokens: 2 }, 'failed'));
    expect(run.decoder.finish()).toMatchObject({ status: 'partial', text: 'Kept prefix', error: { code: 'PROVIDER_ERROR' }, usage: { inputTokens: 8, outputTokens: 2 } });
  });

  test('does not parse or execute truncated arguments on an incomplete response', () => {
    const run = first();
    run.decoder.accept({ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
      output: [message('Observed before cutoff'), { ...record(call()), arguments: '{"id":', status: 'incomplete' }], usage: { input_tokens: 5, output_tokens: 3 } } });
    expect(run.decoder.finish()).toMatchObject({ status: 'partial', text: 'Observed before cutoff', toolCalls: [], error: { code: 'MAX_OUTPUT_TOKENS' }, usage: { inputTokens: 5, outputTokens: 3 } });
    expect(() => encodeResponses(next(request(), run.decoder.finish()))).toThrow('TOOL_RESULT_MISMATCH');
  });

  test('rejects provider output item ID reuse independently from tool call IDs', () => {
    const input = request(); const run = first(input); run.decoder.accept(terminal([call()]));
    const second = first(next(input, run.decoder.finish()));
    expect(() => second.decoder.accept(terminal([call('Different-Call-ID')]))).toThrow('DUPLICATE_OUTPUT_ITEM_ID');
  });

  test('redacts opaque reasoning objects while retaining configured reasoning effort', () => {
    const body: Json = { reasoning: { effort: 'low' }, input: [{ role: 'assistant', content: null, reasoning: { content: 'PRIVATE_REASONING_OBJECT', encrypted_data: 'PRIVATE_ENCRYPTED' } }] };
    const diagnostic = record(diagnosticResponsesBody(body));
    expect(diagnostic.reasoning).toEqual({ effort: 'low' });
    expect(JSON.stringify(diagnostic)).not.toMatch(/PRIVATE_REASONING_OBJECT|PRIVATE_ENCRYPTED/);
    expect(record(body).input[0].reasoning.content).toBe('PRIVATE_REASONING_OBJECT');
  });

  test.each(['refusal', 'content_filter', 'max_output_tokens', 'empty'] as const)('distinguishes terminal %s', mode => {
    const run = first();
    if (mode === 'refusal') run.decoder.accept(terminal([{ ...record(message('')), content: [{ type: 'refusal', refusal: 'Cannot provide that.' }] }]));
    else if (mode === 'empty') run.decoder.accept(terminal([]));
    else run.decoder.accept({ type: 'response.incomplete', response: { status: 'incomplete', output: [message('Observed')], incomplete_details: { reason: mode }, usage: null } });
    expect(run.decoder.finish()).toMatchObject(mode === 'refusal' || mode === 'content_filter' ? { status: 'refused' } : mode === 'empty' ? { status: 'error', error: { code: 'EMPTY_RESPONSE' } } : { status: 'partial', error: { code: 'MAX_OUTPUT_TOKENS' } });
  });

  test.each(['missing-id', 'duplicate-id', 'unknown-name', 'array-args', 'null-args', 'scalar-args', 'invalid-json'] as const)('rejects malformed tool %s without fallback', mode => {
    const run = first(); const item = record(call()); let output: Json[] = [item];
    if (mode === 'missing-id') delete item.call_id;
    if (mode === 'duplicate-id') output.push({ ...item, id: 'fc-B' });
    if (mode === 'unknown-name') item.name = 'knowledge.read';
    if (mode === 'array-args') item.arguments = '[]';
    if (mode === 'null-args') item.arguments = 'null';
    if (mode === 'scalar-args') item.arguments = 'false';
    if (mode === 'invalid-json') item.arguments = '{';
    expect(() => run.decoder.accept(terminal(output))).toThrow();
  });

  test.each(['task', 'source', 'history', 'stable', 'generation', 'role', 'model'] as const)('binds continuation to original %s', field => {
    const input = request(); const run = first(input); run.decoder.accept(terminal([call()])); const continued = next(input, run.decoder.finish());
    if (field === 'stable') continued.stable.contract += ' changed';
    else if (field === 'generation') continued.generation!.temperature = 1;
    else if (field === 'role') continued.role = 'status';
    else if (field === 'model') continued.modelId += '-changed';
    else if (field === 'task') continued.input.task += ' changed';
    else continued.input[field] = { changed: true };
    expect(() => encodeResponses(continued)).toThrow('OPENAI_CONTINUATION_MISMATCH');
  });

  test.each(['missing', 'extra', 'duplicate', 'wrong-id', 'wrong-name', 'tampered-state', 'reused-id'] as const)('rejects %s tool continuation', mode => {
    const input = request(); const run = first(input); run.decoder.accept(terminal([call()])); const continued = next(input, run.decoder.finish()); const results = continued.input.results as Json[];
    if (mode === 'missing') results.pop();
    if (mode === 'extra' || mode === 'duplicate') results.push(structuredClone(results[0]));
    if (mode === 'wrong-id') record(results[0]).callId = 'not-original';
    if (mode === 'wrong-name') record(results[0]).name = 'knowledge_read';
    if (mode === 'tampered-state') record(continued.opaqueState!).bindingHash = 'changed';
    if (mode === 'reused-id') { const second = first(continued); expect(() => second.decoder.accept(terminal([{ ...record(call()), id: 'fresh-output-item' }]))).toThrow('DUPLICATE_TOOL_ID'); }
    else expect(() => encodeResponses(continued)).toThrow();
  });

  test('native translation output schema is source-bound and can be explicitly disabled', () => {
    const input = request(); input.role = 'translation'; input.input.source = { sourceRevision: 'source-1', sourceHash: 'hash-1', chunkId: 'chunk-1', outputSchema: { text: 'EXAMPLE_ONLY' } };
    const encoded = record(encodeResponses(input).body);
    expect(encoded.text.format).toMatchObject({ type: 'json_schema', strict: true, schema: { additionalProperties: false, properties: { sourceRevision: { enum: ['source-1'] } } } });
    expect(encoded.instructions).toContain('Korean number words'); expect(JSON.stringify(encoded.input)).not.toContain('EXAMPLE_ONLY');
    input.generation!.structuredOutput = false;
    const plain = record(encodeResponses(input).body); expect(plain).not.toHaveProperty('text'); expect(JSON.stringify(plain.input)).toContain('EXAMPLE_ONLY');
  });

  test('keeps every selected Responses option alongside the translation schema and signed continuation', () => {
    const input = request(); input.modelId = 'gpt-5.6-sol'; input.role = 'translation';
    input.generation = { maxOutputTokens: 8192, temperature: null, reasoningEffort: 'high', verbosity: 'low', reasoningMode: 'pro', reasoningContext: 'all_turns', serviceTier: 'flex' };
    input.input.source = { sourceRevision: 'source-1', sourceHash: 'hash-1', chunkId: 'chunk-1' };
    const run = first(input); const wire = record(run.body);
    expect(wire.reasoning).toEqual({ effort: 'high', mode: 'pro', context: 'all_turns' });
    expect(wire.text.verbosity).toBe('low'); expect(wire.text.format.schema.properties.sourceHash.enum).toEqual(['hash-1']);
    expect(wire.service_tier).toBe('flex'); expect(record(diagnosticResponsesBody(run.body)).reasoning).toEqual(wire.reasoning);
    const reasoning = { type: 'reasoning', id: 'rs-options', encrypted_content: 'PRIVATE_CONTINUATION' };
    run.decoder.accept(terminal([reasoning, call()]));
    const continued = next(input, run.decoder.finish()); const replay = record(encodeResponses(continued).body);
    expect(replay.input).toContainEqual(reasoning); expect(replay.reasoning).toEqual(wire.reasoning); expect(replay.text).toEqual(wire.text);
    expect(JSON.stringify(diagnosticResponsesBody(replay))).not.toContain('PRIVATE_CONTINUATION');
    continued.generation!.reasoningContext = 'current_turn';
    expect(() => encodeResponses(continued)).toThrow('OPENAI_CONTINUATION_MISMATCH');
  });

  test('omits unselected reasoning and verbosity while rejecting unsupported Astra effort', () => {
    const input = request(); input.modelId = 'gpt-6-astra'; input.generation = { maxOutputTokens: 8192, temperature: null };
    const wire = record(encodeResponses(input).body);
    expect(wire).not.toHaveProperty('reasoning'); expect(wire).not.toHaveProperty('text'); expect(wire).not.toHaveProperty('service_tier');
    input.generation.reasoningEffort = 'none'; expect(() => encodeResponses(input)).toThrow();
  });

  test.each(['explicit','automatic','disabled'] as const)('Responses cache %s reaches requests without a native prompt and preserves translation formatting', cacheMode => {
    const input=request();input.modelId='gpt-5.6-sol';input.role='translation';
    input.generation={maxOutputTokens:8192,temperature:null,cacheMode,...(cacheMode==='disabled'?{}:{cacheTtl:'30m' as const}),verbosity:'low'};
    input.input.source={sourceRevision:'source-cache',sourceHash:'hash-cache',chunkId:'chunk-cache'};
    const wire=record(encodeResponses(input).body);
    expect(wire.prompt_cache_options).toEqual({mode:cacheMode==='automatic'?'implicit':'explicit',...(cacheMode==='disabled'?{}:{ttl:'30m'})});
    expect(wire.text.verbosity).toBe('low');expect(wire.text.format.schema.properties.sourceHash.enum).toEqual(['hash-cache']);
    expect(JSON.stringify(wire)).not.toContain('prompt_cache_breakpoint');
    const run=first(input);run.decoder.accept(terminal([call()]));const continued=next(input,run.decoder.finish());
    expect(record(encodeResponses(continued).body).prompt_cache_options).toEqual(wire.prompt_cache_options);
    continued.generation!.cacheMode=cacheMode==='explicit'?'automatic':'explicit';
    expect(()=>encodeResponses(continued)).toThrow('OPENAI_CONTINUATION_MISMATCH');
  });

  test('never mistakes content disguised as a reasoning setting for safe diagnostics', () => {
    const body: Json = { reasoning: { effort: 'PRIVATE_THOUGHT' }, nested: { reasoning: { mode: 'pro', context: 'PRIVATE_THOUGHT' } } };
    expect(JSON.stringify(diagnosticResponsesBody(body))).not.toContain('PRIVATE_THOUGHT');
  });

  test.each(['thinkingLevel', 'thinkingMode', 'thinkingBudgetTokens'])('rejects foreign generation option %s', key => {
    const input = request(); Object.assign(input.generation!, { [key]: key === 'thinkingBudgetTokens' ? 1024 : 'LOW' });
    expect(() => encodeResponses(input)).toThrow('UNSUPPORTED_GENERATION_OPTIONS');
  });

  test('rejects swapped stream item IDs, response IDs, replayed sequence numbers and negative usage', () => {
    const run = first(); run.decoder.accept({ type: 'response.created', sequence_number: 1, response: { id: 'response-1' } });
    expect(() => run.decoder.accept({ type: 'response.in_progress', sequence_number: 1, response: { id: 'response-1' } })).toThrow('INVALID_EVENT_SEQUENCE');
    expect(() => run.decoder.accept({ type: 'response.in_progress', response: { id: 'response-2' } })).toThrow('RESPONSE_ID_MISMATCH');
    const other = first(); other.decoder.accept({ type: 'response.output_item.added', output_index: 0, item: { ...record(call()), arguments: '' } });
    expect(() => other.decoder.accept({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'different', delta: '{}' })).toThrow('OUTPUT_ITEM_MISMATCH');
    expect(() => first().decoder.accept(terminal([message('text')], { input_tokens: -1, output_tokens: 1 }))).toThrow('INVALID_USAGE');
  });
});
