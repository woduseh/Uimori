import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildContextErrors, contextErrors } from './check-build-context.mjs';
import { buildFingerprint, root } from './lib.mjs';

const dockerignore = readFileSync(new URL('../.dockerignore', import.meta.url), 'utf8');

test('every file the build fingerprint counts reaches the Docker build context', async () => {
  assert.deepEqual(await buildContextErrors(), []);
});

test('a fingerprinted folder the build context excludes is reported', async () => {
  const { files } = await buildFingerprint(root);
  const withoutSkills = dockerignore
    .split('\n')
    .filter((line) => !line.startsWith('!docs/skills'))
    .join('\n');
  const errors = contextErrors(files, withoutSkills);
  assert.ok(files.some((file) => file.startsWith('docs/skills/')));
  assert.match(errors.join('\n'), /docs\/skills\/[^/]+\/SKILL\.md/u);
});

test('an ignored file added to the fingerprint is reported', async () => {
  const { files } = await buildFingerprint(root);
  for (const ignored of ['scripts/check-comments.mjs', 'tests/server.test.ts', 'web/x/.env.local'])
    assert.match(contextErrors([...files, ignored], dockerignore).join('\n'), new RegExp(ignored));
});

test('an empty fingerprint cannot pass', () => {
  assert.notDeepEqual(contextErrors([], dockerignore), []);
});
