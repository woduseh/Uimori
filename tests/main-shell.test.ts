import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, test, vi } from 'vitest';
import { shellExecutionOptions } from '../core/main-shell.js';
import type { RunSnapshot } from '../core/types.js';
import { MainShell } from '../server/main-shell.js';
import { Store } from '../server/store.js';
import { fixtureBotInput, createFixtureChat } from './fixtures/chat.js';
import { completedSource } from './fixtures/illustration.js';

const linuxTest = process.platform === 'linux' ? test : test.skip;
const owned: { directory: string; shell: MainShell; store: Store; child?: ChildProcess }[] = [];
afterEach(async () => {
  for (const item of owned.splice(0)) {
    item.shell.close();
    if (item.child) {
      const closed = new Promise<void>((done) => item.child!.once('close', () => done()));
      item.child.kill('SIGTERM');
      await closed;
    }
    item.store.close();
    rmSync(item.directory, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ums-'));
  vi.stubEnv('UIMORI_SHELL_ROOT', directory);
  const store = new Store(join(directory, 'test.sqlite'));
  const shell = new MainShell(store);
  const resource = store.product.content(fixtureBotInput('On demand only', 'Live library body'));
  const snapshot: RunSnapshot = {
    chatId: 'frozen-chat',
    parentRevision: 'source-before',
    settingsRevision: 1,
    settings: { maxCalls: 5 },
    request: 'Write the continuation',
    resources: [
      {
        id: 'effective-lore',
        chatId: 'frozen-chat',
        kind: 'lore',
        revision: 3,
        title: 'Effective override',
        description: '',
        text: 'Frozen effective lore🙂',
      },
    ],
    history: [
      { revision: 'source-before', text: 'Frozen scene🙂' },
      {
        revision: 'excluded-scene',
        text: 'Excluded original',
        sceneContext: { revision: 0, requestText: '', requestEnabled: true, sceneEnabled: false },
      },
    ],
    contextPlan: {
      version: 1,
      status: 'ready',
      budget: {} as NonNullable<RunSnapshot['contextPlan']>['budget'],
      dependencyKey: 'fixture',
      estimatedInputTokens: null,
      compacted: [],
      recentSourceRevisions: ['source-before'],
      summary: 'Existing derived summary',
      summaryCalls: 0,
      usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
      error: null,
    },
  };
  const item = { directory, shell, store };
  owned.push(item);
  return { ...item, snapshot, resource };
}

test('shell request bounds permit useful long work and explicit bounded output', () => {
  expect(shellExecutionOptions({ command: 'rg hero current' })).toEqual({
    command: 'rg hero current',
    timeoutMs: 10000,
    maxOutputBytes: 16384,
  });
  expect(
    shellExecutionOptions({
      command: 'python3 analyze.py',
      timeoutMs: 300000,
      maxOutputBytes: 65536,
    })
  ).toMatchObject({ timeoutMs: 300000, maxOutputBytes: 65536 });
  expect(() => shellExecutionOptions({ command: 'true', timeoutMs: 300001 })).toThrow('INVALID');
  expect(() => shellExecutionOptions({ command: 'true', maxOutputBytes: 1000000 })).toThrow(
    'INVALID'
  );
});

test('first attempted exec prepares frozen current data without dumping the saved archive', async () => {
  const f = fixture();
  await expect(f.shell.run(f.snapshot, 'first', { command: 'true' })).rejects.toThrow();
  expect(readFileSync(join(f.shell.directory, 'current/resources/0.txt'), 'utf8')).toBe(
    'Frozen effective lore🙂'
  );
  expect(readFileSync(join(f.shell.directory, 'current/resources.jsonl'), 'utf8')).not.toContain(
    'Frozen effective lore🙂'
  );
  expect(readFileSync(join(f.shell.directory, 'current/scenes/1.txt'), 'utf8')).toBe(
    'Excluded original'
  );
  expect(readFileSync(join(f.shell.directory, 'current/summary.txt'), 'utf8')).toBe(
    'Existing derived summary'
  );
  expect(existsSync(join(f.shell.directory, 'library'))).toBe(false);
  const scratch = join(f.shell.directory, 'scratch/preserved.txt');
  writeFileSync(scratch, 'keep retries');
  f.shell.close();
  const resumed = new MainShell(f.store, f.shell.id);
  await expect(
    resumed.run({ ...f.snapshot, history: [] }, 'retry', { command: 'true' })
  ).rejects.toThrow();
  expect(readFileSync(scratch, 'utf8')).toBe('keep retries');
  expect(readFileSync(join(resumed.directory, 'current/scenes/0.txt'), 'utf8')).toBe(
    'Frozen scene🙂'
  );
  resumed.cleanup();
  expect(existsSync(resumed.directory)).toBe(false);
});

linuxTest(
  'real Bash reads current data, exports selected live data and keeps full logs',
  async () => {
    const f = fixture();
    const chat = createFixtureChat(f.store, 'Other story');
    completedSource(f.store, chat.id, 'Live other story');
    const child = spawn(process.execPath, [resolve('runner/runner.mjs')], {
      env: { ...process.env, UIMORI_SHELL_ROOT: f.directory },
      stdio: 'ignore',
    });
    owned.at(-1)!.child = child;
    for (let i = 0; i < 100 && !existsSync(join(f.directory, '.exec.sock')); i++) await delay(20);
    expect(existsSync(join(f.directory, '.exec.sock'))).toBe(true);
    const cli = JSON.stringify(resolve('runner/uimori.mjs'));
    const result = await f.shell.run(f.snapshot, randomUUID(), {
      command: `cat current/summary.txt; node ${cli} export '{"scope":"library"}'; node ${cli} export '{"scope":"chats","id":"${chat.id}"}'; python3 -c "print('가나다🙂'*1000)"`,
      timeoutMs: 31000,
      maxOutputBytes: 512,
    });
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, truncated: true });
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(512);
    expect(result.output).not.toContain('�');
    const full = readFileSync(join(f.shell.directory, result.outputFile), 'utf8');
    expect(full).toContain('Existing derived summary');
    expect(full).toContain('가나다🙂'.repeat(1000));
    expect(existsSync(join(f.shell.directory, `library/${f.resource.id}/resource.json`))).toBe(
      false
    );
    expect(readFileSync(join(f.shell.directory, `chats/${chat.id}/scenes/0.txt`), 'utf8')).toBe(
      'Live other story'
    );
    const exported = await f.shell.run(f.snapshot, 'one-resource', {
      command: `node ${cli} export '{"scope":"library","id":"${f.resource.id}"}'; grep -o 'Live library body' library/${f.resource.id}/resource.json`,
    });
    expect(exported.output).toContain('Live library body');
  }
);

linuxTest(
  'main shell cancellation kills descendant writes and allows the next command',
  async () => {
    const f = fixture();
    const child = spawn(process.execPath, [resolve('runner/runner.mjs')], {
      env: { ...process.env, UIMORI_SHELL_ROOT: f.directory },
      stdio: 'ignore',
    });
    owned.at(-1)!.child = child;
    for (let i = 0; i < 100 && !existsSync(join(f.directory, '.exec.sock')); i++) await delay(20);
    const controller = new AbortController();
    const pending = f.shell.run(
      f.snapshot,
      'cancel',
      { command: 'touch scratch/started; (sleep 0.4; echo late > scratch/late) & wait' },
      controller.signal
    );
    const outcome = pending.catch((error: unknown) => error);
    for (let i = 0; i < 100 && !existsSync(join(f.shell.directory, 'scratch/started')); i++)
      await delay(20);
    controller.abort();
    expect(await outcome).toBeInstanceOf(Error);
    await delay(600);
    expect(existsSync(join(f.shell.directory, 'scratch/late'))).toBe(false);
    expect(await f.shell.run(f.snapshot, 'next', { command: 'printf usable' })).toMatchObject({
      output: 'usable',
      exitCode: 0,
    });
  }
);
