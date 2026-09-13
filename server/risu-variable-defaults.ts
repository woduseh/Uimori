import { validateTemplateVariableDefaults } from '../core/template-variables.js';

/** Fixed Risu parseKeyValue semantics: no trimming, first pair and first duplicate win. */
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
