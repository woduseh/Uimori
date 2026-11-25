import { t } from './i18n.js';
import type { RisuContent } from '../core/risu-content.js';
import type { RisuPrompt } from '../core/risu-prompt.js';
import { nativeRisuBackground, nativeRisuExtension, nativeRisuLore } from '../core/risu-native.js';
import { readTranslationGuide } from '../core/translation-guide.js';
import { readIllustrationAppearanceProfiles } from '../core/illustration-profiles.js';

export type StudioKind = 'bot' | 'persona' | 'module' | 'prompt';
export type StudioGroup = 'story' | 'presentation' | 'behavior' | 'source';
export type StudioSectionDefinition<Id extends string, Doc> = {
  id: Id;
  group?: StudioGroup;
  labelKey: string;
  kinds: readonly StudioKind[];
  defaultFor: readonly StudioKind[];
  available?: (doc: Doc) => boolean;
  hasData: (doc: Doc) => boolean;
  count?: (doc: Doc) => number;
  owns: (path: string) => boolean;
  drafts?: readonly string[];
  layout: 'list' | 'canvas';
};
export type StudioSection<K extends string> = {
  id: K;
  title: string;
  count?: number;
  group?: string;
  more?: boolean;
};

export type ContentSection =
  | 'basic'
  | 'greetings'
  | 'lore'
  | 'instructions'
  | 'assets'
  | 'appearances'
  | 'translation'
  | 'display'
  | 'variables'
  | 'triggers'
  | 'regex'
  | 'modules'
  | 'source';
export type PresetSection = 'blocks' | 'options' | 'variables' | 'regex' | 'collaboration';
export type PresetDocument = { program: RisuPrompt; collaboration: boolean };

const CONTENT_KINDS = ['bot', 'persona', 'module'] as const;
const groupLabels: Record<StudioGroup, string> = {
  story: 'native.sectionGroupStory',
  presentation: 'native.sectionGroupPresentation',
  behavior: 'native.sectionGroupBehavior',
  source: 'native.sectionGroupSource',
};
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const filled = (value: unknown) => !!text(value).trim();
const list = (value: unknown) => (Array.isArray(value) ? value : []);
const matches = (pattern: RegExp) => (path: string) => pattern.test(path);

export function isStandaloneModule(content: RisuContent) {
  return !Object.keys(content.nativeRisu.card).length && !!content.nativeRisu.module;
}
const authoredSource = (content: RisuContent) =>
  isStandaloneModule(content) ? content.nativeRisu.module! : content.nativeRisu.card;
const greetings = (content: RisuContent) => [
  content.nativeRisu.card.first_mes,
  ...list(content.nativeRisu.card.alternate_greetings),
];
const scripts = (content: RisuContent, card: string, module: string) =>
  list(
    content.nativeRisu.module
      ? object(content.nativeRisu.module)[module]
      : nativeRisuExtension(content.nativeRisu)[card]
  );

export const contentSectionRegistry: readonly StudioSectionDefinition<
  ContentSection,
  RisuContent
>[] = [
  {
    id: 'basic',
    group: 'story',
    labelKey: 'native.text_eb7f501b0e',
    kinds: CONTENT_KINDS,
    defaultFor: CONTENT_KINDS,
    hasData: (content) => filled(authoredSource(content).description) || !!content.portraitImageId,
    owns: (path) =>
      /^\/package\/portraitImageId$|^\/package\/nativeRisu\/(card|module)\/(name|description)$/u.test(
        path
      ) || isAuthoringPath(path),
    layout: 'canvas',
  },
  {
    id: 'greetings',
    group: 'story',
    labelKey: 'native.text_be7723bd53',
    kinds: CONTENT_KINDS,
    defaultFor: ['bot'],
    available: (content) => !isStandaloneModule(content),
    hasData: (content) => greetings(content).some(filled),
    count: (content) => {
      const items = greetings(content);
      return items.length === 1 && !items[0] ? 0 : items.length;
    },
    owns: matches(/\/(first_mes|alternate_greetings)(\/|$)/u),
    layout: 'list',
  },
  {
    id: 'lore',
    group: 'story',
    labelKey: 'native.text_5ce4911d95',
    kinds: CONTENT_KINDS,
    defaultFor: ['bot', 'module'],
    hasData: (content) => nativeRisuLore(content.nativeRisu).length > 0,
    count: (content) => nativeRisuLore(content.nativeRisu).length,
    owns: matches(/^\/package\/loreActivation(\/|$)|\/(character_book|lorebook)(\/|$)/u),
    layout: 'list',
  },
  {
    id: 'instructions',
    group: 'story',
    labelKey: 'native.text_22a2af3f54',
    kinds: CONTENT_KINDS,
    defaultFor: ['bot'],
    available: (content) => !isStandaloneModule(content),
    hasData: (content) =>
      filled(content.nativeRisu.card.post_history_instructions) ||
      filled(content.nativeRisu.card.mes_example),
    owns: matches(/\/(system_prompt|post_history_instructions|depth_prompt|mes_example)(\/|$)/u),
    layout: 'canvas',
  },
  {
    id: 'assets',
    group: 'presentation',
    labelKey: 'native.text_b1a821ee46',
    kinds: CONTENT_KINDS,
    defaultFor: CONTENT_KINDS,
    hasData: (content) => !!content.images?.length,
    count: (content) => content.images?.length ?? 0,
    owns: matches(/^\/package\/images(\/|$)|\/(assets|emotions)(\/|$)/u),
    layout: 'list',
  },
  {
    id: 'appearances',
    group: 'presentation',
    labelKey: 'visuals.defaultAppearances',
    kinds: CONTENT_KINDS,
    defaultFor: ['bot'],
    hasData: (content) => readIllustrationAppearanceProfiles(authoredSource(content)).length > 0,
    owns: matches(/\/uimori\/illustrationProfiles(\/|$)/u),
    layout: 'canvas',
  },
  {
    id: 'translation',
    group: 'presentation',
    labelKey: 'native.text_ecc580fe68',
    kinds: CONTENT_KINDS,
    defaultFor: ['bot'],
    hasData: (content) => {
      const guide = readTranslationGuide(authoredSource(content));
      return filled(guide.instructions) || guide.terms.length > 0;
    },
    owns: matches(/\/uimori\/translationGuide(\/|$)/u),
    layout: 'canvas',
  },
  {
    id: 'display',
    group: 'presentation',
    labelKey: 'native.backgroundHtmlCss',
    kinds: CONTENT_KINDS,
    defaultFor: ['bot', 'module'],
    available: (content) => !isStandaloneModule(content) || !!content.imageHandoff,
    hasData: (content) =>
      filled(nativeRisuBackground(content.nativeRisu)) || !!content.imageHandoff,
    owns: matches(/^\/package\/imageHandoff(\/|$)|\/(backgroundHTML|css)(\/|$)/u),
    layout: 'canvas',
  },
  {
    id: 'variables',
    group: 'behavior',
    labelKey: 'native.initialVariablesAndToggles',
    kinds: CONTENT_KINDS,
    defaultFor: ['bot', 'module'],
    hasData: (content) =>
      isStandaloneModule(content)
        ? filled(content.nativeRisu.module?.defaultVariables) ||
          filled(content.nativeRisu.module?.customModuleToggle)
        : filled(nativeRisuExtension(content.nativeRisu).defaultVariables) ||
          filled(nativeRisuExtension(content.nativeRisu).toggles),
    owns: matches(/\/(defaultVariables|customModuleToggle|toggles)(\/|$)/u),
    layout: 'canvas',
  },
  {
    id: 'triggers',
    group: 'behavior',
    labelKey: 'native.text_5aa9d342d6',
    kinds: CONTENT_KINDS,
    defaultFor: ['bot', 'module'],
    hasData: (content) => scripts(content, 'triggerscript', 'trigger').length > 0,
    owns: matches(/\/(triggerscript|trigger|lua)(\/|$)/u),
    drafts: ['package.native.triggers'],
    layout: 'canvas',
  },
  {
    id: 'regex',
    group: 'behavior',
    labelKey: 'native.text_fc7e4f6228',
    kinds: CONTENT_KINDS,
    defaultFor: ['bot', 'module'],
    hasData: (content) => scripts(content, 'customScripts', 'regex').length > 0,
    owns: matches(/\/(customScripts|regex)(\/|$)/u),
    drafts: ['package.native.regex'],
    layout: 'list',
  },
  {
    id: 'modules',
    group: 'behavior',
    labelKey: 'native.text_ae90c98d27',
    kinds: CONTENT_KINDS,
    defaultFor: ['bot'],
    hasData: (content) => !!content.modules?.length,
    owns: matches(/^\/package\/modules(\/|$)/u),
    layout: 'canvas',
  },
  {
    id: 'source',
    group: 'source',
    labelKey: 'native.sourceJson',
    kinds: CONTENT_KINDS,
    defaultFor: ['bot'],
    hasData: () => false,
    owns: () => false,
    drafts: ['package.native.source'],
    layout: 'canvas',
  },
];

export const presetSectionRegistry: readonly StudioSectionDefinition<
  PresetSection,
  PresetDocument
>[] = [
  {
    id: 'blocks',
    labelKey: 'native.text_a0a7b7b4e4',
    kinds: ['prompt'],
    defaultFor: ['prompt'],
    hasData: (doc) => list(doc.program.nativeRisuPreset.preset.promptTemplate).length > 0,
    count: (doc) => list(doc.program.nativeRisuPreset.preset.promptTemplate).length,
    owns: matches(/\/promptTemplate(\/|$)/u),
    layout: 'list',
  },
  {
    id: 'options',
    labelKey: 'native.text_a1c1f8f5fe',
    kinds: ['prompt'],
    defaultFor: ['prompt'],
    hasData: () => false,
    owns: () => false,
    layout: 'canvas',
  },
  {
    id: 'variables',
    labelKey: 'native.text_0a13d19d88',
    kinds: ['prompt'],
    defaultFor: ['prompt'],
    hasData: () => false,
    owns: matches(
      /\/(defaultVariables|templateDefaultVariables|customPromptTemplateToggle)(\/|$)/u
    ),
    drafts: ['prompt.native.toggles'],
    layout: 'canvas',
  },
  {
    id: 'regex',
    labelKey: 'native.text_fc7e4f6228',
    kinds: ['prompt'],
    defaultFor: ['prompt'],
    hasData: () => false,
    owns: matches(/\/(regex|presetRegex|customScripts)(\/|$)/u),
    drafts: ['prompt.native.regex'],
    layout: 'list',
  },
  {
    id: 'collaboration',
    labelKey: 'native.text_780d3f6ed3',
    kinds: ['prompt'],
    defaultFor: ['prompt'],
    available: (doc) => doc.collaboration,
    hasData: () => false,
    owns: () => false,
    layout: 'canvas',
  },
];

const definition = <Id extends string, Doc>(
  registry: readonly StudioSectionDefinition<Id, Doc>[],
  id: Id
) => registry.find((section) => section.id === id)!;

export const contentSectionLabelKey = (id: ContentSection) =>
  definition(contentSectionRegistry, id).labelKey;
export const presetSectionLabelKey = (id: PresetSection) =>
  definition(presetSectionRegistry, id).labelKey;

export function contentSection(path: string): ContentSection | null {
  return contentSectionRegistry.find((section) => section.owns(path))?.id ?? null;
}
export function presetSection(path: string): PresetSection | null {
  return presetSectionRegistry.find((section) => section.owns(path))?.id ?? null;
}
export function isAuthoringPath(path: string) {
  return /^\/package\/nativeRisu\/card\/(creator_notes|creator|character_version)(\/|$)/u.test(
    path
  );
}

export function availableSections<Id extends string, Doc>(
  registry: readonly StudioSectionDefinition<Id, Doc>[],
  doc: Doc
): Id[] {
  return registry
    .filter((section) => section.available?.(doc) ?? true)
    .map((section) => section.id);
}

export const MODULE_SECTION_ORDER: readonly ContentSection[] = [
  'lore',
  'triggers',
  'regex',
  'display',
  'variables',
  'assets',
  'basic',
];
const GROUP_ORDER: readonly StudioGroup[] = ['story', 'presentation', 'behavior', 'source'];

export function placeSections<Id extends string, Doc>(
  registry: readonly StudioSectionDefinition<Id, Doc>[],
  doc: Doc,
  kind: StudioKind,
  current: Id,
  pending: readonly string[] = [],
  order: readonly Id[] = []
): { id: Id; more: boolean }[] {
  const rank = (id: Id) => (order.includes(id) ? order.indexOf(id) : order.length);
  const groupRank = (group?: StudioGroup) =>
    Math.min(
      ...registry.filter((section) => section.group === group).map((section) => rank(section.id))
    );
  return registry
    .filter((section) => section.available?.(doc) ?? true)
    .sort(
      (a, b) =>
        groupRank(a.group) - groupRank(b.group) ||
        GROUP_ORDER.indexOf(a.group!) - GROUP_ORDER.indexOf(b.group!) ||
        rank(a.id) - rank(b.id)
    )
    .map((section) => ({
      id: section.id,
      more: !(
        section.defaultFor.includes(kind) ||
        section.id === current ||
        section.hasData(doc) ||
        !!section.drafts?.some((path) => pending.includes(path))
      ),
    }));
}

function resolve<Id extends string, Doc>(
  section: StudioSectionDefinition<Id, Doc>,
  doc: Doc,
  title = t(section.labelKey)
): StudioSection<Id> {
  return {
    id: section.id,
    title,
    ...(section.count ? { count: section.count(doc) } : {}),
    ...(section.group ? { group: t(groupLabels[section.group]) } : {}),
  };
}

export function contentSections(
  content: RisuContent,
  kind: Exclude<StudioKind, 'prompt'>,
  current: ContentSection,
  pending: readonly string[] = []
): StudioSection<ContentSection>[] {
  return placeSections(
    contentSectionRegistry,
    content,
    kind,
    current,
    pending,
    kind === 'module' ? MODULE_SECTION_ORDER : []
  ).map(({ id, more }) => ({
    ...resolve(
      definition(contentSectionRegistry, id),
      content,
      id === 'display' && isStandaloneModule(content) ? t('native.imageInstructions') : undefined
    ),
    ...(more ? { more } : {}),
  }));
}
export function presetSections(
  program: RisuPrompt,
  collaboration: boolean
): StudioSection<PresetSection>[] {
  const doc = { program, collaboration };
  return presetSectionRegistry
    .filter((section) => section.available?.(doc) ?? true)
    .map((section) => resolve(section, doc));
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
