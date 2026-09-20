import { archiveRejector, type ArchiveReject } from './request-validation.js';
import { isDeepStrictEqual } from 'node:util';
import { validateProviderPrompt } from '../core/risu-prompt.js';
import { validateLoreContextPolicy } from '../core/lore-context.js';
import type { RunSnapshot } from '../core/types.js';
import { candidateCompilationSnapshot, validateContextPlan } from './context-planning.js';
import { captureLogicalHistory, compileSnapshotPrompt } from './prompt-snapshot.js';
import type { Store } from './store.js';
import { mapForkChatOverrideSnapshot } from './chat-overrides.js';
import { mapForkChatOptionSnapshot } from './chat-options.js';
import { sealOutlineSnapshot } from '../core/outline.js';
import { isSourceOnlyTranscript, validateSourceOnlyTranscript } from '../core/authored-history.js';
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
import { validateNativeRisuExecution, nativeRisuPending } from './risu-native-run.js';
import { mapNativeMessageId, remapNativeRisuSnapshot } from './risu-native-archive.js';
import { validateMainJudgmentInput } from './main-judgment.js';
import { mainJudgmentThreshold } from '../core/main-judgment-settings.js';

const reject: ArchiveReject = archiveRejector('Invalid snapshot archive');

/**
 * Bind the frozen model selection to the reserved inputs without asking a model again: the answer is
 * not reproducible, so only its inputs are recomputed. Every entry must name an attached model-mode
 * package, carry the input hash this snapshot still produces, and select or budget-omit only lore
 * that package offers. Only scored known IDs may reach compilation.
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
    const decided = [...entry.selected, ...entry.omitted.map((item) => item.id)];
    for (const id of decided)
      if (!target!.lore.has(id)) reject('lore selection decided an unknown lore');
    if (entry.judgment) {
      const policy = validateLoreContextPolicy(snapshot.profile?.loreContext).judgment;
      if (
        !policy ||
        entry.judgment.threshold !== policy.threshold ||
        entry.judgment.maxSelectedTokens !== policy.maxSelectedTokens
      )
        reject('lore judgment policy mismatch');
      const scores = new Map(entry.judgment.scores.map((score) => [score.id, score.probability]));
      if (
        entry.judgment.scores.some((score) => !target!.lore.has(score.id)) ||
        entry.selected.some((id) => (scores.get(id) ?? -1) < policy!.threshold)
      )
        reject('lore judgment selection mismatch');
    }
  }
}

/** Check frozen history and compiled requests for every archived Run. */
export function validateRunSnapshot(
  store: Store,
  snapshot: RunSnapshot,
  runId?: string
): RunSnapshot {
  if (
    snapshot.judgmentRecovery !== undefined &&
    (snapshot.judgmentRecovery !== true || !snapshot.candidateOf || !snapshot.mainJudgment)
  )
    reject('invalid judgment recovery');
  if (snapshot.mainJudgmentThreshold !== undefined)
    mainJudgmentThreshold(snapshot.mainJudgmentThreshold);
  if (
    snapshot.mainJudgment &&
    snapshot.mainJudgment.threshold !== mainJudgmentThreshold(snapshot.mainJudgmentThreshold)
  )
    reject('main judgment threshold mismatch');
  if (
    snapshot.mainJudgmentEnabled !== undefined &&
    typeof snapshot.mainJudgmentEnabled !== 'boolean'
  )
    reject('invalid main judgment enabled flag');
  if (snapshot.mainJudgment !== undefined) validateMainJudgmentInput(snapshot.mainJudgment);
  if (snapshot.nativeRisuAuthored) {
    const authored = snapshot.nativeRisuAuthored;
    if (
      authored.version !== 1 ||
      typeof authored.action !== 'string' ||
      !Array.isArray(authored.messages) ||
      authored.messages.some(
        (message) =>
          !['user', 'char'].includes(message.role) ||
          typeof message.data !== 'string' ||
          message.data.length > 2_000_000
      ) ||
      authored.messages.filter((message) => message.role === 'char').length > 1 ||
      snapshot.promptCompilation
    )
      reject('native authored message mismatch');
    if (runId) {
      const run = store.run(runId);
      if (run.inputs.length || run.toolEvents.length) reject('native action has story model input');
      if (
        run.sourceRevision &&
        store.sourceOriginal(run.sourceRevision).text !==
          (authored.messages.find((message) => message.role === 'char')?.data ?? '')
      )
        reject('native authored source mismatch');
    }
    return snapshot;
  }
  if (isSourceOnlyTranscript(snapshot)) {
    validateSourceOnlyTranscript(snapshot);
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
  validateNativeRisuExecution(snapshot);
  if (nativeRisuPending(snapshot) && runId && store.run(runId).inputs.length)
    reject('native execution receipt missing');
  validateLoreSelection(store, snapshot, runId);
  const candidateSnapshot = candidateCompilationSnapshot(store, snapshot, runId);
  validateContextPlan(snapshot);
  if (
    snapshot.logicalHistory !== undefined &&
    !isDeepStrictEqual(snapshot.logicalHistory, captureLogicalHistory(store, snapshot)) &&
    // Older receipts replayed carried-forward output over subsequent source edits.
    // Accept only their exact historical reconstruction; never rewrite frozen inputs.
    !isDeepStrictEqual(
      snapshot.logicalHistory,
      captureLogicalHistory(store, snapshot, { legacyNativeOutputReplay: true })
    )
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
    const expected = compileSnapshotPrompt(
      { ...candidateSnapshot, promptCompilation: undefined },
      undefined,
      undefined,
      { compilerVersion: p.compilerVersion }
    );
    if (!isDeepStrictEqual(expected.promptCompilation, p)) reject('compiled prompt mismatch');
  } else if (
    !nativeRisuPending(snapshot) &&
    // A snapshot still owing the selection call reserved uncompiled on purpose.
    !loreSelectionPending(snapshot) &&
    !['pending', 'failed'].includes(snapshot.contextPlan?.status ?? '')
  )
    reject('compiled prompt missing');
  return snapshot;
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
  if (snapshot.logicalHistory)
    snapshot.logicalHistory = snapshot.logicalHistory.map((item) => ({
      ...item,
      id: mapNativeMessageId(item.id, (id) => source(id)!),
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
      const suffix = message.id.slice(`${p.blockId}:`.length);
      const id = `${p.blockId}:${mapNativeMessageId(suffix, (id) => source(id)!)}`;
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
  remapNativeRisuSnapshot(
    snapshot,
    (id) => source(id)!,
    (id) => run(id)!
  );
}
