import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  validateLoreContextPolicy,
  type LoreDependency,
  type RetainedLore,
} from '../core/lore-context.js';
import { buildMainInput, executeTool, roleResources } from '../core/provider.js';
import type { Resource, Run, RunSnapshot } from '../core/types.js';
import { loreDependencies, selectLoreContext } from './lore-context.js';
import { HttpError, type Store } from './store.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const reject = (reason: string): never => {
  throw new HttpError(400, `Invalid lore context archive: ${reason}`);
};
const object = (value: unknown, keys: string[], name: string): Record<string, any> => {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    reject(name);
  return value as Record<string, any>;
};
const identifier = (value: unknown) =>
  typeof value === 'string' && value.length > 0 && value.length <= 200;
const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);

function entryShape(value: unknown, resources: readonly Resource[]): RetainedLore {
  const entry = object(
    value,
    ['id', 'revision', 'hash', 'title', 'start', 'end', 'text', 'origin', 'lastUsed'],
    'entry fields'
  );
  const origin = object(
    entry.origin,
    ['sourceRevision', 'sourceHash', 'runId', 'callId'],
    'origin fields'
  );
  if (
    !identifier(entry.id) ||
    !identifier(origin.sourceRevision) ||
    !identifier(origin.runId) ||
    !identifier(origin.callId) ||
    !identifier(entry.lastUsed) ||
    !digest(entry.hash) ||
    !digest(origin.sourceHash) ||
    typeof entry.title !== 'string' ||
    typeof entry.text !== 'string'
  )
    reject('entry identity');
  const resource = resources.find((item) => item.id === entry.id && item.kind === 'lore');
  if (
    !resource ||
    entry.revision !== resource.revision ||
    entry.hash !== hash(resource.text) ||
    !Number.isSafeInteger(entry.start) ||
    !Number.isSafeInteger(entry.end) ||
    entry.start < 0 ||
    entry.end <= entry.start ||
    entry.end > resource.text.length ||
    entry.text !== resource.text.slice(entry.start, entry.end)
  )
    reject('entry resource or range');
  return entry as RetainedLore;
}

/** Historical validation deliberately uses sourceOriginal, never current edited text or current retcons. */
function sourceRun(store: Store, run: Run) {
  if (run.status !== 'completed' || !run.sourceRevision)
    return reject('read without completed source');
  const source = store.sourceOriginal(run.sourceRevision);
  if (
    source.chatId !== run.chatId ||
    source.runId !== run.id ||
    source.parentRevision !== run.parentRevision
  )
    reject('read source identity');
  return source;
}

function forkReads(store: Store, snapshot: RunSnapshot): RetainedLore[] {
  if (!snapshot.forkedLoreReads) return [];
  const receipt = object(
    snapshot.forkedLoreReads,
    ['version', 'canonHash', 'dependencies', 'entries'],
    'fork receipt fields'
  );
  if (
    !snapshot.forkedFrom ||
    !snapshot.loreContext ||
    receipt.version !== 1 ||
    receipt.canonHash !== snapshot.loreContext.canonHash ||
    !isDeepStrictEqual(receipt.dependencies, loreDependencies(snapshot)) ||
    !Array.isArray(receipt.entries)
  )
    reject('fork receipt scope');
  const resources = roleResources(snapshot);
  return receipt.entries.map((value: unknown) => {
    const entry = entryShape(value, resources),
      run = store.run(entry.origin.runId),
      source = sourceRun(store, run);
    if (
      !isDeepStrictEqual(run.snapshot, snapshot) ||
      source.id !== entry.origin.sourceRevision ||
      source.hash !== entry.origin.sourceHash ||
      entry.lastUsed !== source.id ||
      resources.find((item) => item.id === entry.id)?.title !== entry.title ||
      entry.end - entry.start > 16384
    )
      reject('fork receipt origin');
    return entry;
  });
}

export function historicalRunLoreReads(store: Store, run: Run): RetainedLore[] {
  const source = sourceRun(store, run),
    result = forkReads(store, run.snapshot),
    resources = roleResources(run.snapshot);
  for (const event of run.toolEvents) {
    if (event.denied || event.name !== 'knowledge.read') continue;
    try {
      const expected = executeTool(run.snapshot, {
        callId: event.callId,
        name: event.name,
        args: event.args,
      });
      if (!isDeepStrictEqual(expected, event)) continue;
      const data = expected.result as {
        source: { id: string; revision: number; hash: string };
        range: { start: number; end: number };
        text: string;
      };
      const resource = resources.find((item) => item.id === data.source.id);
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
      /* Malformed execution logs never confer read authority. */
    }
  }
  return result;
}

function readScope(run: Run, dependencies: LoreDependency[], canonHash: string): boolean {
  const index = dependencies.findIndex((item) => item.sourceRevision === run.sourceRevision);
  return (
    index >= 0 &&
    run.snapshot.loreContext?.canonHash === canonHash &&
    isDeepStrictEqual(loreDependencies(run.snapshot), dependencies.slice(0, index))
  );
}
const sameResource = (a: RetainedLore, b: RetainedLore) =>
  a.id === b.id && a.revision === b.revision && a.hash === b.hash;

/** Validate frozen provenance against stored reads without re-evaluating today's retention eligibility. */
export function validateArchivedLoreContext(store: Store, snapshot: RunSnapshot): void {
  if (snapshot.loreContextReset !== undefined && typeof snapshot.loreContextReset !== 'boolean')
    reject('reset flag');
  if (!snapshot.loreContext) {
    if (snapshot.forkedLoreReads) reject('fork receipt without context');
    return;
  }
  const context = object(
    snapshot.loreContext,
    ['version', 'policy', 'canonHash', 'dependencies', 'entries', 'stats'],
    'context fields'
  );
  if (
    context.version !== 1 ||
    !digest(context.canonHash) ||
    !isDeepStrictEqual(context.dependencies, loreDependencies(snapshot))
  )
    reject('context scope');
  const policy = validateLoreContextPolicy(context.policy);
  if (!isDeepStrictEqual(policy, validateLoreContextPolicy(snapshot.profile?.loreContext)))
    reject('frozen policy');
  if (
    !Array.isArray(context.entries) ||
    context.entries.length > policy.maxRetainedEntries ||
    ((!policy.enabled || snapshot.loreContextReset) && context.entries.length)
  )
    reject('entry count');
  const resources = roleResources(snapshot),
    pinned = new Set((buildMainInput(snapshot).pinnedSources ?? []).map((item) => item.id));
  const entries: RetainedLore[] = context.entries.map((value: unknown) =>
    entryShape(value, resources)
  );
  const reads = new Map<string, RetainedLore[]>();
  const fromRun = (run: Run) => {
    let result = reads.get(run.id);
    if (!result) {
      result = historicalRunLoreReads(store, run);
      reads.set(run.id, result);
    }
    return result;
  };
  const parentSource = snapshot.parentRevision
    ? store.sourceOriginal(snapshot.parentRevision)
    : undefined;
  const parent = parentSource ? store.run(parentSource.runId) : undefined;
  const parentEligible =
    !!parent &&
    parent.status === 'completed' &&
    parent.sourceRevision === parentSource!.id &&
    context.dependencies.at(-1)?.sourceHash === parentSource!.hash &&
    readScope(parent, context.dependencies, context.canonHash);
  const candidates = selectLoreContext(snapshot, {
    canonHash: context.canonHash,
    parent: parent?.snapshot.loreContext,
    parentEligible,
    parentReads: parentEligible ? fromRun(parent!) : [],
  }).loreContext!.entries;
  // Later whole-context budgeting may omit complete entries, but cannot recreate, split, reorder or refresh them.
  let nextCandidate = 0;
  for (const entry of entries) {
    const index = candidates.findIndex(
      (candidate, index) => index >= nextCandidate && isDeepStrictEqual(candidate, entry)
    );
    if (index < 0) reject('retained entry outside immediate parent transition');
    nextCandidate = index + 1;
  }
  for (const [index, entry] of entries.entries()) {
    const origin = store.run(entry.origin.runId),
      source = sourceRun(store, origin);
    if (
      source.chatId !== snapshot.chatId ||
      source.id !== entry.origin.sourceRevision ||
      source.hash !== entry.origin.sourceHash ||
      !context.dependencies.some(
        (item: LoreDependency) =>
          item.sourceRevision === source.id && item.sourceHash === source.hash
      ) ||
      !readScope(origin, context.dependencies, context.canonHash) ||
      pinned.has(entry.id)
    )
      reject('retained origin scope');
    if (
      !fromRun(origin).some(
        (read) =>
          sameResource(read, entry) &&
          isDeepStrictEqual(read.origin, entry.origin) &&
          read.title === entry.title &&
          read.start <= entry.start &&
          read.end >= entry.end &&
          entry.text === read.text.slice(entry.start - read.start, entry.end - read.start)
      )
    )
      reject('retained range was not read');
    if (
      entries
        .slice(0, index)
        .some(
          (prior) =>
            sameResource(prior, entry) && prior.start < entry.end && prior.end > entry.start
        )
    )
      reject('overlapping retained ranges');
    const usedIndex = context.dependencies.findIndex(
        (item: LoreDependency) => item.sourceRevision === entry.lastUsed
      ),
      originIndex = context.dependencies.findIndex(
        (item: LoreDependency) => item.sourceRevision === source.id
      );
    if (usedIndex < originIndex) reject('last use ancestry');
    if (entry.lastUsed !== source.id) {
      const usedSource = store.sourceOriginal(entry.lastUsed),
        used = store.run(usedSource.runId);
      if (context.dependencies[usedIndex].sourceHash !== usedSource.hash)
        reject('last use source hash');
      if (
        !readScope(used, context.dependencies, context.canonHash) ||
        !fromRun(used).some(
          (read) => sameResource(read, entry) && read.start < entry.end && read.end > entry.start
        )
      )
        reject('last use was not read');
    }
  }
  forkReads(store, snapshot);
  const stats = object(
    context.stats,
    ['retainedChars', 'retainedEntries', 'appendedChars', 'droppedEntries', 'reasons'],
    'stats fields'
  );
  const chars = entries.reduce((sum, entry) => sum + entry.text.length, 0);
  if (
    chars > policy.maxRetainedChars ||
    stats.retainedChars !== chars ||
    stats.retainedEntries !== entries.length ||
    !Number.isSafeInteger(stats.appendedChars) ||
    stats.appendedChars < 0 ||
    !Number.isSafeInteger(stats.droppedEntries) ||
    stats.droppedEntries < 0 ||
    !Array.isArray(stats.reasons) ||
    stats.reasons.some((reason) => typeof reason !== 'string')
  )
    reject('stats or budget');
}
