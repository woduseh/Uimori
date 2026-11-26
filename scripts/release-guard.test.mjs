import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { releaseRefusal } from '../.claude/hooks/release-guard.mjs';

const hook = fileURLToPath(new URL('../.claude/hooks/release-guard.mjs', import.meta.url));
const shell = (command) => ({ tool_name: 'Bash', tool_input: { command } });
const noEnvironment = { env: {} };

test('release commands are refused while reads and pushes pass', () => {
  for (const command of [
    'git tag -a v0.18.2 -m "Uimori v0.18.2"',
    'git -C ../uimori tag v1',
    'npm version 0.18.2 --no-git-tag-version',
    'npm pkg set version=0.18.2',
    'gh release create v0.18.2 --notes-file notes.md',
    'npm run release:oracle -- --config .local/oracle-release.json',
    'node scripts/release-oracle.mjs --plan',
    'git show HEAD:notes.md > docs/releases/v0.18.2.md',
    'Copy-Item notes.md docs\\releases\\v0.18.2.md',
    'UIMORI_ALLOW_RELEASE=1 git push origin v0.18.2',
    'git push --no-verify origin main',
    'git -C ../uimori push origin main --no-verify',
    'git push origin --tags',
    'git push origin refs/tags/v0.18.2',
  ])
    assert.ok(releaseRefusal(shell(command), noEnvironment), command);
  for (const command of [
    'git tag',
    'git tag -l "v0.18*"',
    'git push origin main',
    'npm run release:check',
    'cat docs/releases/v0.18.1.md',
  ])
    assert.equal(releaseRefusal(shell(command), noEnvironment), null, command);
  assert.equal(
    releaseRefusal(shell('git tag -a v1'), { env: { UIMORI_ALLOW_RELEASE: '1' } }),
    null
  );
});

test('file tools may edit package.json and old release notes but not the version or a new note', () => {
  const files = {
    'C:/repo/package.json': '{\n  "name": "uimori",\n  "version": "0.18.1",\n  "scripts": {}\n}\n',
    'C:/repo/docs/releases/v0.18.1.md': '# v0.18.1\n',
  };
  const options = { env: {}, readText: (file) => files[file.replaceAll('\\', '/')] ?? null };
  const tool = (tool_name, tool_input) => releaseRefusal({ tool_name, tool_input }, options);
  assert.ok(
    tool('Edit', {
      file_path: 'C:\\repo\\package.json',
      old_string: '"version": "0.18.1"',
      new_string: '"version": "0.18.2"',
    })
  );
  assert.equal(
    tool('Edit', {
      file_path: 'C:/repo/package.json',
      old_string: '"scripts": {}',
      new_string: '"scripts": { "a": "b" }',
    }),
    null
  );
  assert.ok(tool('Write', { file_path: 'C:/repo/docs/releases/v0.18.2.md', content: '# v0.18.2' }));
  assert.equal(
    tool('Edit', {
      file_path: 'C:/repo/docs/releases/v0.18.1.md',
      old_string: '# v0.18.1',
      new_string: '# v0.18.1 notes',
    }),
    null
  );
});

test('the hook process exits 2 with its reason for a refused call and 0 otherwise', () => {
  const { UIMORI_ALLOW_RELEASE: _allowed, ...env } = process.env;
  const run = (input) => spawnSync(process.execPath, [hook], { input, encoding: 'utf8', env });
  const refused = run(JSON.stringify(shell('npm version patch')));
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /npm version changes the app version/u);
  assert.equal(run(JSON.stringify(shell('git status'))).status, 0);
});
