import type { BranchTreeNode } from './types.js';
import type { Branch } from './product.js';

type ReaderBranch = Pick<Branch, 'id' | 'headRevision'>;
type Ending = { id: string; length: number };
type Trie = {
  sourceId: string | null;
  length: number;
  count: number;
  first?: Ending;
  endings: Ending[];
  children: Map<string, Trie>;
};
const trie = (sourceId: string | null, length: number): Trie => ({
  sourceId,
  length,
  count: 0,
  endings: [],
  children: new Map(),
});

/**
 * Build shared prefixes once instead of copying each growing sibling group at every scene.
 * Branch order, ending branches and fork indentation match the reader's original traversal.
 * Only one ancestry chain is temporary; no result is cached across mutable branch revisions.
 */
export function branchTree(
  branches: readonly ReaderBranch[],
  parents: ReadonlyMap<string, string | null>
): BranchTreeNode[] {
  // The common single-branch reader needs no trie or retained ancestry array.
  if (branches.length < 2) {
    const branch = branches[0];
    if (!branch) return [];
    const seen = new Set<string>();
    let head = branch.headRevision;
    while (head && !seen.has(head) && parents.has(head)) {
      seen.add(head);
      head = parents.get(head) ?? null;
    }
    return [
      {
        id: branch.id,
        depth: 0,
        forkSourceId: null,
        forkIndex: null,
        ownScenes: seen.size,
        totalScenes: seen.size,
      },
    ];
  }
  const root = trie(null, 0);
  const empty: Ending[] = [];
  for (const branch of branches) {
    const chain: string[] = [];
    const seen = new Set<string>();
    let head = branch.headRevision;
    while (head && !seen.has(head)) {
      seen.add(head);
      if (!parents.has(head)) break;
      chain.push(head);
      head = parents.get(head) ?? null;
    }
    const ending = { id: branch.id, length: chain.length };
    if (!chain.length) {
      empty.push(ending);
      continue;
    }
    let node = root;
    node.count++;
    node.first ??= ending;
    for (let index = chain.length - 1; index >= 0; index--) {
      const source = chain[index];
      let next = node.children.get(source);
      if (!next) {
        next = trie(source, node.length + 1);
        node.children.set(source, next);
      }
      node = next;
      node.count++;
      node.first ??= ending;
    }
    node.endings.push(ending);
  }
  const result: BranchTreeNode[] = [];
  const emit = (ending: Ending, depth: number, fork: Trie | null) => {
    const length = fork?.length ?? 0;
    result.push({
      id: ending.id,
      depth,
      forkSourceId: length ? fork!.sourceId : null,
      forkIndex: length || null,
      ownScenes: ending.length - length,
      totalScenes: ending.length,
    });
  };
  for (const ending of empty) emit(ending, 0, null);
  const pending: { node: Trie; depth: number; fork: Trie | null }[] = [
    { node: root, depth: 0, fork: null },
  ];
  while (pending.length) {
    const { node, depth, fork } = pending.pop()!;
    if (node.count === 1) {
      emit(node.first!, depth, fork);
      continue;
    }
    for (const ending of node.endings) emit(ending, depth, fork);
    const parting = node.endings.length + node.children.size > 1;
    for (const child of [...node.children.values()].reverse())
      pending.push({
        node: child,
        depth: parting ? depth + 1 : depth,
        fork: parting ? node : fork,
      });
  }
  return result;
}
