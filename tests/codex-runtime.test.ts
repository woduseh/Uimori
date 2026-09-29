import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CodexRuntime,
  codexEnvironment,
  codexExecutable,
  type CodexAgentRequest,
  type CodexAgentExecutionOptions,
} from '../server/codex-runtime.js';
import { CodexProcess } from '../server/codex-process.js';
import { buildCodexTurn } from '../core/codex-protocol.js';
import {
  ProviderContractError,
  type ProviderRequest,
  type ProviderResult,
  type WireRecord,
} from '../core/transport.js';

const fixture = resolve('tests/fixtures/codex-app-server.mjs');
const connection = {
  id: 'codex-connection',
  protocol: 'codex-app-server-v1' as const,
  endpoint: 'codex://local',
};
const request = (): ProviderRequest => ({
  role: 'main',
  modelId: 'gpt-5.4',
  stable: { contract: 'Write the synthetic scene.', tools: [] },
  generation: { maxOutputTokens: 8192, temperature: null, reasoningEffort: 'low' },
  input: { task: 'Synthetic request', controls: {} },
});
const output = JSON.stringify({ kind: 'final', text: 'A synthetic scene.', toolCalls: [] });
const agentRequest = (): CodexAgentRequest => ({
  modelId: 'gpt-5.4',
  developerInstructions: 'Read and revise the draft through the provided tools.',
  text: 'Revise the saved draft.',
  tools: [
    { name: 'data.search', description: 'Find saved data', inputSchema: { type: 'object' } },
    { name: 'app.call', description: 'Apply an edit', inputSchema: { type: 'object' } },
  ],
});
const instances: CodexRuntime[] = [],
  roots: string[] = [];
function setup(mode = 'normal', extra: NodeJS.ProcessEnv = {}, maxConcurrent?: number) {
  const dir = mkdtempSync(join(tmpdir(), 'uimori-codex-runtime-test-'));
  roots.push(dir);
  const log = join(dir, 'requests.jsonl');
  const runtime = new CodexRuntime(join(dir, 'db.sqlite'), {
    enabled: true,
    maxConcurrent,
    launch: {
      command: process.execPath,
      args: [fixture],
      env: {
        UIMORI_CODEX_FIXTURE_MODE: mode,
        UIMORI_CODEX_FIXTURE_OUTPUT: output,
        UIMORI_CODEX_FIXTURE_LOG: log,
        ...extra,
      },
    },
  });
  instances.push(runtime);
  const records = () =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  return { runtime, records, dir };
}
afterEach(async () => {
  await Promise.all(instances.splice(0).map((runtime) => runtime.close()));
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('official Codex runtime boundary using a synthetic stdio executable', () => {
  it('keeps host tool results and plain assistant final output inside one native turn', async () => {
    const { runtime, records } = setup('agent-normal');
    const onToolCall = vi.fn<CodexAgentExecutionOptions['onToolCall']>(async () => ({
      success: true,
      text: 'host result',
    }));
    const onProgress = vi.fn();
    const onCommentary = vi.fn();
    const result = await runtime.executeAgent(connection, agentRequest(), {
      signal: new AbortController().signal,
      onToolCall,
      onProgress,
      onCommentary,
    });
    expect(result).toMatchObject({
      status: 'completed',
      text: 'Saved the draft.',
      toolCalls: [],
      usage: { inputTokens: 200, outputTokens: 60, raw: { modelCalls: null } },
    });
    expect(onToolCall.mock.calls.map(([call]) => call)).toEqual([
      { name: 'data.search', callId: 'call-1', arguments: { query: 'saved draft' } },
      { name: 'app.call', callId: 'call-2', arguments: { id: 'draft-1', value: 'revised' } },
    ]);
    expect(onProgress.mock.calls.map(([value]) => value)).toEqual([
      { text: 'Saved ', offset: 6 },
      { text: 'the draft.', offset: 16 },
    ]);
    expect(onCommentary).toHaveBeenCalledExactlyOnceWith('Checking the draft.');
    expect(records().filter((row) => row.method === 'thread/start')).toHaveLength(1);
    expect(records().filter((row) => row.method === 'turn/start')).toHaveLength(1);
    expect(records().find((row) => row.method === 'turn/start').params).not.toHaveProperty(
      'outputSchema'
    );
    expect(records().find((row) => row.method === 'thread/start').params.dynamicTools).toEqual([
      {
        type: 'namespace',
        name: 'uimori',
        description: 'Scoped Uimori application reads and saved changes for the current task.',
        tools: [
          {
            type: 'function',
            name: 'uimori_data_search',
            description: 'Find saved data',
            inputSchema: { type: 'object' },
          },
          {
            type: 'function',
            name: 'uimori_app_call',
            description: 'Apply an edit',
            inputSchema: { type: 'object' },
          },
        ],
      },
    ]);
    expect(records().filter((row) => row.id === 'tool-2')).toEqual([
      {
        id: 'tool-2',
        result: { contentItems: [{ type: 'inputText', text: 'host result' }], success: true },
      },
    ]);
  });
  it.each([
    'agent-wrong-thread',
    'agent-wrong-turn',
    'agent-wrong-namespace',
    'agent-unknown-tool',
  ])('rejects %s before invoking a host tool', async (mode) => {
    const { runtime } = setup(mode);
    const onToolCall = vi.fn(async () => ({ success: true, text: 'should not run' }));
    expect(
      await runtime.executeAgent(connection, agentRequest(), {
        signal: new AbortController().signal,
        onToolCall,
      })
    ).toMatchObject({ status: 'error', error: { code: 'CODEX_TOOL_NOT_ALLOWED' } });
    expect(onToolCall).not.toHaveBeenCalled();
  });
  it('never replays a duplicate tool call or a turn that exited after a write', async () => {
    for (const mode of ['agent-duplicate', 'agent-exit-after-write']) {
      const { runtime, records } = setup(mode);
      const calls: string[] = [];
      const result = await runtime.executeAgent(connection, agentRequest(), {
        signal: new AbortController().signal,
        onToolCall: async ({ callId }) => {
          calls.push(callId);
          return { success: true, text: 'saved' };
        },
      });
      expect(result.status).toBe('error');
      expect(new Set(calls).size).toBe(calls.length);
      expect(records().filter((row) => row.method === 'turn/start')).toHaveLength(1);
      if (mode === 'agent-exit-after-write') expect(calls).toEqual(['call-1', 'call-2']);
    }
  });
  it('interrupts cancellation and suppresses a late host response without replay', async () => {
    const { runtime, records } = setup('agent-normal');
    const controller = new AbortController();
    let release!: () => void;
    let toolSignal: AbortSignal | undefined;
    const onToolCall = vi.fn(async (_call, signal: AbortSignal) => {
      toolSignal = signal;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { success: true, text: 'late saved result' };
    });
    const result = runtime.executeAgent(connection, agentRequest(), {
      signal: controller.signal,
      onToolCall,
    });
    await vi.waitFor(() => expect(onToolCall).toHaveBeenCalledTimes(1));
    controller.abort();
    expect(await result).toMatchObject({ status: 'cancelled' });
    expect(toolSignal?.aborted).toBe(true);
    release();
    await Promise.resolve();
    expect(records().filter((row) => row.method === 'turn/interrupt')).toHaveLength(1);
    expect(records().filter((row) => row.id === 'tool-1')).toHaveLength(0);
  });
  it('retains a thrown host error without requesting another model turn', async () => {
    const { runtime, records } = setup('agent-normal');
    expect(
      await runtime.executeAgent(connection, agentRequest(), {
        signal: new AbortController().signal,
        onToolCall: async () => {
          throw new ProviderContractError('WRITE_OUTCOME_UNKNOWN');
        },
      })
    ).toMatchObject({ status: 'error', error: { code: 'WRITE_OUTCOME_UNKNOWN' } });
    expect(records().filter((row) => row.method === 'turn/start')).toHaveLength(1);
  });
  it.each([false, true])(
    'reserves bounded child capacity for two native parents (cancel waiting child: %s)',
    async (cancelWaiting) => {
      const { runtime } = setup('agent-normal');
      const parents = [new AbortController(), new AbortController()];
      const childResults: ProviderResult[] = [];
      const onChildWire = vi.fn();
      const onOrdinaryWire = vi.fn();
      let arrivals = 0;
      let waitingParent: AbortController | undefined;
      let releaseParents!: () => void;
      const bothParents = new Promise<void>((resolve) => {
        releaseParents = resolve;
      });
      let releaseChild!: () => void;
      const firstChildGate = new Promise<void>((resolve) => {
        releaseChild = resolve;
      });
      let childRequests = 0;
      const executions = parents.map((controller) =>
        runtime.executeAgent(connection, agentRequest(), {
          signal: controller.signal,
          timeoutMs: 10_000,
          onToolCall: async (call, signal) => {
            if (call.callId === 'call-1') {
              if (++arrivals === 2) releaseParents();
              await bothParents;
              if (++childRequests === 2) waitingParent = controller;
              const child = await runtime.execute(connection, request(), {
                signal,
                timeoutMs: 5000,
                onWire: onChildWire,
                beforeTurn: () =>
                  onChildWire.mock.calls.length === 1 ? firstChildGate : undefined,
              });
              childResults.push(child);
              if (child.status !== 'completed') throw new Error('Nested child failed');
            }
            return { success: true, text: 'Synthetic child finished.' };
          },
        })
      );
      await vi.waitFor(() => {
        expect(childRequests).toBe(2);
        expect(onChildWire).toHaveBeenCalledTimes(1);
      });
      // An unrelated call cannot borrow the reserved capacity while both parents run.
      const ordinary = runtime.execute(connection, request(), {
        signal: new AbortController().signal,
        timeoutMs: 5000,
        onWire: onOrdinaryWire,
      });
      expect(onOrdinaryWire).not.toHaveBeenCalled();
      if (cancelWaiting) {
        waitingParent!.abort();
        await vi.waitFor(() => expect(childResults).toHaveLength(1));
        expect(childResults[0].status).toBe('cancelled');
        expect(onChildWire).toHaveBeenCalledTimes(1);
      }
      releaseChild();
      const results = await Promise.all(executions);
      expect(results.map((result) => result.status).sort()).toEqual(
        cancelWaiting ? ['cancelled', 'completed'] : ['completed', 'completed']
      );
      expect(childResults.map((result) => result.status).sort()).toEqual(
        cancelWaiting ? ['cancelled', 'completed'] : ['completed', 'completed']
      );
      expect(await ordinary).toMatchObject({ status: 'completed', text: 'A synthetic scene.' });
      expect(onChildWire).toHaveBeenCalledTimes(cancelWaiting ? 1 : 2);
    }
  );
  it('starts disabled without creating credentials and rejects shell wrapper configuration', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'uimori-codex-runtime-test-'));
    roots.push(dir);
    const runtime = new CodexRuntime(join(dir, 'db'));
    instances.push(runtime);
    expect(await runtime.status()).toMatchObject({
      available: false,
      authenticated: false,
      error: 'CODEX_DISABLED',
    });
    expect(existsSync(join(dir, 'db.codex'))).toBe(false);
    expect(() => codexExecutable('codex --dangerously-bypass-approvals-and-sandbox')).toThrow(
      'CODEX_EXECUTABLE_INVALID'
    );
    expect(() => codexExecutable(resolve('codex.cmd'))).toThrow('CODEX_EXECUTABLE_INVALID');
    const env = codexEnvironment(resolve(dir, 'home'), dir, {
      PATH: 'synthetic',
      OPENAI_API_KEY: 'secret',
      UIMORI_PROVIDER_CUSTOM: 'secret',
      CODEX_HOME: 'personal-home',
      NODE_OPTIONS: '--require secret.js',
    });
    expect(env).not.toHaveProperty('OPENAI_API_KEY');
    expect(env).not.toHaveProperty('UIMORI_PROVIDER_CUSTOM');
    expect(env).not.toHaveProperty('NODE_OPTIONS');
    expect(env.CODEX_HOME).toBe(resolve(dir, 'home'));
    expect(env.HOME).toBe(resolve(dir, 'home'));
  });
  it('checks the required protocol version before starting or authorizing work', async () => {
    const { runtime, records } = setup('normal', { UIMORI_CODEX_FIXTURE_VERSION: '0.152.0' });
    expect(await runtime.status()).toMatchObject({
      available: false,
      error: 'CODEX_VERSION_UNSUPPORTED',
    });
    expect(records()).toEqual([]);
  });
  it('exposes subscription metadata and catalog without identities, credentials or a model turn', async () => {
    const { runtime, records } = setup();
    const status = await runtime.status();
    expect(status).toMatchObject({
      available: true,
      authenticated: true,
      authMode: 'chatgpt',
      planType: 'plus',
      limits: [{ usedPercent: 12, windowDurationMins: 300 }],
    });
    expect(JSON.stringify(status)).not.toMatch(/synthetic@example|SECRET|auth\.json/);
    expect(await runtime.catalog()).toMatchObject([
      { id: 'gpt-5.4', capabilities: { tools: null, structuredOutput: null }, priceRevision: null },
    ]);
    expect(records().some((row) => row.method === 'turn/start')).toBe(false);
    expect((await runtime.logout()).authenticated).toBe(false);
  });
  it('delegates device login to Codex and cancels it without accepting a token', async () => {
    const { runtime, records } = setup('logged-out');
    expect(await runtime.status()).toMatchObject({
      available: true,
      authenticated: false,
      login: null,
    });
    expect((await runtime.login()).login).toEqual({
      id: 'fixture-login',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'TEST-1234',
    });
    expect(records().find((row) => row.method === 'account/login/start').params).toEqual({
      type: 'chatgptDeviceCode',
    });
    expect((await runtime.cancelLogin()).login).toBeNull();
    expect(records().filter((row) => row.method === 'account/login/cancel')).toHaveLength(1);
  });
  it('does not offer an arbitrary provider login URL or fall back to API authentication', async () => {
    const bad = setup('logged-out', {
      UIMORI_CODEX_FIXTURE_LOGIN_URL: 'https://example.invalid/steal',
    });
    await expect(bad.runtime.login()).rejects.toThrow('CODEX_INVALID_LOGIN');
    expect((await bad.runtime.status()).login).toBeNull();
    const api = setup('api-key');
    expect(await api.runtime.status()).toMatchObject({
      authenticated: false,
      authMode: 'apikey',
      error: 'CODEX_SUBSCRIPTION_REQUIRED',
    });
    const onWire = vi.fn();
    expect(
      await api.runtime.execute(connection, request(), {
        signal: new AbortController().signal,

        onWire,
      })
    ).toMatchObject({ status: 'error', error: { code: 'CODEX_LOGIN_REQUIRED' } });
    expect(onWire).not.toHaveBeenCalled();
    expect(api.records().some((row) => row.method === 'turn/start')).toBe(false);
  });
  it('records native utility availability before any turn while preserving the host environment boundary', async () => {
    const { runtime, records } = setup();
    let wire: WireRecord | undefined;
    const result = await runtime.execute(connection, request(), {
      signal: new AbortController().signal,

      onWire: (value) => {
        expect(
          records().some((row) => row.method === 'thread/start' || row.method === 'turn/start')
        ).toBe(false);
        wire = value;
      },
    });
    expect(result).toMatchObject({
      status: 'completed',
      text: 'A synthetic scene.',
      opaqueState: null,
      usage: { inputTokens: 100, outputTokens: 30, costUsd: null, raw: { modelCalls: null } },
    });
    expect(wire).toMatchObject({
      method: 'RPC',
      url: 'codex://local',
      headers: {},
      body: {
        method: 'turn/start',
        environmentAccess: false,
        builtinTools: { codeMode: true, webSearch: 'cached' },
      },
    });
    const start = records().find((row) => row.method === 'thread/start').params;
    expect(start).not.toHaveProperty('baseInstructions');
    expect(wire?.body).not.toHaveProperty('baseInstructions');
    expect(start).toMatchObject({
      environments: [],
      selectedCapabilityRoots: [],
      ephemeral: true,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      config: {
        web_search: 'cached',
        'features.code_mode': true,
        'code_mode.excluded_tool_namespaces': ['functions'],
        'features.shell_tool': false,
        'features.js_repl': false,
        'features.apps': false,
        'features.request_permissions': false,
      },
    });
    expect(records().find((row) => row.method === 'turn/start').params).toMatchObject({
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
    });
    expect(Object.keys(start.config).some((key) => key.startsWith('model_providers.openai.'))).toBe(
      false
    );
    expect(records().filter((row) => row.method === 'turn/start')).toHaveLength(1);
    expect(JSON.stringify(wire)).not.toMatch(/fixture-thread|auth\.json|synthetic@example/);
  });
  it('sends helper base instructions in the thread request and records the same prefix', async () => {
    const { runtime, records } = setup();
    const helper = { ...request(), role: 'helper' as const };
    const built = buildCodexTurn(helper);
    let wire: WireRecord | undefined;
    const result = await runtime.execute(connection, helper, {
      signal: new AbortController().signal,
      onWire: (value) => {
        wire = value;
      },
    });
    expect(result.status).toBe('completed');
    const start = records().find((row) => row.method === 'thread/start').params;
    expect(start.baseInstructions).toBe(built.baseInstructions);
    expect(start.developerInstructions).toBe(built.developerInstructions);
    expect(wire?.body).toMatchObject({ baseInstructions: built.baseInstructions });
    expect(wire?.stablePrefixSha256).toBe(
      createHash('sha256')
        .update(JSON.stringify([built.baseInstructions, built.developerInstructions]))
        .digest('hex')
    );
  });
  it('retains reported total and last token details without inventing missing numbers', async () => {
    const { runtime } = setup();
    const onNotification = CodexProcess.prototype.onNotification;
    const intercept = vi
      .spyOn(CodexProcess.prototype, 'onNotification')
      .mockImplementation(function (this: CodexProcess, listener) {
        return onNotification.call(this, (method, params) => {
          if (method !== 'thread/tokenUsage/updated') return listener(method, params);
          const event = params as { threadId: string; turnId: string };
          listener(method, {
            ...event,
            tokenUsage: {
              total: {
                totalTokens: 130,
                inputTokens: 100,
                cachedInputTokens: 40,
                cacheWriteInputTokens: 6,
                outputTokens: 30,
                reasoningOutputTokens: 12,
              },
              last: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 30 },
            },
          });
        });
      });
    try {
      const result = await runtime.execute(connection, request(), {
        signal: new AbortController().signal,
      });
      expect(result.usage).toMatchObject({ inputTokens: 100, outputTokens: 30 });
      expect(result.usage.raw).toEqual({
        kind: 'codex-agent-turn',
        modelCalls: null,
        tokenUsage: {
          total: {
            totalTokens: 130,
            inputTokens: 100,
            cachedInputTokens: 40,
            cacheWriteInputTokens: 6,
            outputTokens: 30,
            reasoningOutputTokens: 12,
          },
          last: { inputTokens: 100, cachedInputTokens: 20, outputTokens: 30 },
        },
      });
    } finally {
      intercept.mockRestore();
    }
  });
  it('does not execute when durable attempt recording fails', async () => {
    const { runtime, records } = setup();
    const result = await runtime.execute(connection, request(), {
      signal: new AbortController().signal,

      onWire: () => {
        throw new ProviderContractError('RECORDING_FAILED');
      },
    });
    expect(result).toMatchObject({ status: 'error', error: { code: 'RECORDING_FAILED' } });
    expect(records().some((row) => row.method === 'turn/start')).toBe(false);
  });
  it('rechecks host authority after thread setup and before starting the model turn', async () => {
    const { runtime, records } = setup();
    const result = await runtime.execute(connection, request(), {
      signal: new AbortController().signal,

      beforeTurn: () => {
        throw new ProviderContractError('CONNECTION_NOT_AUTHORIZED');
      },
    });
    expect(result).toMatchObject({ status: 'error', error: { code: 'CONNECTION_NOT_AUTHORIZED' } });
    expect(records().filter((row) => row.method === 'thread/start')).toHaveLength(1);
    expect(records().some((row) => row.method === 'turn/start')).toBe(false);
  });
  it.each(['turn-hang', 'thread-hang', 'init-timeout'])(
    'bounds %s and never replays a possibly executing request',
    async (mode) => {
      const { runtime, records } = setup(mode);
      const result = await runtime.execute(connection, request(), {
        signal: new AbortController().signal,

        timeoutMs: 500,
      });
      expect(result).toMatchObject({ status: 'error', error: { code: 'TIMEOUT' } });
      expect(records().filter((row) => row.method === 'turn/start').length).toBeLessThanOrEqual(1);
    }
  );
  it.each([
    ['builtin', 'CODEX_TOOL_NOT_ALLOWED'],
    ['approval-during-turn', 'CODEX_TOOL_NOT_ALLOWED'],
    ['native-without-final', 'CODEX_INVALID_OUTPUT'],
    ['duplicate-final', 'CODEX_INVALID_OUTPUT'],
    ['turn-exit', 'CODEX_EXECUTION_INTERRUPTED'],
    ['turn-error', 'CODEX_TURN_FAILED'],
    ['wrong-model', 'CODEX_INVALID_THREAD'],
  ])('rejects %s without adopting a result or exposing diagnostics', async (mode, code) => {
    const { runtime, records } = setup(mode);
    const result = await runtime.execute(connection, request(), {
      signal: new AbortController().signal,

      timeoutMs: 5000,
    });
    expect(result).toMatchObject({ status: 'error', text: '', error: { code } });
    expect(JSON.stringify(result)).not.toContain('SECRET_AUTH_TOKEN');
    expect(records().filter((row) => row.method === 'turn/start').length).toBeLessThanOrEqual(1);
  });
  it.each(['native-tools', 'phase-less-preamble', 'phase-less-final'])(
    'accepts %s while keeping intermediate messages and native tool output out of the result',
    async (mode) => {
      const { runtime, records } = setup(mode);
      const result = await runtime.execute(connection, request(), {
        signal: new AbortController().signal,
      });
      expect(result).toMatchObject({
        status: 'completed',
        text: 'A synthetic scene.',
        toolCalls: [],
      });
      expect(JSON.stringify(result)).not.toContain('INTERNAL_');
      expect(records().filter((row) => row.method === 'turn/start')).toHaveLength(1);
    }
  );
  it('accepts completion before the turn-start acknowledgement without losing or duplicating the result', async () => {
    const { runtime } = setup('early-completion');
    expect(
      await runtime.execute(connection, request(), {
        signal: new AbortController().signal,
      })
    ).toMatchObject({ status: 'completed', text: 'A synthetic scene.' });
  });
  it('cancels a waiting execution without an attempt and keeps independent turns isolated', async () => {
    const { runtime, records } = setup('turn-hang', {}, 1);
    const first = new AbortController(),
      second = new AbortController(),
      onSecondWire = vi.fn();
    const a = runtime.execute(connection, request(), {
      signal: first.signal,

      timeoutMs: 5000,
    });
    await vi.waitFor(() => expect(records().some((row) => row.method === 'turn/start')).toBe(true));
    const b = runtime.execute(connection, request(), {
      signal: second.signal,

      timeoutMs: 5000,
      onWire: onSecondWire,
    });
    second.abort();
    expect(await b).toMatchObject({ status: 'cancelled' });
    expect(onSecondWire).not.toHaveBeenCalled();
    first.abort();
    expect(await a).toMatchObject({ status: 'cancelled' });
    expect(records().filter((row) => row.method === 'turn/start')).toHaveLength(1);
  });
  it('lets queued ordinary work run after a slot is released', async () => {
    const { runtime, records } = setup('normal', {}, 1);
    const options = { signal: new AbortController().signal };
    const results = await Promise.all([
      runtime.execute(connection, request(), options),
      runtime.execute(connection, request(), options),
      runtime.execute(connection, request(), options),
    ]);
    expect(results.map((result) => result.status)).toEqual(['completed', 'completed', 'completed']);
    expect(records().filter((row) => row.method === 'turn/start')).toHaveLength(3);
  });
  it('closes during installation and initialization without leaving a usable manager', async () => {
    const first = setup();
    const pending = first.runtime.status();
    await first.runtime.close();
    expect(await pending).toMatchObject({ available: false, error: 'CODEX_CLOSED' });
    expect(first.records()).toEqual([]);
    const second = setup('init-timeout');
    const initializing = second.runtime.status();
    await vi.waitFor(() =>
      expect(second.records().some((row) => row.method === 'initialize')).toBe(true)
    );
    await second.runtime.close();
    expect(await initializing).toMatchObject({ available: false, error: 'CODEX_CLOSED' });
    expect(await second.runtime.status()).toMatchObject({
      available: false,
      error: 'CODEX_CLOSED',
    });
  });
});
