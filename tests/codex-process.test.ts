import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { CodexProcess } from '../server/codex-process.js';

const fixture = fileURLToPath(new URL('./fixtures/codex-app-server.mjs', import.meta.url));
const active: CodexProcess[] = [];
function client(mode = 'normal') {
  const value = new CodexProcess({
    command: process.execPath,
    args: [fixture],
    cwd: process.cwd(),
    env: { ...process.env, UIMORI_CODEX_FIXTURE_MODE: mode },
    timeoutMs: 1000,
  });
  active.push(value);
  return value;
}
afterEach(async () => {
  await Promise.all(active.splice(0).map((value) => value.close()));
});
describe('Codex app-server stdio process', () => {
  it('handshakes and correlates concurrent responses in different order', async () => {
    const value = client();
    await value.start();
    const delayed = value.request('fixture/delay', { first: true });
    expect(await value.request('fixture/echo', { second: true })).toEqual({ second: true });
    expect(await delayed).toEqual({ first: true });
  });
  it('rejects server approvals without granting privileges', async () => {
    const value = client();
    await value.start();
    const unsupported = new Promise<unknown>((resolve) =>
      value.onNotification((method, params) => {
        if (method === 'uimori/unsupportedRequest') resolve(params);
      })
    );
    const response = new Promise<unknown>((resolve) =>
      value.onNotification((method, params) => {
        if (method === 'fixture/clientResponse') resolve(params);
      })
    );
    await value.request('fixture/approval', {});
    expect(await response).toMatchObject({ id: 'approval-1', error: { code: -32601 } });
    expect(await unsupported).toEqual({ method: 'item/commandExecution/requestApproval' });
  });
  it('cancels and times out locally, ignores late results, and keeps the session usable', async () => {
    const value = client();
    await value.start();
    const controller = new AbortController();
    const cancelled = value.request('fixture/delay', {}, { signal: controller.signal });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: 'CODEX_CANCELLED' });
    await expect(value.request('fixture/delay', {}, { timeoutMs: 5 })).rejects.toMatchObject({
      code: 'CODEX_TIMEOUT',
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await value.request('fixture/echo', { alive: true })).toEqual({ alive: true });
  });
  it.each(['fixture/malformed', 'fixture/oversized', 'fixture/invalidUtf8'])(
    'terminates and rejects all pending work on %s',
    async (method) => {
      const value = client();
      await value.start();
      const pending = expect(value.request('fixture/hang', {})).rejects.toMatchObject({
        code: 'CODEX_PROTOCOL_ERROR',
      });
      await expect(value.request(method, {})).rejects.toMatchObject({
        code: 'CODEX_PROTOCOL_ERROR',
      });
      await pending;
      await expect(value.start()).rejects.toMatchObject({ code: 'CODEX_CLOSED' });
    }
  );
  it('accepts story context larger than 1 MiB within the bounded frame limit', async () => {
    const value = client();
    await value.start();
    const content = '한글 원고'.repeat(100_000);
    expect(await value.request('fixture/echo', { content })).toEqual({ content });
  });
  it('sanitizes provider errors and process exit diagnostics', async () => {
    const value = client();
    await value.start();
    await expect(value.request('fixture/error', {})).rejects.toThrow('CODEX_REQUEST_FAILED');
    let exits = 0;
    value.onExit(() => exits++);
    await expect(value.request('fixture/exit', {})).rejects.toThrow('CODEX_CLOSED');
    expect(exits).toBe(1);
  });
  it('cleans pending requests on close without a restart', async () => {
    const value = client();
    await value.start();
    const pending = expect(value.request('fixture/hang', {})).rejects.toThrow('CODEX_CLOSED');
    await value.close();
    await pending;
    await value.close();
    await expect(value.start()).rejects.toThrow('CODEX_CLOSED');
  });
  it('closes a stalled initialization', async () => {
    const value = client('init-timeout');
    await expect(value.start()).rejects.toThrow('CODEX_TIMEOUT');
    await expect(value.request('fixture/echo', {})).rejects.toThrow('CODEX_CLOSED');
  });
  it('reports a missing executable without leaking process diagnostics', async () => {
    const value = new CodexProcess({
      command: 'uimori-nonexistent-codex-test',
      cwd: process.cwd(),
      env: process.env,
    });
    active.push(value);
    await expect(value.start()).rejects.toThrow('CODEX_START_FAILED');
    await expect(value.start()).rejects.toThrow('CODEX_CLOSED');
  });
});
