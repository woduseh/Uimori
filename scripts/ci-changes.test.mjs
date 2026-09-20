import { test } from 'node:test';
import assert from 'node:assert/strict';
import { docsOnly } from './ci-changes.mjs';

test('only inert documentation changes skip the expensive quality steps', () => {
  assert.equal(docsOnly(['README.md', 'docs/DEVELOPMENT.md']), true);
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
