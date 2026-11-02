import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
const instructions = dockerfile
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'));

function instructionIndex(prefix) {
  return instructions.findIndex((line) => line.startsWith(prefix));
}

test('revision metadata is applied after all executable Dockerfile instructions', () => {
  const revision = instructionIndex('ARG UIMORI_REVISION=');
  const labels = instructionIndex('LABEL io.uimori.managed=');
  assert.ok(revision >= 0 && labels > revision);
  assert.ok(instructions[labels].includes('org.opencontainers.image.revision=$UIMORI_REVISION'));
  assert.ok(instructions[labels].includes('io.uimori.codex-version=$UIMORI_CODEX_VERSION'));
  assert.equal(
    labels,
    instructions.length - 1,
    'revision label must not invalidate subsequent layers'
  );
  for (const line of instructions.slice(0, revision)) {
    assert.ok(!line.includes('UIMORI_REVISION'), 'revision must not affect any earlier cache key');
  }
});

test('Codex install depends on its version, not the source revision', () => {
  const version = instructionIndex('ARG UIMORI_CODEX_VERSION=');
  const install = instructionIndex('RUN if [ -n "$UIMORI_CODEX_VERSION" ]');
  const revision = instructionIndex('ARG UIMORI_REVISION=');
  assert.ok(version >= 0 && install > version && revision > install);
  assert.ok(instructions[install].includes('"@openai/codex@$UIMORI_CODEX_VERSION"'));
  assert.ok(instructions.includes('USER node'));
  assert.ok(instructions.includes('CMD ["node", "dist/server/index.js"]'));
});
