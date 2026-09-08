import type { AuxiliaryInput } from './auxiliary.js';
import type { RunSnapshot } from './types.js';
import { createDefaultPromptProgram } from './prompt-defaults.js';
import { DEFAULT_TRANSLATION_PROMPT } from './prompts.js';
import { compilePromptProgram, type PromptCompilation } from './prompt-program.js';
import { executionContext } from './execution-context.js';
import { packageSlots } from './package-context.js';

/** A translation job compiles its own frozen preset and values, never main-turn messages. */
export function compileTranslationPrompt(
  input: AuxiliaryInput,
  snapshot: RunSnapshot,
  task: string
): PromptCompilation | undefined {
  if (input.role !== 'translation') return undefined;
  const preset = snapshot.profile?.promptPresets?.translation;
  if (
    preset &&
    (preset.role !== 'translation' ||
      input.context.instructionRevision !== `prompt:${preset.id}@${preset.revision}`)
  )
    throw new Error('SOURCE_PROMPT_REVISION_MISMATCH');
  const contents = snapshot.profile?.contents ?? [];
  const description = input.context.bot?.text ?? '';
  const lore = [
    ...contents
      .filter((item) => item.kind === 'module' && item.loading === 'pinned')
      .map((item) => item.text),
  ].join('\n\n');
  const slots: Record<string, string> = {
    char: contents.find((item) => item.kind === 'bot')?.title ?? 'Character',
    bot: description,
    description,
    persona: input.context.persona?.text ?? '',
    lore,
    lorebook: lore,
    memory: snapshot.story?.memory ? JSON.stringify(snapshot.story.memory) : '',
    state: snapshot.story?.state ? JSON.stringify(snapshot.story.state) : '',
    source: input.sourceText ?? JSON.stringify(input.blocks),
    context: JSON.stringify(input.context),
    outputSchema: JSON.stringify(input.outputSchema),
    catalog: JSON.stringify(input.catalog),
    controls: '{}',
    globalNote: '',
    authorNote: '',
    authornote: '',
    postEverything: '',
    slot: '',
  };
  const packageSlot = packageSlots(snapshot, 'translation');
  if (packageSlot.char) slots.char = packageSlot.char;
  for (const key of ['bot', 'persona', 'lore'] as const)
    if (packageSlot[key]) slots[key] = [slots[key], packageSlot[key]].filter(Boolean).join('\n\n');
  slots.description = slots.bot;
  slots.lorebook = slots.lore;
  return compilePromptProgram(
    preset?.program ?? createDefaultPromptProgram(DEFAULT_TRANSLATION_PROMPT, 'translation'),
    {
      runtime: {
        ...executionContext(snapshot, 'translation'),
        source: {
          id: input.sourceRevision,
          hash: input.sourceHash,
          text: input.sourceText ?? '',
          blocks: input.blocks as unknown as import('./prompt-program.js').RuntimeValue,
        },
      },
      values: preset
        ? snapshot.profile?.promptControls?.[`${preset.id}@${preset.revision}`]?.values
        : undefined,
      slots,
      history: [
        {
          id: `translation-current:${input.sourceRevision}`,
          role: 'user',
          text: task,
          sourceRevision: input.sourceRevision,
          sourceHash: input.sourceHash,
          current: true,
        },
      ],
    }
  );
}
