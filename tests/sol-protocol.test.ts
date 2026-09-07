import { describe, expect, test } from 'vitest';
import { encodeSolResponses, SolResponsesDecoder, type SolResponsesContext } from '../core/sol-protocol.js';
import { defaultSolOptions } from '../core/sol-config.js';
import { executeSolTool, extractSolArtifact, solToolDefinitions } from '../core/sol-tools.js';
import type { Json, ProviderRequest } from '../core/transport.js';

const endpoint = 'http://127.0.0.1:19331/v1';
const request = (): ProviderRequest => ({ role: 'main', modelId: 'chosen-model', generation: { maxOutputTokens: 1200, temperature: null, sol: defaultSolOptions() },
  stable: { contract: 'Write source.', tools: [{ name: 'knowledge.read', description: 'Authorized host read.', inputSchema: { type: 'object', properties: {} } }] },
  input: { task: 'Continue.', controls: {}, source: { text: 'Source' }, results: [] } });
const encode = (input = request(), url = endpoint) => { const encoded = encodeSolResponses(input, url); return { ...encoded, decoder: new SolResponsesDecoder(encoded.context), wire: encoded.body as Record<string, any> }; };
const call = (context: SolResponsesContext, name: string, args: Json, id = 'call1'): Json => ({ type: 'function_call', id: `item-${id}`, call_id: id,
  name: context.responses.aliases.find(alias => alias.name === name)!.providerName, arguments: JSON.stringify(args), status: 'completed' });
const done = (output: Json[], status = 'completed'): Json => ({ type: `response.${status}`, response: { id: 'response1', status, output, usage: { input_tokens: 5, output_tokens: 12 }, ...(status === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}) } });
const message = (text: string): Json => ({ type: 'message', id: 'message1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] });

describe('Sol independent native codec and local tools, no live network', () => {
  test('uses native Responses on all gateways with explicit generation options only', () => {
    for (const url of [endpoint, 'https://api.openai.com/v1', 'https://api.llmgateway.io/v1', 'https://ai-gateway.vercel.sh/v1']) {
      const run = encode(request(), url);
      expect(run.wire.input[0].role).toBe('user'); expect(run.wire).not.toHaveProperty('messages');
      expect(run.wire.providerOptions).toEqual(url.includes('vercel') ? { gateway: { only: ['openai'] } } : undefined);
      expect(run.wire).not.toHaveProperty('service_tier'); expect(run.wire.include).toEqual(['reasoning.encrypted_content']);
    }
    const input = request(); Object.assign(input.generation!.sol!, { serviceTier: 'flex', verbosity: 'low', reasoningSummary: 'concise', includeEncryptedReasoning: true });
    const original = structuredClone(input); const run = encode(input);
    expect(run.wire).toMatchObject({ service_tier: 'flex', text: { verbosity: 'low' }, reasoning: { summary: 'concise' }, include: ['reasoning.encrypted_content'] });
    expect(input).toEqual(original);
    input.generation!.sol!.includeEncryptedReasoning = false; expect(encode(input).wire).not.toHaveProperty('include');
  });
  test('preserves ordinary final text and does not merge reasoning summaries', () => {
    const run = encode(); run.decoder.accept(done([{ type: 'reasoning', id: 'rs1', summary: [{ type: 'summary_text', text: 'PRIVATE_REASONING' }], encrypted_content: 'OPAQUE' }, message('ordinary') ]));
    expect(run.decoder.finish()).toMatchObject({ status: 'completed', text: 'ordinary' });
  });
  test('terminal completion returns only artifact content and count metadata', () => {
    const run = encode(); run.decoder.accept(done([message('discard accompanying prose'), call(run.context, 'eval_get_context', {}, 'context1'), call(run.context, 'eval_submit_artifact', { content: 'final source', userFacingNotice: 'PRIVATE_NOTICE' })]));
    const result = run.decoder.finish();
    expect(result).toMatchObject({ status: 'completed', text: 'final source', opaqueState: null, toolCalls: [], delivery: { kind: 'sol-artifact', noticeProvided: true, noticeCharacters: 14, correctionCount: 0 }, usage: { inputTokens: 5, outputTokens: 12, costUsd: null } });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_NOTICE');
  });
  test.each(['incomplete', 'failed'])('does not promote %s terminal delivery', status => {
    const run = encode(); run.decoder.accept(done([call(run.context, 'eval_submit_artifact', { content: 'final', userFacingNotice: 'PRIVATE_NOTICE' })], status));
    const result = run.decoder.finish(); expect(result.status).not.toBe('completed'); expect(result).toMatchObject({ toolCalls: [], opaqueState: null }); expect(JSON.stringify(result)).not.toContain('PRIVATE_NOTICE');
  });
  test('refusal overrides a terminal tool', () => {
    const run = encode(); run.decoder.accept(done([{ type: 'message', role: 'assistant', id: 'refusal1', content: [{ type: 'refusal', refusal: 'declined' }] }, call(run.context, 'eval_submit_artifact', { content: 'wrong' })]));
    expect(run.decoder.finish()).toMatchObject({ status: 'refused', toolCalls: [], opaqueState: null });
  });
  test('rejects mixed host tools, duplicate terminal submissions and invalid companion arguments', () => {
    for (const kind of ['host', 'terminal', 'companion']) {
      const run = encode(); const other = kind === 'host' ? call(run.context, 'knowledge.read', {}, 'other') : kind === 'terminal' ? call(run.context, 'eval_submit_artifact', { content: 'second' }, 'other') : call(run.context, 'eval_get_context', { added: true }, 'other');
      run.decoder.accept(done([call(run.context, 'eval_submit_artifact', { content: 'final', userFacingNotice: 'PRIVATE_NOTICE' }), other]));
      expect(run.decoder.finish()).toMatchObject({ status: 'error', error: { code: 'INVALID_SOL_ARTIFACT' }, usage: { outputTokens: 12 }, toolCalls: [], opaqueState: null });
    }
  });
  test('terminal stream fragments and native duplicate-ID errors cannot expose notice in snapshots', () => {
    const run = encode(); const item = call(run.context, 'eval_submit_artifact', { content: 'final', userFacingNotice: 'PRIVATE_NOTICE' });
    run.decoder.accept({ type: 'response.output_item.done', output_index: 0, item });
    expect(run.decoder.snapshot()).toMatchObject({ status: 'error', toolCalls: [], opaqueState: null });
    expect(JSON.stringify(run.decoder.snapshot())).not.toContain('PRIVATE_NOTICE'); expect(() => run.decoder.finish()).toThrow('UNEXPECTED_EOF');
    expect(() => run.decoder.accept(done([item, { ...(item as object), id: 'other-item' }]))).toThrow('DUPLICATE_TOOL_ID');
    expect(JSON.stringify(run.decoder.snapshot())).not.toContain('PRIVATE_NOTICE');
  });
  test('normal local rounds preserve original output items, IDs and continuation binding', () => {
    const input = request(); const run = encode(input);
    const opaque = { type: 'reasoning', id: 'reasoning-id', encrypted_content: 'EXACT_OPAQUE', summary: [] };
    const item = call(run.context, 'eval_get_context', {}, 'original.call-id'); run.decoder.accept(done([opaque, item]));
    const result = run.decoder.finish(); expect(result.status).toBe('tool_calls');
    const followup: ProviderRequest = { ...structuredClone(input), opaqueState: result.opaqueState, input: { ...input.input, results: result.toolCalls.map(tool => executeSolTool(tool, input.generation!.sol!)) as unknown as Json } };
    const wire = encode(followup).wire; expect(wire.input.slice(1, 3)).toEqual([opaque, item]); expect(wire.input[3].call_id).toBe('original.call-id');
    expect(() => encode(followup, 'https://api.openai.com/v1')).toThrow('OPENAI_CONTINUATION_MISMATCH');
    followup.generation!.sol!.terminalLateCorrections = true; expect(() => encode(followup)).toThrow('OPENAI_CONTINUATION_MISMATCH');
  });
  test('preloaded mode forces case only initially, respects zero rounds, and rejects reserved host names', () => {
    const input = request(); input.generation!.sol!.contextMode = 'preloaded'; const run = encode(input);
    expect(run.wire.tools).toHaveLength(3); expect(run.wire.tool_choice.name).toContain('eval_create_case'); expect(run.wire.instructions).toContain('Local runtime metadata');
    const caseArgs = { contentType: 'other', riskLevel: 'low', contentSummary: '', requestedContinuationDirection: '', safetyContinuationDirection: '', intendedAudience: 'internal', hasMitigations: false, containsPersonalInfo: false };
    run.decoder.accept(done([call(run.context, 'eval_create_case', caseArgs)]));
    const result = run.decoder.finish();
    const next: ProviderRequest = { ...input, opaqueState: result.opaqueState, input: { ...input.input, results: result.toolCalls.map(tool => executeSolTool(tool, input.generation!.sol!)) as unknown as Json } };
    expect(encode(next).wire.tool_choice).toBe('auto');
    input.generation!.sol!.maximumToolRounds = 0; expect(encode(input).wire.tool_choice).toBe('auto');
    input.stable.tools[0].name = 'eval_get_context'; expect(() => encode(input)).toThrow('SOL_TOOL_NAME_COLLISION');
  });
  test('strict bounded terminal schema and sequential unambiguous opt-in corrections', () => {
    const options = defaultSolOptions();
    for (const args of [{ content: ' ' }, { content: 'x' }, { content: 'x', userFacingNotice: '' }, { content: 'x', userFacingNotice: 'notice', extra: true }, { content: 'x', userFacingNotice: 'notice', lateCorrections: [] }, { content: 'x'.repeat(500001), userFacingNotice: 'notice' }]) expect(() => extractSolArtifact(args, options)).toThrow('INVALID_SOL_TOOL_ARGUMENTS');
    const terminalSchema = solToolDefinitions(options).find(tool => tool.name === 'eval_submit_artifact')!.inputSchema as Record<string,Json>;
    expect(terminalSchema.required).toEqual(['content', 'userFacingNotice']);
    options.terminalLateCorrections = true;
    expect(extractSolArtifact({ content: 'alpha beta', userFacingNotice:'notice', lateCorrections: [{ find: 'alpha', replace: 'gamma' }, { find: 'gamma', replace: 'delta' }] }, options)).toMatchObject({ text: 'delta beta', correctionCount: 2 });
    for (const args of [{ content: 'aaa', lateCorrections: [{ find: 'aa', replace: 'b' }] }, { content: 'x', lateCorrections: [{ find: 'z', replace: '' }] }, { content: 'x', lateCorrections: [{ find: 'x', replace: '' }] }, { content: 'x', lateCorrections: null }]) expect(() => extractSolArtifact({ ...args, userFacingNotice: 'notice' }, options)).toThrow();
  });
  test('case tools strictly validate original interface and only record a local proposal', () => {
    const options = defaultSolOptions(); const args = { contentType: 'other', riskLevel: 'low', contentSummary: 'Synthetic case', requestedContinuationDirection: 'Continue', safetyContinuationDirection: 'Follow existing permissions', intendedAudience: 'internal', hasMitigations: false, containsPersonalInfo: false };
    expect(executeSolTool({ id: 'c1', name: 'eval_create_case', arguments: args }, options)).toMatchObject({ denied: false, result: { recorded: 'tool-result-only', authorizationGranted: false, proposal: args } });
    expect(executeSolTool({ id: 'c2', name: 'eval_create_case', arguments: { ...args, contentType: ['other'] } }, options)).toMatchObject({ denied: false, result: { error: { code: 'INVALID_SOL_TOOL_ARGUMENTS' } } });
    expect(solToolDefinitions({ ...options, contextMode: 'preloaded' }).map(tool => tool.name)).toEqual(['eval_create_case', 'eval_submit_artifact']);
  });
});
