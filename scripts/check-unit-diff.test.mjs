import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkUnitDiff } from './check-unit-diff.mjs';

const script = fileURLToPath(new URL('./check-unit-diff.mjs', import.meta.url));
const twoCases = "test('a', () => {});\ntest('b', () => {});\n";

function fixture(t) {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'uimori-unit-diff-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Unit diff fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Unit diff fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      },
    });
  const write = (file, text) => {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    writeFileSync(path.join(repo, file), text);
  };
  git('init', '--quiet');
  write('package.json', '{ "name": "fixture", "version": "1.0.0" }\n');
  write('tests/a.test.ts', twoCases);
  write('scripts/tool.mjs', 'export const tool = 1;\n');
  git('add', '.');
  git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'base');
  return {
    repo,
    write,
    check: (options) => checkUnitDiff({ base: 'HEAD', cwd: repo, ...options }),
  };
}

test('a change inside the allowed paths that keeps every test passes', (t) => {
  const { write, check } = fixture(t);
  write('scripts/tool.mjs', 'export const tool = 2;\n');
  write('scripts/new.mjs', 'export const added = true;\n');
  write('tests/a.test.ts', `${twoCases}test('c', () => {});\n`);
  const result = check({ allow: ['scripts/**', 'tests/**'] });
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.cases, { before: 2, after: 3 });
});

test('paths outside the allowance, removed cases, new skips and a version change each fail', (t) => {
  const { write, check } = fixture(t);
  write('docs/note.md', 'outside\n');
  write('tests/a.test.ts', "test('a', () => {});\nit.skip('b', () => {});\n");
  write('package.json', '{ "name": "fixture", "version": "1.0.1" }\n');
  const failures = check({ allow: ['tests/**', 'package.json'] }).failures;
  assert.equal(failures.length, 3);
  assert.match(failures[0], /outside the allowed paths: docs\/note\.md/u);
  assert.match(failures[1], /skip, only, todo or fixme markers rose from 0 to 1/u);
  assert.match(failures[2], /package\.json version changed/u);

  write('tests/a.test.ts', "test('a', () => {});\n");
  write('package.json', '{ "name": "fixture", "version": "1.0.0" }\n');
  assert.match(check({ allow: ['**'] }).failures.join('\n'), /test cases fell from 2 to 1/u);
  assert.deepEqual(check({ allow: ['**'], allowTestRemoval: true }).failures, []);
});

test('the command exits 1 on a failure and 2 without an allowance', (t) => {
  const { repo, write } = fixture(t);
  write('tests/a.test.ts', "test('a', () => {});\n");
  const run = (...args) =>
    spawnSync(process.execPath, [script, ...args], { cwd: repo, encoding: 'utf8' });
  const failed = run('--base', 'HEAD', '--allow', 'tests/**');
  assert.equal(failed.status, 1, failed.stderr);
  assert.match(failed.stderr, /FAIL test cases fell from 2 to 1/u);
  assert.equal(run('--base', 'HEAD', '--allow', 'tests/**', '--allow-test-removal').status, 0);
  assert.equal(run('--base', 'HEAD').status, 2);
});
