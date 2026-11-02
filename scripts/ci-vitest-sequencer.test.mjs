import assert from 'node:assert/strict';
import { test } from 'node:test';
import CiVitestSequencer, { balanceTestFiles } from './ci-vitest-sequencer.ts';

const files = ['tests/slow.test.ts', 'tests/b.test.ts', 'tests/a.test.ts', 'tests/c.test.ts'];
const weights = { 'tests/slow.test.ts': 9, 'tests/a.test.ts': 3 };

test('every test file belongs to exactly one deterministic shard', () => {
  const shards = balanceTestFiles(files, 2, weights);
  assert.equal(shards.length, 2);
  assert.deepEqual(shards.flat().sort(), [...files].sort());
  assert.deepEqual(balanceTestFiles([...files].reverse(), 2, weights), shards);
  assert.ok(shards.every((shard) => shard.length > 0));
});

test('long files are distributed and unknown files remain covered', () => {
  const shards = balanceTestFiles(files, 2, weights);
  assert.notEqual(
    shards.findIndex((shard) => shard.includes('tests/slow.test.ts')),
    shards.findIndex((shard) => shard.includes('tests/a.test.ts'))
  );
  assert.equal(new Set(shards.flat()).size, files.length);
});

test('invalid shards and duplicate inventory fail instead of silently skipping tests', () => {
  for (const count of [0, 1.5, 5]) assert.throws(() => balanceTestFiles(files, count, weights));
  assert.throws(() => balanceTestFiles([...files, files[0]], 2, weights), /Duplicate/);
});

test('Vitest integration selects only a shard without copying or dropping specifications', async () => {
  const specs = files.map((file) => ({ moduleId: `/repo/${file}` }));
  const selected = [];
  for (let index = 1; index <= 2; index++) {
    const sequencer = new CiVitestSequencer({
      config: { root: '/repo', shard: { index, count: 2 } },
    });
    selected.push(...(await sequencer.shard(specs)));
  }
  assert.deepEqual(
    [...selected].sort((a, b) => a.moduleId.localeCompare(b.moduleId)),
    [...specs].sort((a, b) => a.moduleId.localeCompare(b.moduleId))
  );
});
