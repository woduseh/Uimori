import type { RunSnapshot } from '../core/types.js';
import { isSourceOnlyTranscript, validateSourceOnlyTranscript } from '../core/authored-history.js';
import type { Store } from './store.js';
import { ChatOptionsStore } from './chat-options.js';
import { freezeChatOverrides } from './chat-overrides.js';
import { freezeOutline, freezeOutlineFocus } from './outline-store.js';
import { freezeLoreContext } from './lore-context.js';
import { captureLogicalHistory, compileSnapshotPrompt } from './prompt-snapshot.js';
import { loreSelectionPending } from './lore-selection.js';
import { chatVariableProfile } from './chat-variable-context.js';
import { nativeRisuPending } from './risu-native-run.js';
import { nativeRisuPresetPending } from './risu-native-preset.js';
import { readChatVariables } from './chat-variables.js';
import { validateChatVariableState } from '../core/chat-variables.js';
import { storyUiThemeChoices } from './themes.js';

export type ReservationPurpose =
  | {
      purpose: 'run' | 'authored';
      runId: string;
      sceneCommandId?: string;
      supersedesRunId?: string;
    }
  | { purpose: 'helper-context' }
  | {
      purpose: 'preview-main' | 'preview-translation';
      executionClock: () => NonNullable<RunSnapshot['executionClock']>;
    }
  | { purpose: 'resume-state' };

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
  const helper = options.purpose === 'helper-context';
  const translationPreview = options.purpose === 'preview-translation';
  if (
    reserved &&
    authored !==
      (base.packageStart?.mode === 'authored' ||
        base.transcriptImport !== undefined ||
        base.nativeRisuAuthored !== undefined)
  )
    throw new Error('RESERVATION_AUTHORSHIP_MISMATCH');

  if (base.nativeRisuAuthored) return base;

  if (authored && isSourceOnlyTranscript(base)) {
    validateSourceOnlyTranscript(base);
    return base;
  }

  if (reserved && base.profile) {
    new ChatOptionsStore(store).freeze(base.profile, options.runId);
    const roots =
      base.profile.chatOverrides?.roots ??
      store.product.profile(base.chatId).packageAttachments ??
      [];
    const overrides = freezeChatOverrides(store, base.profile, roots, base.parentRevision);
    if (overrides) base.profile.chatOverrides = overrides;
    else delete base.profile.chatOverrides;
  }
  if (base.profile && !translationPreview) {
    base = { ...base, profile: chatVariableProfile(store, base.chatId, base.profile) };
    if (base.replacement && base.packageStart?.mode !== 'authored') {
      const live = readChatVariables(store, base.chatId);
      const checkpoint = base.parentRevision
        ? store.db
            .prepare('SELECT body FROM chat_variable_outputs WHERE source_id=?')
            .get(base.parentRevision)
        : undefined;
      base.profile!.variableState = {
        revision: live.revision,
        values: checkpoint
          ? validateChatVariableState(JSON.parse(String(checkpoint.body))).values
          : {},
      };
    }
    if ((reserved || base.profile?.variableState) && base.profile?.packageAttachments?.length)
      base.resources = [
        ...base.resources.filter((resource) => !resource.id.startsWith('package:')),
        ...store.product
          .resources(base.chatId, base.profile)
          .filter((resource) => resource.id.startsWith('package:')),
      ];
  }

  let frozen = base;
  if (base.settings.storyUi && (options.purpose === 'run' || options.purpose === 'preview-main')) {
    const choices = storyUiThemeChoices(store, store.chat(base.chatId).botId);
    if (choices) frozen = { ...frozen, storyUiThemeChoices: choices };
  }
  if (options.purpose === 'run' && !frozen.executionPurpose) {
    const { revision, config } = store.storyGuide.get(base.chatId);
    frozen = { ...frozen, storyGuide: { revision, config } };
  }
  if (!authored) frozen = store.story.prepareRunInTransaction(frozen);
  if (reserved && options.sceneCommandId)
    frozen = freezeOutline(store, options.sceneCommandId, frozen);
  else if (
    (options.purpose === 'run' || options.purpose === 'preview-main') &&
    !frozen.executionPurpose
  )
    frozen = freezeOutlineFocus(store, frozen);
  frozen = { ...frozen, logicalHistory: captureLogicalHistory(store, frozen) };
  if (options.purpose === 'preview-main' || options.purpose === 'preview-translation')
    frozen = { ...frozen, executionClock: options.executionClock() };
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
