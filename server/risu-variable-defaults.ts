import { validateTemplateVariableDefaults } from '../core/template-variables.js';

// https://github.com/kwaroran/RisuAI/blob/cad8595aa39620df4246f56918f0962c2aa0263a/src/ts/util.ts#L989-L1008 (2026-11-20):
// parseKeyValue splits on newlines and keeps the first two `=`-separated parts of each line,
// untrimmed, skipping lines where either part is empty.
// https://github.com/kwaroran/RisuAI/blob/cad8595aa39620df4246f56918f0962c2aa0263a/src/ts/parser/chatVar.svelte.ts#L16-L21 (2026-11-20):
// getChatVar takes the first pair whose key matches.
export function importRisuVariableDefaults(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null || value === '') return;
  if (typeof value !== 'string') throw new Error('RISU_VARIABLE_DEFAULTS_INVALID');
  const result: Record<string, string> = Object.create(null);
  for (const line of value.split('\n')) {
    const [key, text] = line.split('=');
    if (key && text && !Object.hasOwn(result, key)) result[key] = text;
  }
  return validateTemplateVariableDefaults(result);
}
