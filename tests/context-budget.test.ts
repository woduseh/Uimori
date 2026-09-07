import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { assertContextBudget, contextBudgetForModel, estimateContextTokens, validateContextBudget, type ContextBudget } from '../core/context-budget.js';
import { executeProvider, validateRequest, type Json, type ProviderConnection, type ProviderRequest, type ProviderResult } from '../core/transport.js';
import { encodeResponses, ResponsesDecoder } from '../core/openai-protocol.js';
import { encodeChat, ChatDecoder } from '../core/openai-chat-protocol.js';
import { encodeAnthropic, AnthropicDecoder } from '../core/anthropic-protocol.js';
import { encodeVertex, VertexDecoder } from '../core/vertex-protocol.js';
import { CodexRuntime } from '../server/codex-runtime.js';

const budget = (): ContextBudget => ({ inputTokenLimit: 8192, estimator: 'o200k_base-v1' });
const large = 'Long synthetic context. 긴 합성 문맥이에요. '.repeat(1600);
const variants = [
  { protocol: 'openai-responses-v1', endpoint: 'https://api.openai.com/v1', model: 'gpt-5.6-sol' },
  { protocol: 'openai-chat-v1', endpoint: 'https://api.openai.com/v1', model: 'gpt-5.6-sol' },
  { protocol: 'vercel-chat-v1', endpoint: 'https://ai-gateway.vercel.sh/v1', model: 'synthetic/routed-model' },
  { protocol: 'anthropic-messages-v1', endpoint: 'https://api.anthropic.com/v1', model: 'claude-opus-5' },
  { protocol: 'vertex-gemini-v1', endpoint: 'https://aiplatform.googleapis.com/v1/projects/synthetic-project/locations/global/publishers/google/models', model: 'gemini-3.8-flash' },
  { protocol: 'fixture-sse-v1', endpoint: 'http://127.0.0.1:18881', model: 'synthetic-model' },
] as const;
type Variant = typeof variants[number];
const connection = (variant: Variant): ProviderConnection => ({ id: 'context-budget-test', protocol: variant.protocol, endpoint: variant.endpoint, credentialEnv: 'NARRATIVE_PROVIDER_CONTEXT_TEST' });
const request = (variant = variants[0] as Variant): ProviderRequest => ({
  role: 'main', modelId: variant.model, contextBudget: budget(), generation: { maxOutputTokens: 1024, temperature: null },
  stable: { contract: 'Keep the source and current request intact.', tools: [{ name: 'knowledge.read', description: 'Read synthetic data', inputSchema: { type: 'object', properties: {} } }] },
  input: { task: 'Continue the complete current scene.', controls: {}, history: [], results: [] },
});
function encoded(input: ProviderRequest, variant: Variant) {
  if (variant.protocol === 'openai-responses-v1') return encodeResponses(input);
  if (variant.protocol === 'anthropic-messages-v1') return encodeAnthropic(input);
  if (variant.protocol === 'vertex-gemini-v1') return encodeVertex(input);
  return encodeChat(input);
}
function continued(input: ProviderRequest, variant: Variant, privateText = 'opaque synthetic provider state'): ProviderRequest {
  let result: ProviderResult;
  if (variant.protocol === 'openai-responses-v1') {
    const decoder = new ResponsesDecoder(encodeResponses(input).context);
    decoder.accept({ type: 'response.completed', response: { id: 'response-budget', status: 'completed', output: [
      { type: 'reasoning', id: 'reasoning-budget', summary: [], encrypted_content: privateText },
      { type: 'function_call', id: 'function-budget', call_id: 'call-budget', name: 'tool_0_knowledge_read', arguments: '{}', status: 'completed' },
    ] } });
    result = decoder.finish();
  } else if (variant.protocol === 'anthropic-messages-v1') {
    const decoder = new AnthropicDecoder(encodeAnthropic(input).context);
    decoder.accept({ type: 'message_start', message: { id: 'message-budget', type: 'message', role: 'assistant', model: input.modelId, content: [], stop_reason: null } });
    const parts = [{ type: 'thinking', thinking: 'synthetic reasoning', signature: privateText }, { type: 'tool_use', id: 'call-budget', name: 'tool_0_knowledge_read', input: {} }];
    for (const [index, content_block] of parts.entries()) { decoder.accept({ type: 'content_block_start', index, content_block }); decoder.accept({ type: 'content_block_stop', index }); }
    decoder.accept({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null } }); decoder.accept({ type: 'message_stop' });
    result = decoder.finish();
  } else if (variant.protocol === 'vertex-gemini-v1') {
    const decoder = new VertexDecoder(encodeVertex(input).context);
    decoder.accept({ candidates: [{ index: 0, content: { role: 'model', parts: [{ functionCall: { id: 'call-budget', name: 'knowledge.read', args: {} }, thoughtSignature: privateText }] }, finishReason: 'STOP' }] });
    result = decoder.finish();
  } else {
    const decoder = new ChatDecoder(encodeChat(input).context);
    decoder.accept({ id: 'chat-budget', choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: privateText, tool_calls: [{ index: 0, id: 'call-budget', type: 'function', function: { name: 'tool_0_knowledge_read', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] });
    decoder.accept('[DONE]'); result = decoder.finish();
  }
  expect(result.status).toBe('tool_calls');
  return { ...structuredClone(input), opaqueState: result.opaqueState, input: { ...structuredClone(input.input), results: result.toolCalls.map(call => ({ callId: call.id, name: call.name, args: call.arguments, result: { found: true }, denied: false })) } };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('offline host context budget', () => {
  test('uses stable multilingual o200k estimates with safety margin, including literal special-token spellings', () => {
    expect(estimateContextTokens('hello world')).toBe(5);
    expect(estimateContextTokens('안녕하세요. 오늘은 바다를 바라봐요.')).toBe(15);
    expect(estimateContextTokens('<|endoftext|>')).toBe(8);
    expect(estimateContextTokens('🌊 바다 🌊')).toBe(9);
    expect(estimateContextTokens(large)).toBeGreaterThan(8192);
    expect(estimateContextTokens(large)).toBeLessThan(Buffer.byteLength(large));
    const circular: Record<string, unknown> = {}; circular.self = circular;
    expect(() => estimateContextTokens(circular)).toThrow('INVALID_CONTEXT_INPUT');
    expect(() => estimateContextTokens(undefined)).toThrow('INVALID_CONTEXT_INPUT');
  });
  test('validates host policy strictly, preserves explicit limits and applies the model default', () => {
    expect(contextBudgetForModel({})).toEqual({ inputTokenLimit: 272000, estimator: 'o200k_base-v1' });
    expect(contextBudgetForModel({ inputTokenLimit: 8192 })).toEqual(budget());
    expect(contextBudgetForModel({ inputTokenLimit: 1000000 }).inputTokenLimit).toBe(1000000);
    expect(() => contextBudgetForModel({ inputTokenLimit: null } as unknown as { inputTokenLimit: number })).toThrow('INVALID_CONTEXT_BUDGET');
    for (const invalid of [null, [], {}, { inputTokenLimit: 8192 }, { ...budget(), extra: true }, { ...budget(), estimator: 'provider-exact' }, ...[0, 8191, 1000001, 8192.5, NaN, Infinity, '8192'].map(inputTokenLimit => ({ ...budget(), inputTokenLimit }))]) {
      expect(() => validateContextBudget(invalid)).toThrow('INVALID_CONTEXT_BUDGET');
      expect(() => validateRequest({ ...request(), contextBudget: invalid })).toThrow('INVALID_CONTEXT_BUDGET');
    }
    const checked = validateRequest(request()); expect(checked.contextBudget).toEqual(budget());
    expect(() => validateRequest({ ...request(), generation: { ...request().generation, inputTokenLimit: 8192 } })).toThrow('UNSUPPORTED_GENERATION_OPTIONS');
  });
  test('accepts the inclusive boundary and never mutates oversized payloads or silently imposes an absent policy', () => {
    const body = { current: large, history: ['must remain complete'] }, before = structuredClone(body);
    const count = estimateContextTokens(body);
    expect(() => assertContextBudget(body, { ...budget(), inputTokenLimit: count })).not.toThrow();
    expect(() => assertContextBudget(body, { ...budget(), inputTokenLimit: count - 1 })).toThrow('INPUT_CONTEXT_LIMIT_EXCEEDED');
    expect(() => assertContextBudget(body)).not.toThrow(); expect(body).toEqual(before);
  });
  test.each([
    { modelId: 'gpt-6-astra', protocol: 'openai-responses-v1', output: 128000, effective: 922000 },
    { modelId: 'gpt-5.6-sol', protocol: 'openai-chat-v1', output: 128000, effective: 922000 },
    { modelId: 'claude-opus-5', protocol: 'anthropic-messages-v1', output: 128000, effective: 872000 },
    { modelId: 'gemini-3.8-flash', protocol: 'vertex-gemini-v1', output: 65536, effective: 983040 },
  ] as const)('$protocol reserves the selected output inside the reviewed native window without rewriting settings', ({ modelId, protocol, output, effective }) => {
    const model = { inputTokenLimit: 1000000, modelId, maxOutputTokens: output, connection: { protocol } }, before = structuredClone(model);
    expect(contextBudgetForModel(model).inputTokenLimit).toBe(effective);
    expect(contextBudgetForModel({ ...model, maxOutputTokens: undefined }).inputTokenLimit).toBe(effective);
    expect(contextBudgetForModel({ ...model, inputTokenLimit: 8192 }).inputTokenLimit).toBe(8192);
    expect(contextBudgetForModel({ ...model, inputTokenLimit: undefined }).inputTokenLimit).toBe(272000);
    expect(model).toEqual(before);
  });
  test('does not invent a native window for Codex, a routed model or an unknown model ID', () => {
    for (const connection of [{ protocol: 'codex-app-server-v1' }, { protocol: 'vercel-chat-v1' }, { protocol: 'fixture-sse-v1' }] as const) {
      expect(contextBudgetForModel({ modelId: 'gpt-6-astra', connection }).inputTokenLimit).toBe(272000);
      expect(contextBudgetForModel({ modelId: 'gpt-6-astra', connection, inputTokenLimit: 1000000, maxOutputTokens: 128000 }).inputTokenLimit).toBe(1000000);
    }
    expect(contextBudgetForModel({ modelId: 'unreviewed', connection: { protocol: 'openai-chat-v1' }, inputTokenLimit: 1000000, maxOutputTokens: 128000 }).inputTokenLimit).toBe(1000000);
    expect(contextBudgetForModel({ modelId: 'gpt-6-astra', inputTokenLimit: 1000000, maxOutputTokens: 128000 }).inputTokenLimit).toBe(1000000);
  });
});

describe('final wire body budget before credentials and transmission', () => {
  test.each(variants)('$protocol rejects an oversized first request with zero credential, journal and fetch calls', async variant => {
    const input = request(variant); input.stable.contract = large; const before = structuredClone(input);
    const fetch = vi.fn(), resolveCredential = vi.fn(() => 'synthetic-secret'), onWire = vi.fn(); vi.stubGlobal('fetch', fetch);
    const result = await executeProvider(connection(variant), input, { signal: new AbortController().signal, approvedOrigins: [new URL(variant.endpoint).origin], resolveCredential, onWire });
    expect(result).toMatchObject({ status: 'error', error: { code: 'INPUT_CONTEXT_LIMIT_EXCEEDED' } });
    expect(resolveCredential).not.toHaveBeenCalled(); expect(onWire).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); expect(input).toEqual(before);
  });
  test.each(variants.slice(0, -1))('$protocol measures the native body, not duplicated raw snapshot fields', async variant => {
    const input = request(variant); input.input.history = [{ text: large }];
    input.prompt = { compilerVersion: 'uimori-prompt-1', values: {}, cachePlan: [], messages: [{ id: 'current', role: 'user', content: [{ type: 'text', text: input.input.task }], completion: 'complete', provenance: { blockId: 'current', origin: 'current' } }] };
    expect(estimateContextTokens(input)).toBeGreaterThan(8192); expect(estimateContextTokens(encoded(input, variant).body)).toBeLessThan(8192);
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => { const body = JSON.parse(String(init?.body)); expect(body).not.toHaveProperty('contextBudget'); expect(JSON.stringify(body)).not.toContain(large); return new Response(null, { status: 503 }); });
    const resolveCredential = vi.fn(() => 'synthetic-secret'), onWire = vi.fn(); vi.stubGlobal('fetch', fetch);
    const result = await executeProvider(connection(variant), input, { signal: new AbortController().signal, approvedOrigins: [new URL(variant.endpoint).origin], resolveCredential, onWire });
    expect(result.error?.code).toBe('HTTP_503'); expect(fetch).toHaveBeenCalledTimes(1); expect(resolveCredential).toHaveBeenCalledTimes(1); expect(onWire).toHaveBeenCalledTimes(1);
  });
  test.each(variants.slice(0, -1))('$protocol includes unredacted opaque continuation content in the budget before any wire work', async variant => {
    const input = continued(request(variant), variant, large), before = structuredClone(input);
    expect(estimateContextTokens(input.input)).toBeLessThan(8192); expect(estimateContextTokens(encoded(input, variant).body)).toBeGreaterThan(8192);
    const fetch = vi.fn(), resolveCredential = vi.fn(() => 'synthetic-secret'), onWire = vi.fn(); vi.stubGlobal('fetch', fetch);
    const result = await executeProvider(connection(variant), input, { signal: new AbortController().signal, approvedOrigins: [new URL(variant.endpoint).origin], resolveCredential, onWire });
    expect(result.error?.code).toBe('INPUT_CONTEXT_LIMIT_EXCEEDED'); expect(resolveCredential).not.toHaveBeenCalled(); expect(onWire).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); expect(input).toEqual(before);
  });
  test.each(variants.slice(0, -1))('$protocol binds the budget across native continuation, including adding or removing it', variant => {
    const input = continued(request(variant), variant);
    for (const contextBudget of [undefined, { ...budget(), inputTokenLimit: 16384 }]) expect(() => encoded({ ...input, contextBudget }, variant)).toThrow(/CONTINUATION_MISMATCH/);
    const initial = request(variant); delete initial.contextBudget;
    const unbudgeted = continued(initial, variant);
    expect(() => encoded({ ...unbudgeted, contextBudget: budget() }, variant)).toThrow(/CONTINUATION_MISMATCH/);
    expect(() => encoded(input, variant)).not.toThrow();
  });
  test('fixture continuation content is counted before credentials and journaling', async () => {
    const variant = variants.at(-1)!, input = request(variant); input.opaqueState = { providerContinuation: large };
    const fetch = vi.fn(), resolveCredential = vi.fn(() => 'synthetic-secret'), onWire = vi.fn(); vi.stubGlobal('fetch', fetch);
    const result = await executeProvider(connection(variant), input, { signal: new AbortController().signal, approvedOrigins: [new URL(variant.endpoint).origin], resolveCredential, onWire });
    expect(result.error?.code).toBe('INPUT_CONTEXT_LIMIT_EXCEEDED'); expect(resolveCredential).not.toHaveBeenCalled(); expect(onWire).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  test('Codex rejects its assembled instructions, input and schema before creating session state or a process', async () => {
    const dbPath = join(tmpdir(), `uimori-context-budget-${randomUUID()}`, 'db.sqlite');
    const runtime = new CodexRuntime(dbPath, { enabled: true, launch: { command: process.execPath, args: [resolve('tests/fixtures/codex-app-server.mjs')] } });
    const input = request(); input.stable.contract = large; const before = structuredClone(input), onWire = vi.fn(), beforeTurn = vi.fn();
    try {
      const result = await runtime.execute({ id: 'codex-budget', protocol: 'codex-app-server-v1', endpoint: 'codex://local' }, input, { signal: new AbortController().signal, approvedOrigins: [], onWire, beforeTurn });
      expect(result.error?.code).toBe('INPUT_CONTEXT_LIMIT_EXCEEDED'); expect(onWire).not.toHaveBeenCalled(); expect(beforeTurn).not.toHaveBeenCalled();
      expect(existsSync(`${dbPath}.codex`)).toBe(false); expect(input).toEqual(before);
    } finally { await runtime.close(); }
  });
});
