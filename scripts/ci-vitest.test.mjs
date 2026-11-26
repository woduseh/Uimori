import assert from 'node:assert/strict';
import { test } from 'node:test';
import { distTests } from './check-changed.mjs';
import { parseArguments, selectTests, shardTests } from './ci-vitest.mjs';

const collected = ['tests/a.test.ts', 'tests/b.test.ts', ...distTests, 'tests/c.test.ts'].sort();

test('arguments take one shard, at most one dist mode and an optional impact base', () => {
  assert.deepEqual(parseArguments(['2/4']), {
    shard: '2/4',
    index: 2,
    total: 4,
    dist: 'include',
    impactBase: undefined,
  });
  assert.deepEqual(parseArguments(['1/1', '--dist-only', '--impact-base', 'abc123']), {
    shard: '1/1',
    index: 1,
    total: 1,
    dist: 'only',
    impactBase: 'abc123',
  });
  assert.equal(parseArguments(['--exclude-dist', '3/4']).dist, 'exclude');
  for (const argv of [
    [],
    ['1/4', '2/4'],
    ['1/4', '--exclude-dist', '--dist-only'],
    ['1/4', '--impact-base'],
    ['1/4', '--impact-base', '--exclude-dist'],
    ['1/4', '--shard'],
    ['5/4'],
  ])
    assert.throws(() => parseArguments(argv), argv.join(' '));
});

test('the dist modes split the collection into compiled-server tests and the rest', () => {
  assert.deepEqual(selectTests(collected), collected);
  assert.deepEqual(selectTests(collected, { dist: 'only' }), [...distTests].sort());
  assert.deepEqual(selectTests(collected, { dist: 'exclude' }), [
    'tests/a.test.ts',
    'tests/b.test.ts',
    'tests/c.test.ts',
  ]);
});

test('an impact run keeps only affected tests, and full-required changes escalate to everything', () => {
  const impact = { fullRequired: [], affectedTests: ['tests/c.test.ts', 'tests/server.test.ts'] };
  assert.deepEqual(selectTests(collected, { dist: 'exclude', impact }), ['tests/c.test.ts']);
  assert.deepEqual(selectTests(collected, { dist: 'only', impact }), ['tests/server.test.ts']);
  assert.deepEqual(selectTests(collected, { impact: { fullRequired: [], affectedTests: [] } }), []);
  assert.deepEqual(
    selectTests(collected, {
      dist: 'exclude',
      impact: { ...impact, fullRequired: ['package.json'] },
    }),
    selectTests(collected, { dist: 'exclude' })
  );
});

test('shards partition the selection, and selections smaller than the shard count leave shards empty', () => {
  const files = Array.from({ length: 9 }, (_, index) => `tests/t${index}.test.ts`);
  const parts = [1, 2, 3, 4].map((index) => shardTests(files, { index, total: 4 }));
  assert.ok(parts.every((part) => part.length));
  assert.deepEqual(parts.flat().sort(), files);
  assert.deepEqual(
    [1, 2, 3, 4].map((index) => shardTests(files.slice(0, 2), { index, total: 4 })),
    [['tests/t0.test.ts'], ['tests/t1.test.ts'], [], []]
  );
  assert.deepEqual(shardTests([], { index: 1, total: 4 }), []);
});
