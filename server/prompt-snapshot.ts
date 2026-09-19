import { loreHistory } from '../core/lore-context.js';
import { placeNativeRisuLore } from '../core/risu-native-lore.js';
import { createDefaultRisuPrompt } from '../core/prompt-defaults.js';
import { attachMainHostContext } from './main-host-context.js';
import { buildMainInput, pinnedSlotSources } from '../core/provider.js';
import {
  compileRisuPrompt,
  type PromptCompilerVersion,
  type PromptHistoryMessage,
  type RisuPrompt,
  type PromptValue,
} from '../core/risu-prompt.js';
import type { RunSnapshot } from '../core/types.js';
import type { Store } from './store.js';
import { DEFAULT_MAIN_PROMPT } from '../core/prompts.js';
import { compiledPackages, type ResolvedPackage } from '../core/package-context.js';
import { executionContext } from '../core/execution-context.js';
import { projectedLogicalHistory } from '../core/context-projection.js';
import { nativeRisuPresetPending, projectNativeRisuPresetProgram } from './risu-native-preset.js';

/** Pair each exact source version with its actual user request; never infer roles from prose. */
export function captureLogicalHistory(store: Store, snapshot: RunSnapshot): PromptHistoryMessage[] {
  const entries = snapshot.history;
  return entries.reduce<PromptHistoryMessage[]>((accumulated, entry) => {
    const source = entry.contentHash
      ? store.sourceAtHash(entry.revision, entry.contentHash)
      : store.sourceOriginal(entry.revision);
    const row = store.db
      .prepare(
        "SELECT request,json_extract(snapshot,'$.packageStart.mode') AS startMode FROM runs WHERE id=?"
      )
      .get(source.runId) as { request: string; startMode: string | null } | undefined;
    if (!row) throw new Error('PROMPT_HISTORY_REQUEST_MISSING');
    const provenance = {
      sourceRevision: entry.revision,
      sourceHash: entry.contentHash ?? source.hash,
      runId: source.runId,
    };
    const owner = store.run(source.runId).snapshot;
    const native = owner.nativeRisuAuthored;
    const output = owner.nativeRisuExecution?.output;
    if (output) {
      const prior = new Map(accumulated.map((message) => [message.id, message]));
      return [
        ...accumulated.filter((message) => message.sourceKind === 'authored-start'),
        ...output.messages.map((message, index) => {
          const existing = message.id ? prior.get(message.id) : undefined;
          const current = message.id === 'current-output';
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
            text: current ? entry.text : message.data,
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
          ...provenance,
          ...(native.greeting ? { sourceKind: 'authored-start' as const } : {}),
        }))
      );
      return accumulated;
    }
    accumulated.push(
      ...(row.startMode === 'authored'
        ? []
        : [
            {
              id: `request:${entry.revision}`,
              role: 'user' as const,
              text: row.request,
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
    return accumulated;
  }, []);
}
export function promptContext(snapshot: RunSnapshot) {
  return contextFromPackages(snapshot, compiledPackages(snapshot, 'main'));
}
function contextFromPackages(
  snapshot: RunSnapshot,
  packages: readonly ResolvedPackage[],
  compilerVersion?: PromptCompilerVersion
) {
  const input = buildMainInput(snapshot, [], { compilerVersion });
  const body = (slot: string) =>
    pinnedSlotSources(input, slot)
      .map((item) => item.text)
      .join('\n\n');
  const slots: Record<string, string> = {
    char: packages.find((entry) => entry.attachment.role === 'bot')?.package.title ?? 'Character',
    bot: body('bot'),
    description: body('description'),
    persona: body('persona'),
    lore: body('lore'),
    notes: input.notes ? JSON.stringify(input.notes) : '',
    outline: input.outline ? JSON.stringify(input.outline) : '',
    globalNote: '',
    authorNote: '',
    postEverything: '',
    slot: '',
    backgroundLore: pinnedSlotSources(input, 'backgroundLore')
      .map((item) => JSON.stringify(item))
      .join('\n'),
    sceneLore: pinnedSlotSources(input, 'sceneLore')
      .map((item) => JSON.stringify(item))
      .join('\n'),
    references: JSON.stringify(
      input.pinnedSources?.length
        ? { pinnedSources: pinnedSlotSources(input, 'references') }
        : { facts: input.facts }
    ),
    catalog: JSON.stringify(input.catalog),
    source: '',
  };
  const bot = packages.find((p) => p.attachment.role === 'bot')?.package;
  const name = bot?.identity?.name ?? bot?.title;
  if (name) slots.char = name;
  slots.description = slots.bot;
  slots.lorebook = slots.lore;
  slots.authornote = slots.authorNote;
  for (const instruction of packages.flatMap((p) => p.instructions))
    if (instruction.position)
      slots[instruction.position] = [slots[instruction.position], instruction.text]
        .filter(Boolean)
        .join('\n\n');
  const inputHistoryIds = new Set(input.history.map((entry) => entry.revision));
  const logical = (
    snapshot.nativeRisuExecution?.history ??
    snapshot.logicalHistory ??
    input.history.map((entry) => ({
      id: `source:${entry.revision}`,
      role: 'assistant' as const,
      text: entry.text,
      sourceRevision: entry.revision,
      ...(entry.contentHash ? { sourceHash: entry.contentHash } : {}),
    }))
  ).filter(
    (message) =>
      snapshot.contextPlan || !message.sourceRevision || inputHistoryIds.has(message.sourceRevision)
  );
  const historyInput = [
    ...structuredClone(logical),
    {
      id: 'current-input',
      role: 'user' as const,
      text: snapshot.nativeRisuExecution?.request ?? snapshot.request,
      current: true,
    },
  ];
  const current = historyInput.at(-1)!;
  const history = [
    ...loreHistory(
      projectedLogicalHistory(snapshot, historyInput.slice(0, -1)),
      snapshot.loreContext
    ),
    current,
  ];
  const preset = snapshot.profile?.promptPresets?.main;
  return {
    slots,
    history,
    runtime: executionContext(snapshot),
    values: preset
      ? snapshot.profile?.promptControls?.[`${preset.id}@${preset.revision}`]?.values
      : undefined,
  };
}
/** Pass `compilerVersion` only to reproduce a stored compilation; a fresh one takes the current stamp. */
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
  const context = contextFromPackages(snapshot, packages, options.compilerVersion);
  const promptCompilation = compileRisuPrompt(selected, {
    ...context,
    ...(values ? { values } : {}),
    ...(options.compilerVersion ? { compilerVersion: options.compilerVersion } : {}),
  });
  if (nativeRisuPresetPending(snapshot))
    promptCompilation.warnings.push('RISU_NATIVE_PRESET_PENDING');
  if (context.runtime.variableDefaultsError === 'TEMPLATE_VARIABLE_DEFAULTS_LIMIT')
    promptCompilation.warnings.push('TEMPLATE_VARIABLE_DEFAULTS_LIMIT');
  const hosted = attachMainHostContext({ ...snapshot, promptCompilation });
  return {
    ...hosted,
    promptCompilation: placeNativeRisuLore(
      hosted.promptCompilation!,
      buildMainInput(snapshot, [], options).pinnedSources ?? []
    ),
  };
}
