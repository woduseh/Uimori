import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { artifactRoot, json, removeOwned } from './lib.mjs';
import {
  cachedCheckPassed,
  requiredChecks,
  runReleaseChecks,
  verifyReleaseReceipt,
} from './release-check.mjs';
import {
  identityKey,
  parseOptions,
  releaseFingerprint,
  runExternal,
  sha256,
  shellQuote,
} from './release-common.mjs';
import {
  parseRemoteSummary,
  releaseOracle,
  remoteCommand,
  sshOptions,
  validateConfig,
} from './release-oracle.mjs';

const identity = {
  sourceHash: 'a'.repeat(64),
  verificationHash: 'b'.repeat(64),
  node: 'v24.14.0',
  platform: 'win32',
};
const build = { buildId: 'c'.repeat(64), sourceHash: 'c'.repeat(64), distHash: 'd'.repeat(64) };
const commit = 'e'.repeat(40);
const scripts = Object.fromEntries(
  [
    'quality:full',
    'verify:smoke',
    'verify:browser-smoke',
    'verify:selfhost',
    'verify:redesign',
    'verify:visual',
  ].map((name) => [name, 'fixture'])
);

async function directory(t) {
  await mkdir(artifactRoot, { recursive: true });
  const value = await mkdtemp(path.join(artifactRoot, 'release-unit-'));
  t.after(() => removeOwned(artifactRoot, value));
  return value;
}

async function checksFixture(t) {
  const outputRoot = await directory(t);
  const calls = [];
  let source = { ...identity },
    nextFailure,
    buildMissing = false;
  const dependencies = {
    outputRoot,
    scripts,
    npmCli: 'fixture-npm.mjs',
    log: () => {},
    fingerprint: async () => source,
    assertBuild: async () => {
      if (buildMissing) throw new Error('Missing build');
      return build;
    },
    execute: async (_executable, args, options) => {
      const name = args.at(-1);
      calls.push(name);
      if (name === 'build') buildMissing = false;
      const override = nextFailure?.(name) ?? {};
      const output = `${name} ${override.code ? 'failed' : 'passed'}\n`;
      await mkdir(path.dirname(options.log), { recursive: true });
      await writeFile(options.log, output);
      return {
        code: 0,
        timedOut: false,
        cancelled: false,
        output,
        log: options.log,
        logHash: sha256(output),
        ...override,
      };
    },
  };
  return {
    dependencies,
    calls,
    setFailure: (value) => {
      nextFailure = value;
    },
    setSource: (value) => {
      source = value;
    },
    removeBuild: () => {
      buildMissing = true;
    },
    run: (options = {}) => runReleaseChecks(options, dependencies),
  };
}

test('release options reject ambiguity and remote arguments are POSIX quoted', () => {
  assert.deepEqual(
    parseOptions(['--area', 'verify:smoke', '--full'], { values: ['area'], flags: ['full'] }),
    { area: 'verify:smoke', full: true }
  );
  for (const args of [['--full', '--full'], ['--area'], ['--skip-tests'], ['other']])
    assert.throws(() => parseOptions(args, { values: ['area'], flags: ['full'] }));
  assert.equal(shellQuote("a'; $(touch bad)"), "'a'\\''; $(touch bad)'");
  assert.throws(() => shellQuote('one\ntwo'));
  assert.deepEqual(requiredChecks('verify:browser-smoke', true, scripts), [
    'quality:full',
    'verify:smoke',
    'verify:browser-smoke',
    'verify:redesign',
  ]);
  for (const name of [
    'verify:visual',
    'verify:unknown',
    'verify:redesign',
    'quality:full',
    'verify:live',
  ])
    assert.throws(() => requiredChecks(name, false, scripts));
});

test('release identity covers deploy and packaging changes but ignores generated evidence', async (t) => {
  const root = await directory(t);
  for (const folder of ['core', 'deploy', 'scripts', 'output'])
    await mkdir(path.join(root, folder));
  await writeFile(path.join(root, 'core/app.ts'), 'source\n');
  await writeFile(path.join(root, 'deploy/oracle-update.sh'), 'script\n');
  await writeFile(path.join(root, 'Dockerfile'), 'FROM base\n');
  const before = await releaseFingerprint(root);
  await writeFile(path.join(root, 'output/log.json'), 'new evidence');
  await writeFile(path.join(root, 'deploy/oracle-update.sh'), 'script\r\n');
  assert.deepEqual(await releaseFingerprint(root), before);
  await writeFile(path.join(root, 'deploy/oracle-update.sh'), 'changed\n');
  assert.notEqual(identityKey(await releaseFingerprint(root)), identityKey(before));
  await writeFile(path.join(root, 'deploy/oracle-update.sh'), 'script\n');
  await writeFile(path.join(root, 'Dockerfile'), 'FROM other\n');
  assert.notEqual(identityKey(await releaseFingerprint(root)), identityKey(before));
});

test('unchanged release reuses successful evidence and refreshes only a missing build', async (t) => {
  const fixture = await checksFixture(t);
  const first = await fixture.run();
  assert.equal(first.status, 'PASS');
  assert.deepEqual(fixture.calls, ['quality:full', 'verify:smoke', 'verify:browser-smoke']);
  const second = await fixture.run();
  assert.equal(second.status, 'PASS');
  assert.equal(fixture.calls.length, 3);
  fixture.removeBuild();
  assert.equal((await fixture.run()).status, 'PASS');
  assert.deepEqual(fixture.calls.slice(3), ['build']);
});

test('failed later check preserves earlier passes but cannot be bypassed by a narrower scope', async (t) => {
  const fixture = await checksFixture(t);
  fixture.setFailure((name) => (name === 'verify:redesign' ? { code: 1 } : {}));
  const first = await fixture.run({ full: true });
  assert.equal(first.status, 'FAIL');
  const narrower = await fixture.run();
  assert.equal(narrower.status, 'FAIL');
  assert.match(narrower.error, /recorded failures/);
  assert.equal(fixture.calls.length, 4);
  fixture.setFailure(undefined);
  const fixed = await fixture.run({ full: true });
  assert.equal(fixed.status, 'PASS');
  assert.deepEqual(fixture.calls.slice(4), ['verify:redesign']);
});

test('interrupted full run keeps missing check results unresolved across narrower retries', async (t) => {
  const fixture = await checksFixture(t);
  const previous = await fixture.run();
  previous.status = 'FAIL';
  previous.requested.push('verify:redesign');
  await json(previous.report, previous);
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await fixture.run();
    assert.equal(result.status, 'FAIL');
    assert.equal(result.checks['verify:redesign'].status, 'NOT_RUN');
  }
  assert.equal(fixture.calls.length, 3);
  assert.equal((await fixture.run({ full: true })).status, 'PASS');
  assert.deepEqual(fixture.calls.slice(3), ['verify:redesign']);
});

test('failed termination without a close event still produces a bounded timeout result', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const result = await runExternal('fixture', [], {
    timeoutMs: 5,
    stopTimeoutMs: 5,
    spawnChild: () => child,
    terminateChild: async () => {
      throw new Error('termination refused');
    },
  });
  assert.equal(result.code, -1);
  assert.equal(result.timedOut, true);
  assert.match(result.output, /termination refused/);
});

test('changed source invalidates cache and mid-run source changes remain failures', async (t) => {
  const fixture = await checksFixture(t);
  await fixture.run();
  fixture.setSource({ ...identity, sourceHash: 'f'.repeat(64) });
  assert.equal((await fixture.run()).status, 'PASS');
  assert.equal(fixture.calls.length, 6);
  fixture.setSource({ ...identity, sourceHash: '1'.repeat(64) });
  fixture.setFailure(() => {
    fixture.setSource({ ...identity, sourceHash: '2'.repeat(64) });
    return {};
  });
  assert.equal((await fixture.run()).status, 'FAIL');
  assert.equal(fixture.calls.length, 7);
});

test('timeout, cancellation, missing logs and swapped commands cannot certify a release', async (t) => {
  const fixture = await checksFixture(t);
  const receipt = await fixture.run();
  await verifyReleaseReceipt(receipt, identity, requiredChecks(undefined, false, scripts));
  await assert.rejects(
    () =>
      verifyReleaseReceipt(receipt, { ...identity, sourceHash: '9'.repeat(64) }, ['quality:full']),
    /stale/
  );
  await assert.rejects(
    () => verifyReleaseReceipt(receipt, identity, ['verify:redesign']),
    /unavailable/
  );
  const quality = receipt.checks['quality:full'];
  assert.equal(await cachedCheckPassed({ ...quality, timedOut: true }, 'quality:full'), false);
  assert.equal(await cachedCheckPassed({ ...quality, cancelled: true }, 'quality:full'), false);
  assert.equal(
    await cachedCheckPassed({ ...quality, command: 'verify:smoke' }, 'quality:full'),
    false
  );
  await writeFile(quality.log, 'changed log');
  assert.equal(await cachedCheckPassed(quality, 'quality:full'), false);
  fixture.setFailure(() => ({ code: 0, timedOut: true }));
  assert.equal((await fixture.run()).status, 'FAIL');
});

test('Oracle configuration rejects remote shell options, overlapping paths and embedded secrets', () => {
  const valid = {
    host: 'ubuntu@oracle.example',
    identityFile: '/key',
    knownHostsFile: '/hosts',
    accessEnvFile: '/env',
  };
  const config = validateConfig(valid);
  assert.ok(sshOptions(config).includes('StrictHostKeyChecking=yes'));
  for (const change of [
    { host: '-oProxyCommand=bad' },
    { appDirectory: '/' },
    { releaseRoot: '/opt/uimori/app/releases' },
    { accessToken: 'secret' },
    { releaseRoot: '/opt/uimori/../other' },
  ])
    assert.throws(() => validateConfig({ ...valid, ...change }));
  const command = remoteCommand({
    config,
    commit,
    build,
    releaseDirectory: '/opt/uimori/releases/run',
    origin: 'https://example.test',
    fresh: true,
    image: 'ghcr.io/team/uimori@sha256:' + 'f'.repeat(64),
    checkOnly: true,
  });
  for (const flag of ['--fresh', '--image', '--check-only', '--expected-origin'])
    assert.ok(command.includes(shellQuote(flag)));
  assert.throws(() =>
    remoteCommand({
      config,
      commit,
      build,
      releaseDirectory: '/opt/uimori/releases/run',
      origin: 'https://example.test',
      image: 'bad; shell',
    })
  );
  assert.throws(() => parseRemoteSummary('no marker'), /missing/);
  assert.throws(() => parseRemoteSummary('ORACLE_SUMMARY {}\nORACLE_SUMMARY {}'), /ambiguous/);
});

async function releaseFixture(
  t,
  {
    dirty = false,
    remoteCommit = commit,
    malformedRemote = false,
    badSmoke = false,
    missingOrigin = false,
  } = {}
) {
  const outputRoot = await directory(t);
  const configFile = path.join(outputRoot, 'config.json');
  for (const name of ['key', 'hosts', 'env'])
    await writeFile(path.join(outputRoot, name), 'private fixture');
  await json(configFile, {
    host: 'ubuntu@oracle.example',
    identityFile: 'key',
    knownHostsFile: 'hosts',
    accessEnvFile: 'env',
  });
  const checks = await checksFixture(t);
  const receipt = await checks.run();
  const calls = [],
    secret = 'private-token-'.repeat(4);
  const dependencies = {
    outputRoot,
    scripts,
    ssh: 'fixture-ssh',
    scp: 'fixture-scp',
    log: () => {},
    fingerprint: async () => identity,
    assertBuild: async () => build,
    readAccessEnv: async () => ({ origin: 'https://example.test', token: secret }),
    check: async () => {
      calls.push('verification');
      return receipt;
    },
    smoke: async () => {
      calls.push('smoke');
      return { status: badSmoke ? 'FAIL' : 'PASS' };
    },
    execute: async (executable, args) => {
      if (executable === 'git') {
        if (args[0] === 'rev-parse') return { code: 0, output: commit };
        if (args[0] === 'status') return { code: 0, output: dirty ? ' M file' : '' };
        if (args[0] === 'ls-remote') return { code: 0, output: `${remoteCommit}\trefs/heads/main` };
        throw new Error('Unexpected git write');
      }
      const command = args.at(-1);
      if (command.includes('oracle-update.sh')) {
        calls.push('remote');
        return {
          code: 0,
          output: malformedRemote
            ? 'lost response'
            : 'ORACLE_SUMMARY ' +
              JSON.stringify({
                status: 'PASS',
                commit,
                buildId: build.buildId,
                distHash: build.distHash,
                mode: command.includes("'--fresh'") ? 'fresh' : 'update',
                checkOnly: command.includes("'--check-only'"),
                ...(missingOrigin ? {} : { publicOrigin: 'https://example.test' }),
              }),
        };
      }
      calls.push('stage');
      assert.equal(JSON.stringify(args).includes(secret), false);
      return { code: 0, output: '' };
    },
  };
  return { dependencies, calls, configFile, secret };
}

test('plan contacts no remote; dirty or unpushed source cannot stage a release', async (t) => {
  const fixture = await releaseFixture(t, { dirty: true });
  const plan = await releaseOracle(
    { config: fixture.configFile, plan: true },
    fixture.dependencies
  );
  assert.equal(plan.status, 'PLAN');
  assert.equal(plan.remoteContacted, false);
  assert.equal(plan.dirty, true);
  assert.deepEqual(fixture.calls, []);
  await assert.rejects(
    () => releaseOracle({ config: fixture.configFile }, fixture.dependencies),
    /commit local changes/
  );
  const unpushed = await releaseFixture(t, { remoteCommit: '0'.repeat(40) });
  await assert.rejects(
    () => releaseOracle({ config: unpushed.configFile }, unpushed.dependencies),
    /origin\/main/
  );
  assert.deepEqual(unpushed.calls, []);
});

test('check-only never invokes production login, while deployed release requires HTTPS success', async (t) => {
  const fixture = await releaseFixture(t);
  const result = await releaseOracle(
    { config: fixture.configFile, 'check-only': true },
    fixture.dependencies
  );
  assert.equal(result.status, 'PASS');
  assert.equal(fixture.calls.includes('smoke'), false);
  assert.equal(JSON.stringify(result).includes(fixture.secret), false);
  const failed = await releaseFixture(t, { badSmoke: true });
  const outcome = await releaseOracle({ config: failed.configFile }, failed.dependencies);
  assert.equal(outcome.status, 'FAIL');
  assert.equal(outcome.remote.status, 'PASS');
  assert.match(outcome.error, /HTTPS\/API smoke/);
  assert.equal(failed.calls.filter((name) => name === 'remote').length, 1);
});

test('lost remote outcome stays UNKNOWN and is never automatically replayed', async (t) => {
  const fixture = await releaseFixture(t, { malformedRemote: true });
  const outcome = await releaseOracle({ config: fixture.configFile }, fixture.dependencies);
  assert.equal(outcome.status, 'FAIL');
  assert.equal(outcome.remoteState, 'UNKNOWN');
  assert.equal(fixture.calls.filter((name) => name === 'remote').length, 1);
  assert.equal(fixture.calls.includes('smoke'), false);
  assert.equal(JSON.parse(await readFile(outcome.report, 'utf8')).status, 'FAIL');
});

test('check-only requires exact origin in the remote proof even without a login smoke', async (t) => {
  const fixture = await releaseFixture(t, { missingOrigin: true });
  const outcome = await releaseOracle(
    { config: fixture.configFile, 'check-only': true },
    fixture.dependencies
  );
  assert.equal(outcome.status, 'FAIL');
  assert.match(outcome.error, /Remote public origin/);
  assert.equal(fixture.calls.includes('smoke'), false);
});
