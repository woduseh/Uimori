import { t } from './i18n.js';
import type { RisuContent } from '../core/risu-content.js';
import type { RisuPrompt } from '../core/risu-prompt.js';
import { nativeRisuLore } from '../core/risu-native.js';
import type { StudioSection } from './EditorStudio.js';

export type ContentSection =
  | 'basic'
  | 'greetings'
  | 'lore'
  | 'assets'
  | 'translation'
  | 'appearances'
  | 'advanced';
export type ContentAdvancedTab =
  | 'instructions'
  | 'variables'
  | 'display'
  | 'scripts'
  | 'modules'
  | 'source';
export type PresetSection = 'blocks' | 'options' | 'variables' | 'regex' | 'collaboration';

export function isStandaloneModule(content: RisuContent) {
  return !Object.keys(content.nativeRisu.card).length && !!content.nativeRisu.module;
}

export function contentSections(content: RisuContent): StudioSection<ContentSection>[] {
  const native = content.nativeRisu;
  const greetings = [
    native.card.first_mes,
    ...(Array.isArray(native.card.alternate_greetings) ? native.card.alternate_greetings : []),
  ];
  return [
    { id: 'basic', title: t('native.text_eb7f501b0e') },
    ...(!isStandaloneModule(content)
      ? [
          {
            id: 'greetings' as const,
            title: t('native.text_be7723bd53'),
            count: greetings.length === 1 && !greetings[0] ? 0 : greetings.length,
          },
        ]
      : []),
    { id: 'lore', title: t('native.text_5ce4911d95'), count: nativeRisuLore(native).length },
    { id: 'assets', title: t('native.text_b1a821ee46'), count: content.images?.length ?? 0 },
    { id: 'translation', title: t('native.text_ecc580fe68') },
    { id: 'appearances', title: t('visuals.defaultAppearances') },
    { id: 'advanced', title: t('native.text_772fa878ec') },
  ];
}

export function presetSections(
  program: RisuPrompt,
  collaboration: boolean
): StudioSection<PresetSection>[] {
  return [
    {
      id: 'blocks',
      title: t('native.text_a0a7b7b4e4'),
      count: (program.nativeRisuPreset.preset.promptTemplate as unknown[]).length,
    },
    { id: 'options', title: t('native.text_a1c1f8f5fe') },
    { id: 'variables', title: t('native.text_0a13d19d88') },
    { id: 'regex', title: t('native.text_fc7e4f6228') },
    ...(collaboration
      ? [{ id: 'collaboration' as const, title: t('native.text_780d3f6ed3') }]
      : []),
  ];
}

export function contentSection(
  path: string
): { section: ContentSection; advanced?: ContentAdvancedTab; authoring?: true } | null {
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
  if (has(/\/(creator_notes|creator|character_version)(\/|$)/u))
    return { section: 'basic', authoring: true };
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
