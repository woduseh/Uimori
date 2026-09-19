import type {
  PromptBlock,
  PromptControl,
  PromptProgram,
  PromptRoleName,
  PromptTemplate,
} from './prompt-program.js';

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
const role = (value: unknown): PromptRoleName =>
  value === 'user' ? 'user' : value === 'bot' || value === 'assistant' ? 'assistant' : 'system';

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
/** Slot insertion is mechanical; CBS remains native text and is evaluated by the bounded server worker. */
function template(text: string, slot = 'slot'): PromptTemplate {
  const at = text.indexOf('{{slot}}');
  return at < 0
    ? [{ kind: 'text', text }]
    : [
        { kind: 'text', text: text.slice(0, at) },
        { kind: 'slot', name: slot },
        { kind: 'text', text: text.slice(at + 8) },
      ];
}
export function nativeRisuPresetProjection(
  source: NativeRisuPreset,
  fields?: Record<string, string>
): Pick<PromptProgram, 'blocks' | 'controls' | 'variableDefaults'> {
  const preset = source.preset,
    settings = object(preset.promptSettings);
  const blocks: PromptBlock[] = [];
  const value = (key: string, fallback: unknown) => fields?.[key] ?? string(fallback);
  for (const [index, raw] of (preset.promptTemplate as Record<string, unknown>[]).entries()) {
    const type = string(raw.type),
      common = {
        id: `risu-block-${index + 1}`,
        title: string(raw.name) || `${index + 1}. ${type}`,
      };
    if (['plain', 'jailbreak', 'cot'].includes(type)) {
      const enabled =
        type === 'jailbreak'
          ? preset.jailbreakToggle !== false
          : type === 'cot'
            ? preset.chainOfThought !== false
            : true;
      blocks.push({
        ...common,
        kind: 'message',
        role: role(raw.role),
        enabled,
        template: template(
          value(`block:${index}:text`, raw.text),
          raw.type2 === 'globalNote' ? 'globalNote' : 'slot'
        ),
      });
    } else if (type === 'chat') {
      const from =
        raw.rangeStart === -1000
          ? 0
          : Number.isSafeInteger(raw.rangeStart)
            ? Number(raw.rangeStart)
            : 0;
      const to =
        raw.rangeStart === -1000 || raw.rangeEnd === 'end' || raw.rangeEnd === undefined
          ? 'end'
          : Number(raw.rangeEnd);
      blocks.push({
        ...common,
        kind: 'history',
        from,
        to,
        ...(settings.sendChatAsSystem && !raw.chatAsOriginalOnSystem
          ? { role: 'system' as const }
          : {}),
      });
    } else if (type === 'cache') {
      if (raw.role === 'system') continue;
      blocks.push({
        ...common,
        kind: 'cache',
        depth: Math.max(1, Math.min(4, Number(raw.depth) || 1)),
        role: raw.role === 'user' ? 'user' : raw.role === 'assistant' ? 'assistant' : 'all',
        policy: 'prefer',
      });
    } else if (type === 'memory') {
      // Uimori provides its own summary in logical history. Preserve the source without duplicating it.
      blocks.push({ ...common, kind: 'message', role: 'system', enabled: false, template: [] });
    } else if (
      ['persona', 'description', 'lorebook', 'authornote', 'postEverything'].includes(type)
    ) {
      const slot = type === 'authornote' ? 'authorNote' : type;
      const format = value(`block:${index}:innerFormat`, raw.innerFormat);
      blocks.push({
        ...common,
        kind: 'slot',
        slot,
        role: role(raw.role2),
        ...(format ? { template: template(format) } : {}),
        ...(type === 'authornote' && raw.defaultText
          ? { fallback: value(`block:${index}:defaultText`, raw.defaultText) }
          : {}),
      });
    } else throw new Error(`RISU_NATIVE_PRESET_BLOCK:${type}`);
  }
  if (settings.postEndInnerFormat)
    blocks.push({
      id: 'risu-post-end',
      title: '마지막 지시',
      kind: 'message',
      role: 'system',
      template: template(
        value('settings:postEndInnerFormat', settings.postEndInnerFormat),
        'postEverything'
      ),
    });
  if (settings.assistantPrefill)
    blocks.push({
      id: 'risu-assistant-prefill',
      title: 'Assistant prefill',
      kind: 'message',
      role: 'assistant',
      completion: 'prefill',
      template: template(value('settings:assistantPrefill', settings.assistantPrefill)),
    });
  const variableDefaults: Record<string, string> = Object.create(null);
  for (const line of string(preset.templateDefaultVariables).split('\n')) {
    // Matches Risu parseKeyValue: first pair, first duplicate, and original whitespace.
    const [key, text] = line.split('=');
    if (key && text && !Object.hasOwn(variableDefaults, key)) variableDefaults[key] = text;
  }
  return {
    blocks,
    controls: nativeRisuPresetControls(source),
    ...(Object.keys(variableDefaults).length ? { variableDefaults } : {}),
  };
}
export function createNativeRisuPresetProgram(source: NativeRisuPreset): PromptProgram {
  return { version: 1, ...nativeRisuPresetProjection(source), nativeRisuPreset: source };
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
