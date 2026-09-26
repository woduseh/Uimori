import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { listenAddress, networkPolicy } from '../server/network-policy.js';

// Exercise the real reporter, artifact files and cleanup paths while replacing
// process/browser launch and build inputs with deterministic fault boundaries.
vi.mock('../scripts/artifact-retention.mjs', () => ({ retainArtifacts: vi.fn() }));
vi.mock('../scripts/browser-runtime.mjs', () => ({ assertBrowserRuntime: vi.fn() }));
vi.mock('../scripts/lib.mjs', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertBuild: vi.fn(),
  browserPath: vi.fn(),
  startServer: vi.fn(),
  command: vi.fn(),
  killOwned: vi.fn(),
  artifactScan: vi.fn(),
  json: vi.fn(),
}));
const { retainArtifacts } = await import(
  new URL('../scripts/artifact-retention.mjs', import.meta.url).href
);
const { assertBrowserRuntime } = await import(
  new URL('../scripts/browser-runtime.mjs', import.meta.url).href
);
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
  vi.mocked(retainArtifacts).mockResolvedValue({ status: 'PASS', removed: [] });
  vi.mocked(assertBrowserRuntime).mockResolvedValue({ name: 'synthetic' });
  vi.stubEnv('UIMORI_VISUAL_REVIEW', '0');
  lib.browserPath.mockReturnValue(process.execPath);
  lib.killOwned.mockResolvedValue({ exited: true });
  lib.artifactScan.mockImplementation(realLib.artifactScan);
  lib.json.mockImplementation(realLib.json);
  lib.startServer.mockImplementation(
    async (env: Record<string, string>, _directory: string, children: Set<unknown>) => {
      await writeFile(env.UIMORI_DB!, 'synthetic DB evidence');
      const child = { pid: 12345, exitCode: 0, signalCode: null };
      children.add(child);
      return { child, ready: { url: 'http://127.0.0.1:1', dbPath: env.UIMORI_DB } };
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
    ...options,
  });
  directories.add(result.directory);
  expect(JSON.parse(await readFile(path.join(result.directory, 'summary.json'), 'utf8'))).toEqual(
    result.summary
  );
  return result;
}

test('browser harness records its build and selected commands without retaining successful databases', async () => {
  const { directory, summary } = await run({
    files: ['tests/fixture-browser.spec.ts'],
    grep: 'CASE01',
    timeout: 4321,
  });
  expect(summary.status).toBe('PASS');
  expect(summary.identity).toEqual(identity);
  expect(summary.cleanup).toMatchObject({ status: 'PASS', runtimeRemoved: true });
  expect(lib.assertBuild).toHaveBeenCalledTimes(1);
  expect(lib.artifactScan).not.toHaveBeenCalled();
  expect(existsSync(path.join(directory, 'evidence-db'))).toBe(false);
  expect(lib.command).toHaveBeenCalledWith(
    [
      'node_modules/@playwright/test/cli.js',
      'test',
      'tests/fixture-browser.spec.ts',
      '--grep',
      'CASE01',
      '--reporter=list,json',
    ],
    expect.objectContaining({ timeout: 4321, echo: true })
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
  expect(JSON.parse(cleanup.stdout)).toMatchObject({ status: 'PASS', evidencePreserved: false });
  expect(existsSync(directory)).toBe(false);
});

test.each([false, true])(
  'local verification isolates inherited self-host and Codex settings at the real spawn boundary (provider fixture: %s)',
  async (providerFixture) => {
    vi.stubEnv('UIMORI_PUBLIC_ORIGIN', 'https://synthetic-self-host.example');
    vi.stubEnv('UIMORI_HOST', '0.0.0.0');
    vi.stubEnv('UIMORI_PORT', '4310');
    vi.stubEnv('UIMORI_ACCESS_TOKEN', 'synthetic-parent-token-for-harness-only');
    vi.stubEnv('UIMORI_CODEX_ENABLED', '1');
    vi.stubEnv('UIMORI_CODEX_EXECUTABLE', 'synthetic-parent-codex.exe');
    await run({ providerFixture });
    const env: NodeJS.ProcessEnv = lib.startServer.mock.calls[0][0];
    const providerOrigins = providerFixture ? new URL(env.UIMORI_PROVIDER_FIXTURE_URL!).origin : '';
    if (providerFixture) expect(new URL(providerOrigins).hostname).toBe('127.0.0.1');
    const probe = await realLib.command(
      [
        '-e',
        `process.stdout.write(JSON.stringify({
        publicOriginPresent: Object.hasOwn(process.env, 'UIMORI_PUBLIC_ORIGIN'),
        codexExecutablePresent: Object.hasOwn(process.env, 'UIMORI_CODEX_EXECUTABLE'),
        env: {
          UIMORI_PUBLIC_ORIGIN: process.env.UIMORI_PUBLIC_ORIGIN,
          UIMORI_HOST: process.env.UIMORI_HOST,
          UIMORI_PORT: process.env.UIMORI_PORT,
          UIMORI_TEST_MODE: process.env.UIMORI_TEST_MODE,
          UIMORI_ACCESS_TOKEN: process.env.UIMORI_ACCESS_TOKEN,
          UIMORI_CODEX_ENABLED: process.env.UIMORI_CODEX_ENABLED,
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
      UIMORI_HOST: '127.0.0.1',
      UIMORI_PORT: '0',
      UIMORI_TEST_MODE: '1',
      UIMORI_ACCESS_TOKEN: '',
      UIMORI_CODEX_ENABLED: '0',
    });
    const policy = networkPolicy({
      publicOrigin: child.env.UIMORI_PUBLIC_ORIGIN,
      accessToken: child.env.UIMORI_ACCESS_TOKEN,
      testMode: child.env.UIMORI_TEST_MODE === '1',
    });
    expect(policy).toEqual({});
    expect(listenAddress(child.env, policy)).toEqual({ host: '127.0.0.1', port: 0 });
    expect(process.env.UIMORI_PUBLIC_ORIGIN).toBe('https://synthetic-self-host.example');
    expect(process.env.UIMORI_CODEX_ENABLED).toBe('1');
    expect(process.env.UIMORI_CODEX_EXECUTABLE).toBe('synthetic-parent-codex.exe');
  }
);

test.each(['missing', 'zero', 'skipped', 'retried', 'global'])(
  'browser harness rejects %s reporter evidence and still records cleanup',
  async (fault) => {
    if (fault === 'zero') process.argv.push('--grep', 'no such case');
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
    const { directory, summary } = await run();
    expect(summary.status).toBe('FAIL');
    expect(summary.failures.length).toBeGreaterThan(0);
    if (fault === 'zero') expect(summary.selection.focused).toBe(true);
    expect(summary.cleanup.status).toBe('PASS');
    expect(existsSync(path.join(directory, 'runtime'))).toBe(false);
    expect(process.exitCode).toBe(1);
  }
);

test.each(['command', 'timeout'])('passing assertions cannot hide a %s failure', async (fault) => {
  if (fault === 'command') commandFailure.code = 1;
  else commandFailure.timedOut = true;
  const { directory, summary } = await run();
  expect(summary.report.passed).toBe(1);
  expect(summary.status).toBe('FAIL');
  expect(summary.cleanup.status).toBe('PASS');
  expect(await readFile(path.join(directory, 'evidence-db', 'app.sqlite'), 'utf8')).toBe(
    'synthetic DB evidence'
  );
});

test('a stale build fails before launching any browser or server', async () => {
  lib.assertBuild.mockRejectedValue(new Error('stale build'));
  const { summary } = await run();
  expect(summary.status).toBe('FAIL');
  expect(lib.startServer).not.toHaveBeenCalled();
  expect(lib.command).not.toHaveBeenCalled();
});

test('focused visual checks narrow the existing selection and record their actual scope', async () => {
  process.argv.push('--grep', 'CASE01', '--visual');
  const { summary } = await run({
    files: ['tests/fixture-browser.spec.ts'],
    grep: 'CASE01|CASE02',
  });
  expect(summary.status).toBe('PASS');
  expect(summary.selection).toMatchObject({
    focused: true,
    files: ['tests/fixture-browser.spec.ts'],
  });
  const filter = new RegExp(summary.selection.grep);
  expect(filter.test('fixture CASE01 selected scenario')).toBe(true);
  expect(filter.test('fixture CASE02 unselected scenario')).toBe(false);
  expect(filter.test('fixture OTHER unselected scenario')).toBe(false);
  expect(summary.screenshots).toEqual([]);
  expect(summary.visualReview).toBe(true);
  expect(lib.command).toHaveBeenCalledWith(
    expect.arrayContaining(['--grep', summary.selection.grep]),
    expect.objectContaining({ env: expect.objectContaining({ UIMORI_VISUAL_REVIEW: '1' }) })
  );
});

test.each([['--grep', '['], ['--unknown'], ['--grep'], ['--visual', '--visual']])(
  'invalid browser options fail before launching a server: %j',
  async (...args) => {
    process.argv.push(...args);
    await expect(run()).rejects.toThrow();
    expect(lib.startServer).not.toHaveBeenCalled();
    expect(lib.command).not.toHaveBeenCalled();
  }
);

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

test('visual mode records captured screenshots without a second filename manifest', async () => {
  vi.stubEnv('UIMORI_VISUAL_REVIEW', '1');
  const originalCommand = lib.command.getMockImplementation();
  const relativeScreenshot = path.join('browser', 'nested-output', 'required.png');
  lib.command.mockImplementation(
    async (args: string[], options: { env: Record<string, string> }) => {
      const directory = path.join(options.env.UIMORI_BROWSER_OUTPUT!, 'nested-output');
      await mkdir(directory, { recursive: true });
      const valid = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9n8AAAAASUVORK5CYII=',
        'base64'
      );
      await writeFile(path.join(directory, 'required.png'), valid);
      return originalCommand(args, options);
    }
  );
  const { directory, summary } = await run();
  expect(summary.report.passed).toBe(1);
  expect(summary.cleanup.status).toBe('PASS');
  expect(summary.status).toBe('PASS');
  expect(summary.screenshots).toContain(relativeScreenshot);
  expect(existsSync(path.join(directory, relativeScreenshot))).toBe(true);
});

test.each([false, true])(
  'private sample discovery follows the runner opt-in: %s',
  async (privateMaterials) => {
    vi.stubEnv('UIMORI_PRIVATE_MATERIALS', '1');
    const { summary } = await run({ privateMaterials });
    expect(summary.status).toBe('PASS');
    expect(lib.command).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({ UIMORI_PRIVATE_MATERIALS: privateMaterials ? '1' : '0' }),
      })
    );
  }
);

test('passing browser assertions cannot hide errors from the actual loopback provider fixture', async () => {
  const originalCommand = lib.command.getMockImplementation();
  lib.command.mockImplementation(
    async (args: string[], options: { env: Record<string, string> }) => {
      const response = await fetch(options.env.UIMORI_PROVIDER_FIXTURE_URL!, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ protocol: 'unexpected-fixture-request', input: {} }),
        signal: AbortSignal.timeout(2000),
      });
      expect(response.status).toBe(500);
      return originalCommand(args, options);
    }
  );
  const { summary } = await run({ providerFixture: true });
  expect(summary.report.passed).toBe(1);
  expect(summary.status).toBe('FAIL');
  expect(summary.providerFixture.errors).toEqual(['Unexpected fixture purpose']);
  expect(summary.failures).toContain('Fixture: Unexpected fixture purpose');
  expect(summary.cleanup).toMatchObject({ status: 'PASS', runtimeRemoved: true });
  expect(process.exitCode).toBe(1);
});

test('cancellation during failure artifact scanning settles cleanup', async () => {
  commandFailure.code = 1;
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

test('unrunnable browser is BLOCKED before creating the application', async () => {
  vi.mocked(assertBrowserRuntime).mockRejectedValue(
    Object.assign(new Error('missing libglib'), {
      code: 'BROWSER_RUNTIME_UNAVAILABLE',
    })
  );
  const { summary } = await run();
  expect(summary.status).toBe('BLOCKED');
  expect(lib.startServer).not.toHaveBeenCalled();
  expect(lib.command).not.toHaveBeenCalled();
});

test('native browser shard records the full collection and only reports the selected execution', async () => {
  process.argv.push('--shard', '1/3');
  const full = browserReport();
  full.suites[0].specs.push(
    ...browserReport({ title: 'CASE02 outside this shard' }).suites[0].specs
  );
  const execute = lib.command.getMockImplementation()!;
  lib.command.mockImplementation(
    async (args: string[], options: { env: Record<string, string> }) => {
      report = args.includes('--list') ? full : browserReport();
      return execute(args, options);
    }
  );
  const { summary } = await run();
  expect(summary.status).toBe('PASS');
  expect(summary.selection.shard).toBe('1/3');
  expect(summary.selection.allTests).toHaveLength(2);
  expect(summary.testCases).toHaveLength(1);
  expect(summary.selection.allTests).toEqual(expect.arrayContaining(summary.testCases));
  expect(lib.command.mock.calls[0][0]).toContain('--list');
  expect(lib.command.mock.calls[0][0]).not.toContain('--shard=1/3');
  expect(lib.command.mock.calls[1][0]).toContain('--shard=1/3');
});

test.each(['0/4', '5/4', '1/0', 'bad'])(
  'invalid browser shard %s fails before server startup',
  async (shard) => {
    process.argv.push('--shard', shard);
    await expect(run()).rejects.toThrow();
    expect(lib.startServer).not.toHaveBeenCalled();
  }
);

test('artifact cleanup warnings preserve the original browser result', async () => {
  vi.mocked(retainArtifacts).mockResolvedValue({
    status: 'WARN',
    warnings: ['synthetic cleanup failure'],
  });
  const { summary } = await run();
  expect(summary.status).toBe('PASS');
  expect(summary.retention.status).toBe('WARN');
});
