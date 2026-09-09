import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  appendLoreReads,
  validateLoreContextPolicy,
  type LoreContextSnapshot,
  type LoreDependency,
  type RetainedLore,
} from '../core/lore-context.js';
import { buildMainInput, executeTool, roleResources } from '../core/provider.js';
import type { Resource, Run, RunSnapshot } from '../core/types.js';
import type { Store } from './store.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export const loreDependencies = (snapshot: RunSnapshot): LoreDependency[] =>
  snapshot.history.map((e) => ({
    sourceRevision: e.revision,
    sourceHash: e.contentHash ?? hash(e.text),
  }));
function currentDependencies(store: Store, snapshot: RunSnapshot): boolean {
  try {
    const actual = store.history(snapshot.parentRevision);
    return isDeepStrictEqual(
      loreDependencies({ ...snapshot, history: actual }),
      loreDependencies(snapshot)
    );
  } catch {
    return false;
  }
}
/** Source edits and changed ancestors invalidate all reads made under that context. */
export function loreRunIsCurrent(store: Store, run: Run): boolean {
  if (
    run.status !== 'completed' ||
    !run.sourceRevision ||
    !run.snapshot.loreContext ||
    !currentDependencies(store, run.snapshot)
  )
    return false;
  try {
    const original = store.sourceOriginal(run.sourceRevision),
      current = store.source(run.sourceRevision);
    return (
      original.chatId === run.chatId &&
      original.runId === run.id &&
      original.hash === current.hash &&
      run.snapshot.loreContext.canonHash ===
        store.story.notes.canonHash(store.story.notes.scope(run.chatId, run.parentRevision))
    );
  } catch {
    return false;
  }
}
/** Recompute each successful main read against its immutable source corpus; metadata search is never a receipt. */
export function verifiedRunLoreReads(store: Store, run: Run): RetainedLore[] {
  if (!loreRunIsCurrent(store, run)) return [];
  const source = store.sourceOriginal(run.sourceRevision!),
    resources = roleResources(run.snapshot),
    result: RetainedLore[] = [];
  if (run.snapshot.forkedLoreReads) {
    const receipt = run.snapshot.forkedLoreReads;
    if (
      receipt.canonHash === run.snapshot.loreContext!.canonHash &&
      isDeepStrictEqual(receipt.dependencies, loreDependencies(run.snapshot))
    )
      result.push(...structuredClone(receipt.entries));
  }
  for (const event of run.toolEvents) {
    if (event.denied || event.name !== 'knowledge.read') continue;
    try {
      const actual = executeTool(run.snapshot, {
        callId: event.callId,
        name: event.name,
        args: event.args,
      });
      if (!isDeepStrictEqual(actual, event)) continue;
      const data = actual.result as {
        source: { id: string; revision: number; hash: string };
        range: { start: number; end: number };
        text: string;
      };
      const resource = resources.find((r) => r.id === data.source.id);
      if (!resource || !data.text || data.range.end <= data.range.start) continue;
      result.push({
        id: data.source.id,
        revision: data.source.revision,
        hash: data.source.hash,
        title: resource.title,
        start: data.range.start,
        end: data.range.end,
        text: data.text,
        origin: {
          sourceRevision: source.id,
          sourceHash: source.hash,
          runId: run.id,
          callId: event.callId,
        },
        lastUsed: source.id,
      });
    } catch {
      /* Invalid or failed events carry no retention authority. */
    }
  }
  return result;
}
function allowedEntry(
  entry: RetainedLore,
  resources: Map<string, Resource>,
  dependencies: LoreDependency[]
): boolean {
  const resource = resources.get(entry.id);
  return (
    !!resource &&
    resource.kind === 'lore' &&
    resource.revision === entry.revision &&
    hash(resource.text) === entry.hash &&
    Number.isSafeInteger(entry.start) &&
    Number.isSafeInteger(entry.end) &&
    entry.start >= 0 &&
    entry.end > entry.start &&
    entry.end <= resource.text.length &&
    resource.text.slice(entry.start, entry.end) === entry.text &&
    dependencies.some(
      (d) =>
        d.sourceRevision === entry.origin.sourceRevision && d.sourceHash === entry.origin.sourceHash
    )
  );
}
/** Pure transition shared by runtime selection and historical archive validation. */
export function selectLoreContext(
  snapshot: RunSnapshot,
  input: {
    canonHash: string;
    parent?: LoreContextSnapshot;
    parentEligible: boolean;
    parentReads: RetainedLore[];
  }
): RunSnapshot {
  const policy = validateLoreContextPolicy(snapshot.profile?.loreContext),
    dependencies = loreDependencies(snapshot);
  const canonHash = input.canonHash;
  const reasons: string[] = [];
  let previous: RetainedLore[] = [],
    reads: RetainedLore[] = [],
    droppedEntries = 0;
  if (input.parent) {
    const old = input.parent;
    if (input.parentEligible && old.canonHash === canonHash) {
      previous = structuredClone(old.entries);
      reads = input.parentReads;
    } else if (old) {
      droppedEntries += old.entries.length;
      reasons.push('source-or-canon-changed');
    }
  }
  if (!policy.enabled || snapshot.loreContextReset) {
    droppedEntries += appendLoreReads(
      previous,
      reads,
      {
        ...policy,
        maxRetainedChars: Number.MAX_SAFE_INTEGER,
        maxRetainedEntries: Number.MAX_SAFE_INTEGER,
      },
      dependencies.map((d) => d.sourceRevision)
    ).entries.length;
    previous = [];
    reads = [];
    reasons.push(!policy.enabled ? 'disabled' : 'new-scene');
  }
  const resources = new Map(roleResources(snapshot).map((r) => [r.id, r]));
  const pinned = new Set((buildMainInput(snapshot).pinnedSources ?? []).map((r) => r.id));
  const permitted = (entries: RetainedLore[]) =>
    entries.filter((entry) => {
      const allowed = !pinned.has(entry.id) && allowedEntry(entry, resources, dependencies);
      if (!allowed) {
        droppedEntries++;
        reasons.push(
          pinned.has(entry.id) ? 'provided-as-pinned' : 'resource-scope-or-revision-changed'
        );
      }
      return allowed;
    });
  const selected = appendLoreReads(
    permitted(previous),
    permitted(reads),
    policy,
    dependencies.map((d) => d.sourceRevision)
  );
  if (selected.droppedEntries) reasons.push('retention-budget');
  return {
    ...snapshot,
    loreContext: {
      version: 1,
      policy,
      canonHash,
      dependencies,
      entries: selected.entries,
      stats: {
        retainedChars: selected.retainedChars,
        retainedEntries: selected.entries.length,
        appendedChars: selected.appendedChars,
        droppedEntries: droppedEntries + selected.droppedEntries,
        reasons: [...new Set(reasons)],
      },
    },
  };
}

/** Read-only selection. The host freezes the returned context in the Run transaction. */
export function freezeLoreContext(store: Store, snapshot: RunSnapshot): RunSnapshot {
  const canonHash = store.story.notes.canonHash(
    store.story.notes.scope(snapshot.chatId, snapshot.parentRevision)
  );
  const parent = snapshot.parentRevision
    ? store.run(store.source(snapshot.parentRevision).runId)
    : undefined;
  const parentEligible = !!parent && loreRunIsCurrent(store, parent);
  return selectLoreContext(snapshot, {
    canonHash,
    parent: parent?.snapshot.loreContext,
    parentEligible,
    parentReads: parentEligible ? verifiedRunLoreReads(store, parent!) : [],
  });
}
