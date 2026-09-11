import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectData } from './oracle-data.mjs';

export function artifactHash(directory) {
  const hash = createHash('sha256');
  const files = [];
  function visit(folder) {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const file = join(folder, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && basename(file) !== 'build-identity.json') {
        files.push(file);
      } else if (!entry.isFile()) throw new Error('Unexpected artifact file type');
    }
  }
  visit(directory);
  for (const file of files.sort()) {
    hash.update(relative(directory, file).replaceAll('\\', '/') + '\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function verifyIdentity(directory, buildId, distHash) {
  const identity = JSON.parse(readFileSync(join(directory, 'build-identity.json'), 'utf8'));
  if (
    identity.buildId !== buildId ||
    identity.sourceHash !== buildId ||
    identity.distHash !== distHash ||
    artifactHash(directory) !== distHash
  )
    throw new Error('Image build identity or artifact hash mismatch');
  return identity;
}

export async function bootProbe(app = '/app', data = '/data') {
  const identity = verifyIdentity(
    join(app, 'dist'),
    process.env.EXPECTED_BUILD,
    process.env.EXPECTED_DIST
  );
  const child = spawn(process.execPath, ['dist/server/index.js'], {
    cwd: app,
    env: {
      ...process.env,
      NR_DB: join(data, 'narrative.sqlite'),
      NR_HOST: '127.0.0.1',
      NR_PORT: '4310',
      NR_PUBLIC_ORIGIN: 'https://oracle-probe.invalid',
      NR_ACCESS_TOKEN: 'isolated-oracle-image-probe-token-0000',
      NR_PROVIDER_ORIGINS: '',
      NR_CODEX_ENABLED: '0',
      NR_BUILD_ID: identity.buildId,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const exited = once(child, 'exit');
  let diagnostics = '';
  child.stdout.on('data', (chunk) => {
    diagnostics = (diagnostics + chunk).slice(-3000);
  });
  child.stderr.on('data', (chunk) => {
    diagnostics = (diagnostics + chunk).slice(-3000);
  });
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null)
        throw new Error(`Linux application startup failed: ${diagnostics}`);
      try {
        const response = await fetch('http://127.0.0.1:4310/api/session', {
          headers: { Host: 'oracle-probe.invalid' },
          signal: AbortSignal.timeout(500),
        });
        const session = await response.json();
        if (
          response.status === 200 &&
          session.required === true &&
          session.authenticated === false
        ) {
          ready = true;
          break;
        }
      } catch {
        /* Wait for the isolated application listener. */
      }
      await delay(200);
    }
    if (!ready) throw new Error(`Linux application startup timed out: ${diagnostics}`);
  } finally {
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    await exited;
    clearTimeout(timer);
  }
  return {
    status: 'PASS',
    identity,
    database: inspectData(data, { integrity: true, columns: true }),
    scope: 'Isolated actual-image Linux boot; no provider calls',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  console.log(JSON.stringify(await bootProbe()));
