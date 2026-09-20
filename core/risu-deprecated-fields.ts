/** RisuToki's deprecated-save-policy plus retired Uimori preset options; source-file bytes stay intact. */
const CARD_FIELDS = [
  'personality',
  'scenario',
  'system_prompt',
  'nickname',
  'source',
  'group_only_greetings',
] as const;
const CARD_EXTENSION_FIELDS = ['additionalText', 'license', 'virtualscript'] as const;
const PRESET_FIELDS = [
  'mainPrompt',
  'jailbreak',
  'globalNote',
  'useInstructPrompt',
  'instructChatTemplate',
  'JinjaTemplate',
  'jailbreakToggle',
  'chainOfThought',
] as const;
const PRESET_SETTING_FIELDS = [
  'sendName',
  'sendChatAsSystem',
  'postEndInnerFormat',
  'assistantPrefill',
] as const;
const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Takes the card payload itself, rather than its file envelope's `data` property. */
export function stripDeprecatedRisuCardFields(card: Record<string, unknown>): void {
  for (const key of CARD_FIELDS) delete card[key];
  const extension = object(object(card.extensions)?.risuai);
  if (extension) for (const key of CARD_EXTENSION_FIELDS) delete extension[key];
}

export function stripDeprecatedRisuModuleFields(module: Record<string, unknown>): void {
  delete module.cjs;
}

export function stripDeprecatedRisuPresetFields(preset: Record<string, unknown>): void {
  for (const key of PRESET_FIELDS) delete preset[key];
  const settings = object(preset.promptSettings);
  if (settings) for (const key of PRESET_SETTING_FIELDS) delete settings[key];
  if (Array.isArray(preset.promptTemplate))
    preset.promptTemplate = preset.promptTemplate.filter(
      (block) => !['jailbreak', 'cot'].includes(String(object(block)?.type))
    );
  if (Array.isArray(preset.promptTemplate))
    for (const block of preset.promptTemplate) {
      const item = object(block);
      if (item) {
        delete item.chatAsOriginalOnSystem;
        if (item.type2 === 'jailbreak') delete item.type2;
      }
    }
}
