/** Matches RisuToki's deprecated-save-policy; retained source-file bytes are never changed. */
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
}
