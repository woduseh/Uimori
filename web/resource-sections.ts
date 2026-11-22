import { t } from './i18n.js';

export type ContentSection =
  | 'basic'
  | 'greetings'
  | 'lore'
  | 'assets'
  | 'translation'
  | 'appearances'
  | 'advanced'
  | 'creator';
export type ContentAdvancedTab =
  | 'instructions'
  | 'variables'
  | 'display'
  | 'scripts'
  | 'modules'
  | 'source';
export type PresetSection = 'blocks' | 'options' | 'variables' | 'regex' | 'collaboration';

export function contentSection(
  path: string
): { section: ContentSection; advanced?: ContentAdvancedTab } | null {
  const has = (pattern: RegExp) => pattern.test(path);
  if (has(/^\/package\/portraitImageId$/u)) return { section: 'basic' };
  if (has(/^\/package\/modules(\/|$)/u)) return { section: 'advanced', advanced: 'modules' };
  if (has(/^\/package\/imageHandoff(\/|$)/u)) return { section: 'advanced', advanced: 'display' };
  if (has(/^\/package\/loreActivation(\/|$)|\/(character_book|lorebook)(\/|$)/u))
    return { section: 'lore' };
  if (has(/\/(first_mes|alternate_greetings)(\/|$)/u)) return { section: 'greetings' };
  if (has(/\/uimori\/translationGuide(\/|$)/u)) return { section: 'translation' };
  if (has(/\/uimori\/illustrationProfiles(\/|$)/u)) return { section: 'appearances' };
  if (has(/^\/package\/images(\/|$)|\/(assets|emotions)(\/|$)/u)) return { section: 'assets' };
  if (has(/\/(creator_notes|creator|character_version)(\/|$)/u)) return { section: 'creator' };
  if (has(/\/(customScripts|triggerscript|regex|trigger|lua)(\/|$)/u))
    return { section: 'advanced', advanced: 'scripts' };
  if (has(/\/(backgroundHTML|css)(\/|$)/u)) return { section: 'advanced', advanced: 'display' };
  if (has(/\/(defaultVariables|customModuleToggle)(\/|$)/u))
    return { section: 'advanced', advanced: 'variables' };
  if (has(/\/(system_prompt|post_history_instructions|depth_prompt)(\/|$)/u))
    return { section: 'advanced', advanced: 'instructions' };
  return null;
}

export function presetSection(path: string): PresetSection | null {
  if (/\/promptTemplate(\/|$)/u.test(path)) return 'blocks';
  if (/\/(regex|customScripts)(\/|$)/u.test(path)) return 'regex';
  if (/\/(defaultVariables|customPromptTemplateToggle)(\/|$)/u.test(path)) return 'variables';
  return null;
}

export function promptBlockTypeLabels(): Record<string, string> {
  return {
    plain: t('native.text_87c554df93'),
    description: t('native.text_4c515a8bac'),
    persona: t('native.text_789c237f0d'),
    lorebook: t('native.text_5ce4911d95'),
    chat: t('native.text_c0a10149c3'),
    authornote: t('native.text_ec0f0b70df'),
    postEverything: t('native.text_bc212cb334'),
    cache: t('native.text_33ff59f35d'),
    chatML: 'ChatML',
  };
}
