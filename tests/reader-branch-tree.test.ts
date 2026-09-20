import assert from 'node:assert/strict';
import { test } from 'vitest';
import { branchTree } from '../core/reader-branch-tree.js';
import { legacyBranchTree } from './fixtures/legacy-reader-branch-tree.js';

test('branch traversal retains ending/sibling order, duplicate heads and empty branches', () => {
  const parents = new Map<string, string | null>([
    ['a', null],
    ['b', 'a'],
    ['c', 'b'],
    ['d', 'b'],
    ['e', 'd'],
    ['other', null],
  ]);
  const branches = [
    { id: 'late-ending', headRevision: 'e' },
    { id: 'early-ending', headRevision: 'a' },
    { id: 'empty', headRevision: null },
    { id: 'sibling', headRevision: 'c' },
    { id: 'same-head', headRevision: 'e' },
    { id: 'other-root', headRevision: 'other' },
  ];
  assert.deepEqual(branchTree(branches, parents), legacyBranchTree(branches, parents));
  assert.deepEqual(branchTree([], parents), []);
});

test('missing parents, missing heads and cycles retain the original bounded traversal', () => {
  const parents = new Map<string, string | null>([
    ['a', 'b'],
    ['b', 'a'],
    ['c', 'b'],
    ['d', 'missing'],
    ['self', 'self'],
  ]);
  const branches = ['a', 'b', 'c', 'd', 'self', 'missing', null].map((headRevision, index) => ({
    id: String(index),
    headRevision,
  }));
  assert.deepEqual(branchTree(branches, parents), legacyBranchTree(branches, parents));
});

test('deterministic generated forests preserve every output field of the previous implementation', () => {
  let seed = 0x2468ace;
  const random = (bound: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % bound;
  };
  for (let sample = 0; sample < 250; sample++) {
    const parents = new Map<string, string | null>();
    for (let i = 0; i < 120; i++)
      parents.set(String(i), i === 0 || random(7) === 0 ? null : String(random(i)));
    const branches = Array.from({ length: random(60) }, (_, index) => ({
      id: `branch-${index}`,
      headRevision: random(6) === 0 ? null : String(random(120)),
    }));
    assert.deepEqual(
      branchTree(branches, parents),
      legacyBranchTree(branches, parents),
      `sample ${sample}`
    );
  }
});

test('fresh branch/head/parent changes cannot serve a stale cached tree', () => {
  const parents = new Map<string, string | null>([
    ['a', null],
    ['b', 'a'],
    ['c', 'a'],
  ]);
  const branches = [
    { id: 'one', headRevision: 'b' },
    { id: 'two', headRevision: 'c' },
  ];
  const original = branchTree(branches, parents);
  branches[1].headRevision = 'b';
  parents.set('b', null);
  const next = branchTree(branches, parents);
  assert.notDeepEqual(next, original);
  assert.deepEqual(next, legacyBranchTree(branches, parents));
  next[0].depth = 999;
  assert.deepEqual(branchTree(branches, parents), legacyBranchTree(branches, parents));
});

test('deep shared ancestry remains iterative and matches original fork indices', () => {
  const parents = new Map<string, string | null>();
  for (let i = 0; i < 12000; i++) parents.set(String(i), i ? String(i - 1) : null);
  const branches = Array.from({ length: 6 }, (_, i) => ({
    id: `b-${i}`,
    headRevision: String(11999 - i),
  }));
  assert.deepEqual(branchTree(branches, parents), legacyBranchTree(branches, parents));
});

test('zero and single branches avoid trie allocation while preserving missing and cyclic ancestry', () => {
  const parents = new Map<string, string | null>([
    ['root', null],
    ['head', 'root'],
    ['loop', 'loop'],
  ]);
  for (const branches of [
    [],
    [{ id: 'one', headRevision: null }],
    [{ id: 'one', headRevision: 'head' }],
    [{ id: 'one', headRevision: 'missing' }],
    [{ id: 'one', headRevision: 'loop' }],
  ])
    assert.deepEqual(branchTree(branches, parents), legacyBranchTree(branches, parents));
});
