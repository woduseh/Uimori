import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, test } from 'vitest';

const linuxTest = process.platform === 'linux' ? test : test.skip;
const owned: { dir: string; child: ChildProcess; closed: Promise<void> }[] = [];

afterEach(async () => {
  for (const { dir, child, closed } of owned.splice(0)) {
    child.kill('SIGTERM');
    await closed;
    rmSync(dir, { recursive: true, force: true });
  }
});

type ExecResult = {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  output: string;
  truncated: boolean;
  outputFile: string;
};

async function until(condition: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (condition()) return;
    await delay(20);
  }
  throw new Error('Runner fixture did not become ready');
}

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'uimori-runner-'));
  const taskId = randomUUID();
  const taskDir = join(dir, 'tasks', taskId);
  mkdirSync(join(taskDir, 'scratch'), { recursive: true });
  const child = spawn(process.execPath, [resolve('runner/runner.mjs')], {
    env: { ...process.env, UIMORI_SHELL_ROOT: dir },
    stdio: 'ignore',
  });
  const closed = new Promise<void>((done) => child.once('close', () => done()));
  owned.push({ dir, child, closed });
  const socketPath = join(dir, '.exec.sock');
  await until(() => existsSync(socketPath));
  function exec(command: string, timeoutMs = 1000) {
    const req = request({ socketPath, method: 'POST', path: '/exec' });
    const result = new Promise<ExecResult>((accept, reject) => {
      req.once('error', reject);
      req.once('response', (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.once('error', reject);
        res.once('end', () => {
          try {
            accept(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      });
    });
    req.end(JSON.stringify({ taskId, toolId: randomUUID(), command, timeoutMs }));
    return { req, result };
  }
  return { taskDir, child, closed, exec };
}

linuxTest(
  'runner keeps status, bounded UTF-8 head and tail, and the complete output log',
  async () => {
    const f = await fixture();
    const expected = 'HEAD\n' + '가나다🙂'.repeat(5000) + '\nTAIL stderr\n';
    const result = await f.exec(`python3 - <<'PY'
print('HEAD')
print('가나다🙂' * 5000, end='')
PY
printf '\\nTAIL stderr\\n' >&2
exit 7`).result;
    expect(result).toMatchObject({ exitCode: 7, signal: null, timedOut: false, truncated: true });
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(16384);
    expect(result.output).toMatch(/^HEAD\n/);
    expect(result.output).toMatch(/\nTAIL stderr\n$/);
    expect(result.output).toContain('[output truncated]');
    expect(result.output).not.toContain('�');
    expect(result.outputFile).toMatch(/^scratch\/exec-[a-f0-9-]+\.log$/);
    expect(readFileSync(join(f.taskDir, result.outputFile), 'utf8')).toBe(expected);
  }
);

linuxTest('runner timeout kills descendants before they can change files later', async () => {
  const f = await fixture();
  const result = await f.exec('(sleep 1.4; printf late > scratch/late) & wait', 1000).result;
  expect(result).toMatchObject({ exitCode: null, signal: 'SIGKILL', timedOut: true });
  await delay(600);
  expect(existsSync(join(f.taskDir, 'scratch/late'))).toBe(false);
});

linuxTest('completed synchronous commands leave no background writes running', async () => {
  const f = await fixture();
  const result = await f.exec('(sleep 0.3; printf late > scratch/late) & printf RETURNED').result;
  expect(result).toMatchObject({
    exitCode: 0,
    signal: null,
    timedOut: false,
    output: 'RETURNED',
    truncated: false,
  });
  expect(readFileSync(join(f.taskDir, result.outputFile), 'utf8')).toBe('RETURNED');
  await delay(500);
  expect(existsSync(join(f.taskDir, 'scratch/late'))).toBe(false);
});

linuxTest('disconnect cancels only its command group and the runner remains usable', async () => {
  const f = await fixture();
  const pending = f.exec(
    'touch scratch/started; (sleep 0.4; printf late > scratch/late) & wait',
    5000
  );
  const disconnected = pending.result.catch((error: unknown) => error);
  await until(() => existsSync(join(f.taskDir, 'scratch/started')));
  const independent = f.exec('sleep 0.2; printf unaffected');
  pending.req.destroy(new Error('Cancelled by caller'));
  expect(await disconnected).toBeInstanceOf(Error);
  expect(await independent.result).toMatchObject({ exitCode: 0, output: 'unaffected' });
  await delay(400);
  expect(existsSync(join(f.taskDir, 'scratch/late'))).toBe(false);
});

linuxTest(
  'runner shutdown terminates active command groups and preserves termination status',
  async () => {
    const f = await fixture();
    const pending = f.exec(
      'touch scratch/started; (sleep 0.4; printf late > scratch/late) & wait',
      5000
    );
    await until(() => existsSync(join(f.taskDir, 'scratch/started')));
    f.child.kill('SIGTERM');
    expect(await pending.result).toMatchObject({
      exitCode: null,
      signal: 'SIGKILL',
      timedOut: false,
    });
    await f.closed;
    await delay(600);
    expect(existsSync(join(f.taskDir, 'scratch/late'))).toBe(false);
  }
);

linuxTest(
  'JSON transport accepts a valid heavily escaped command near the command limit',
  async () => {
    const f = await fixture();
    const command = "printf '한글🙂'\n#" + '\u0001'.repeat(49970);
    expect(command.length).toBeLessThanOrEqual(50000);
    const result = await f.exec(command).result;
    expect(result).toMatchObject({
      exitCode: 0,
      output: '한글🙂',
      timedOut: false,
      truncated: false,
    });
    expect(readFileSync(join(f.taskDir, result.outputFile), 'utf8')).toBe('한글🙂');
  }
);
