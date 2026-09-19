import type { AuxiliaryInput } from './auxiliary.js';
import type { RunSnapshot } from './types.js';
import { createDefaultRisuPrompt } from './prompt-defaults.js';
import { DEFAULT_TRANSLATION_PROMPT } from './prompts.js';
import { compileRisuPrompt, type PromptCompilation } from './risu-prompt.js';
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
  const description = input.context.bot?.text ?? '';
  const slots: Record<string, string> = {
    char: 'Character',
    bot: description,
    description,
    persona: input.context.persona?.text ?? '',
    lore: '',
    lorebook: '',
    // No separate glossary category exists. Source-time modules remain in lore/context.references.
    glossary: '',
    notes: snapshot.story?.notes ? JSON.stringify(snapshot.story.notes) : '',
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
  const currentText = `${task}\n\n<Sample_Text>\n${input.sourceText ?? ''}\n</Sample_Text>\n\n<Additional_Information>\n\ncontext:\n${JSON.stringify(input.context)}\nnotes:\n${JSON.stringify(snapshot.story?.notes ?? [])}\n</Additional_Information>`;
  const compilation = compileRisuPrompt(
    preset?.program ?? createDefaultRisuPrompt(DEFAULT_TRANSLATION_PROMPT, 'translation'),
    {
      runtime: {
        ...executionContext(snapshot, 'translation'),
        source: {
          id: input.sourceRevision,
          hash: input.sourceHash,
          text: input.sourceText ?? '',
          blocks: input.blocks as unknown as import('./risu-prompt.js').RuntimeValue,
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
          text: currentText,
          sourceRevision: input.sourceRevision,
          sourceHash: input.sourceHash,
          current: true,
        },
      ],
    }
  );
  // Native chat blocks place the host's source message; the source is never interpreted as CBS.
  if (
    compilation.messages.some(
      (message) =>
        message.provenance.origin === 'current' &&
        message.content.some((part) => part.text === currentText)
    )
  )
    compilation.usedSlots = [
      ...new Set([...(compilation.usedSlots ?? []), 'source', 'context', 'notes']),
    ];
  return compilation;
}
