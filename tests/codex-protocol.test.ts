import { expect, test, vi } from 'vitest';
import { buildCodexTurn, CODEX_ENDPOINT, decodeCodexOutput } from '../core/codex-protocol.js';
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
  for (const role of [
    'main',
    'translation',
    'status',
    'image',
    'state',
    'context',
    'helper',
  ] as const) {
    const result = await executeProvider(
      connection,
      { ...request(), role },
      { signal: new AbortController().signal, approvedOrigins: [], executeCodex: run }
    );
    expect(result.status).toBe('completed');
    expect(result.usage.costUsd).toBeNull();
  }
  expect(run).toHaveBeenCalledTimes(7);
  expect(
    (
      await executeProvider(connection, request(), {
        signal: new AbortController().signal,
        approvedOrigins: [],
      })
    ).error?.code
  ).toBe('CODEX_UNAVAILABLE');
  expect(() => validateConnection({ ...connection, credentialEnv: 'SECRET' }, [])).toThrow(
    'INVALID_CODEX_CONNECTION'
  );
  expect(() => validateConnection({ ...connection, endpoint: 'codex://other' }, [])).toThrow(
    'INVALID_CODEX_CONNECTION'
  );
  await expect(
    executeProvider(
      connection,
      { ...request(), generation: { ...request().generation!, structuredOutput: false } },
      { signal: new AbortController().signal, approvedOrigins: [], executeCodex: run }
    )
  ).rejects.toThrow('UNSUPPORTED_GENERATION_OPTIONS');
});

test('preserves ordered logical roles and explicit empty instructions while rejecting unsupported semantics', () => {
  const r = request();
  r.prompt = {
    compilerVersion: 'uimori-prompt-1',
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
  const built = buildCodexTurn(r),
    input = JSON.parse(built.inputText);
  expect(input.taskContract).toBe('');
  expect(input.orderedMessages).toEqual(r.prompt.messages);
  r.prompt.messages[2].completion = 'prefill';
  expect(() => buildCodexTurn(r)).toThrow('CODEX_PROMPT_PREFILL_UNSUPPORTED');
  r.prompt.messages[2].completion = 'complete';
  r.prompt.cachePlan = [{ blockId: 'b0', afterMessageId: 'm0', policy: 'require' }];
  expect(() => buildCodexTurn(r)).toThrow('CODEX_PROMPT_CACHE_UNSUPPORTED');
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
    encode('tools', '', [{ ...call, name: 'shell' }]),
    encode('tools', '', [{ ...call, argumentsJson: '[]' }]),
    '{}',
  ])
    expect(decodeCodexOutput(raw, r).status).toBe('error');
  r.input.results = [{ callId: 'a', result: {} }];
  expect(decodeCodexOutput(encode('tools', '', [call]), r).status).toBe('error');
  expect(decodeCodexOutput(encode('refused', 'Cannot'), request())).toMatchObject({
    status: 'refused',
    refusal: 'Cannot',
  });
  expect(decodeCodexOutput(encode('final', ''), request()).error?.code).toBe('EMPTY_COMPLETION');
});

test('permits native assistance while reserving Uimori application actions for the JSON envelope', () => {
  const built = buildCodexTurn(request());
  expect(built.developerInstructions).toContain('Use available Codex builtin tools when they help');
  expect(built.developerInstructions).toContain(
    'Use these Uimori tools for application data and saved changes'
  );
  expect(built.developerInstructions).not.toContain('Never invoke builtin tools');
  expect(JSON.parse(built.inputText).allowedTools).toEqual(request().stable.tools);
  expect(
    decodeCodexOutput(
      encode('tools', '', [{ id: 'x', name: 'exec', argumentsJson: '{}' }]),
      request()
    ).error?.code
  ).toBe('CODEX_INVALID_TOOL_CALL');
});
