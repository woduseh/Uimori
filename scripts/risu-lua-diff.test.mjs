import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./risu-lua-diff.mjs', import.meta.url));
const sourceFile = 'src/ts/process/scriptings.ts';

function source(after = false) {
  return `
export function run(mode: string) {
  declareAPI('getChatVar', (id: string) => { return ${after ? 'id + "changed"' : 'id'} })
  declareAPI('generateImage', (${after ? 'id: string, options?: object' : 'id: string'}) => { return id })
  ${after ? "declareAPI('newApi', (id: string) => { return id })" : "declareAPI('removedApi', (id: string) => { return id })"}
  declareAPI('duplicate', (id: string) => { return 'first' })
  declareAPI('duplicate', (id: string) => { return ${after ? "'changed'" : "'second'"} })
  switch (mode) {
    case 'input': { const func = luaEngine.global.get('onInput'); func(${after ? 'mode' : ''}); break }
    ${after ? "case 'onFormSubmit': { const func = luaEngine.global.get('onFormSubmit'); func(); break }\n    case 'otherButtonEvent': { const func = luaEngine.global.get('onButtonClick'); func(); break }" : ''}
    case 'editRequest':
    case 'editInput': { const func = luaEngine.global.get('callListenMain'); func(); break }
    default: { const func = luaEngine.global.get(mode); func(); break }
  }
}
function luaCodeWrapper(code: string) {
  return \`
function getChat(id)
  return getChatMain(id)
end
function listenEdit(type, func)
  ${after ? "if type == 'editRequest' or 'editOutput' == type then return func end" : "if type == 'editRequest' then return func end\n  if type == 'editInput' then return func end"}
end
${after ? 'newHelper = function(id)\n  return id\nend' : ''}
\${code}
\`
}
`;
}

function git(repo, ...args) {
  return execFileSync('git', ['--no-optional-locks', '-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: '0',
      GIT_AUTHOR_NAME: 'Lua diff fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Lua diff fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
  }).trim();
}

function commit(repo, message, content) {
  if (content !== undefined) {
    writeFileSync(path.join(repo, sourceFile), content);
    git(repo, 'add', '--', sourceFile);
  }
  git(repo, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

function run(...args) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
}

test('compares committed Risu Lua source and fails closed on invalid inputs', async (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'uimori-risu-diff-'));
  assert.equal(path.dirname(temp), path.resolve(os.tmpdir()));
  const repo = path.join(temp, 'risu repo');
  const worktree = path.join(temp, 'risu worktree');
  mkdirSync(path.join(repo, 'src', 'ts', 'process'), { recursive: true });
  try {
    git(repo, 'init', '--quiet');
    const missing = commit(repo, 'missing file');
    const base = commit(repo, 'base', source());
    const malformed = commit(repo, 'malformed', 'export function broken( {');
    const restructured = commit(repo, 'unrecognized contract', 'export const scripting = 1;');
    const target = commit(repo, 'target', source(true));
    const uncategorized = commit(
      repo,
      'outside tracked regions',
      `${source(true)}\nexport const other = true;\n`
    );
    const absentBlob = commit(repo, 'missing blob', `${source(true)}\n// unique missing blob\n`);
    const blob = git(repo, 'rev-parse', `${absentBlob}:${sourceFile}`);
    git(repo, 'worktree', 'add', '--quiet', '--detach', worktree, target);
    // A promisor remote would normally let cat-file fetch the deliberately missing blob.
    git(repo, 'config', 'extensions.partialClone', 'origin');
    git(repo, 'config', 'remote.origin.promisor', 'true');
    git(repo, 'config', 'remote.origin.url', path.join(temp, 'no-such-remote'));
    const blobPath = path.join(repo, '.git', 'objects', blob.slice(0, 2), blob.slice(2));
    assert.ok(blobPath.startsWith(`${repo}${path.sep}`));
    unlinkSync(blobPath);
    git(repo, 'replace', base, target);
    assert.equal(git(repo, 'show', `${base}:${sourceFile}`), source(true).trim());
    const compare = ['--risu', repo, '--base', base, '--ref', target];

    await t.test('detects host declarations, callback events and wrapper changes', () => {
      const result = run(...compare, '--json', '--check');
      assert.equal(result.status, 1, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.base.commit, base);
      assert.equal(report.target.commit, target);
      assert.equal(report.drift, true);
      assert.deepEqual(
        report.hostApis.added.map((row) => row.name),
        ['newApi']
      );
      assert.deepEqual(
        report.hostApis.removed.map((row) => row.name),
        ['removedApi']
      );
      assert.deepEqual(
        report.hostApis.changed.map((row) => row.name),
        ['duplicate', 'generateImage', 'getChatVar']
      );
      const image = report.hostApis.changed.find((row) => row.name === 'generateImage');
      assert.equal(image.exposure, 'explicitly-unsupported');
      assert.deepEqual(image.changes, ['signature']);
      assert.match(image.target[0].signature, /options\?: object/);
      const duplicate = report.hostApis.changed.find((row) => row.name === 'duplicate');
      assert.equal(duplicate.base.length, 2);
      assert.equal(duplicate.target.length, 2);
      assert.deepEqual(duplicate.changes, ['body']);
      assert.equal(
        report.hostApis.changed.find((row) => row.name === 'getChatVar').exposure,
        'exposed'
      );
      assert.equal(report.hostApis.added[0].exposure, 'unclassified');
      assert.equal(report.callbacks.dispatch.added[0].name, 'onFormSubmit');
      assert.equal(report.callbacks.dispatch.added[0].uimori, 'unclassified');
      assert.equal(report.callbacks.dispatch.added[1].name, 'otherButtonEvent');
      assert.equal(report.callbacks.dispatch.added[1].uimori, 'unclassified');
      assert.equal(report.callbacks.dispatch.changed[0].name, 'input');
      assert.equal(report.callbacks.dispatch.changed[0].uimori, 'statically-observed');
      assert.deepEqual(report.callbacks.listenEdit, {
        added: ['editOutput'],
        removed: ['editInput'],
      });
      assert.equal(report.luaWrapper.changed, true);
      assert.deepEqual(report.luaWrapper.helpers.added, ['newHelper']);
      assert.ok(report.uimori.exposed.includes('getChat'));
      assert.ok(report.uimori.explicitlyUnsupported.includes('generateImage'));
      assert.ok(report.uimori.unclassified.includes('newApi'));
      assert.equal(run(...compare, '--json', '--check').stdout, result.stdout);
      const normal = run(...compare);
      assert.equal(normal.status, 0, normal.stderr);
      assert.match(normal.stdout, /onFormSubmit.*unclassified/);
      assert.match(normal.stdout, /not the exact Uimori support version/);
    });

    await t.test('reports unchanged committed source and ignores dirty worktree files', () => {
      writeFileSync(path.join(worktree, sourceFile), 'this dirty file is not TypeScript');
      const result = run('--risu', worktree, '--base', target, '--json', '--check');
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.target.ref, 'HEAD');
      assert.equal(report.target.commit, target);
      assert.equal(report.drift, false);
      assert.equal(report.luaWrapper.changed, false);
      assert.deepEqual(report.hostApis.changed, []);
      assert.deepEqual(report.callbacks.dispatch.changed, []);
    });

    await t.test('whole-file drift catches changes outside extracted regions', () => {
      const result = run(
        '--risu',
        repo,
        '--base',
        target,
        '--ref',
        uncategorized,
        '--json',
        '--check'
      );
      assert.equal(result.status, 1, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.drift, true);
      assert.equal(report.luaWrapper.changed, false);
      assert.deepEqual(report.hostApis.changed, []);
      assert.deepEqual(report.callbacks.dispatch.changed, []);
    });

    await t.test('invalid refs, missing files and unrecognized syntax exit 2', () => {
      for (const [ref, message] of [
        ['not-a-commit', /Cannot resolve target ref/],
        [missing, /Cannot read src\/ts\/process\/scriptings\.ts/],
        [malformed, /Cannot parse target/],
        [restructured, /Unrecognized target extraction contract/],
      ]) {
        const result = run('--risu', repo, '--base', base, '--ref', ref, '--json', '--check');
        assert.equal(result.status, 2, result.stderr);
        assert.equal(result.stdout, '');
        assert.match(result.stderr, message);
      }
    });

    await t.test('fails on a missing promisor object without fetching', () => {
      const trace = path.join(temp, 'git.trace');
      const result = spawnSync(
        process.execPath,
        [script, '--risu', repo, '--base', base, '--ref', absentBlob, '--check'],
        { encoding: 'utf8', env: { ...process.env, GIT_TRACE: trace } }
      );
      if (result.error) throw result.error;
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, /Cannot read src\/ts\/process\/scriptings\.ts/);
      assert.doesNotMatch(
        readFileSync(trace, 'utf8'),
        /built-in: git fetch|run_command: git fetch/
      );
    });

    await t.test('help succeeds and bad CLI arguments fail', () => {
      assert.equal(run('--help').status, 0);
      assert.match(run('--help').stdout, /Usage:/);
      for (const args of [[], ['--unknown'], ['--risu'], ['--risu', repo, '--json', '--json']]) {
        const result = run(...args);
        assert.equal(result.status, 2, result.stderr);
        assert.match(result.stderr, /risu-lua-diff:/);
      }
    });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
