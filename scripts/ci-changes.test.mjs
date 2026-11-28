import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserSelection, docsOnly, versionChanged, windowsSensitive } from './ci-changes.mjs';
import { readFeatureMap } from './feature-map.mjs';
import { buildFingerprint } from './lib.mjs';

test('a version change between the pushed revisions marks a release candidate', () => {
  const packages = {
    base: '{"version":"0.18.0"}',
    same: '{"version":"0.18.0"}',
    next: '{"version":"0.19.0"}',
  };
  assert.equal(
    versionChanged((revision) => packages[revision], 'base', 'next'),
    true
  );
  assert.equal(
    versionChanged((revision) => packages[revision], 'base', 'same'),
    false
  );
});

test('only inert documentation changes skip the expensive quality steps', () => {
  for (const files of [
    ['README.md', 'docs/dev/DEVELOPMENT.md'],
    ['README.ko.md'],
    ['AGENTS.md', 'LICENSE'],
    ['docs/plans/ux-redesign.md'],
    ['docs/releases/v0.18.1.md'],
  ])
    assert.equal(docsOnly(files), true);
});

test('root user guides are build inputs and run the full quality steps', () => {
  for (const files of [
    ['docs/READING.md'],
    ['README.md', 'docs/dev/DEVELOPMENT.md', 'docs/READING.md'],
  ])
    assert.equal(docsOnly(files), false);
});

test('no build input counts as an inert documentation change', async () => {
  const { files } = await buildFingerprint();
  assert.ok(files.includes('package.json'));
  assert.ok(files.some((file) => /^docs\/[^/]+\.md$/u.test(file)));
  assert.ok(files.some((file) => /^docs\/skills\/[^/]+\/SKILL\.md$/u.test(file)));
  assert.deepEqual(
    files.filter((file) => docsOnly([file])),
    []
  );
});

test('only web, documentation and browser spec changes skip the Windows tooling job', () => {
  for (const files of [
    ['web/ChatComposer.tsx', 'web/styles.css'],
    ['docs/READING.md', 'docs/dev/CHECKS.md', 'README.ko.md'],
    ['tests/chat-composer-browser.spec.ts'],
  ])
    assert.equal(windowsSensitive(files), false, files.join(', '));
  for (const files of [
    [],
    ['server/app.ts'],
    ['web/ChatComposer.tsx', 'core/provider.ts'],
    ['scripts/build.mjs'],
    ['tests/server.test.ts'],
    ['tests/feature-map.json'],
    ['package-lock.json'],
    ['.github/workflows/quality.yml'],
  ])
    assert.equal(windowsSensitive(files), true, files.join(', '));
});

test('code, workflow and empty change sets run the full quality steps', () => {
  for (const files of [
    [],
    ['server/app.ts'],
    ['web/help.md'],
    ['docs/example.ts'],
    ['docs/page.mdx'],
    ['.github/workflows/quality.yml'],
    ['package.json'],
    ['docs/READING.md', 'server/app.ts'],
  ])
    assert.equal(docsOnly(files), false);
});

function featureMap(specCounts) {
  return {
    domains: Object.fromEntries(
      Object.entries(specCounts).map(([name, count]) => [
        name,
        {
          title: name,
          sources: [`web/${name}/**`],
          specs: Array.from({ length: count }, (_, i) => ({ file: `tests/${name}-${i}.spec.ts` })),
        },
      ])
    ),
  };
}

test('a pull request runs the changed browser domains up to one full shard of specs', () => {
  const map = featureMap({ reader: 4, chat: 3, helper: 2 });
  assert.deepEqual(browserSelection(map, ['web/reader/Reader.tsx', 'web/helper/Helper.tsx']), {
    domains: [],
    specs: 6,
    cap: 3,
    uncovered: [],
    full: true,
  });
  assert.deepEqual(
    browserSelection(map, ['web/chat/Composer.tsx', 'docs/dev/CHECKS.md', 'scripts/verify.mjs']),
    { domains: ['chat'], specs: 3, cap: 3, uncovered: [], full: false }
  );
});

test('a browser input that no domain covers runs the full browser shards, even beside a covered one', () => {
  const map = featureMap({ reader: 4, chat: 3, helper: 2 });
  for (const files of [
    ['web/style.css'],
    ['web/chat/Composer.tsx', 'server/app.ts'],
    ['tests/fixtures/app.ts'],
    ['playwright.config.ts'],
  ]) {
    const selection = browserSelection(map, files);
    assert.equal(selection.full, true, files.join(', '));
    assert.deepEqual(selection.domains, [], files.join(', '));
    assert.ok(selection.uncovered.length, files.join(', '));
  }
  assert.equal(browserSelection(map, ['runner/runner.mjs']).full, false);
});

test('specs the changed-browser job cannot run neither count toward the cap nor select their domain', () => {
  const map = featureMap({ reader: 2, risu: 2, host: 0 });
  map.domains.risu.specs.push(
    { file: 'tests/private-0.spec.ts', launch: { requiredEnv: ['UIMORI_RISU_SAMPLE_ROOT'] } },
    { file: 'tests/private-1.spec.ts', launch: { requiredEnv: ['UIMORI_RISU_SAMPLE_ROOT'] } }
  );
  map.domains.host.specs.push({ file: 'tests/host-0.spec.ts', launch: { runner: 'self-host' } });
  assert.deepEqual(browserSelection(map, ['web/risu/Import.tsx']), {
    domains: ['risu'],
    specs: 2,
    cap: 3,
    uncovered: [],
    full: false,
  });
  assert.deepEqual(browserSelection(map, ['web/host/Gate.tsx', 'web/reader/Reader.tsx']), {
    domains: ['reader'],
    specs: 2,
    cap: 3,
    uncovered: [],
    full: false,
  });
});

test('the real feature map routes each kind of change to the browser run that covers it', () => {
  const map = readFeatureMap();
  const domainRuns = {
    'packages/contracts/src/domains/resource-editors/endpoints.ts': ['resource-editors'],
    'packages/contracts/src/domains/library/operations.ts': ['library'],
    'server/builtin-prompts/pheme.json': ['prompts'],
    'server/appearance-scope.ts': ['appearance', 'illustration'],
    'web/ArchivePanel.tsx': ['personal-workspace'],
    'runner/uimori.mjs': [],
    'runner/runner.mjs': [],
    'packages/contracts/src/domains/self-host/endpoints.ts': [],
  };
  for (const [file, domains] of Object.entries(domainRuns)) {
    const selection = browserSelection(map, [file]);
    assert.deepEqual(selection.domains, domains, file);
    assert.equal(selection.full, false, file);
  }
  for (const file of ['web/style.css', 'server/maintenance.ts', 'packages/contracts/src/index.ts'])
    assert.equal(browserSelection(map, [file]).full, true, file);
});
