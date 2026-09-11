import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { get } from 'node:http';
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

// Use node:http so the HTTPS-origin Host reaches the loopback server unchanged.
export function probeSession(url, host, timeoutMs = 500) {
  return new Promise((resolve) => {
    const finish = (ready) => {
      clearTimeout(timer);
      resolve(ready);
    };
    const request = get(url, { headers: { Host: host }, agent: false }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
        if (body.length > 65536) request.destroy(new Error('Probe response too large'));
      });
      response.on('error', () => finish(false));
      response.on('end', () => {
        try {
          const session = JSON.parse(body);
          finish(
            response.statusCode === 200 &&
              session.required === true &&
              session.authenticated === false
          );
        } catch {
          finish(false);
        }
      });
    });
    const timer = setTimeout(() => {
      request.destroy();
      finish(false);
    }, timeoutMs);
    request.on('error', () => finish(false));
  });
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
      if (await probeSession('http://127.0.0.1:4310/api/session', 'oracle-probe.invalid')) {
        ready = true;
        break;
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
