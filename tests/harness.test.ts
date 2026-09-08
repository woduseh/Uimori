import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { listenAddress, networkPolicy } from '../server/network-policy.js';

// Exercise the real reporter, artifact files and cleanup paths while replacing
// process/browser launch and build inputs with deterministic fault boundaries.
vi.mock('../scripts/lib.mjs', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertBuild: vi.fn(),
  fingerprint: vi.fn(),
  buildFingerprint: vi.fn(),
  browserPath: vi.fn(),
  startServer: vi.fn(),
  command: vi.fn(),
  killOwned: vi.fn(),
  artifactScan: vi.fn(),
  json: vi.fn(),
}));
const libraryUrl = new URL('../scripts/lib.mjs', import.meta.url).href;
const runnerUrl = new URL('../scripts/browser-verification.mjs', import.meta.url).href;
const lib = await import(libraryUrl);
const realLib: typeof lib = await vi.importActual('../scripts/lib.mjs');
const { runBrowserVerification } = await import(runnerUrl);
const directories = new Set<string>();
const originalArgv = process.argv;
const originalExitCode = process.exitCode;
const identity = { buildId: 'fixture-build', sourceHash: 'fixture-source' };
let report: Record<string, unknown> | undefined;
let commandFailure = { code: 0, timedOut: false };

function browserReport({
  title = 'CASE01 required scenario',
  status = 'expected',
  expectedStatus = 'passed',
  results = [{ status: 'passed' }],
  errors = [] as unknown[],
} = {}) {
  return {
    errors,
    suites: [
      {
        title: 'fixture-browser.spec.ts',
        specs: [{ title, tests: [{ status, expectedStatus, results }] }],
      },
    ],
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  process.argv = originalArgv.slice(0, 2);
  report = browserReport();
  commandFailure = { code: 0, timedOut: false };
  lib.assertBuild.mockResolvedValue(identity);
  lib.fingerprint.mockResolvedValue({ hash: identity.sourceHash });
  lib.buildFingerprint.mockResolvedValue({ hash: identity.sourceHash });
  vi.stubEnv('NR_VISUAL_REVIEW', '0');
  lib.browserPath.mockReturnValue(process.execPath);
  lib.killOwned.mockResolvedValue({ exited: true });
  lib.artifactScan.mockImplementation(realLib.artifactScan);
  lib.json.mockImplementation(realLib.json);
  lib.startServer.mockImplementation(
    async (env: Record<string, string>, _directory: string, children: Set<unknown>) => {
      await writeFile(env.NR_DB!, 'synthetic DB evidence');
      const child = { pid: 12345, exitCode: 0, signalCode: null };
      children.add(child);
      return { child, ready: { url: 'http://127.0.0.1:1', dbPath: env.NR_DB } };
    }
  );
  lib.command.mockImplementation(
    async (args: string[], options: { env: Record<string, string> }) => {
      if (report !== undefined)
        await writeFile(options.env.PLAYWRIGHT_JSON_OUTPUT_NAME!, JSON.stringify(report));
      return { command: [process.execPath, ...args], output: 'fixture', ...commandFailure };
    }
  );
});

afterEach(async () => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of directories) await lib.removeOwned(lib.artifactRoot, directory);
  directories.clear();
});

async function run(options: Record<string, unknown> = {}) {
  const result = await runBrowserVerification({
    name: 'harness-selftest',
    scope: 'Synthetic harness fault injection only',
    requiredCases: ['CASE01'],
    ...options,
  });
  directories.add(result.directory);
  expect(JSON.parse(await readFile(path.join(result.directory, 'summary.json'), 'utf8'))).toEqual(
    result.summary
  );
  return result;
}

test('browser harness preserves selected commands, verified identity and DB evidence with a cleanup-compatible owner', async () => {
  const { directory, summary } = await run({
    files: ['tests/fixture-browser.spec.ts'],
    grep: 'CASE01',
    timeout: 4321,
  });
  expect(summary.status).toBe('PASS');
  expect(summary.identityVerifiedAt).toEqual(expect.any(String));
  expect(summary.cleanup).toMatchObject({ status: 'PASS', runtimeRemoved: true });
  expect(summary.artifactScan.status).toBe('PASS');
  expect(await readFile(path.join(directory, 'evidence-db', 'app.sqlite'), 'utf8')).toBe(
    'synthetic DB evidence'
  );
  expect(lib.command).toHaveBeenCalledWith(
    [
      'node_modules/@playwright/test/cli.js',
      'test',
      'tests/fixture-browser.spec.ts',
      '--grep',
      'CASE01',
      '--reporter=json',
    ],
    expect.objectContaining({ timeout: 4321 })
  );
  const owner = JSON.parse(await readFile(path.join(directory, 'ownership.json'), 'utf8'));
  expect(owner).toMatchObject({
    root: lib.root,
    directory,
    ownerPid: process.pid,
    active: false,
    cleanup: summary.cleanup,
  });
  const cleanup = spawnSync(process.execPath, ['scripts/cleanup.mjs', '--run', owner.runId], {
    cwd: lib.root,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
  });
  expect(cleanup.status, cleanup.stderr).toBe(0);
  expect(JSON.parse(cleanup.stdout)).toMatchObject({ status: 'PASS', evidencePreserved: true });
  expect(existsSync(path.join(directory, 'evidence-db', 'app.sqlite'))).toBe(true);
});

test.each([false, true])(
  'local verification isolates inherited self-host and Codex settings at the real spawn boundary (registration fixture: %s)',
  async (registrationFixture) => {
    vi.stubEnv('NR_PUBLIC_ORIGIN', 'https://synthetic-self-host.example');
    vi.stubEnv('NR_HOST', '0.0.0.0');
    vi.stubEnv('NR_PORT', '4310');
    vi.stubEnv('NR_ACCESS_TOKEN', 'synthetic-parent-token-for-harness-only');
    vi.stubEnv('NR_PROVIDER_ORIGINS', 'https://synthetic-provider.example');
    vi.stubEnv('NR_CODEX_ENABLED', '1');
    vi.stubEnv('NR_CODEX_EXECUTABLE', 'synthetic-parent-codex.exe');
    await run({ registrationFixture });
    const env: NodeJS.ProcessEnv = lib.startServer.mock.calls[0][0];
    const providerOrigins = registrationFixture
      ? new URL(env.NR_REGISTRATION_FIXTURE_URL!).origin
      : '';
    if (registrationFixture) expect(new URL(providerOrigins).hostname).toBe('127.0.0.1');
    const probe = await realLib.command(
      [
        '-e',
        `process.stdout.write(JSON.stringify({
        publicOriginPresent: Object.hasOwn(process.env, 'NR_PUBLIC_ORIGIN'),
        codexExecutablePresent: Object.hasOwn(process.env, 'NR_CODEX_EXECUTABLE'),
        env: {
          NR_PUBLIC_ORIGIN: process.env.NR_PUBLIC_ORIGIN,
          NR_HOST: process.env.NR_HOST,
          NR_PORT: process.env.NR_PORT,
          NR_TEST_MODE: process.env.NR_TEST_MODE,
          NR_ACCESS_TOKEN: process.env.NR_ACCESS_TOKEN,
          NR_PROVIDER_ORIGINS: process.env.NR_PROVIDER_ORIGINS,
          NR_CODEX_ENABLED: process.env.NR_CODEX_ENABLED,
        },
      }));`,
      ],
      { env }
    );
    expect(probe.code, probe.output).toBe(0);
    const child = JSON.parse(probe.output);
    expect(child.publicOriginPresent).toBe(false);
    expect(child.codexExecutablePresent).toBe(false);
    expect(child.env).toEqual({
      NR_HOST: '127.0.0.1',
      NR_PORT: '0',
      NR_TEST_MODE: '1',
      NR_ACCESS_TOKEN: '',
      NR_PROVIDER_ORIGINS: providerOrigins,
      NR_CODEX_ENABLED: '0',
    });
    const policy = networkPolicy({
      publicOrigin: child.env.NR_PUBLIC_ORIGIN,
      accessToken: child.env.NR_ACCESS_TOKEN,
      testMode: child.env.NR_TEST_MODE === '1',
    });
    expect(policy).toEqual({});
    expect(listenAddress(child.env, policy)).toEqual({ host: '127.0.0.1', port: 0 });
    expect(process.env.NR_PUBLIC_ORIGIN).toBe('https://synthetic-self-host.example');
    expect(process.env.NR_CODEX_ENABLED).toBe('1');
    expect(process.env.NR_CODEX_EXECUTABLE).toBe('synthetic-parent-codex.exe');
  }
);

test.each(['missing', 'zero', 'skipped', 'retried', 'global'])(
  'browser harness rejects %s reporter evidence and still records cleanup',
  async (fault) => {
    report =
      fault === 'missing'
        ? undefined
        : fault === 'zero'
          ? { suites: [] }
          : fault === 'skipped'
            ? browserReport({ status: 'skipped', expectedStatus: 'skipped', results: [] })
            : fault === 'retried'
              ? browserReport({ results: [{ status: 'failed' }, { status: 'passed' }] })
              : browserReport({ errors: [{ message: 'global fixture failure' }] });
    const { summary } = await run();
    expect(summary.status).toBe('FAIL');
    expect(summary.failures.length).toBeGreaterThan(0);
    expect(summary.cleanup.status).toBe('PASS');
    expect(summary.evidenceIdentity).toBe('NOT_CONFIRMED_AT_END');
    expect(process.exitCode).toBe(1);
  }
);

test.each(['command', 'timeout', 'source', 'tests'])(
  'passing assertions cannot hide a %s failure',
  async (fault) => {
    if (fault === 'command') commandFailure.code = 1;
    if (fault === 'timeout') commandFailure.timedOut = true;
    if (fault === 'source')
      lib.assertBuild
        .mockResolvedValueOnce(identity)
        .mockRejectedValueOnce(new Error('stale build'));
    if (fault === 'tests')
      lib.fingerprint
        .mockResolvedValueOnce({ hash: 'before' })
        .mockResolvedValueOnce({ hash: 'after' });
    const { summary } = await run();
    expect(summary.report.passed).toBe(1);
    expect(summary.status).toBe('FAIL');
    expect(summary.cleanup.status).toBe('PASS');
    expect(summary.identityVerifiedAt).toBeUndefined();
  }
);

test('functional mode records separate verification identity and does not require design PNGs', async () => {
  lib.fingerprint.mockResolvedValue({ hash: 'test-only-change' });
  const { summary } = await run({ requiredScreenshots: ['design-only.png'] });
  expect(summary.status).toBe('PASS');
  expect(summary.visualReview).toBe(false);
  expect(summary.requiredScreenshots).toEqual([]);
  expect(summary.identity.sourceHash).toBe(identity.sourceHash);
  expect(summary.verificationIdentity.hash).toBe('test-only-change');
});

test('missing required IDs cannot be satisfied by a longer ID with the same prefix', async () => {
  report = browserReport({ title: 'CASE010 unrelated scenario' });
  const { summary } = await run();
  expect(summary.status).toBe('FAIL');
  expect(summary.failures).toContain('Missing CASE01 evidence');
});

test('primary and cleanup failures both survive in the saved summary and ownership', async () => {
  commandFailure.code = 1;
  lib.killOwned.mockRejectedValue(new Error('injected process cleanup failure'));
  const { directory, summary } = await run();
  expect(summary.status).toBe('FAIL');
  expect(summary.failures.some((message: string) => message.startsWith('Command exit 1:'))).toBe(
    true
  );
  expect(summary.failures).toContain('Cleanup: injected process cleanup failure');
  expect(summary.cleanup.status).toBe('FAIL');
  const owner = JSON.parse(await readFile(path.join(directory, 'ownership.json'), 'utf8'));
  expect(owner.cleanup.status).toBe('FAIL');
});

test('missing browser records BLOCKED before any server or test launch', async () => {
  lib.browserPath.mockReturnValue(undefined);
  const { summary } = await run();
  expect(summary.status).toBe('BLOCKED');
  expect(summary.cleanup.status).toBe('PASS');
  expect(lib.startServer).not.toHaveBeenCalled();
  expect(lib.command).not.toHaveBeenCalled();
});

test.each(['missing', 'invalid-signature', 'truncated', 'valid'])(
  'required PNG evidence is checked on disk: %s',
  async (scenario) => {
    vi.stubEnv('NR_VISUAL_REVIEW', '1');
    const originalCommand = lib.command.getMockImplementation();
    const relativeScreenshot = path.join('browser', 'nested-output', 'required.png');
    lib.command.mockImplementation(
      async (args: string[], options: { env: Record<string, string> }) => {
        if (scenario !== 'missing') {
          const directory = path.join(options.env.NR_BROWSER_OUTPUT!, 'nested-output');
          await mkdir(directory, { recursive: true });
          const valid = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9n8AAAAASUVORK5CYII=',
            'base64'
          );
          const bytes = scenario === 'truncated' ? valid.subarray(0, 16) : Buffer.from(valid);
          if (scenario === 'invalid-signature') bytes[0] = 0;
          await writeFile(path.join(directory, 'required.png'), bytes);
        }
        return originalCommand(args, options);
      }
    );
    const { directory, summary } = await run({ requiredScreenshots: ['required.png'] });
    expect(summary.report.passed).toBe(1);
    expect(summary.cleanup.status).toBe('PASS');
    if (scenario === 'valid') {
      expect(summary.status).toBe('PASS');
      expect(summary.screenshots).toContain(relativeScreenshot);
      expect(existsSync(path.join(directory, relativeScreenshot))).toBe(true);
    } else {
      expect(summary.status).toBe('FAIL');
      expect(summary.failures).toContain(
        `${scenario === 'missing' ? 'Missing' : 'Invalid'} screenshot: required.png`
      );
      expect(process.exitCode).toBe(1);
    }
  }
);

test('passing browser assertions cannot hide errors from the actual loopback provider fixture', async () => {
  const originalCommand = lib.command.getMockImplementation();
  lib.command.mockImplementation(
    async (args: string[], options: { env: Record<string, string> }) => {
      const response = await fetch(options.env.NR_REGISTRATION_FIXTURE_URL!, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ protocol: 'unexpected-fixture-request', input: {} }),
        signal: AbortSignal.timeout(2000),
      });
      expect(response.status).toBe(500);
      return originalCommand(args, options);
    }
  );
  const { summary } = await run({ registrationFixture: true });
  expect(summary.report.passed).toBe(1);
  expect(summary.status).toBe('FAIL');
  expect(summary.registrationFixture.errors).toEqual(['Unexpected fixture purpose']);
  expect(summary.failures).toContain('Fixture: Unexpected fixture purpose');
  expect(summary.cleanup).toMatchObject({ status: 'PASS', runtimeRemoved: true });
  expect(process.exitCode).toBe(1);
});

test('cancellation during final evidence scanning fails the run and settles its cleanup', async () => {
  lib.artifactScan.mockImplementation(async (directory: string) => {
    process.emit('SIGINT');
    return realLib.artifactScan(directory);
  });
  const { summary } = await run();
  expect(summary.report.passed).toBe(1);
  expect(summary.status).toBe('FAIL');
  expect(summary.failures).toContain('SIGINT: harness-selftest verification cancelled');
  expect(process.exitCode).toBe(1);
});

test('terminal summary saving begins after cancellation listeners have been released', async () => {
  const beforeInterrupt = process.listeners('SIGINT');
  const beforeTerminate = process.listeners('SIGTERM');
  let terminalWrite = false;
  lib.json.mockImplementation(async (file: string, value: Record<string, unknown>) => {
    if (path.basename(file) === 'summary.json') {
      terminalWrite = true;
      expect(process.listeners('SIGINT')).toEqual(beforeInterrupt);
      expect(process.listeners('SIGTERM')).toEqual(beforeTerminate);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(value.status).toBe('PASS');
    }
    return realLib.json(file, value);
  });
  const { summary } = await run();
  expect(terminalWrite).toBe(true);
  expect(summary.status).toBe('PASS');
});
