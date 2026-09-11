import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SCOPE = 'trusted-production-https-api';
const MAX_JSON_BYTES = 5 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

function asErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function canonicalOrigin(value) {
  if (typeof value !== 'string') throw new Error('NR_PUBLIC_ORIGIN must be an HTTPS origin');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('NR_PUBLIC_ORIGIN must be an HTTPS origin');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    !url.hostname ||
    url.port === '0' ||
    (value !== url.origin && value !== `${url.origin}/`)
  )
    throw new Error('NR_PUBLIC_ORIGIN must be one exact HTTPS origin');
  return url.origin;
}

function requiredBuildId(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value))
    throw new Error('buildId must be 64 lowercase hexadecimal characters');
  return value;
}

function requiredToken(value) {
  if (typeof value !== 'string' || value.length < 32 || value.length > 1000 || /\s/u.test(value))
    throw new Error('NR_ACCESS_TOKEN must contain 32-1000 non-whitespace characters');
  return value;
}

function responseHeader(response, name) {
  const wanted = name.toLowerCase();
  const headers = response?.headers;
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name) ?? undefined;
  for (const [key, value] of Object.entries(headers))
    if (key.toLowerCase() === wanted) return value;
  return undefined;
}

function setCookieHeaders(response) {
  const headers = response?.headers;
  if (typeof headers?.getSetCookie === 'function') return headers.getSetCookie();
  const value = responseHeader(response, 'set-cookie');
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [String(value)];
}

async function responseText(response, maxBytes) {
  if (typeof response.body === 'string') {
    if (Buffer.byteLength(response.body) > maxBytes)
      throw new Error('response exceeded size limit');
    return response.body;
  }
  if (Buffer.isBuffer(response.body)) {
    if (response.body.length > maxBytes) throw new Error('response exceeded size limit');
    return response.body.toString('utf8');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.length;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error('response exceeded size limit');
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** A TLS-verifying, redirect-refusing requester used by the production CLI. */
export async function nodeHttpsRequest({
  url,
  method = 'GET',
  headers = {},
  body,
  timeoutMs = REQUEST_TIMEOUT_MS,
  maxBytes = MAX_JSON_BYTES,
}) {
  const response = await fetch(url, {
    method,
    headers,
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  });
  return {
    status: response.status,
    headers: response.headers,
    body: await responseText(response, maxBytes),
  };
}

function parseEnvValue(raw, lineNumber) {
  const value = raw.trim();
  if (!value) return '';
  if (value.startsWith('"')) {
    if (!value.endsWith('"'))
      throw new Error(`Invalid quoted environment value on line ${lineNumber}`);
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed !== 'string') throw new Error('not a string');
      return parsed;
    } catch {
      throw new Error(`Invalid quoted environment value on line ${lineNumber}`);
    }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'"))
      throw new Error(`Invalid quoted environment value on line ${lineNumber}`);
    return value.slice(1, -1);
  }
  return value;
}

/** Read only the two access values required by the smoke from an existing private env file. */
export async function readAccessEnv(envFile) {
  if (typeof envFile !== 'string' || !envFile) throw new Error('--env-file is required');
  let source;
  try {
    source = await readFile(envFile, 'utf8');
  } catch {
    throw new Error('Unable to read --env-file');
  }
  const values = new Map();
  for (const [index, original] of source
    .replace(/^\uFEFF/u, '')
    .split(/\r?\n/u)
    .entries()) {
    const line = original.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
    if (!match) throw new Error(`Invalid environment entry on line ${index + 1}`);
    const [, key, raw] = match;
    if (values.has(key)) throw new Error(`Duplicate environment key: ${key}`);
    values.set(key, parseEnvValue(raw, index + 1));
  }
  for (const key of ['NR_PUBLIC_ORIGIN', 'NR_ACCESS_TOKEN'])
    if (!values.has(key) || !values.get(key)) throw new Error(`Missing environment key: ${key}`);
  return {
    origin: canonicalOrigin(values.get('NR_PUBLIC_ORIGIN')),
    token: requiredToken(values.get('NR_ACCESS_TOKEN')),
  };
}

function assertStatus(response, expected) {
  if (!Number.isInteger(response?.status)) throw new Error('request returned no HTTP status');
  if (response.status >= 300 && response.status < 400)
    throw new Error(`redirect refused (HTTP ${response.status})`);
  if (response.status !== expected)
    throw new Error(`expected HTTP ${expected}, received HTTP ${response.status}`);
}

function jsonBody(response) {
  try {
    return JSON.parse(response.body);
  } catch {
    throw new Error('response was not valid JSON');
  }
}

function sessionCookie(response) {
  const cookies = setCookieHeaders(response);
  if (cookies.length !== 1) throw new Error('session response must set exactly one cookie');
  const parts = cookies[0]
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);
  const [pair, ...attributes] = parts;
  const match = /^nr_session=([a-f0-9]{64})$/u.exec(pair ?? '');
  if (!match) throw new Error('session cookie is missing or malformed');
  const normalized = new Set(attributes.map((attribute) => attribute.toLowerCase()));
  for (const attribute of ['secure', 'httponly', 'samesite=strict', 'path=/'])
    if (!normalized.has(attribute)) throw new Error(`session cookie is missing ${attribute}`);
  return { header: pair, secret: match[1] };
}

function assertLibrary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('library summary has invalid shape');
  for (const key of [
    'contents',
    'connections',
    'models',
    'promptPresets',
    'promptCombinations',
    'assets',
  ])
    if (!Array.isArray(value[key])) throw new Error(`library summary is missing ${key}`);
  if (value.contentBodiesOmitted !== true || value.assetsOmitted !== true)
    throw new Error('library summary did not omit large bodies and assets');
  if (
    !value.organization ||
    typeof value.organization !== 'object' ||
    Array.isArray(value.organization)
  )
    throw new Error('library summary is missing organization');
  return {
    contents: value.contents.length,
    connections: value.connections.length,
    models: value.models.length,
    promptPresets: value.promptPresets.length,
    promptCombinations: value.promptCombinations.length,
  };
}

function assertPromptWorkspace(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('prompt workspace has invalid shape');
  if (!Number.isInteger(value.revision) || value.revision < 1)
    throw new Error('prompt workspace has invalid revision');
  for (const role of ['main', 'translation'])
    if (value[role]?.program?.version !== 1)
      throw new Error(`prompt workspace ${role} program is invalid`);
  if (
    !Number.isInteger(value.translationPolicy?.maxRetries) ||
    value.translationPolicy.maxRetries < 0
  )
    throw new Error('prompt workspace translation policy is invalid');
  return { revision: value.revision, mainProgramVersion: 1, translationProgramVersion: 1 };
}

function scriptAsset(html, origin) {
  const match = /<script\b[^>]*\bsrc\s*=\s*(["'])([^"']+)\1[^>]*>/iu.exec(html);
  if (!match) throw new Error('root HTML did not reference a script asset');
  const url = new URL(match[2], `${origin}/`);
  if (url.origin !== origin || url.protocol !== 'https:')
    throw new Error('root HTML referenced a script outside the configured origin');
  return url;
}

/**
 * Run a read-only production check. The optional request dependency is for the node:test harness;
 * production callers should omit it so certificate verification stays enabled.
 */
export async function runOracleSmoke({
  origin,
  token,
  buildId,
  outputFile,
  request = nodeHttpsRequest,
}) {
  const started = Date.now();
  const secrets = new Set(typeof token === 'string' && token ? [token] : []);
  const sanitize = (value) => {
    let result = String(value);
    for (const secret of secrets) if (secret) result = result.split(secret).join('[redacted]');
    return result.replace(/[\r\n]+/gu, ' ').slice(0, 1000);
  };
  const summary = {
    status: 'FAIL',
    scope: SCOPE,
    proof: 'HTTPS/API',
    origin: null,
    expectedBuildId: null,
    startedAt: new Date(started).toISOString(),
    finishedAt: null,
    elapsedMs: null,
    checks: [],
    failures: [],
    requestCounts: { GET: 0, POST: 0 },
    limitations: [
      'Read-only HTTPS/API deployment proof; no browser layout, GUI, physical-device or IME claim.',
      'Only one same-origin session POST plus GET requests; no model, import, archive, settings or application-data mutation.',
      'Does not inspect production database integrity, container identity, provider behavior or semantic quality.',
    ],
  };
  let configuredOrigin;
  const record = async (name, action) => {
    try {
      const detail = await action();
      summary.checks.push({ name, status: 'PASS', ...(detail === undefined ? {} : { detail }) });
      return detail;
    } catch (error) {
      const message = sanitize(asErrorMessage(error));
      summary.checks.push({ name, status: 'FAIL', error: message });
      throw new Error(`${name}: ${message}`);
    }
  };
  const send = async (pathname, options = {}) => {
    const method = options.method ?? 'GET';
    if (method !== 'GET' && !(method === 'POST' && pathname === '/api/session'))
      throw new Error('smoke attempted a disallowed request method or path');
    if (method === 'POST' && summary.requestCounts.POST !== 0)
      throw new Error('smoke attempted more than one POST');
    const url = new URL(pathname, `${configuredOrigin}/`);
    if (url.origin !== configuredOrigin || url.protocol !== 'https:')
      throw new Error('smoke attempted a request outside the configured origin');
    summary.requestCounts[method]++;
    try {
      return await request({
        url,
        method,
        headers: options.headers ?? {},
        body: options.body,
        timeoutMs: REQUEST_TIMEOUT_MS,
        maxBytes: options.maxBytes ?? MAX_JSON_BYTES,
      });
    } catch (error) {
      throw new Error(sanitize(asErrorMessage(error)));
    }
  };
  try {
    configuredOrigin = canonicalOrigin(origin);
    const accessToken = requiredToken(token);
    const expectedBuildId = requiredBuildId(buildId);
    if (typeof request !== 'function') throw new Error('request dependency must be a function');
    summary.origin = configuredOrigin;
    summary.expectedBuildId = expectedBuildId;

    await record('anonymous APIs deny access', async () => {
      for (const pathname of ['/api/health', '/api/library?view=summary', '/api/prompt-workspace'])
        assertStatus(await send(pathname), 401);
      return { endpoints: 3 };
    });

    let cookie;
    await record('same-origin login creates a secure HttpOnly session', async () => {
      const response = await send('/api/session', {
        method: 'POST',
        headers: { Origin: configuredOrigin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: accessToken }),
      });
      assertStatus(response, 200);
      const body = jsonBody(response);
      if (body?.required !== true || body?.authenticated !== true)
        throw new Error('session response did not confirm required authentication');
      cookie = sessionCookie(response);
      secrets.add(cookie.secret);
      return { secure: true, httpOnly: true, sameSite: 'Strict', path: '/' };
    });

    const authenticatedHeaders = () => ({ Cookie: cookie.header });
    await record('authenticated health matches the release build', async () => {
      const response = await send('/api/health', { headers: authenticatedHeaders() });
      assertStatus(response, 200);
      const body = jsonBody(response);
      if (
        body?.ready !== true ||
        body?.testMode !== false ||
        body?.mode !== 'self-host' ||
        body?.buildId !== expectedBuildId
      )
        throw new Error('authenticated health identity did not match the expected release');
      return { ready: true, testMode: false, mode: 'self-host', buildId: expectedBuildId };
    });

    await record('read-only library summary is sane', async () => {
      const response = await send('/api/library?view=summary', {
        headers: authenticatedHeaders(),
      });
      assertStatus(response, 200);
      return assertLibrary(jsonBody(response));
    });

    await record('current prompt workspace is sane', async () => {
      const response = await send('/api/prompt-workspace', { headers: authenticatedHeaders() });
      assertStatus(response, 200);
      return assertPromptWorkspace(jsonBody(response));
    });

    await record('root HTML and same-origin JavaScript asset are delivered', async () => {
      const root = await send('/', { maxBytes: 1024 * 1024 });
      assertStatus(root, 200);
      if (!/^text\/html(?:;|$)/iu.test(String(responseHeader(root, 'content-type') ?? '')))
        throw new Error('root response was not HTML');
      const assetUrl = scriptAsset(root.body, configuredOrigin);
      const asset = await send(`${assetUrl.pathname}${assetUrl.search}`, {
        maxBytes: 10 * 1024 * 1024,
      });
      assertStatus(asset, 200);
      if (!/(?:java|ecma)script/iu.test(String(responseHeader(asset, 'content-type') ?? '')))
        throw new Error('script asset response was not JavaScript');
      if (Buffer.byteLength(asset.body) < 100) throw new Error('script asset response was empty');
      return { root: '/', assetPath: assetUrl.pathname };
    });

    if (summary.requestCounts.POST !== 1) throw new Error('smoke did not perform exactly one POST');
    summary.status = 'PASS';
  } catch (error) {
    summary.failures.push(sanitize(asErrorMessage(error)));
  } finally {
    const finished = Date.now();
    summary.finishedAt = new Date(finished).toISOString();
    summary.elapsedMs = Math.max(0, finished - started);
    if (outputFile) {
      await mkdir(path.dirname(path.resolve(outputFile)), { recursive: true });
      await writeFile(outputFile, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
    }
  }
  return summary;
}

function usage() {
  return `Usage: node scripts/oracle-smoke.mjs --env-file <path> --build-id <64hex> --output <summary.json>\n\nRuns a trusted HTTPS/API deployment smoke using one session POST and read-only GET requests.\nThe access token is read only from --env-file and is never accepted as a CLI argument.`;
}

function parseCli(argv) {
  if (argv.includes('--help')) {
    if (argv.length !== 1) throw new Error('--help cannot be combined with other arguments');
    return { help: true };
  }
  const allowed = new Set(['--env-file', '--build-id', '--output']);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key)) throw new Error(`Unknown argument: ${key ?? '(missing)'}`);
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    if (values.has(key)) throw new Error(`Duplicate argument: ${key}`);
    values.set(key, value);
  }
  for (const key of allowed) if (!values.has(key)) throw new Error(`Missing argument: ${key}`);
  return {
    help: false,
    envFile: values.get('--env-file'),
    buildId: values.get('--build-id'),
    outputFile: values.get('--output'),
  };
}

async function main() {
  let args;
  try {
    args = parseCli(process.argv.slice(2));
    if (args.help) {
      console.log(usage());
      return;
    }
    const access = await readAccessEnv(args.envFile);
    const summary = await runOracleSmoke({
      ...access,
      buildId: args.buildId,
      outputFile: args.outputFile,
    });
    console.log(
      JSON.stringify({ status: summary.status, proof: summary.proof, output: args.outputFile })
    );
    if (summary.status !== 'PASS') process.exitCode = 1;
  } catch (error) {
    console.error(`Oracle smoke configuration failed: ${asErrorMessage(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)
  await main();
