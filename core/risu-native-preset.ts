import type { PromptControl, RisuPrompt } from './risu-prompt.js';

export type NativeRisuPreset = { version: 1; preset: Record<string, unknown> };
export type NativeRisuPresetExecution = {
  version: 1;
  sourceHash: string;
  fields: Record<string, string>;
  variables: Record<string, string>;
  issues: string[];
};
const allowed = new Set([
  'name',
  'promptTemplate',
  'promptSettings',
  'customPromptTemplateToggle',
  'templateDefaultVariables',
  'regex',
  'presetRegex',
  'mainPrompt',
  'jailbreak',
  'globalNote',
  'jailbreakToggle',
  'chainOfThought',
]);
const settingKeys = new Set([
  'assistantPrefill',
  'postEndInnerFormat',
  'sendChatAsSystem',
  'sendName',
  'utilOverride',
  'customChainOfThought',
]);
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const string = (value: unknown) => (typeof value === 'string' ? value : '');

/** Keep only authored prompt data. Connections, credentials and generation settings never enter the active preset. */
export function nativeRisuPresetSource(value: unknown): NativeRisuPreset {
  const input = object(value),
    preset: Record<string, unknown> = {};
  for (const key of allowed)
    if (input[key] !== undefined) preset[key] = structuredClone(input[key]);
  if (preset.promptSettings !== undefined)
    preset.promptSettings = Object.fromEntries(
      Object.entries(object(preset.promptSettings)).filter(([key]) => settingKeys.has(key))
    );
  return validateNativeRisuPreset({ version: 1, preset });
}
export function validateNativeRisuPreset(value: unknown): NativeRisuPreset {
  const item = object(value),
    preset = object(item.preset);
  if (
    item.version !== 1 ||
    Object.keys(item).some((key) => !['version', 'preset'].includes(key)) ||
    Object.keys(preset).some((key) => !allowed.has(key)) ||
    !Array.isArray(preset.promptTemplate) ||
    preset.promptTemplate.length > 290 ||
    Object.keys(object(preset.promptSettings)).some((key) => !settingKeys.has(key))
  )
    throw new Error('RISU_NATIVE_PRESET_INVALID');
  if (
    preset.promptTemplate.some((item) => !item || typeof item !== 'object' || Array.isArray(item))
  )
    throw new Error('RISU_NATIVE_PRESET_INVALID');
  for (const key of ['regex', 'presetRegex'])
    if (preset[key] !== undefined && (!Array.isArray(preset[key]) || preset[key].length > 2000))
      throw new Error('RISU_NATIVE_PRESET_INVALID');
  if (JSON.stringify(value).length > 750_000) throw new Error('RISU_NATIVE_PRESET_LIMIT');
  return structuredClone(value) as NativeRisuPreset;
}

export function nativeRisuPresetControls(source: NativeRisuPreset): PromptControl[] {
  const controls: PromptControl[] = [],
    seen = new Set<string>();
  let group: string | undefined;
  for (const line of string(source.preset.customPromptTemplateToggle).split('\n')) {
    const [key, label, type, options] = line.replace(/\r$/u, '').split('=');
    if (type === 'group') {
      group = label;
      continue;
    }
    if (type === 'groupEnd') {
      group = undefined;
      continue;
    }
    if (type === 'caption' || type === 'divider' || !key || !label) continue;
    if (!/^[A-Za-z0-9_-]{1,120}$/u.test(key) || seen.has(key))
      throw new Error('RISU_NATIVE_PRESET_TOGGLE_KEY');
    seen.add(key);
    const text = type === 'text' || type === 'textarea';
    controls.push({
      id: key,
      label,
      type: text ? 'text' : 'select',
      default: null,
      ...(group ? { group } : {}),
      ...(!text
        ? {
            options: [
              { label: '미설정', value: null },
              ...(type === 'select'
                ? (options ?? '')
                    .split(',')
                    .map((label, index) => ({ label, value: String(index) }))
                : [
                    { label: '끔', value: '0' },
                    { label: '켬', value: '1' },
                  ]),
            ],
          }
        : {}),
    });
  }
  return controls;
}
export function nativeRisuPresetVariableDefaults(source: NativeRisuPreset): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const line of string(source.preset.templateDefaultVariables).split('\n')) {
    const [key, value] = line.split('=');
    if (key && value && !Object.hasOwn(result, key)) result[key] = value;
  }
  return result;
}
export function createNativeRisuPresetProgram(source: NativeRisuPreset): RisuPrompt {
  return { version: 1, nativeRisuPreset: source };
}
/** Apply only a frozen CBS receipt to a detached native source for host composition. */
export function evaluatedNativeRisuPreset(
  source: NativeRisuPreset,
  fields: Record<string, string>
): NativeRisuPreset {
  const result = structuredClone(source);
  for (const [index, raw] of (result.preset.promptTemplate as Record<string, unknown>[]).entries())
    for (const key of ['text', 'innerFormat', 'defaultText'])
      if (Object.hasOwn(fields, `block:${index}:${key}`))
        raw[key] = fields[`block:${index}:${key}`];
  const settings = object(result.preset.promptSettings);
  for (const key of ['postEndInnerFormat', 'assistantPrefill'])
    if (Object.hasOwn(fields, `settings:${key}`)) settings[key] = fields[`settings:${key}`];
  return result;
}
export function nativeRisuPresetFields(source: NativeRisuPreset): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [index, raw] of (source.preset.promptTemplate as Record<string, unknown>[]).entries())
    for (const key of ['text', 'innerFormat', 'defaultText'])
      if (typeof raw[key] === 'string') result[`block:${index}:${key}`] = raw[key];
  for (const [key, value] of Object.entries(object(source.preset.promptSettings)))
    if (['postEndInnerFormat', 'assistantPrefill'].includes(key) && typeof value === 'string')
      result[`settings:${key}`] = value;
  return result;
}
