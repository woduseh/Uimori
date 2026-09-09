import type { PromptProgram, PromptValue } from '../core/prompt-program.js';

/** Only explicit editor writes normalize old unset booleans; stored history is untouched. */
export function booleanPromptDraft(
  program: PromptProgram,
  values: Record<string, PromptValue> = {}
) {
  const nextValues = { ...values };
  const controls = program.controls.map((control) => {
    if (control.type !== 'boolean') return control;
    if (nextValues[control.id] === null) nextValues[control.id] = false;
    return control.default === null ? { ...control, default: false } : control;
  });
  return { program: { ...program, controls }, values: nextValues };
}
