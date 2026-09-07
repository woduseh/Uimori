import { freezeSourceSegments } from '../core/package-source-segments.js';
import { isDeepStrictEqual } from 'node:util';
import { validateProviderPrompt } from '../core/prompt-program.js';
import type { RunSnapshot } from '../core/types.js';
import { candidateCompilationSnapshot, validateContextPlan } from './context-planning.js';
import { captureLogicalHistory, compileSnapshotPrompt } from './prompt-snapshot.js';
import { HttpError, type Store } from './store.js';

const reject = (message: string): never => {
  throw new HttpError(400, `Invalid snapshot archive: ${message}`);
};

/** Check frozen history and compiled requests for every archived Run. */
export function validateRunSnapshot(store: Store, snapshot: RunSnapshot, runId?: string): void {
  const compilationSnapshot = candidateCompilationSnapshot(store, snapshot, runId);
  if (!isDeepStrictEqual(snapshot.sourceSegments, freezeSourceSegments(snapshot.profile)))
    reject('source segment policy mismatch');
  for (const item of snapshot.history) {
    const source = item.contentHash
      ? store.sourceAtHash(item.revision, item.contentHash)
      : store.sourceOriginal(item.revision);
    if (!isDeepStrictEqual(item.sourceSegments, store.run(source.runId).snapshot.sourceSegments))
      reject('history source segment policy mismatch');
  }
  validateContextPlan(snapshot);
  if (
    snapshot.logicalHistory !== undefined &&
    !isDeepStrictEqual(snapshot.logicalHistory, captureLogicalHistory(store, snapshot))
  )
    reject('logical history mismatch');
  if (snapshot.promptCompilation) {
    const p = snapshot.promptCompilation;
    validateProviderPrompt({
      compilerVersion: p.compilerVersion,
      messages: p.messages,
      cachePlan: p.cachePlan,
      values: p.values,
    });
    const expected = compileSnapshotPrompt({
      ...compilationSnapshot,
      promptCompilation: undefined,
    });
    if (!isDeepStrictEqual(expected.promptCompilation, p)) reject('compiled prompt mismatch');
  } else if (
    !snapshot.story?.waiting &&
    !['pending', 'failed'].includes(snapshot.contextPlan?.status ?? '')
  )
    reject('compiled prompt missing');
}

/** Remap identities only; source text, role order and provenance hashes stay fixed. */
export function mapForkSnapshot(
  snapshot: RunSnapshot,
  sources: Map<string, string>,
  runs: Map<string, string>
): void {
  const source = (id: string | undefined) =>
    id ? (sources.get(id) ?? reject('fork source dependency')) : undefined;
  const run = (id: string | undefined) =>
    id ? (runs.get(id) ?? reject('fork run dependency')) : undefined;
  if (snapshot.logicalHistory)
    snapshot.logicalHistory = snapshot.logicalHistory.map((item) => ({
      ...item,
      id: item.sourceRevision
        ? `${item.role === 'user' ? 'request' : 'source'}:${source(item.sourceRevision)}`
        : item.id,
      ...(item.sourceRevision ? { sourceRevision: source(item.sourceRevision) } : {}),
      ...(item.runId ? { runId: run(item.runId) } : {}),
    }));
  if (snapshot.contextPlan) {
    snapshot.contextPlan.compacted = snapshot.contextPlan.compacted.map((ref) => ({
      ...ref,
      revision: source(ref.revision)!,
    }));
    snapshot.contextPlan.recentSourceRevisions = snapshot.contextPlan.recentSourceRevisions.map(
      (id) => source(id)!
    );
  }
  if (snapshot.promptCompilation) {
    const ids = new Map<string, string>();
    for (const message of snapshot.promptCompilation.messages) {
      if (message.provenance.origin !== 'history' || !message.provenance.sourceRevision) continue;
      const p = message.provenance;
      const mapped = source(p.sourceRevision);
      const id = `${p.blockId}:${message.role === 'user' ? 'request' : 'source'}:${mapped}`;
      ids.set(message.id, id);
      message.id = id;
      p.sourceRevision = mapped;
      if (p.runId) p.runId = run(p.runId);
    }
    for (const anchor of snapshot.promptCompilation.cachePlan)
      anchor.afterMessageId = ids.get(anchor.afterMessageId) ?? anchor.afterMessageId;
    for (const trace of snapshot.promptCompilation.trace)
      trace.messageIds = trace.messageIds.map((id) => ids.get(id) ?? id);
  }
}
