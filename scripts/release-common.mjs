import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { filesBelow, fingerprint, killOwned, root } from './lib.mjs';

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const isMain = (url) =>
  Boolean(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(url));

export function parseOptions(args, { values = [], flags = [] } = {}) {
  const result = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (Object.hasOwn(result, key)) throw new Error(`Duplicate option: ${arg}`);
    if (flags.includes(key)) result[key] = true;
    else if (values.includes(key) && args[index + 1] && !args[index + 1].startsWith('--'))
      result[key] = args[++index];
    else throw new Error(`Unknown option or missing value: ${arg}`);
  }
  return result;
}

// Shell text is only used for the remote POSIX command. Local tools receive argv.
export function shellQuote(value) {
  if (typeof value !== 'string' || /[\0\r\n]/u.test(value))
    throw new Error('Invalid remote argument');
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function npmCli() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
  ];
  const found = candidates.find((file) => file && existsSync(file));
  if (!found) throw new Error('npm CLI unavailable; run through npm run release:check');
  return found;
}

export async function releaseFingerprint(repository = root) {
  const application = await fingerprint(repository);
  const packaging = [
    'Dockerfile',
    '.dockerignore',
    'compose.tailscale.yaml',
    '.github/workflows/quality.yml',
    ...(await filesBelow(path.join(repository, 'deploy'))).map((file) =>
      path.relative(repository, file).replaceAll('\\', '/')
    ),
  ].sort();
  const hash = createHash('sha256').update(application.hash + '\0');
  for (const name of packaging) {
    if (!existsSync(path.join(repository, name))) continue;
    hash.update(name + '\0');
    hash.update((await readFile(path.join(repository, name), 'utf8')).replaceAll('\r\n', '\n'));
    hash.update('\0');
  }
  return {
    sourceHash: hash.digest('hex'),
    verificationHash: application.hash,
    node: process.version,
    platform: process.platform,
  };
}

export function identityKey(identity) {
  return sha256(JSON.stringify(identity));
}

export async function readJson(file, missingValue) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' && arguments.length > 1) return missingValue;
    throw error;
  }
}

export async function runExternal(
  executable,
  args,
  {
    cwd = root,
    log,
    timeoutMs = 120_000,
    signal,
    redact = (value) => value,
    env = {},
    spawnChild = spawn,
    terminateChild = killOwned,
    stopTimeoutMs = 5000,
  } = {}
) {
  if (signal?.aborted) throw new Error('Release cancelled');
  const startedAt = new Date().toISOString();
  const child = spawnChild(executable, args, {
    cwd,
    env: { ...process.env, ...env },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '',
    timedOut = false,
    cancelled = false;
  const append = (chunk) => {
    output += chunk.toString();
    // Keep a useful tail even when a child prints an unexpectedly large report.
    if (output.length > 8_000_000) output = output.slice(-8_000_000);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  let cleanup;
  let finish, fallback;
  const stop = () => {
    cleanup ??= terminateChild(child).catch((error) => append(`\nCLEANUP: ${error.message}`));
    fallback ??= setTimeout(() => finish?.(-1), stopTimeoutMs);
  };
  const abort = () => {
    cancelled = true;
    stop();
  };
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, timeoutMs);
  const code = await new Promise((resolve) => {
    finish = resolve;
    child.once('error', (error) => {
      append(error.message);
      resolve(-1);
    });
    child.once('close', (value) => resolve(value ?? -1));
  });
  clearTimeout(timer);
  clearTimeout(fallback);
  signal?.removeEventListener('abort', abort);
  // A failed termination must not make reporting a timeout depend on another
  // unbounded child wait. The recorded outcome stays failed/uncertain.
  if (cleanup) {
    let cleanupTimer;
    await Promise.race([
      cleanup,
      new Promise((resolve) => {
        cleanupTimer = setTimeout(resolve, stopTimeoutMs);
      }),
    ]);
    clearTimeout(cleanupTimer);
  }
  output = redact(output);
  if (log) {
    await mkdir(path.dirname(log), { recursive: true });
    await writeFile(log, output);
  }
  const finishedAt = new Date().toISOString();
  return {
    code,
    timedOut,
    cancelled,
    startedAt,
    finishedAt,
    elapsedMs: Date.parse(finishedAt) - Date.parse(startedAt),
    output,
    ...(log ? { log, logHash: sha256(output) } : {}),
  };
}

export function requireSuccess(result, label) {
  if (result.cancelled) throw new Error(`${label}: cancelled`);
  if (result.timedOut)
    throw new Error(`${label}: timeout; inspect the recorded state before retrying`);
  if (result.code !== 0)
    throw new Error(`${label}: exit ${result.code}\n${result.output.slice(-1600)}`);
  return result;
}
