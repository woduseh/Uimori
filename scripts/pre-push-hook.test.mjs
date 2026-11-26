import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const hooks = fileURLToPath(new URL('../.githooks', import.meta.url));
const identity = {
  GIT_AUTHOR_NAME: 'Pre-push fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Pre-push fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

test('the pre-push hook refuses a version change or a tag unless a person allows the release', (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'uimori-pre-push-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const work = path.join(temp, 'work');
  const { UIMORI_ALLOW_RELEASE: _allowed, ...environment } = process.env;
  const git = (args, extra = {}) =>
    spawnSync('git', ['-C', work, '-c', `core.hooksPath=${hooks}`, ...args], {
      encoding: 'utf8',
      env: { ...environment, ...identity, ...extra },
    });
  const commit = (version, message) => {
    writeFileSync(
      path.join(work, 'package.json'),
      `{ "name": "fixture", "version": "${version}", "note": "${message}" }\n`
    );
    execFileSync('git', ['-C', work, 'add', 'package.json']);
    execFileSync('git', ['-C', work, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message], {
      env: { ...environment, ...identity },
    });
  };
  execFileSync('git', ['init', '--quiet', '--bare', path.join(temp, 'remote.git')]);
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', work]);
  execFileSync('git', ['-C', work, 'remote', 'add', 'origin', path.join(temp, 'remote.git')]);
  commit('1.0.0', 'first');
  assert.equal(git(['push', '-q', 'origin', 'main']).status, 0);

  commit('1.0.0', 'ordinary');
  assert.equal(git(['push', '-q', 'origin', 'main']).status, 0);

  commit('1.0.1', 'release');
  const refused = git(['push', '-q', 'origin', 'main']);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /refs\/heads\/main: the push changes the package\.json version/u);

  execFileSync('git', ['-C', work, 'branch', 'side']);
  const newBranch = git(['push', '-q', 'origin', 'side']);
  assert.notEqual(newBranch.status, 0);
  assert.match(newBranch.stderr, /refs\/heads\/side: the push changes the package\.json version/u);

  execFileSync('git', ['-C', work, 'tag', 'v1.0.1']);
  const tag = git(['push', '-q', 'origin', 'v1.0.1']);
  assert.notEqual(tag.status, 0);
  assert.match(tag.stderr, /refs\/tags\/v1\.0\.1: pushing a tag publishes a release/u);

  assert.equal(git(['push', '-q', 'origin', 'main'], { UIMORI_ALLOW_RELEASE: '1' }).status, 0);
});
