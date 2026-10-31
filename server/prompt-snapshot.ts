import { applyMessageChanges } from '../core/message-changes.js';
import { createHash } from 'node:crypto';
import { nativeCharacterExamples, nativePromptSlots } from './native-prompt-slots.js';
import { effectiveRisuControls } from '../core/risu-effective-controls.js';
import { loreHistory, type RetainedLore } from '../core/lore-context.js';
import { placeNativeRisuLore } from '../core/risu-native-lore.js';
import { createDefaultRisuPrompt } from '../core/prompt-defaults.js';
import { attachMainHostContext } from './main-host-context.js';
import { buildMainInput, type MainInput } from '../core/provider.js';
import {
  compileRisuPrompt,
  type PromptCompilerVersion,
  type PromptHistoryMessage,
  type RisuPrompt,
  type PromptValue,
} from '../core/risu-prompt.js';
import type { RunSnapshot, Source } from '../core/types.js';
import { validateSourceIdentity } from '../core/auxiliary.js';
import { HttpError } from './request-validation.js';
import type { Store } from './store.js';
import { DEFAULT_MAIN_PROMPT } from '../core/prompts.js';
import { compiledPackages, type ResolvedPackage } from '../core/package-context.js';
import { resolveTemplateVariableContext } from '../core/template-variables.js';
import { projectedLogicalHistory, selectLogicalHistory } from '../core/context-projection.js';
import { nativeRisuPresetPending, projectNativeRisuPresetProgram } from './risu-native-preset.js';

/** Pair each exact source version with its actual user request; never infer roles from prose. */
export function captureLogicalHistory(store: Store, snapshot: RunSnapshot): PromptHistoryMessage[] {
  const entries = snapshot.history;
  if (!entries.length) return [];
  const sourceMessages = new Set<string>();
  // This fold needs exact provenance, not Reader paragraph anchors or translation revisions.
  // Keep the same original/selected-edit integrity checks without constructing those views.
  const readSource = store.db.prepare(
    'SELECT id,chat_id AS chatId,run_id AS runId,text,hash FROM sources WHERE id=?'
  );
  const readEdit = store.db.prepare(
    'SELECT text,hash FROM source_edits WHERE source_id=? AND hash=? ORDER BY revision DESC LIMIT 1'
  );
  const readOwner = store.db.prepare(
    "SELECT request,snapshot,json_extract(snapshot,'$.packageStart.mode') AS startMode FROM runs WHERE id=?"
  );
  const folded = entries.reduce<PromptHistoryMessage[]>((accumulated, entry) => {
    const source = readSource.get(entry.revision) as
      | Pick<Source, 'id' | 'chatId' | 'runId' | 'text' | 'hash'>
      | undefined;
    if (!source) throw new HttpError(404, 'Source not found');
    validateSourceIdentity(source);
    if (entry.contentHash && entry.contentHash !== source.hash) {
      const edit = readEdit.get(entry.revision, entry.contentHash) as
        | Pick<Source, 'text' | 'hash'>
        | undefined;
      if (!edit) throw new HttpError(400, 'Unknown source content hash');
      validateSourceIdentity({ ...source, ...edit });
    }
    const row = readOwner.get(source.runId) as
      | { request: string; snapshot: string; startMode: string | null }
      | undefined;
    if (!row) throw new Error('PROMPT_HISTORY_REQUEST_MISSING');
    const provenance = {
      sourceRevision: entry.revision,
      sourceHash: entry.contentHash ?? source.hash,
      runId: source.runId,
    };
    const owner = JSON.parse(row.snapshot) as RunSnapshot;
    const native = owner.nativeRisuAuthored;
    const output = owner.nativeRisuExecution?.output;
    if (native)
      native.messages.forEach((message, index) => {
        if (message.role === 'char') sourceMessages.add(`native:${entry.revision}:${index}`);
      });
    else sourceMessages.add(`source:${entry.revision}`);
    if (output) {
      const prior = new Map(accumulated.map((message) => [message.id, message]));
      const capturedHashes = new Map(
        owner.history.map((item) => [
          item.revision,
          item.contentHash ?? store.sourceOriginal(item.revision).hash,
        ])
      );
      const capturedMessages = new Map(
        owner.logicalHistory?.map((message) => [message.id, message.text]) ??
          owner.nativeRisuExecution!.messages.map((message) => [message.id, message.data])
      );
      return [
        ...accumulated.filter((message) => message.sourceKind === 'authored-start'),
        ...output.messages.map((message, index) => {
          const existing = message.id ? prior.get(message.id) : undefined;
          const current = message.id === 'current-output';
          // Only source text is edited by the user; requests and script-added messages
          // keep their own Lua changes. Unchanged receipt input is a carried-forward
          // value, which must not resurrect text already corrected earlier in this fold.
          const preserveSource =
            existing?.sourceRevision !== undefined &&
            sourceMessages.has(existing.id) &&
            ((capturedHashes.has(existing.sourceRevision) &&
              capturedHashes.get(existing.sourceRevision) !== existing.sourceHash) ||
              capturedMessages.get(message.id) === message.data);
          return {
            ...(existing ?? provenance),
            id:
              existing?.id ??
              (current
                ? `source:${entry.revision}`
                : message.id === 'current-input'
                  ? `request:${entry.revision}`
                  : `native:${entry.revision}:${index}`),
            role: message.role === 'user' ? ('user' as const) : ('assistant' as const),
            text: current ? entry.text : preserveSource ? existing!.text : message.data,
            requestImages:
              message.role === 'user'
                ? message.id === 'current-input'
                  ? owner.requestImages
                  : existing?.requestImages
                : undefined,
          };
        }),
      ];
    }
    if (native) {
      accumulated.push(
        ...native.messages.map((message, index) => ({
          id: `native:${entry.revision}:${index}`,
          role: message.role === 'user' ? ('user' as const) : ('assistant' as const),
          text: message.role === 'char' ? entry.text : message.data,
          ...(message.role === 'user' && message.requestImageIndexes?.length
            ? {
                requestImages: message.requestImageIndexes.map((index) => {
                  const image = owner.requestImages?.[index];
                  if (!image) throw new Error('PROMPT_HISTORY_REQUEST_IMAGE_MISSING');
                  return image;
                }),
              }
            : {}),
          ...provenance,
          ...(native.greeting ? { sourceKind: 'authored-start' as const } : {}),
        }))
      );
      return applyMessageChanges(accumulated, owner.messageChanges);
    }
    accumulated.push(
      ...(row.startMode === 'authored'
        ? []
        : [
            {
              id: `request:${entry.revision}`,
              role: 'user' as const,
              text: row.request,
              ...(owner.requestImages?.length ? { requestImages: owner.requestImages } : {}),
              ...provenance,
            },
          ]),
      {
        id: `source:${entry.revision}`,
        role: 'assistant' as const,
        text: entry.text,
        ...provenance,
        ...(row.startMode === 'authored' ? { sourceKind: 'authored-start' as const } : {}),
      }
    );
    return applyMessageChanges(accumulated, owner.messageChanges);
  }, []);
  // User controls always win over retained native/Risu script transformations.
  const controls = new Map(entries.map((entry) => [entry.revision, entry.sceneContext]));
  // A native Risu action may retain multiple user messages in one scene. The user edits
  // that scene's combined request, so project it once while retaining every attachment.
  const requestImages = new Map<string, NonNullable<PromptHistoryMessage['requestImages']>>();
  for (const message of folded) {
    if (message.role !== 'user' || !message.sourceRevision) continue;
    const existing = requestImages.get(message.sourceRevision) ?? [];
    requestImages.set(message.sourceRevision, [...existing, ...(message.requestImages ?? [])]);
  }
  const replaced = new Set<string>();
  return folded.flatMap((message) => {
    const revision = message.sourceRevision;
    const control = revision ? controls.get(revision) : undefined;
    if (
      control?.sceneEnabled === false ||
      (message.role === 'user' && control?.requestEnabled === false)
    )
      return [];
    if (
      revision &&
      message.role === 'user' &&
      control?.requestText !== null &&
      control?.requestText !== undefined
    ) {
      if (replaced.has(revision)) return [];
      replaced.add(revision);
      return [
        { ...message, text: control.requestText, requestImages: requestImages.get(revision) },
      ];
    }
    return [message];
  });
}
function contextFromPackages(
  snapshot: RunSnapshot,
  packages: readonly ResolvedPackage[],
  input: MainInput
) {
  const slots = nativePromptSlots(snapshot, input);
  const logical = selectLogicalHistory(snapshot, input.history);
  const current = {
    id: 'current-input',
    role: 'user' as const,
    text: snapshot.nativeRisuExecution?.request ?? snapshot.request,
    current: true,
    ...(snapshot.requestImages?.length ? { requestImages: snapshot.requestImages } : {}),
  };
  const historyInput = [...structuredClone(logical)];
  const history = [
    ...projectedLogicalHistory(snapshot, historyInput),
    ...(snapshot.nativeRisuExecution?.requestPresent === false ? [] : [current]),
  ];
  const fixedIds = new Set(input.pinnedSources?.map((resource) => resource.id));
  const selected: RetainedLore[] = packages
    .flatMap((pkg) => pkg.selectedLore)
    .filter((resource) => !resource.nativeRisuPosition && resource.text)
    .map((resource) => ({
      id: resource.id,
      revision: resource.revision,
      hash: '',
      title: resource.title,
      start: 0,
      end: resource.text.length,
      text: resource.text,
      retention: 'selection',
      ...(resource.risuSource ? { risuSource: resource.risuSource } : {}),
      origin: {
        sourceRevision: 'current-input',
        sourceHash: '',
        runId: '',
        callId: 'lore-selection',
      },
      lastUsed: '',
    }));
  // Hashes already exist in the input only for fixed bodies; admitted references use
  // the same server hash as successful retention, without changing authored sources.
  for (const entry of selected) entry.hash = createHash('sha256').update(entry.text).digest('hex');
  const entries = [
    ...(snapshot.loreContext?.entries ?? []).filter(
      (entry) => !fixedIds.has(entry.id) && !selected.some((item) => item.id === entry.id)
    ),
    ...selected,
  ];
  const expanded = loreHistory(history, { entries });
  const references = expanded.flatMap((message, index) =>
    message.id.startsWith('lore-reference:')
      ? [
          {
            message,
            beforeMessageId: expanded
              .slice(index + 1)
              .find((item) => !item.id.startsWith('lore-reference:'))?.id,
            afterMessageId: expanded
              .slice(0, index)
              .findLast((item) => !item.id.startsWith('lore-reference:'))?.id,
          },
        ]
      : []
  );
  const preset = snapshot.profile?.promptPresets?.main;
  return {
    examples: nativeCharacterExamples(snapshot, packages)?.messages ?? [],
    slots,
    history,
    references,
    values: preset
      ? snapshot.profile?.promptControls?.[`${preset.id}@${preset.revision}`]?.values
      : undefined,
  };
}
/** Compile the current native prompt semantics for this request. */
export function compileSnapshotPrompt(
  snapshot: RunSnapshot,
  program?: RisuPrompt,
  values?: Record<string, PromptValue>,
  options: { compilerVersion?: PromptCompilerVersion } = {}
): RunSnapshot {
  if (snapshot.contextPlan?.status === 'pending') return snapshot;
  const authored =
    program ??
    snapshot.profile?.promptPresets?.main?.program ??
    createDefaultRisuPrompt(DEFAULT_MAIN_PROMPT);
  const selected = projectNativeRisuPresetProgram(snapshot, authored);
  const packages = compiledPackages(snapshot, 'main');
  // Reuse only within this synchronous compilation; later requests and tool results rebuild it.
  const input = buildMainInput(snapshot, [], packages);
  const context = contextFromPackages(snapshot, packages, input);
  const promptCompilation = compileRisuPrompt(selected, {
    ...context,
    ...(snapshot.profile ? { controls: effectiveRisuControls(snapshot.profile, selected) } : {}),
    ...(values ? { values } : {}),
    ...(options.compilerVersion ? { compilerVersion: options.compilerVersion } : {}),
  });
  if (nativeRisuPresetPending(snapshot))
    promptCompilation.warnings.push('RISU_NATIVE_PRESET_PENDING');
  if (
    resolveTemplateVariableContext(snapshot.profile).variableDefaultsError ===
    'TEMPLATE_VARIABLE_DEFAULTS_LIMIT'
  )
    promptCompilation.warnings.push('TEMPLATE_VARIABLE_DEFAULTS_LIMIT');
  const hosted = attachMainHostContext({ ...snapshot, promptCompilation }, input);
  return {
    ...hosted,
    promptCompilation: placeNativeRisuLore(hosted.promptCompilation!, input.pinnedSources ?? []),
  };
}
