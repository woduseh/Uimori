import { expect, test, vi } from 'vitest';
import {
  buildCodexDescriptor,
  buildCodexTurn,
  CODEX_ENDPOINT,
  decodeCodexOutput,
  TEXT_BASE_INSTRUCTIONS,
} from '../core/codex-protocol.js';
import { executeProvider, validateConnection, type ProviderRequest } from '../core/transport.js';

const connection = {
  id: 'codex',
  protocol: 'codex-app-server-v1' as const,
  endpoint: CODEX_ENDPOINT,
};
const request = (): ProviderRequest => ({
  role: 'main',
  modelId: 'synthetic',
  stable: {
    contract: '',
    tools: [
      {
        name: 'resource.read',
        description: 'Read authorized resource',
        inputSchema: { type: 'object' },
      },
    ],
  },
  generation: { maxOutputTokens: 1000, temperature: null },
  input: { task: 'Write', controls: {} },
});
const encode = (kind: string, text: string, toolCalls: unknown[] = []) =>
  JSON.stringify({ kind, text, toolCalls });

test('all provider roles use injected Codex execution without HTTP authority or credentials', async () => {
  const run = vi.fn(async () => decodeCodexOutput(encode('final', 'result'), request()));
  for (const role of ['main', 'translation', 'image', 'script', 'context', 'helper'] as const) {
    const result = await executeProvider(
      connection,
      { ...request(), role },
      { signal: new AbortController().signal, executeCodex: run }
    );
    expect(result.status).toBe('completed');
    expect(result.usage.costUsd).toBeNull();
  }
  expect(run).toHaveBeenCalledTimes(6);
  expect(
    (
      await executeProvider(connection, request(), {
        signal: new AbortController().signal,
      })
    ).error?.code
  ).toBe('CODEX_UNAVAILABLE');
  expect(() => validateConnection({ ...connection, credentialRef: 'SECRET' })).toThrow(
    'INVALID_CODEX_CONNECTION'
  );
  expect(() => validateConnection({ ...connection, endpoint: 'codex://other' })).toThrow(
    'INVALID_CODEX_CONNECTION'
  );
  await expect(
    executeProvider(
      connection,
      { ...request(), generation: { ...request().generation!, structuredOutput: false } },
      { signal: new AbortController().signal, executeCodex: run }
    )
  ).rejects.toThrow('UNSUPPORTED_GENERATION_OPTIONS');
});

test('preserves ordered logical roles and explicit empty instructions while rejecting unsupported semantics', () => {
  const r = request();
  r.prompt = {
    compilerVersion: 'risu-native-prompt-2',
    cachePlan: [],
    values: {},
    messages: ['system', 'user', 'assistant'].map((role, index) => ({
      id: `m${index}`,
      role: role as 'system' | 'user' | 'assistant',
      content: [{ type: 'text' as const, text: index === 0 ? '' : role }],
      completion: 'complete' as const,
      provenance: { blockId: `b${index}`, origin: 'prompt' as const },
    })),
  };
  const before = structuredClone(r);
  const built = buildCodexTurn(r),
    input = JSON.parse(built.inputText);
  expect(input.taskContract).toBe('');
  expect(input.allowedTools).toEqual(r.stable.tools);
  expect(input.orderedMessages).toEqual(
    r.prompt.messages.map(({ id, role, content }) => ({
      id,
      role,
      content,
      provenance: { origin: 'prompt' },
    }))
  );
  expect(r).toEqual(before);
  expect(input.outputTokenBudget).toBe(1000);
  expect(input).not.toHaveProperty('outputTokenTarget');
  expect(built.developerInstructions).toContain('soft capacity budget');
  r.prompt.messages[2].completion = 'prefill';
  expect(() => buildCodexTurn(r)).toThrow('CODEX_PROMPT_PREFILL_UNSUPPORTED');
  r.prompt.messages[2].completion = 'complete';
  r.prompt.cachePlan = [{ blockId: 'b0', afterMessageId: 'm0', policy: 'require' }];
  expect(() => buildCodexTurn(r)).toThrow('CODEX_PROMPT_CACHE_UNSUPPORTED');
});

test('text roles use writing base instructions while helper keeps its application-operation guidance', () => {
  const helper = { ...request(), role: 'helper' as const };
  const built = buildCodexTurn(helper);
  expect(built.baseInstructions).toContain('single-user creative-writing app');
  expect(built.baseInstructions).toContain('do not automatically repeat a write');
  expect(buildCodexDescriptor(helper, built)).toMatchObject({
    baseInstructions: built.baseInstructions,
    developerInstructions: built.developerInstructions,
  });
  for (const role of ['main', 'translation', 'image', 'script', 'context', 'title'] as const) {
    const selected = { ...request(), role };
    expect(buildCodexTurn(selected).baseInstructions).toBe(TEXT_BASE_INSTRUCTIONS);
    expect(buildCodexDescriptor(selected)).toMatchObject({
      baseInstructions: TEXT_BASE_INSTRUCTIONS,
    });
  }
});

test('compact logical messages keep retrievable provenance and omit only an exact current user task duplicate', () => {
  const r = request();
  r.prompt = {
    compilerVersion: 'risu-native-prompt-2',
    cachePlan: [{ blockId: 'cache', afterMessageId: 'history', policy: 'prefer' }],
    values: {},
    messages: [
      {
        id: 'history',
        role: 'assistant',
        content: [{ type: 'text', text: 'Earlier prose.' }],
        completion: 'complete',
        provenance: {
          blockId: 'chat',
          origin: 'history',
          sourceRevision: 'source',
          sourceHash: 'a'.repeat(64),
          runId: 'host-run',
        },
      },
      {
        id: 'current',
        role: 'user',
        content: [{ type: 'text', text: r.input.task }],
        completion: 'complete',
        provenance: { blockId: 'chat', origin: 'current' },
      },
    ],
  };
  const before = structuredClone(r);
  const input = JSON.parse(buildCodexTurn(r).inputText);
  expect(input.orderedMessages[0]).toEqual({
    id: 'history',
    role: 'assistant',
    content: [{ type: 'text', text: 'Earlier prose.' }],
    provenance: { origin: 'history', sourceRevision: 'source', sourceHash: 'a'.repeat(64) },
  });
  expect(input.orderedMessages[1]).toMatchObject({
    role: 'user',
    provenance: { origin: 'current' },
  });
  expect(input.input).not.toHaveProperty('task');
  expect(input.cacheDiagnostics).toEqual([{ ...r.prompt.cachePlan[0], status: 'not-applied' }]);
  expect(r).toEqual(before);

  r.prompt.messages[1].role = 'system';
  expect(JSON.parse(buildCodexTurn(r).inputText).input.task).toBe('Write');
  r.prompt.messages[1].role = 'user';
  r.prompt.messages[1].content[0].text = 'Rewritten current request';
  expect(JSON.parse(buildCodexTurn(r).inputText).input.task).toBe('Write');
  r.prompt.messages[1].content[0].text = 'Write';
  r.prompt.messages[1].provenance.origin = 'history';
  expect(JSON.parse(buildCodexTurn(r).inputText).input.task).toBe('Write');
});

test('decodes only advertised Uimori tool requests and rejects mixed, foreign, duplicate, and malformed output', () => {
  const r = request(),
    call = { id: 'a', name: 'resource.read', argumentsJson: '{"id":"resource"}' };
  expect(decodeCodexOutput(encode('tools', '', [call]), r)).toMatchObject({
    status: 'tool_calls',
    toolCalls: [{ id: 'a', name: 'resource.read', arguments: { id: 'resource' } }],
  });
  for (const raw of [
    encode('tools', 'mixed', [call]),
    encode('final', 'text', [call]),
    encode('tools', '', [call, call]),
    encode('tools', '', [{ ...call, argumentsJson: '[]' }]),
    '{}',
  ])
    expect(decodeCodexOutput(raw, r).status).toBe('error');
  expect(decodeCodexOutput(encode('tools', '', [{ ...call, name: 'shell' }]), r)).toMatchObject({
    status: 'error',
    error: { code: 'CODEX_INVALID_TOOL_CALL' },
  });
  r.input.results = [{ callId: 'a', result: {} }];
  expect(decodeCodexOutput(encode('tools', '', [call]), r).status).toBe('error');
  expect(decodeCodexOutput(encode('refused', 'Cannot'), request())).toMatchObject({
    status: 'refused',
    refusal: 'Cannot',
  });
  expect(decodeCodexOutput(encode('final', ''), request()).error?.code).toBe('EMPTY_COMPLETION');
});
