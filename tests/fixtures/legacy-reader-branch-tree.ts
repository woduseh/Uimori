// Differential reference: server/reader.ts at e9a1aff837b8b2bf9f00e5127e26dadeae04af28.
// Algorithm retained verbatim; only the name and type-only signature are adapted for this fixture.
import type { BranchTreeNode } from '../../core/types.js';
import type { Branch } from '../../core/product.js';
export function legacyBranchTree(
  branches: Pick<Branch, 'id' | 'headRevision'>[],
  parents: Map<string, string | null>
): BranchTreeNode[] {
  const chains = new Map<string, string[]>();
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
    chains.set(branch.id, chain.reverse());
  }
  const nodes: BranchTreeNode[] = [];
  const emit = (branch: Pick<Branch, 'id' | 'headRevision'>, depth: number, fork: number) => {
    const chain = chains.get(branch.id)!;
    nodes.push({
      id: branch.id,
      depth,
      forkSourceId: fork > 0 ? chain[fork - 1] : null,
      forkIndex: fork > 0 ? fork : null,
      ownScenes: chain.length - fork,
      totalScenes: chain.length,
    });
  };
  const pending = [
    {
      members: branches.filter((branch) => chains.get(branch.id)!.length > 0),
      start: 0,
      depth: 0,
      fork: 0,
    },
  ];
  for (const branch of branches) if (!chains.get(branch.id)!.length) emit(branch, 0, 0);
  while (pending.length) {
    const { members, start, depth, fork } = pending.pop()!;
    if (members.length === 1) {
      emit(members[0], depth, fork);
      continue;
    }
    const ending = members.filter((branch) => chains.get(branch.id)!.length === start);
    const groups = new Map<string, Pick<Branch, 'id' | 'headRevision'>[]>();
    for (const branch of members.filter((item) => chains.get(item.id)!.length > start)) {
      const next = chains.get(branch.id)![start];
      groups.set(next, [...(groups.get(next) ?? []), branch]);
    }
    const parting = ending.length + groups.size > 1;
    for (const branch of ending) emit(branch, depth, fork);
    for (const group of [...groups.values()].reverse()) {
      pending.push({
        members: group,
        start: start + 1,
        depth: parting ? depth + 1 : depth,
        fork: parting ? start : fork,
      });
    }
  }
  return nodes;
}
