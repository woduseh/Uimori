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
    full: true,
  });
  assert.deepEqual(browserSelection(map, ['web/chat/Composer.tsx', 'server/app.ts']), {
    domains: ['chat'],
    specs: 3,
    cap: 3,
    full: false,
  });
  assert.equal(browserSelection(map, ['web/style.css', 'docs/dev/CHECKS.md']).domains.length, 0);
});

test('the real feature map selects a small domain change without the full browser shards', () => {
  const map = readFeatureMap();
  const [name, domain] = Object.entries(map.domains).find(([, entry]) => entry.specs.length === 1);
  const selection = browserSelection(map, [domain.specs[0].file]);
  assert.deepEqual(selection.domains, [name]);
  assert.equal(selection.full, false);
});
