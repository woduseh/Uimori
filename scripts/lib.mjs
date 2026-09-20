import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const artifactRoot = path.join(root, 'output', 'playwright');
export const canary = 'm0-secret-canary-do-not-record-73915';
export const newId = () =>
  `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
export function localVerificationEnv(variables = {}) {
  return {
    ...variables,
    UIMORI_PORT: '0',
    UIMORI_HOST: '127.0.0.1',
    UIMORI_TEST_MODE: '1',
    // Undefined removes inherited configuration at spawn; an empty origin is invalid.
    UIMORI_PUBLIC_ORIGIN: undefined,
    UIMORI_ACCESS_TOKEN: '',
    UIMORI_PROVIDER_ORIGINS: variables.UIMORI_PROVIDER_ORIGINS ?? '',
    UIMORI_CODEX_ENABLED: '0',
    UIMORI_CODEX_EXECUTABLE: undefined,
  };
}
export function createOwnership(directory, startedAt) {
  return {
    runId: path.basename(directory),
    ownerPid: process.pid,
    root,
    directory: path.resolve(directory),
    active: true,
    children: [],
    startedAt,
  };
}
export async function json(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2) + '\n');
}
export async function filesBelow(dir) {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? filesBelow(path.join(dir, entry.name))
        : entry.isFile()
          ? [path.join(dir, entry.name)]
          : []
    )
  );
  return nested.flat().sort();
}
export function ownedPath(parent, target) {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error(`Unsafe cleanup target: ${target}`);
  return path.resolve(target);
}
export async function removeOwned(parent, target) {
  ownedPath(parent, target);
  // Reject symlinks/junctions along the cleanup path, including its parent.
  const { lstat, realpath } = await import('node:fs/promises');
  const resolvedParent = await realpath(parent);
  const comparable = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
  if (comparable(resolvedParent) !== comparable(path.resolve(parent)))
    throw new Error(`Junction/alias cleanup parent refused: ${parent}`);
  let cursor = path.resolve(target);
  while (true) {
    if (existsSync(cursor) && (await lstat(cursor)).isSymbolicLink())
      throw new Error(`Symlink cleanup refused: ${cursor}`);
    if (cursor === path.resolve(parent)) break;
    cursor = path.dirname(cursor);
  }
  await rm(target, { recursive: true, force: true });
}
export async function fingerprint(
  sourceRoot = root,
  { buildOnly = false, verificationOnly = false } = {}
) {
  const root = sourceRoot;
  const dirs = verificationOnly
    ? ['tests', 'scripts', 'fixtures']
    : buildOnly
      ? ['core', 'server', 'web', 'src', 'third_party']
      : ['core', 'server', 'web', 'src', 'third_party', 'tests', 'scripts', 'fixtures'];
  const config = (await readdir(root)).filter((name) =>
    (buildOnly
      ? /^(package(?:-lock)?\.json|tsconfig(?:\.server)?\.json|vite\.config\.[cm]?[jt]s|\.gitattributes)$/
      : /^(package(?:-lock)?\.json|(?:tsconfig.*\.json)|(?:vite|vitest|playwright)\.config\.[cm]?[jt]s|biome\.json|\.gitattributes)$/
    ).test(name)
  );
  const files = [
    ...(await Promise.all(dirs.map((dir) => filesBelow(path.join(root, dir))))).flat(),
    ...config.map((name) => path.join(root, name)),
    ...(buildOnly
      ? [
          'scripts/build.mjs',
          'scripts/build-runner.mjs',
          'scripts/lib.mjs',
          'scripts/browser-path.mjs',
        ]
          .map((name) => path.join(root, name))
          .filter(existsSync)
      : []),
  ].sort();
  const hash = createHash('sha256');
  for (const file of files) {
    const content = await readFile(file);
    const normalized = /\.(?:[cm]?[jt]sx?|json|html|css|txt|md)$/.test(file)
      ? Buffer.from(content.toString('utf8').replaceAll('\r\n', '\n'))
      : content;
    hash.update(path.relative(root, file).replaceAll('\\', '/') + '\0');
    hash.update(normalized);
    hash.update('\0');
  }
  return {
    hash: hash.digest('hex'),
    files: files.map((file) => path.relative(root, file).replaceAll('\\', '/')),
    lineEndings: 'text CRLF normalized to LF',
  };
}
// Tests and verification runners identify evidence, but are not compiler inputs.
export async function buildFingerprint(sourceRoot = root) {
  return fingerprint(sourceRoot, { buildOnly: true });
}
export async function distHash(directory = path.join(root, 'dist')) {
  const hash = createHash('sha256');
  for (const file of await filesBelow(directory)) {
    if (path.basename(file) === 'build-identity.json') continue;
    hash.update(path.relative(directory, file).replaceAll('\\', '/') + '\0');
    hash.update(await readFile(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}
export async function assertBuild({ checkSource = true } = {}) {
  const manifest = JSON.parse(
    await readFile(path.join(root, 'dist', 'build-identity.json'), 'utf8')
  );
  if (checkSource && (await buildFingerprint()).hash !== manifest.sourceHash)
    throw new Error('Source fingerprint differs from build. Run npm run build.');
  if ((await distHash()) !== manifest.distHash)
    throw new Error('Compiled build fingerprint mismatch.');
  return manifest;
}
export { browserPath } from './browser-path.mjs';
export async function killOwned(child) {
  if (child.exitCode !== null || child.signalCode !== null)
    return { pid: child.pid, alreadyExited: true };
  if (process.platform === 'win32') {
    const result = await new Promise((resolve) => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.once('error', (error) => resolve({ error: error.message }));
      killer.once('exit', (code) => resolve({ code }));
    });
    if (result.error) throw new Error(result.error);
    if (result.code !== 0 && child.exitCode === null && child.signalCode === null)
      throw new Error(`taskkill failed for owned PID ${child.pid}: ${result.code}`);
  } else child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('close', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  if (child.exitCode === null && child.signalCode === null)
    throw new Error(`Owned PID ${child.pid} did not exit`);
  return { pid: child.pid, exited: true };
}
export async function command(
  args,
  { cwd = root, env = {}, timeout = 120000, log, children } = {}
) {
  const started = Date.now();
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...process.env, ...env },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children?.add(child);
  let output = '';
  let timedOut = false;
  child.stdout.on('data', (value) => {
    output += value;
  });
  child.stderr.on('data', (value) => {
    output += value;
  });
  let timer;
  const code = await new Promise((resolve) => {
    child.once('error', (error) => {
      output += error.message;
      resolve(-1);
    });
    child.once('close', (value) => resolve(value ?? -1));
    timer = setTimeout(() => {
      timedOut = true;
      const fallback = setTimeout(() => resolve(-1), 4000);
      void killOwned(child)
        .catch((error) => {
          output += `\nCLEANUP: ${error.message}`;
        })
        .finally(() => {
          clearTimeout(fallback);
          resolve(-1);
        });
    }, timeout);
  });
  clearTimeout(timer);
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) children?.delete(child);
  if (log) await writeFile(log, output);
  return {
    command: [process.execPath, ...args],
    cwd,
    code,
    timedOut,
    elapsedMs: Date.now() - started,
    output,
  };
}
export function requireCommand(result) {
  if (result.timedOut) throw new Error(`Command timeout: ${result.command.join(' ')}`);
  if (result.code !== 0)
    throw new Error(
      `Command exit ${result.code}: ${result.command.join(' ')}\n${result.output.slice(-1800)}`
    );
}
export async function assertHealth(url, expected) {
  const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(4000) });
  if (!response.ok) throw new Error(`Health HTTP ${response.status}`);
  const actual = await response.json();
  for (const field of ['buildId', 'instanceId', 'dbPath']) {
    if (actual[field] !== expected[field])
      throw new Error(
        `Stale/wrong server ${field}: expected ${expected[field]}, received ${actual[field]}`
      );
  }
  return actual;
}
export async function startServer(env, directory, children, cwd = root) {
  const child = spawn(process.execPath, ['dist/server/index.js'], {
    cwd,
    env: { ...process.env, ...env },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  const log = path.join(directory, 'server.log');
  let output = '';
  let pending = '';
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('App ready timeout (15000ms)')), 15000);
    const fail = (code) => {
      clearTimeout(timer);
      reject(new Error(`App exited before ready (${code}): ${output.slice(-1000)}`));
    };
    child.once('error', fail);
    child.once('exit', fail);
    child.stderr.on('data', (value) => {
      output += value;
      void writeFile(log, output);
    });
    child.stdout.on('data', (value) => {
      output += value;
      pending += value;
      void writeFile(log, output);
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || '';
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.event === 'ready') {
            clearTimeout(timer);
            child.removeListener('exit', fail);
            child.removeListener('error', fail);
            resolve(event);
          }
        } catch {
          /* ordinary diagnostic line */
        }
      }
    });
  });
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(ready.url))
    throw new Error(`Unexpected local ready URL: ${ready.url}`);
  await assertHealth(ready.url, {
    buildId: env.UIMORI_BUILD_ID,
    instanceId: env.UIMORI_INSTANCE,
    dbPath: env.UIMORI_DB,
  });
  return { child, ready };
}
export async function readBrowserReport(file, since) {
  if (!existsSync(file)) throw new Error('playwright report missing');
  if ((await stat(file)).mtimeMs < since - 1000) throw new Error('playwright stale report');
  const report = JSON.parse(await readFile(file, 'utf8'));
  const tests = [];
  function visit(suite, parents = []) {
    for (const spec of suite.specs || [])
      for (const test of spec.tests || []) {
        const results = test.results || [];
        tests.push({
          title: [...parents, suite.title || '', spec.title].join(' '),
          status:
            test.status === 'expected' &&
            test.expectedStatus === 'passed' &&
            results.length === 1 &&
            results[0].status === 'passed'
              ? 'passed'
              : test.status || 'missing',
        });
      }
    for (const nested of suite.suites || []) visit(nested, [...parents, suite.title || '']);
  }
  for (const suite of report.suites || []) visit(suite);
  const globalFailure = Boolean(report.errors?.length);
  const skipped = tests.filter((test) => test.status === 'skipped').length;
  const failed = tests.filter(
    (test) => test.status !== 'passed' && test.status !== 'skipped'
  ).length;
  const observations = {
    discovered: tests.length,
    executed: tests.length - skipped,
    passed: tests.length - failed - skipped,
    skipped,
    failed,
    globalFailure,
    tests,
    report: path.relative(root, file),
  };
  const problem = !tests.length
    ? 'playwright: zero discovered tests'
    : skipped || failed
      ? `playwright: required tests not PASS (${skipped} skipped, ${failed} failed)`
      : globalFailure
        ? 'playwright reporter records global failure'
        : undefined;
  if (problem) {
    const error = new Error(problem);
    error.observations = observations;
    throw error;
  }
  return observations;
}
export async function artifactScan(directory) {
  const bad = [];
  for (const file of await filesBelow(directory)) {
    if ((await readFile(file)).includes(Buffer.from(canary)))
      bad.push(path.relative(directory, file));
  }
  if (bad.length) throw new Error(`Synthetic secret canary leaked to artifacts: ${bad.join(', ')}`);
  return {
    status: 'PASS',
    filesScanned: (await filesBelow(directory)).length,
    scope: 'known synthetic secret canary only; no real secrets or private prose used',
  };
}
