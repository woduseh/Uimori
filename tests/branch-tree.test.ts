import { expect, test } from 'vitest';
import { branchTree } from '../server/reader.js';
import type { Branch } from '../core/product.js';

/** Scene ids are the chain; a parent map of `b→a` means scene b continues scene a. */
function tree(
  heads: Record<string, string | null>,
  parents: Record<string, string | null>,
  order = Object.keys(heads)
) {
  const branches = order.map<Branch>((id) => ({
    id,
    chatId: 'chat',
    title: id,
    headRevision: heads[id],
    revision: 1,
    default: id === order[0],
  }));
  return branchTree(branches, new Map(Object.entries(parents))).map((node) => ({
    id: node.id,
    depth: node.depth,
    fork: node.forkSourceId,
    forkIndex: node.forkIndex,
    own: node.ownScenes,
    total: node.totalScenes,
  }));
}

test('a chat with one branch is a single flat row that never claims a fork', () => {
  expect(tree({ main: 'b' }, { a: null, b: 'a' })).toEqual([
    { id: 'main', depth: 0, fork: null, forkIndex: null, own: 2, total: 2 },
  ]);
});

test('branches that all leave the first scene stay siblings at one level', () => {
  // `third` stops at the fork itself, so it holds the trunk and the other two hang below it.
  expect(tree({ main: 'b', second: 'c', third: 'a' }, { a: null, b: 'a', c: 'a' })).toEqual([
    { id: 'third', depth: 0, fork: null, forkIndex: null, own: 1, total: 1 },
    { id: 'main', depth: 1, fork: 'a', forkIndex: 1, own: 1, total: 2 },
    { id: 'second', depth: 1, fork: 'a', forkIndex: 1, own: 1, total: 2 },
  ]);
});

test('a branch taken from inside another branch nests one level deeper', () => {
  // a ─┬─ b            main
  //    └─ c ── d       second, then third from inside it
  const shape = tree({ main: 'b', second: 'c', third: 'd' }, { a: null, b: 'a', c: 'a', d: 'c' });
  expect(shape).toEqual([
    { id: 'main', depth: 1, fork: 'a', forkIndex: 1, own: 1, total: 2 },
    { id: 'second', depth: 1, fork: 'a', forkIndex: 1, own: 1, total: 2 },
    { id: 'third', depth: 2, fork: 'c', forkIndex: 2, own: 1, total: 3 },
  ]);
});

test('scenes shared after a fork do not add levels, so depth counts forks and not scenes', () => {
  // a ─ b ─ c ─┬─ d     two branches sharing three scenes before parting
  //            └─ e
  expect(tree({ main: 'd', second: 'e' }, { a: null, b: 'a', c: 'b', d: 'c', e: 'c' })).toEqual([
    { id: 'main', depth: 1, fork: 'c', forkIndex: 3, own: 1, total: 4 },
    { id: 'second', depth: 1, fork: 'c', forkIndex: 3, own: 1, total: 4 },
  ]);
});

test('a branch with no scene yet reports no fork and sorts with the roots', () => {
  expect(tree({ main: 'a', empty: null }, { a: null })).toEqual([
    { id: 'empty', depth: 0, fork: null, forkIndex: null, own: 0, total: 0 },
    { id: 'main', depth: 0, fork: null, forkIndex: null, own: 1, total: 1 },
  ]);
});

test('a branch head that lost its source stops the chain instead of looping', () => {
  expect(tree({ main: 'gone' }, { a: null })).toEqual([
    { id: 'main', depth: 0, fork: null, forkIndex: null, own: 0, total: 0 },
  ]);
});
