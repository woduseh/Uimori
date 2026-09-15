import { archiveRejector, type ArchiveReject } from './request-validation.js';
import { freezeSourceSegments } from '../core/package-source-segments.js';
import { isDeepStrictEqual } from 'node:util';
import { validateProviderPrompt } from '../core/prompt-program.js';
import type { RunSnapshot } from '../core/types.js';
import { candidateCompilationSnapshot, validateContextPlan } from './context-planning.js';
import { captureLogicalHistory, compileSnapshotPrompt } from './prompt-snapshot.js';
import type { Store } from './store.js';
import { mapForkChatOverrideSnapshot } from './chat-overrides.js';
import { mapForkChatOptionSnapshot } from './chat-options.js';
import { sealOutlineSnapshot } from '../core/outline.js';
import { isSourceOnlyTranscript, validateSourceOnlyTranscript } from '../core/authored-history.js';
import { preparedBehaviorSnapshot } from './package-behavior-run.js';
import { hasPromptInputTransforms, validatePromptInputTransforms } from './prompt-transforms.js';
import { risuCompatInputHash, risuCompatTargets } from './compat/risu/cbs.js';
import { risuCompatKey, validateRisuCompatReceipt } from '../core/risu-compat.js';
import { loreActivationInputHash, loreActivationTargets } from './compat/risu/lore-activation.js';
import {
  loreActivationKey,
  loreActivationLore,
  validateLoreActivationReceipt,
} from '../core/lore-activation.js';
import {
  loreSelectionKey,
  loreSelectionLore,
  validateLoreSelectionReceipt,
} from '../core/lore-selection.js';
import {
  loreSelectionInputHash,
  loreSelectionPending,
  loreSelectionTargets,
} from './lore-selection.js';
import { resolveExtensionConversation } from './extension-conversation.js';

const reject: ArchiveReject = archiveRejector('Invalid snapshot archive');

/**
 * Bind the frozen evaluation to the reserved inputs without running a single CBS token again: every
 * entry must name a declared field of an attached package and carry the input hash this snapshot
 * still produces. The evaluated text itself is bound by the prompt it compiled.
 */
function validateRisuCompat(store: Store, snapshot: RunSnapshot, runId?: string): void {
  const receipt = snapshot.risuCompat;
  // The input hash covers content only, so the run id it is recomputed under does not matter.
  const targets = risuCompatTargets(snapshot, runId ?? '');
  if (!receipt) {
    if (targets.length && runId && store.run(runId).inputs.length)
      reject('risu compat receipt missing');
    return;
  }
  try {
    validateRisuCompatReceipt(receipt);
  } catch {
    reject('risu compat receipt mismatch');
  }
  const expected = new Map(
    targets.map(({ context, field }) => [
      risuCompatKey(context.attachment, field.fieldId),
      risuCompatInputHash(context, field),
    ])
  );
  if (receipt.entries.length !== expected.size) reject('risu compat receipt mismatch');
  for (const entry of receipt.entries)
    if (expected.get(entry.key) !== entry.inputHash) reject('risu compat receipt mismatch');
}

/**
 * Bind the frozen keyword scan to the reserved inputs without scanning again: every entry must name an
 * attached keyword-mode package, carry the input hash this snapshot still produces, and decide only
 * lore that package actually offers for scanning. Which entries the decision pinned is bound by the
 * prompt it compiled.
 */
function validateLoreActivation(store: Store, snapshot: RunSnapshot, runId?: string): void {
  const receipt = snapshot.loreActivation;
  // The input hash covers content only, so the run id it is recomputed under does not matter.
  const targets = loreActivationTargets(snapshot, runId ?? '');
  if (!receipt) {
    if (targets.length && runId && store.run(runId).inputs.length)
      reject('lore activation receipt missing');
    return;
  }
  try {
    validateLoreActivationReceipt(receipt);
  } catch {
    reject('lore activation receipt mismatch');
  }
  const expected = new Map(
    targets.map((context) => [
      loreActivationKey(context.attachment),
      {
        inputHash: loreActivationInputHash(context),
        lore: new Set(loreActivationLore(context.package).map((item) => item.id)),
      },
    ])
  );
  if (receipt.entries.length !== expected.size) reject('lore activation receipt mismatch');
  for (const entry of receipt.entries) {
    const target = expected.get(entry.key);
    if (!target || target.inputHash !== entry.inputHash) reject('lore activation receipt mismatch');
    for (const id of [...entry.activated, ...entry.omitted.map((item) => item.id)])
      if (!target!.lore.has(id)) reject('lore activation receipt mismatch');
  }
}

/**
 * Bind the frozen model selection to the reserved inputs without asking a model again: the answer is
 * not reproducible, so only its inputs are recomputed. Every entry must name an attached model-mode
 * package, carry the input hash this snapshot still produces, and select or budget-omit only lore
 * that package offers. `unknown` omissions are exempt by definition - they record ids the answer
 * invented - and they decide nothing, because only `selected` reaches compilation.
 */
function validateLoreSelection(store: Store, snapshot: RunSnapshot, runId?: string): void {
  const receipt = snapshot.loreSelection;
  const targets = loreSelectionTargets(snapshot);
  if (!receipt) {
    if (targets.length && runId && store.run(runId).inputs.length)
      reject('lore selection receipt missing');
    return;
  }
  try {
    validateLoreSelectionReceipt(receipt);
  } catch {
    reject('lore selection receipt mismatch');
  }
  const expected = new Map(
    targets.map((target) => [
      loreSelectionKey(target.attachment),
      {
        inputHash: loreSelectionInputHash(target),
        lore: new Set(loreSelectionLore(target.package).map((item) => item.id)),
      },
    ])
  );
  if (receipt.entries.length !== expected.size) reject('lore selection receipt mismatch');
  for (const entry of receipt.entries) {
    const target = expected.get(entry.key);
    if (!target || target.inputHash !== entry.inputHash) reject('lore selection receipt mismatch');
    const decided = [
      ...entry.selected,
      ...entry.omitted.filter((item) => item.reason === 'budget').map((item) => item.id),
    ];
    for (const id of decided)
      if (!target!.lore.has(id)) reject('lore selection decided an unknown lore');
  }
}

function behaviorExecutionProjection(
  store: Store,
  snapshot: RunSnapshot,
  runId?: string
): RunSnapshot {
  if (!runId) return snapshot;
  try {
    return preparedBehaviorSnapshot(store, runId, snapshot);
  } catch (error) {
    return reject(
      `behavior preparation projection (${error instanceof Error ? error.message : 'invalid'})`
    );
  }
}

/** Check frozen history and compiled requests for every archived Run. */
export function validateRunSnapshot(
  store: Store,
  snapshot: RunSnapshot,
  runId?: string
): RunSnapshot {
  if (snapshot.extensionConversation !== undefined) {
    try {
      if (runId && snapshot.extensionConversation.admissionRunId !== runId)
        reject('conversation admission owner');
      resolveExtensionConversation(store, snapshot, snapshot.extensionConversation);
    } catch {
      reject('conversation reference mismatch');
    }
  }
  if (isSourceOnlyTranscript(snapshot)) {
    validateSourceOnlyTranscript(snapshot);
    if (!isDeepStrictEqual(snapshot.sourceSegments, freezeSourceSegments(snapshot.profile)))
      reject('source segment policy mismatch');
    if (runId) {
      const run = store.run(runId);
      if (
        run.status !== 'completed' ||
        run.usage.modelCalls !== 0 ||
        run.inputs.length ||
        run.toolEvents.length
      )
        reject('imported source has model execution');
    }
    return snapshot;
  }
  // The receipt froze on the reserved snapshot, before any behavior projection reached the profile,
  // so it is checked against the stored reservation rather than the execution view.
  validateRisuCompat(store, snapshot, runId);
  validateLoreActivation(store, snapshot, runId);
  validateLoreSelection(store, snapshot, runId);
  const executionSnapshot = behaviorExecutionProjection(store, snapshot, runId);
  try {
    validatePromptInputTransforms(executionSnapshot);
  } catch {
    reject('prompt input transform receipt mismatch');
  }
  if (
    hasPromptInputTransforms(executionSnapshot) &&
    !executionSnapshot.promptInputTransforms &&
    runId &&
    store.run(runId).inputs.length
  )
    reject('prompt input transform receipt missing');
  const candidateSnapshot = candidateCompilationSnapshot(store, snapshot, runId);
  // Deferred behavior stays immutable in the archived Run snapshot. Once an input was recorded,
  // its execution receipt owns the state/results projected into that compiled model input. A
  // terminal Run without a recorded main input may retain either deterministic compilation.
  const preparedCompilationSnapshot =
    candidateSnapshot === snapshot
      ? executionSnapshot
      : behaviorExecutionProjection(store, candidateSnapshot, runId);
  const compilationCandidates =
    runId &&
    snapshot.behaviorExecution?.deferredAutomatic === true &&
    !store.run(runId).inputs.length
      ? [
          { compilation: preparedCompilationSnapshot, execution: executionSnapshot },
          { compilation: candidateSnapshot, execution: snapshot },
        ]
      : [{ compilation: preparedCompilationSnapshot, execution: executionSnapshot }];
  let validatedExecutionSnapshot = executionSnapshot;
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
    const matched = compilationCandidates.find(({ compilation }) => {
      const expected = compileSnapshotPrompt(
        { ...compilation, promptCompilation: undefined },
        undefined,
        undefined,
        { compilerVersion: p.compilerVersion }
      );
      return isDeepStrictEqual(expected.promptCompilation, p);
    });
    if (!matched) return reject('compiled prompt mismatch');
    validatedExecutionSnapshot = matched.execution;
  } else if (
    !snapshot.story?.waiting &&
    snapshot.behaviorExecution?.deferredAutomatic !== true &&
    !(
      hasPromptInputTransforms(snapshot) &&
      !snapshot.promptInputTransforms &&
      (!runId || !store.run(runId).inputs.length)
    ) &&
    // A snapshot still owing the selection call reserved uncompiled on purpose.
    !loreSelectionPending(snapshot) &&
    !['pending', 'failed'].includes(snapshot.contextPlan?.status ?? '')
  )
    reject('compiled prompt missing');
  return validatedExecutionSnapshot;
}

/** Remap identities only; source text, role order and provenance hashes stay fixed. */
export function mapForkSnapshot(
  snapshot: RunSnapshot,
  sources: Map<string, string>,
  runs: Map<string, string>
): void {
  mapForkChatOverrideSnapshot(snapshot.profile, snapshot.chatId, sources);
  mapForkChatOptionSnapshot(snapshot.profile, snapshot.chatId);
  const source = (id: string | undefined) =>
    id ? (sources.get(id) ?? reject('fork source dependency')) : undefined;
  const run = (id: string | undefined) =>
    id ? (runs.get(id) ?? reject('fork run dependency')) : undefined;
  if (snapshot.extensionConversation) {
    const captured = snapshot.extensionConversation;
    if (!snapshot.branchId) reject('fork conversation branch');
    snapshot.extensionConversation = {
      ...captured,
      chatId: snapshot.chatId,
      branchId: snapshot.branchId!,
      parentRevision: snapshot.parentRevision,
      admissionRunId: captured.admissionRunId ? run(captured.admissionRunId)! : null,
      messages: captured.messages.map((ref) => ({
        ...ref,
        runId: run(ref.runId)!,
        ...(ref.kind === 'source' ? { sourceRevision: source(ref.sourceRevision)! } : {}),
      })),
    };
  }
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
  if (snapshot.outline)
    snapshot.outline = sealOutlineSnapshot({
      version: snapshot.outline.version,
      path: snapshot.outline.path,
      children: snapshot.outline.children,
      written: snapshot.outline.written.map((item) => ({
        ...item,
        sourceRevision: source(item.sourceRevision)!,
      })),
    });
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
