import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexRuntime, codexEnvironment, codexExecutable } from '../server/codex-runtime.js';
import { ProviderContractError, type ProviderRequest, type WireRecord } from '../core/transport.js';

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
      NARRATIVE_PROVIDER_CUSTOM: 'secret',
      CODEX_HOME: 'personal-home',
      NODE_OPTIONS: '--require secret.js',
    });
    expect(env).not.toHaveProperty('OPENAI_API_KEY');
    expect(env).not.toHaveProperty('NARRATIVE_PROVIDER_CUSTOM');
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
      limits: [{ usedPercent: 12 }],
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
        approvedOrigins: [],
        onWire,
      })
    ).toMatchObject({ status: 'error', error: { code: 'CODEX_LOGIN_REQUIRED' } });
    expect(onWire).not.toHaveBeenCalled();
    expect(api.records().some((row) => row.method === 'turn/start')).toBe(false);
  });
  it('persists a truthful RPC attempt before any turn, denies environment access and decodes final output', async () => {
    const { runtime, records } = setup();
    let wire: WireRecord | undefined;
    const result = await runtime.execute(connection, request(), {
      signal: new AbortController().signal,
      approvedOrigins: [],
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
      body: { method: 'turn/start', environmentAccess: false },
    });
    const start = records().find((row) => row.method === 'thread/start').params;
    expect(start).toMatchObject({
      environments: [],
      selectedCapabilityRoots: [],
      ephemeral: true,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      config: { 'features.shell_tool': false, 'features.apps': false },
    });
    expect(Object.keys(start.config).some((key) => key.startsWith('model_providers.openai.'))).toBe(
      false
    );
    expect(records().filter((row) => row.method === 'turn/start')).toHaveLength(1);
    expect(JSON.stringify(wire)).not.toMatch(/fixture-thread|auth\.json|synthetic@example/);
  });
  it('does not execute when durable attempt recording fails', async () => {
    const { runtime, records } = setup();
    const result = await runtime.execute(connection, request(), {
      signal: new AbortController().signal,
      approvedOrigins: [],
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
      approvedOrigins: [],
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
        approvedOrigins: [],
        timeoutMs: 500,
      });
      expect(result).toMatchObject({ status: 'error', error: { code: 'TIMEOUT' } });
      expect(records().filter((row) => row.method === 'turn/start').length).toBeLessThanOrEqual(1);
    }
  );
  it.each([
    ['builtin', 'CODEX_TOOL_NOT_ALLOWED'],
    ['turn-exit', 'CODEX_EXECUTION_INTERRUPTED'],
    ['turn-error', 'CODEX_TURN_FAILED'],
    ['wrong-model', 'CODEX_INVALID_THREAD'],
  ])('rejects %s without adopting a result or exposing diagnostics', async (mode, code) => {
    const { runtime, records } = setup(mode);
    const result = await runtime.execute(connection, request(), {
      signal: new AbortController().signal,
      approvedOrigins: [],
      timeoutMs: 5000,
    });
    expect(result).toMatchObject({ status: 'error', text: '', error: { code } });
    expect(JSON.stringify(result)).not.toContain('SECRET_AUTH_TOKEN');
    expect(records().filter((row) => row.method === 'turn/start').length).toBeLessThanOrEqual(1);
  });
  it('accepts completion before the turn-start acknowledgement without losing or duplicating the result', async () => {
    const { runtime } = setup('early-completion');
    expect(
      await runtime.execute(connection, request(), {
        signal: new AbortController().signal,
        approvedOrigins: [],
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
      approvedOrigins: [],
      timeoutMs: 5000,
    });
    await vi.waitFor(() => expect(records().some((row) => row.method === 'turn/start')).toBe(true));
    const b = runtime.execute(connection, request(), {
      signal: second.signal,
      approvedOrigins: [],
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
    const options = { signal: new AbortController().signal, approvedOrigins: [] };
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
