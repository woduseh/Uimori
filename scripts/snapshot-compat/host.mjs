import { Agent } from 'undici';
import { request, timeoutMs } from './requests.mjs';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { root } from '../lib.mjs';
import { expectedReplayOutbox, tableDigests } from './probes.mjs';

export const git = (...args) =>
  execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
export function buildOld(tree, ref) {
  const sha = git('rev-parse', '--verify', '--end-of-options', ref + '^{commit}');
  git('worktree', 'add', '--detach', tree, sha);
  const npm = process.env.npm_execpath;
  if (!npm) throw new Error('Use npm run verify:snapshot');
  for (const args of [
    ['ci', '--no-audit', '--no-fund'],
    ['run', 'build'],
  ]) {
    execFileSync(process.execPath, [npm, ...args], {
      cwd: tree,
      stdio: 'ignore',
      windowsHide: true,
    });
  }
  return sha;
}
export async function boot(tree, dir, mode, report, children) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'replay.sqlite');
  const before = mode === 'import' ? null : tableDigests(file, true);
  const expected = before && { ...before };
  if (before?.push_outbox) expected.push_outbox = expectedReplayOutbox(file);
  const script = path.join(root, 'scripts', 'snapshot-compat', 'instance.ts');
  const token = randomUUID();
  const env = {
    REPLAY_TOKEN: token,
    TEMP: dir,
    TMP: dir,
    TMPDIR: dir,
    HOME: dir,
    USERPROFILE: dir,
  };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  const child = spawn(
    process.execPath,
    [
      '--permission',
      '--allow-net',
      '--allow-worker',
      '--allow-addons',
      ...[
        dir,
        path.dirname(script),
        path.join(tree, 'dist'),
        path.join(tree, 'node_modules'),
        path.join(tree, 'package.json'),
      ].map((p) => '--allow-fs-read=' + p),
      '--allow-fs-write=' + dir,
      script,
      tree,
      mode,
    ],
    { cwd: dir, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
  );
  const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
  const name = path.basename(dir);
  const closed = once(child, 'close');
  let stderr = '';
  child.stderr.on('data', (bytes) => {
    stderr = (stderr + bytes).slice(-8192);
  });
  const exit = closed.then(([code]) => {
    throw new Error('Instance exited ' + code + ' ' + stderr);
  });
  exit.catch(() => {});
  children.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 4000);
      try {
        await closed;
      } finally {
        clearTimeout(timer);
      }
    }
    await dispatcher.destroy();
    const log = path.join(dir, 'blocked.jsonl');
    if (before && report.boot[path.basename(dir)]) {
      const final = tableDigests(file, true);
      report.boot[path.basename(dir)].final = final;
      if (JSON.stringify(final) !== JSON.stringify(expected))
        report.errors.push({
          phase: 'shutdown',
          url: null,
          instance: name,
          error: 'Work tables changed during replay',
        });
    }
    if (existsSync(log))
      report.blocked.push(
        ...readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((operation) => ({ instance: path.basename(dir), operation: JSON.parse(operation) }))
      );
  });
  const lines = createInterface({ input: child.stdout });
  const [line] = await Promise.race([
    once(lines, 'line', { signal: AbortSignal.timeout(60000) }),
    exit,
  ]);
  const { port, routes } = JSON.parse(line);
  if (before) {
    const after = tableDigests(file, true);
    if (
      before.push_outbox &&
      JSON.stringify(before.push_outbox) === JSON.stringify(after.push_outbox)
    )
      expected.push_outbox = before.push_outbox;
    report.boot[path.basename(dir)] = {
      before,
      after,
      expectedOutbox: expected.push_outbox,
      outboxReason:
        'Environment-dependent: AccessSessions removes sessions for a different access token. Foreign keys cascade to their subscriptions and outbox rows.',
    };
    if (JSON.stringify(expected) !== JSON.stringify(after))
      report.errors.push({
        phase: 'boot',
        url: null,
        instance: name,
        error: 'Work tables changed on boot',
      });
  }
  const instance = {
    routes,
    file,
    name,
    request: (url, options = {}) => {
      if (!url.startsWith('/api/')) throw new Error('Invalid replay URL');
      return fetch('http://127.0.0.1:' + port + url, {
        ...options,
        headers: { ...options.headers, authorization: token, 'accept-encoding': 'identity' },
        redirect: 'error',
        dispatcher,
        signal: AbortSignal.timeout(timeoutMs(url, report.timeoutSeconds)),
      });
    },
  };
  if (mode !== 'import' && routes.includes('/api/diagnostics/metrics')) {
    try {
      instance.initialMetrics = await request(
        instance,
        '/api/diagnostics/metrics',
        async (metrics) => {
          const bytes = await metrics.arrayBuffer();
          return () => new Response(bytes, { status: metrics.status, headers: metrics.headers });
        }
      );
    } catch (error) {
      instance.initialMetrics = () => {
        throw error;
      };
    }
  }
  return instance;
}
