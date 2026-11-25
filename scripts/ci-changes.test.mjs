import { test } from 'node:test';
import assert from 'node:assert/strict';
import { docsOnly, versionChanged } from './ci-changes.mjs';

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
  assert.equal(docsOnly(['README.md', 'docs/dev/DEVELOPMENT.md', 'docs/READING.md']), true);
  assert.equal(docsOnly(['README.ko.md']), true);
  for (const files of [
    [],
    ['web/help.md'],
    ['docs/example.ts'],
    ['docs/page.mdx'],
    ['.github/workflows/quality.yml'],
    ['package.json'],
    ['docs/READING.md', 'server/app.ts'],
  ])
    assert.equal(docsOnly(files), false);
});
