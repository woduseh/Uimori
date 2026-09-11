import type { RunSnapshot } from '../core/types.js';
import { isSourceOnlyTranscript, validateSourceOnlyTranscript } from '../core/authored-history.js';
import { freezeSourceSegments } from '../core/package-source-segments.js';
import type { Store } from './store.js';
import { ChatOptionsStore } from './chat-options.js';
import { freezeChatOverrides } from './chat-overrides.js';
import { freezeOutline } from './outline-store.js';
import { freezePackageStates } from './package-behavior-host.js';
import { prepareRunBehavior } from './package-behavior-run.js';
import { freezeLoreContext } from './lore-context.js';
import { captureLogicalHistory, compileSnapshotPrompt } from './prompt-snapshot.js';

export type ReservationPurpose =
  | { purpose: 'run' | 'authored'; runId: string; sceneCommandId?: string }
  | { purpose: 'helper-artifact' | 'helper-context' }
  | {
      purpose: 'preview-main' | 'preview-translation';
      executionClock: () => NonNullable<RunSnapshot['executionClock']>;
    }
  | { purpose: 'resume-state' };

/**
 * Synchronous reservation phases. Callers own profile/model selection, clock, CAS,
 * transactions and persistence. Run/authored callers must already own the transaction.
 * Helper callers freeze chat options before building their profile-derived resources.
 * Preview compilation and resumed-state dependency validation remain with their callers.
 */
export function freezeReservationSnapshot(
  store: Store,
  base: RunSnapshot,
  options: ReservationPurpose
): RunSnapshot {
  if (options.purpose === 'resume-state')
    return compileSnapshotPrompt(freezeLoreContext(store, base));

  const reserved = options.purpose === 'run' || options.purpose === 'authored';
  const authored = options.purpose === 'authored';
  const helper = options.purpose === 'helper-artifact' || options.purpose === 'helper-context';
  const translationPreview = options.purpose === 'preview-translation';
  if (
    reserved &&
    authored !== (base.packageStart?.mode === 'authored' || base.transcriptImport !== undefined)
  )
    throw new Error('RESERVATION_AUTHORSHIP_MISMATCH');

  if (authored && isSourceOnlyTranscript(base)) {
    validateSourceOnlyTranscript(base);
    const sourceSegments = freezeSourceSegments(base.profile);
    return { ...base, ...(sourceSegments ? { sourceSegments } : {}) };
  }

  if (reserved && base.profile) {
    new ChatOptionsStore(store).freeze(base.profile, base.branchId!, options.runId);
    const roots =
      base.profile.chatOverrides?.roots ??
      store.product.profile(base.chatId).packageAttachments ??
      [];
    const overrides = freezeChatOverrides(store, base.profile, roots, base.parentRevision);
    if (overrides) base.profile.chatOverrides = overrides;
    else delete base.profile.chatOverrides;
    if (base.profile.packageAttachments?.length)
      base.resources = [
        ...base.resources.filter((resource) => !resource.id.startsWith('package:')),
        ...store.product
          .resources(base.chatId, base.profile)
          .filter((resource) => resource.id.startsWith('package:')),
      ];
  }

  let frozen = base;
  if (!translationPreview) {
    const sourceSegments = freezeSourceSegments(base.profile);
    // Preserve the persisted Run shape and the explicit optional field on read-only snapshots.
    frozen = reserved
      ? { ...base, ...(sourceSegments ? { sourceSegments } : {}) }
      : { ...base, sourceSegments };
  }
  if (!authored) frozen = store.story.prepareRunInTransaction(frozen);
  if (reserved && options.sceneCommandId)
    frozen = freezeOutline(store, options.sceneCommandId, frozen);
  frozen = { ...frozen, logicalHistory: captureLogicalHistory(store, frozen) };
  if (options.purpose === 'preview-main' || options.purpose === 'preview-translation')
    frozen = { ...frozen, executionClock: options.executionClock() };
  frozen = freezePackageStates(store, frozen, reserved);
  if (options.purpose === 'run') frozen = prepareRunBehavior(store, options.runId, frozen);
  if (!translationPreview) frozen = freezeLoreContext(store, frozen);

  if (helper) {
    const prepared = store.context.prepareRun(frozen);
    const previous = store.context.previous(prepared);
    if (previous && prepared.contextPlan)
      prepared.contextPlan = {
        ...prepared.contextPlan,
        compacted: previous.compacted,
        summary: previous.summary,
        recentSourceRevisions: prepared.history
          .slice(previous.compacted.length)
          .map((source) => source.revision),
      };
    return prepared;
  }
  return reserved
    ? compileSnapshotPrompt(authored ? frozen : store.context.prepareRun(frozen))
    : frozen;
}
