import { loreHistory } from '../core/lore-context.js';
import { placeNativeRisuLore } from '../core/risu-native-lore.js';
import { createDefaultPromptProgram } from '../core/prompt-defaults.js';
import { attachMainHostContext } from './main-host-context.js';
import { buildMainInput, pinnedSlotSources } from '../core/provider.js';
import {
  compilePromptProgram,
  type PromptCompilerVersion,
  type PromptHistoryMessage,
  type PromptProgram,
  type PromptValue,
  type PromptTemplate,
} from '../core/prompt-program.js';
import { sourceLogicalHistoryForRequest } from '../core/source-context.js';
import type { RunSnapshot } from '../core/types.js';
import type { Store } from './store.js';
import { DEFAULT_MAIN_PROMPT } from '../core/prompts.js';
import { compiledPackages, type ResolvedPackage } from '../core/package-context.js';
import { executionContext } from '../core/execution-context.js';
import { projectedLogicalHistory } from '../core/context-projection.js';
import { nativeRisuPresetPending, projectNativeRisuPresetProgram } from './risu-native-preset.js';
import { projectPromptInputTransforms } from './prompt-transforms.js';
import {
  projectExtensionMessageEdits,
  projectExtensionRequestEdit,
} from './extension-request-edit.js';

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
export function promptContext(
  snapshot: RunSnapshot,
  program?: PromptProgram,
  values?: Record<string, PromptValue>
) {
  return contextFromPackages(snapshot, compiledPackages(snapshot, 'main'), program, values);
}
function contextFromPackages(
  snapshot: RunSnapshot,
  packages: readonly ResolvedPackage[],
  program?: PromptProgram,
  values?: Record<string, PromptValue>,
  compilerVersion?: PromptCompilerVersion
) {
  const input = buildMainInput(snapshot, [], { compilerVersion });
  const contents = snapshot.profile?.contents ?? [];
  const body = (slot: string) =>
    pinnedSlotSources(input, slot)
      .map((item) => item.text)
      .join('\n\n');
  const slots: Record<string, string> = {
    char: contents.find((c) => c.kind === 'bot')?.title ?? 'Character',
    bot: body('bot'),
    description: body('description'),
    persona: body('persona'),
    lore: body('lore'),
    notes: input.notes ? JSON.stringify(input.notes) : '',
    state: input.state ? JSON.stringify(input.state) : '',
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
  const edited = projectExtensionMessageEdits(snapshot, [
    ...sourceLogicalHistoryForRequest(snapshot, logical),
    {
      id: 'current-input',
      role: 'user' as const,
      text: projectExtensionRequestEdit(snapshot).text,
      current: true,
    },
  ]);
  const transformed = projectPromptInputTransforms(snapshot, edited.history, program, values);
  const current = transformed.history.at(-1)!;
  const history = [
    ...loreHistory(
      projectedLogicalHistory(snapshot, transformed.history.slice(0, -1)),
      snapshot.loreContext
    ),
    current,
  ];
  const preset = snapshot.profile?.promptPresets?.main;
  return {
    slots,
    history,
    transformWarnings: [...edited.warnings, ...transformed.warnings],
    runtime: executionContext(snapshot),
    values: preset
      ? snapshot.profile?.promptControls?.[`${preset.id}@${preset.revision}`]?.values
      : undefined,
  };
}
/** Pass `compilerVersion` only to reproduce a stored compilation; a fresh one takes the current stamp. */
export function compileSnapshotPrompt(
  snapshot: RunSnapshot,
  program?: PromptProgram,
  values?: Record<string, PromptValue>,
  options: { compilerVersion?: PromptCompilerVersion } = {}
): RunSnapshot {
  if (snapshot.story?.waiting || snapshot.contextPlan?.status === 'pending') return snapshot;
  const authored =
    program ??
    snapshot.profile?.promptPresets?.main?.program ??
    createDefaultPromptProgram(DEFAULT_MAIN_PROMPT);
  const selected = projectNativeRisuPresetProgram(snapshot, authored);
  const packages = compiledPackages(snapshot, 'main');
  const positioned = packages.flatMap((p) => p.instructions).filter((n) => n.position);
  if (positioned.length) {
    const declared = new Set<string>();
    const walk = (nodes: PromptTemplate) => {
      for (const node of nodes) {
        if (node.kind === 'slot') declared.add(node.name);
        else if (node.kind === 'if') {
          walk(node.then);
          walk(node.else ?? []);
        } else if (node.kind === 'each') {
          walk(node.body);
          walk(node.else ?? []);
        } else if (node.kind === 'let') walk(node.body);
      }
    };
    for (const block of selected?.blocks ?? []) {
      if (block.kind === 'slot') declared.add(block.slot);
      if ((block.kind === 'slot' || block.kind === 'message') && block.template)
        walk(block.template);
    }
    for (const pkg of packages) {
      pkg.instructions = pkg.instructions.filter((instruction) => {
        if (!instruction.position || declared.has(instruction.position)) return true;
        (pkg.unavailableInstructions ??= []).push({
          id: instruction.id.slice(
            `package:${pkg.attachment.id}:${pkg.attachment.role}:instruction:`.length
          ),
          code: 'PACKAGE_INSERTION_SLOT_MISSING',
        });
        return false;
      });
    }
  }
  const context = contextFromPackages(
    snapshot,
    packages,
    selected,
    values,
    options.compilerVersion
  );
  const promptCompilation = compilePromptProgram(selected, {
    ...context,
    ...(values ? { values } : {}),
    ...(options.compilerVersion ? { compilerVersion: options.compilerVersion } : {}),
  });
  promptCompilation.warnings.push(...context.transformWarnings);
  if (nativeRisuPresetPending(snapshot))
    promptCompilation.warnings.push('RISU_NATIVE_PRESET_PENDING');
  if (context.runtime.variableDefaultsError === 'TEMPLATE_VARIABLE_DEFAULTS_LIMIT')
    promptCompilation.warnings.push('TEMPLATE_VARIABLE_DEFAULTS_LIMIT');
  for (const pkg of packages)
    for (const item of pkg.unavailableInstructions ?? [])
      promptCompilation.warnings.push(
        `PACKAGE_INSTRUCTION_UNAVAILABLE:${JSON.stringify({ instanceId: `${pkg.attachment.id}:${pkg.attachment.role}`, instructionId: item.id, code: item.code })}`
      );
  for (const pkg of packages)
    for (const item of pkg.unavailableTextTemplates ?? [])
      promptCompilation.warnings.push(
        `PACKAGE_TEXT_TEMPLATE_FALLBACK:${JSON.stringify({ instanceId: `${pkg.attachment.id}:${pkg.attachment.role}`, resourceId: item.id, code: item.code })}`
      );

  const hosted = attachMainHostContext({ ...snapshot, promptCompilation });
  return {
    ...hosted,
    promptCompilation: placeNativeRisuLore(
      hosted.promptCompilation!,
      buildMainInput(snapshot, [], options).pinnedSources ?? []
    ),
  };
}
