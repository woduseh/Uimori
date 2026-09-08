import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { build } from '../scripts/build-runner.mjs';
import { root, distHash, fingerprint, removeOwned } from '../scripts/lib.mjs';

async function fixture(t) {
  const parent = path.join(root, 'output', 'tooling-tests');
  await mkdir(parent, { recursive: true });
  const cwd = await mkdtemp(path.join(parent, 'build-'));
  t.after(() => removeOwned(parent, cwd));
  await mkdir(path.join(cwd, 'server'));
  await mkdir(path.join(cwd, 'dist'));
  await writeFile(path.join(cwd, 'server', 'index.ts'), 'export const version = 1;\n');
  await writeFile(path.join(cwd, 'dist', 'old.js'), 'previous complete build');
  return { cwd, before: await distHash(path.join(cwd, 'dist')) };
}

async function compiler(args, { log }) {
  const destination = args[args.indexOf('--outDir') + 1];
  const file = args[0].includes('typescript')
    ? path.join(destination, 'server', 'index.js')
    : path.join(destination, 'index.html');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, 'synthetic compiler output');
  await writeFile(log, 'synthetic compiler invocation');
  return { command: args, code: 0, timedOut: false, elapsedMs: 1, output: '' };
}

async function cleaned(cwd) {
  assert.equal(
    (await readdir(cwd)).some((name) => name.startsWith('.build-')),
    false
  );
  assert.equal(existsSync(path.join(cwd, 'output/build/active.json')), false);
}

test('build promotes only complete outputs and keeps a matching manifest and logs', async (t) => {
  const { cwd } = await fixture(t);
  const result = await build({ cwd, run: compiler, progress() {} });
  assert.equal(result.status, 'PASS', JSON.stringify(result));
  assert.equal(existsSync(path.join(cwd, 'dist/old.js')), false);
  assert.equal(result.identity.sourceHash, (await fingerprint(cwd)).hash);
  assert.equal(result.identity.distHash, await distHash(path.join(cwd, 'dist')));
  assert.equal(JSON.parse(await readFile(result.evidence, 'utf8')).status, 'PASS');
  assert.equal(result.steps.length, 2);
  await cleaned(cwd);
});

for (const failure of ['compiler', 'spawn', 'missing-output', 'source-change'])
  test(`build preserves the previous output and cause on ${failure}`, async (t) => {
    const { cwd, before } = await fixture(t);
    const result = await build({
      cwd,
      progress() {},
      async run(args, options) {
        if (failure === 'spawn') throw Object.assign(new Error('spawn EPERM'), { code: 'EPERM' });
        const record = await compiler(args, options);
        if (!args[0].includes('vite')) return record;
        if (failure === 'compiler') return { ...record, code: 1, output: 'injected compile error' };
        if (failure === 'missing-output')
          await removeOwned(cwd, args[args.indexOf('--outDir') + 1]);
        if (failure === 'source-change')
          await writeFile(path.join(cwd, 'server/index.ts'), 'export const version = 2;');
        return record;
      },
    });
    assert.equal(result.status, failure === 'spawn' ? 'BLOCKED' : 'FAIL');
    assert.equal(result.previousBuildPreserved, true);
    assert.equal(await distHash(path.join(cwd, 'dist')), before);
    assert.ok(result.failures.length > 0);
    assert.equal(result.cleanup.status, 'PASS');
    if (failure === 'spawn') {
      assert.equal(result.steps[0].status, 'BLOCKED');
      assert.match(
        await readFile(path.join(path.dirname(result.evidence), 'server.log'), 'utf8'),
        /EPERM/u
      );
    }
    await cleaned(cwd);
  });

test('build refuses a concurrent owner and leaves its lock and dist intact', async (t) => {
  const { cwd, before } = await fixture(t);
  await mkdir(path.join(cwd, 'output/build'), { recursive: true });
  const lock = path.join(cwd, 'output/build/active.json');
  const owner = JSON.stringify({ pid: process.pid, runId: 'other-build' });
  await writeFile(lock, owner);
  const result = await build({
    cwd,
    run() {
      assert.fail('must not start compiler');
    },
    progress() {},
  });
  assert.equal(result.status, 'FAIL');
  assert.match(result.failures[0], /Build lock exists/u);
  assert.equal(await readFile(lock, 'utf8'), owner);
  assert.equal(await distHash(path.join(cwd, 'dist')), before);
});

test('failed promotion and rollback retain the original build even if another dist appeared', async (t) => {
  const { cwd } = await fixture(t);
  const result = await build({
    cwd,
    run: compiler,
    progress() {},
    async move(from, to) {
      if (from === path.join(cwd, 'dist')) return rename(from, to);
      if (!from.endsWith('-previous')) {
        await mkdir(path.join(cwd, 'dist'));
        await writeFile(path.join(cwd, 'dist/foreign.js'), 'concurrent writer');
      }
      throw Object.assign(new Error('injected destination collision'), { code: 'EEXIST' });
    },
  });
  assert.equal(result.status, 'FAIL');
  assert.equal(result.cleanup.status, 'FAIL');
  const owner = JSON.parse(await readFile(path.join(cwd, 'output/build/active.json'), 'utf8'));
  assert.equal(
    await readFile(path.join(owner.previous, 'old.js'), 'utf8'),
    'previous complete build'
  );
  assert.equal(await readFile(path.join(cwd, 'dist/foreign.js'), 'utf8'), 'concurrent writer');
  assert.equal(existsSync(owner.candidate), false);
  assert.equal(result.previousBuildPreserved, false);
  assert.ok(result.failures.some((message) => message.startsWith('Rollback:')));
});
