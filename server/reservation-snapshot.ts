import type { RunSnapshot } from '../core/types.js';
import { isSourceOnlyTranscript, validateSourceOnlyTranscript } from '../core/authored-history.js';
import type { Store } from './store.js';
import { ChatOptionsStore } from './chat-options.js';
import { freezeChatOverrides } from './chat-overrides.js';
import { freezeOutline } from './outline-store.js';
import { freezeLoreContext } from './lore-context.js';
import { captureLogicalHistory, compileSnapshotPrompt } from './prompt-snapshot.js';
import { loreSelectionPending } from './lore-selection.js';
import { chatVariableProfile } from './chat-variable-context.js';
import { nativeRisuPending } from './risu-native-run.js';
import { nativeRisuPresetPending } from './risu-native-preset.js';

export type ReservationPurpose =
  | {
      purpose: 'run' | 'authored';
      runId: string;
      sceneCommandId?: string;
      supersedesRunId?: string;
    }
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
    return nativeRisuPending(base) || nativeRisuPresetPending(base) || loreSelectionPending(base)
      ? base
      : compileSnapshotPrompt(freezeLoreContext(store, base));

  const reserved = options.purpose === 'run' || options.purpose === 'authored';
  const authored = options.purpose === 'authored';
  const helper = options.purpose === 'helper-artifact' || options.purpose === 'helper-context';
  const translationPreview = options.purpose === 'preview-translation';
  if (
    reserved &&
    authored !==
      (base.packageStart?.mode === 'authored' ||
        base.transcriptImport !== undefined ||
        base.nativeRisuAuthored !== undefined)
  )
    throw new Error('RESERVATION_AUTHORSHIP_MISMATCH');

  // A native card action already executed in an isolated worker. Adopting its authored
  // messages must not execute the card again or prepare a story-model request.
  if (base.nativeRisuAuthored) return base;

  if (authored && isSourceOnlyTranscript(base)) {
    validateSourceOnlyTranscript(base);
    return base;
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
  }
  if (base.profile && !translationPreview) {
    const branchId = base.branchId ?? store.product.branch(base.chatId).id;
    base = { ...base, profile: chatVariableProfile(store, base.chatId, branchId, base.profile) };
    if ((reserved || base.profile?.variableState) && base.profile?.packageAttachments?.length)
      base.resources = [
        ...base.resources.filter((resource) => !resource.id.startsWith('package:')),
        ...store.product
          .resources(base.chatId, base.profile)
          .filter((resource) => resource.id.startsWith('package:')),
      ];
  }

  let frozen = base;
  if (!authored) frozen = store.story.prepareRunInTransaction(frozen);
  if (reserved && options.sceneCommandId)
    frozen = freezeOutline(store, options.sceneCommandId, frozen);
  frozen = { ...frozen, logicalHistory: captureLogicalHistory(store, frozen) };
  const previousNative = frozen.history.at(-1);
  if (previousNative) {
    const previous = store.run(store.source(previousNative.revision).runId).snapshot;
    const revision =
      previous.nativeRisuExecution?.historyRevision ?? previous.nativeRisuHistoryRevision;
    if (revision) frozen.nativeRisuHistoryRevision = revision;
  }
  if (options.purpose === 'preview-main' || options.purpose === 'preview-translation')
    frozen = { ...frozen, executionClock: options.executionClock() };
  // The model selection needs a provider call, which a reservation transaction must not make, so a
  // snapshot that still owes one reserves uncompiled and the worker compiles after the answer lands.
  if (
    options.purpose === 'run' &&
    (nativeRisuPending(frozen) || nativeRisuPresetPending(frozen) || loreSelectionPending(frozen))
  ) {
    const { contextBase } = store.context.prepareRun(frozen);
    return { ...frozen, contextBase };
  }
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
