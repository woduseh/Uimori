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

test('a chat with one execution branch is a flat row, including an empty chat', () => {
  expect(tree({}, {})).toEqual([]);
  expect(tree({ main: null }, {})).toEqual([
    { id: 'main', depth: 0, fork: null, forkIndex: null, own: 0, total: 0 },
  ]);
  expect(tree({ main: 'b' }, { a: null, b: 'a' })).toEqual([
    { id: 'main', depth: 0, fork: null, forkIndex: null, own: 2, total: 2 },
  ]);
});

test('missing sources and cyclic ancestry stop without inventing a fork', () => {
  expect(tree({ main: 'gone' }, { a: null })).toEqual([
    { id: 'main', depth: 0, fork: null, forkIndex: null, own: 0, total: 0 },
  ]);
  expect(tree({ main: 'loop' }, { loop: 'loop' })).toEqual([
    { id: 'main', depth: 0, fork: null, forkIndex: null, own: 1, total: 1 },
  ]);
});

test('long manuscript histories do not consume the call stack', () => {
  const count = 20_000;
  const parents = Object.fromEntries(
    Array.from({ length: count }, (_, i) => [`s${i}`, i ? `s${i - 1}` : null])
  );
  const head = `s${count - 1}`;
  expect(tree({ main: head }, parents)).toEqual([
    { id: 'main', depth: 0, fork: null, forkIndex: null, own: count, total: count },
  ]);
});
