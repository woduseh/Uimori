import { createDefaultRisuPrompt } from '../../core/prompt-defaults.js';
import type { RisuPrompt } from '../../core/risu-prompt.js';
import type { PromptRole } from '../../core/product.js';

/** Synthetic native RISUP source; callers provide the same raw fields as an imported preset. */
export function nativePrompt(
  text = 'Synthetic native instructions.',
  preset: Record<string, unknown> = {},
  role: PromptRole = 'main'
): RisuPrompt {
  const program = createDefaultRisuPrompt(text, role);
  Object.assign(program.nativeRisuPreset.preset, structuredClone(preset));
  return program;
}
