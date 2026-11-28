import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import * as checkChanged from './check-changed.mjs';

const toolingTests = [
  'scripts/ci-gate.test.mjs',
  'scripts/doctor.test.mjs',
  'tests/build-runner.node.test.mjs',
];

test('a deleted file stays in the change set and only leaves the Biome arguments', () => {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-check-changed-'));
  try {
    const git = (...args) =>
      execFileSync(
        'git',
        [
          '-c',
          'user.name=fixture',
          '-c',
          'user.email=fixture@example.invalid',
          '-c',
          'core.autocrlf=false',
          ...args,
        ],
        { cwd: directory, encoding: 'utf8' }
      );
    git('init', '--quiet');
    for (const path of ['core/gone.ts', 'docs/dev/GONE.md']) {
      mkdirSync(dirname(join(directory, path)), { recursive: true });
      writeFileSync(join(directory, path), 'export {};\n');
    }
    git('add', '.');
    git('commit', '--quiet', '-m', 'fixture');
    unlinkSync(join(directory, 'core/gone.ts'));
    unlinkSync(join(directory, 'docs/dev/GONE.md'));
    assert.deepEqual(checkChanged.changedFiles(undefined, directory), [
      'core/gone.ts',
      'docs/dev/GONE.md',
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }

  const checks = checkChanged.selectChecks(
    ['core/gone.ts', 'core/kept.ts', 'docs/dev/GONE.md'],
    {},
    { exists: (file) => file === 'core/kept.ts' }
  );
  assert.deepEqual(checks.biome, ['core/kept.ts']);
  assert.equal(checks.typeScript, true);
  assert.equal(checks.documentation, true);
  assert.deepEqual(checks.vitest, ['core/gone.ts', 'core/kept.ts']);
});

test('a scripts change runs its paired tooling test, or the whole tooling suite without one', () => {
  const tooling = (files, toolingSources = {}, extraTests = []) =>
    checkChanged.selectChecks(
      files,
      {},
      {
        toolingTests: [...toolingTests, ...extraTests],
        toolingSources,
      }
    ).tooling;
  assert.deepEqual(tooling(['scripts/doctor.mjs']), ['scripts/doctor.test.mjs']);
  assert.deepEqual(tooling(['scripts/ci-gate.test.mjs']), ['scripts/ci-gate.test.mjs']);
  assert.deepEqual(tooling(['tests/build-runner.node.test.mjs']), [
    'tests/build-runner.node.test.mjs',
  ]);
  assert.equal(tooling(['scripts/doctor.mjs', 'scripts/lib.mjs']), 'all');
  assert.deepEqual(tooling(['core/provider.ts']), []);
  const typed = ['scripts/perf-ledger.test.ts'];
  assert.deepEqual(tooling(['scripts/perf-ledger.mjs'], {}, typed), typed);
  assert.deepEqual(tooling(typed, {}, typed), typed);
  const importers = {
    'scripts/ci-changes.test.mjs': "import { docsOnly } from './ci-changes.mjs';",
    'scripts/check-changed.test.mjs': "import { docsOnly } from './ci-changes.mjs';",
    'scripts/pre-push-hook.test.mjs': "import { docsOnly } from './ci-changes.mjs';",
  };
  const extra = Object.keys(importers);
  assert.deepEqual(tooling(['scripts/ci-changes.mjs'], importers, extra), [
    'scripts/check-changed.test.mjs',
    'scripts/ci-changes.test.mjs',
    'scripts/pre-push-hook.test.mjs',
  ]);
  assert.deepEqual(
    tooling(
      ['.githooks/pre-push.mjs'],
      { 'scripts/pre-push-hook.test.mjs': "import '../.githooks/pre-push.mjs';" },
      extra
    ),
    ['scripts/pre-push-hook.test.mjs']
  );
  assert.equal(tooling(['.claude/hooks/release-guard.mjs']), 'all');
  assert.equal(checkChanged.toolingNeedsBuild('all'), true);
  assert.equal(
    checkChanged.toolingNeedsBuild(['scripts/perf-ledger.test.ts'], {
      'scripts/perf-ledger.test.ts': "import '#dist/server/app.js';",
    }),
    true
  );
  assert.equal(
    checkChanged.toolingNeedsBuild(['scripts/doctor.test.mjs'], {
      'scripts/doctor.test.mjs': "import { doctor } from './doctor.mjs';",
    }),
    false
  );
  assert.deepEqual(
    checkChanged.vitestRelatedFiles(
      ['core/gone.ts', 'core/kept.ts'],
      (file) => file === 'core/kept.ts'
    ),
    ['core/kept.ts']
  );
});

test('a script change also runs the tooling tests of scripts and hooks that import it indirectly', () => {
  const toolingSources = {
    'scripts/change-classifier.test.mjs': "import { is } from './change-classifier.mjs';",
    'scripts/ci-changes.test.mjs': "import { docsOnly } from './ci-changes.mjs';",
    'scripts/pre-push-hook.test.mjs': "import '../.githooks/pre-push.mjs';",
    'scripts/doctor.test.mjs': "import { doctor } from './doctor.mjs';",
  };
  const scriptSources = {
    'scripts/ci-changes.mjs': "import { docsOnly } from './change-classifier.mjs';",
    '.githooks/pre-push.mjs': "import { versionChanged } from '../scripts/ci-changes.mjs';",
    'scripts/doctor.mjs': "import { run } from './lib.mjs';",
  };
  const { tooling } = checkChanged.selectChecks(
    ['scripts/change-classifier.mjs'],
    {},
    { toolingTests: Object.keys(toolingSources), toolingSources, scriptSources }
  );
  assert.deepEqual(tooling, [
    'scripts/change-classifier.test.mjs',
    'scripts/ci-changes.test.mjs',
    'scripts/pre-push-hook.test.mjs',
  ]);
});

test('global configuration changes are reported as needing the full suite', () => {
  for (const file of [
    'package.json',
    'package-lock.json',
    'vitest.config.ts',
    'tsconfig.json',
    'tsconfig.web.json',
    'biome.json',
    'scripts/build.mjs',
    'scripts/build-runner.mjs',
  ])
    assert.deepEqual(checkChanged.selectChecks([file], {}).fullRequired, [file], file);
  assert.deepEqual(checkChanged.selectChecks(['core/provider.ts'], {}).fullRequired, []);
});

test('a hub change runs direct matches and 1-hop importers first, up to a stated limit', () => {
  const sources = {
    'tests/hub.test.ts': "import { other } from '../core/other.js';",
    'tests/hub-user.test.ts': "import { hub } from '../core/hub.js';",
    'tests/lazy-user.test.ts': "const { hub } = await import('../core/hub.js');",
    'tests/unrelated.test.ts': "import { other } from '../core/other.js';",
  };
  const checks = checkChanged.selectChecks(['core/hub.ts'], sources);
  assert.deepEqual(checks.directTests, ['tests/hub.test.ts']);
  assert.deepEqual(checks.firstHopTests, ['tests/hub-user.test.ts', 'tests/lazy-user.test.ts']);

  const affected = Array.from({ length: 40 }, (_, index) => `tests/t${index + 10}.test.ts`);
  const limited = checkChanged.prioritizeTests(
    affected,
    { direct: ['tests/t49.test.ts'], firstHop: ['tests/t48.test.ts'] },
    30
  );
  assert.equal(limited.total, 40);
  assert.equal(limited.run.length, 30);
  assert.deepEqual(limited.run.slice(0, 3), [
    'tests/t49.test.ts',
    'tests/t48.test.ts',
    'tests/t10.test.ts',
  ]);
  assert.match(limited.notice, /40 affected/u);
  assert.match(limited.notice, /30/u);
  assert.match(limited.notice, /npm test/u);
  const unlimited = checkChanged.prioritizeTests(affected, { direct: [], firstHop: [] }, Infinity);
  assert.equal(unlimited.run.length, 40);
  assert.equal(unlimited.notice, undefined);

  assert.deepEqual(checkChanged.parseArguments([], {}), {
    base: undefined,
    limit: 30,
    listJson: false,
  });
  assert.deepEqual(checkChanged.parseArguments(['HEAD~1', '--limit', '5', '--list-json'], {}), {
    base: 'HEAD~1',
    limit: 5,
    listJson: true,
  });
  assert.equal(checkChanged.parseArguments(['--all'], {}).limit, Infinity);
  assert.equal(checkChanged.parseArguments([], { CI: 'true' }).limit, Infinity);
});

test('a test that names a module by its repository path is a direct test of that module', () => {
  const sources = {
    'tests/spawns.test.ts': "spawn(process.execPath, [resolve('runner/runner.mjs')]);",
    'tests/unrelated.test.ts': "spawn(process.execPath, [resolve('runner/other.mjs')]);",
  };
  const checks = checkChanged.selectChecks(['runner/runner.mjs'], sources);
  assert.deepEqual(checks.directTests, ['tests/spawns.test.ts']);
  assert.ok(checks.vitest.includes('tests/spawns.test.ts'));

  const testsDirectory = new URL('../tests/', import.meta.url);
  const repositoryTests = Object.fromEntries(
    readdirSync(testsDirectory)
      .filter((name) => name.endsWith('.test.ts'))
      .map((name) => [`tests/${name}`, readFileSync(new URL(name, testsDirectory), 'utf8')])
  );
  for (const [file, tests] of [
    [
      'runner/runner.mjs',
      [
        'tests/helper-runner.test.ts',
        'tests/helper-shell-runtime.test.ts',
        'tests/helper-shell.test.ts',
        'tests/main-shell.test.ts',
      ],
    ],
    ['runner/uimori.mjs', ['tests/helper-cli.test.ts', 'tests/helper-shell.test.ts']],
  ]) {
    const selected = checkChanged.selectChecks([file], repositoryTests).directTests;
    for (const test of tests) assert.ok(selected.includes(test), `${file} selects ${test}`);
  }
});

test('comments check only the changed files, and i18n runs for the runtime sources it scans', () => {
  const checks = checkChanged.selectChecks(['core/a.ts', 'web/b.tsx'], {});
  assert.deepEqual(checks.comments, ['core/a.ts', 'web/b.tsx']);
  assert.equal(checks.i18n, true);
  assert.equal(checkChanged.selectChecks(['core/a.ts'], {}).i18n, true);
  assert.equal(checkChanged.selectChecks(['packages/contracts/src/a.ts'], {}).i18n, true);
  assert.equal(checkChanged.selectChecks(['tests/a.test.ts'], {}).i18n, false);
  assert.equal(checkChanged.selectChecks(['web/locales/settings.ts'], {}).i18n, true);
  assert.equal(checkChanged.selectChecks(['scripts/check-i18n.mjs'], {}).i18n, true);
  assert.equal(checkChanged.selectChecks(['scripts/korean-literal-allowlist.json'], {}).i18n, true);
  assert.equal(checkChanged.selectChecks(['server/app.ts'], {}).i18n, true);
  assert.equal(checks.uiMessage, true);
  assert.equal(checks.endpointCalls, true);
  assert.equal(
    checkChanged.selectChecks(['scripts/legacy-api-allowlist.json'], {}).endpointCalls,
    true
  );
  assert.equal(
    checkChanged.selectChecks(['packages/contracts/src/domains/library/endpoints.ts'], {})
      .endpointCalls,
    false
  );
  assert.equal(checkChanged.selectChecks(['server/app.ts'], {}).endpointCalls, false);
  assert.equal(checkChanged.selectChecks(['server/app.ts'], {}).uiMessage, false);
  assert.equal(
    checkChanged.selectChecks(['scripts/ui-message-allowlist.json'], {}).uiMessage,
    true
  );
  assert.equal(
    checkChanged.selectChecks(['core/a.ts', 'scripts/comment-allowlist.json'], {}).comments,
    'all'
  );
});

test('sources outside the app run the script import check, and JavaScript runs tsc when the program includes it', () => {
  const select = (file) => checkChanged.selectChecks([file], {});
  assert.equal(select('scripts/doctor.mjs').scriptImports, true);
  assert.equal(select('tests/fixtures/worker.mjs').scriptImports, true);
  assert.equal(select('.githooks/pre-push.mjs').scriptImports, true);
  assert.equal(select('scripts/helper-eval.ts').scriptImports, true);
  assert.equal(select('server/worker.mjs').scriptImports, false);
  assert.equal(select('server/app.ts').scriptImports, false);
  assert.equal(select('scripts/lib.mjs').typeScript, true);
  assert.equal(select('runner/runner.mjs').typeScript, false);
});

test('root user guides select the guide test, and server entry changes say the dist tests need a build', () => {
  const sources = { 'tests/app-guides.test.ts': "readdirSync('docs')" };
  assert.ok(
    checkChanged
      .selectChecks(['docs/READING.md'], sources)
      .vitest.includes('tests/app-guides.test.ts')
  );
  assert.ok(
    !checkChanged
      .selectChecks(['docs/dev/CHECKS.md'], sources)
      .vitest.includes('tests/app-guides.test.ts')
  );
  for (const file of ['server/index.ts', 'server/app.ts']) {
    const notes = checkChanged.selectChecks([file], {}).notes.join('\n');
    assert.match(notes, /tests\/server\.test\.ts/u, file);
    assert.match(notes, /tests\/background-work\.test\.ts/u, file);
    assert.match(notes, /npm run build/u, file);
  }
});
