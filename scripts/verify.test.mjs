import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseArguments,
  planVerification,
  privateMaterialEnv,
  runOptions,
  selectChanged,
  verificationNames,
} from './verify.mjs';

const map = {
  version: 1,
  defaults: { launch: { runner: 'browser-harness', providerFixture: true } },
  domains: {
    reader: {
      title: 'Reader',
      sources: ['web/Reader*.tsx', 'web/reader-*.css'],
      specs: [{ file: 'tests/reading-browser.spec.ts' }],
    },
    risu: {
      title: 'Risu',
      sources: ['server/risu-*.ts'],
      specs: [
        { file: 'tests/risu-import-browser.spec.ts' },
        {
          file: 'tests/risu-native-samples-browser.spec.ts',
          launch: { privateMaterials: true, requiredEnv: ['SAMPLE_ROOT'] },
        },
        {
          file: 'tests/narrative-browser.spec.ts',
          launch: { privateMaterialsEnv: 'DEMO_DIR' },
        },
      ],
    },
    'self-host': {
      title: 'Self-host',
      sources: ['server/access-session.ts'],
      specs: [{ file: 'tests/self-host-browser.spec.ts', launch: { runner: 'self-host' } }],
    },
  },
  presets: {
    smoke: { title: 'Smoke', specs: ['tests/reading-browser.spec.ts'], grep: '@smoke' },
  },
};

const summarize = ({ runs, skipped }) => ({
  runs: runs.map(({ kind, name, files, grep, privateMaterials, script }) =>
    kind === 'script'
      ? { name, script }
      : { name, files, ...(grep ? { grep } : {}), privateMaterials }
  ),
  skipped,
});

test('domains merge into one run per launch and skip specs whose required environment is missing', () => {
  assert.deepEqual(summarize(planVerification(map, ['reader', 'risu', 'self-host'], { env: {} })), {
    runs: [
      {
        name: 'reader-risu-self-host',
        files: [
          'tests/reading-browser.spec.ts',
          'tests/risu-import-browser.spec.ts',
          'tests/narrative-browser.spec.ts',
        ],
        privateMaterials: false,
      },
      { name: 'self-host', script: 'scripts/verify-self-host.mjs' },
    ],
    skipped: [{ file: 'tests/risu-native-samples-browser.spec.ts', missingEnv: ['SAMPLE_ROOT'] }],
  });
  assert.deepEqual(
    summarize(
      planVerification(map, ['risu'], { env: { SAMPLE_ROOT: '/cards', DEMO_DIR: '/demo' } })
    ),
    {
      runs: [
        { name: 'risu', files: ['tests/risu-import-browser.spec.ts'], privateMaterials: false },
        {
          name: 'risu-private',
          files: ['tests/risu-native-samples-browser.spec.ts', 'tests/narrative-browser.spec.ts'],
          privateMaterials: true,
        },
      ],
      skipped: [],
    }
  );
});

test('a runner drops only harness options it does not accept and passes the rest on to reject', () => {
  const [, selfHost] = planVerification(map, ['reader', 'self-host'], { env: {} }).runs;
  assert.deepEqual(
    runOptions(selfHost, ['--visual', '--workers', '2', '--grep', 'SH01', '--shard', '1/3']),
    { kept: ['--grep', 'SH01'], dropped: ['--visual', '--workers', '2', '--shard', '1/3'] }
  );
  assert.deepEqual(runOptions(selfHost, ['--grepp', 'SH01']), {
    kept: ['--grepp', 'SH01'],
    dropped: [],
  });
  for (const missingValue of [['--workers', '--grep', 'SH01'], ['--workers'], ['--shard', '']])
    assert.deepEqual(runOptions(selfHost, missingValue), { kept: missingValue, dropped: [] });
  const [gallery] = planVerification(map, ['gallery'], { env: {} }).runs;
  assert.deepEqual(runOptions(gallery, ['--visual']), { kept: ['--visual'], dropped: [] });
  assert.deepEqual(privateMaterialEnv(map), ['SAMPLE_ROOT', 'DEMO_DIR']);
});

test('presets, engines and the full regression keep their own runs', () => {
  assert.deepEqual(summarize(planVerification(map, ['smoke', 'gallery'], { env: {} })).runs, [
    {
      name: 'smoke',
      files: ['tests/reading-browser.spec.ts'],
      grep: '@smoke',
      privateMaterials: false,
    },
    { name: 'gallery', script: 'scripts/verify-gallery.mjs' },
  ]);
  const [full] = planVerification(map, ['all'], { env: {} }).runs;
  assert.deepEqual([full.files, full.providerFixture], [[], true]);
  assert.throws(() => planVerification(map, ['all', 'reader']), /name it alone/u);
  assert.throws(() => planVerification(map, ['gone']), /Unknown verification name: gone/u);
  assert.throws(
    () => verificationNames({ ...map, presets: { copy: { title: 'Copy', specs: [] } } }),
    /copy is taken twice \(preset, engine\)/u
  );
});

test('changed files select owning domains and report browser inputs no domain covers', () => {
  assert.deepEqual(
    selectChanged(map, [
      'docs/dev/CHECKS.md',
      'server/risu-import.ts',
      'tests/reading-browser.spec.ts',
      'web/reader-selection.css',
      'web/style.css',
      'tests/fixtures/run-completion.ts',
    ]),
    {
      domains: ['reader', 'risu'],
      uncovered: ['web/style.css', 'tests/fixtures/run-completion.ts'],
    }
  );
  assert.deepEqual(selectChanged(map, ['docs/dev/CHECKS.md', 'scripts/doctor.mjs']), {
    domains: [],
    uncovered: [],
  });
});

test('options follow the names, and --changed takes an optional base first', () => {
  assert.deepEqual(parseArguments(['reader', 'risu', '--grep', 'LIB', '--visual']), {
    changed: false,
    names: ['reader', 'risu'],
    options: ['--grep', 'LIB', '--visual'],
  });
  assert.deepEqual(parseArguments(['--changed', 'origin/main', '--workers', '2']), {
    changed: true,
    base: 'origin/main',
    names: [],
    options: ['--workers', '2'],
  });
  assert.throws(() => parseArguments(['--grep', 'LIB']), /Usage/u);
});
