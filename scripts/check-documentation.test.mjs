import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { documentationErrors } from './check-documentation.mjs';

test('current documentation links and verification entry points name existing files', () => {
  assert.deepEqual(documentationErrors(), []);
});

test('nested guides and verification runners report missing targets without treating URLs or anchors as files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-doc-links-'));
  try {
    for (const child of ['docs/releases', 'scripts', 'tests'])
      mkdirSync(join(directory, child), { recursive: true });
    writeFileSync(join(directory, 'README.md'), '[guide](docs/releases/nested.md#usage)');
    writeFileSync(join(directory, 'AGENTS.md'), '[email](mailto:hello@example.invalid)');
    writeFileSync(
      join(directory, 'docs/releases/nested.md'),
      '[lost](../missing.md)\n[local](#usage)\n[web](https://example.invalid)'
    );
    writeFileSync(
      join(directory, 'scripts/verify-example.mjs'),
      "const files = ['tests/missing.test.ts'];"
    );
    assert.deepEqual(documentationErrors(directory), [
      `${join(directory, 'docs/releases/nested.md')}: ../missing.md`,
      'verify-example.mjs: tests/missing.test.ts',
    ]);
    writeFileSync(join(directory, 'docs/missing.md'), '[root](../README.md)');
    writeFileSync(join(directory, 'tests/missing.test.ts'), '');
    assert.deepEqual(documentationErrors(directory), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
