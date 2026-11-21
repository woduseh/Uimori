import type { HelperChangeListSection, HelperChangeLocation } from '../core/helper.js';
import { OUTLINE_LEVELS } from '../core/outline.js';
import { formatNumber, t } from './i18n.js';
import {
  contentSection,
  presetSection,
  promptBlockTypeLabels,
  type ContentAdvancedTab,
  type ContentSection,
  type PresetSection,
} from './resource-sections.js';

export type LocationPart = { text: string; identifier?: boolean };

export const settingsLabels: Record<string, string> = {
  'global.mainModel': 'helperResults.globalMainModel',
  'global.translationModel': 'helperResults.globalTranslationModel',
  'global.helperModel': 'helperResults.globalHelperModel',
  'global.contextModel': 'helperResults.globalContextModel',
  'global.scriptModel': 'helperResults.globalScriptModel',
  'global.titleModel': 'helperResults.globalTitleModel',
  'chat.mainModel': 'helperResults.chatMainModel',
  'chat.mainPromptPreset': 'helperResults.chatMainPromptPreset',
  'chat.maxCalls': 'helperResults.chatMaxCalls',
  'chat.storyUi': 'storyUi.enable',
  'chat.storyUiStyle': 'storyUi.style',
  'newChat.maxCalls': 'settings.m92',
  'newChat.storyUi': 'storyUi.enable',
  'newChat.storyUiStyle': 'storyUi.style',
  'bot.storyUiTheme': 'storyUi.botDefault',
  'chat.illustrationProfiles': 'visuals.characterProfiles',
  'chat.illustrationReferences': 'visuals.m028',
  'model.pricing': 'helperResults.modelPricing',
  'vertex.location': 'helperResults.vertexLocation',
  'chat.variables': 'helperResults.chatVariables',
  'chat.options': 'helperResults.chatOptions',
  'chat.storyGuide': 'helperResults.storyGuide',
  'model.parameters': 'helperResults.modelParameters',
};

const sceneFields = {
  original: 'reader.original',
  translation: 'reader.translation',
  title: 'reader.sceneName',
} as const;
const outlineLevels = new Set<string>(OUTLINE_LEVELS);
const noteKinds: Record<string, string> = {
  'author-note': 'native.text_ec0f0b70df',
  'imported-memory': 'orphanmemory.imported',
};
const listSections: Record<HelperChangeListSection, string> = {
  lore: 'native.text_5ce4911d95',
  prompt: 'native.text_02eb4cbf48',
  terms: 'library.namesAndTerminology',
};
const itemFields: Record<HelperChangeListSection, Record<string, string>> = {
  lore: {
    comment: 'native.text_3df0f8d368',
    name: 'native.text_3df0f8d368',
    content: 'native.text_bf0b828e2d',
    key: 'native.text_4fc1889a0b',
    keys: 'native.text_4fc1889a0b',
    secondkey: 'native.text_e45a128fa4',
    secondary_keys: 'native.text_e45a128fa4',
  },
  prompt: {
    name: 'native.text_d07c6c9a24',
    role: 'native.text_32ae236cf2',
    role2: 'native.text_32ae236cf2',
    text: 'native.text_d7e4bc7b33',
  },
  terms: {
    source: 'library.originalTerm',
    target: 'library.preferredTerm',
    note: 'library.conditionsOrDescription',
  },
};
const contentSections: Record<ContentSection, string> = {
  basic: 'native.text_eb7f501b0e',
  greetings: 'native.text_be7723bd53',
  lore: 'native.text_5ce4911d95',
  assets: 'native.text_b1a821ee46',
  translation: 'native.text_ecc580fe68',
  appearances: 'visuals.defaultAppearances',
  advanced: 'native.text_772fa878ec',
  creator: 'native.text_78def74816',
};
const contentAdvancedTabs: Record<ContentAdvancedTab, string> = {
  instructions: 'native.text_22a2af3f54',
  variables: 'native.initialVariablesAndToggles',
  display: 'native.backgroundHtmlCss',
  scripts: 'native.text_f31813202f',
  modules: 'native.text_ae90c98d27',
  source: 'native.sourceJson',
};
const presetSections: Record<PresetSection, string> = {
  blocks: 'native.text_a0a7b7b4e4',
  options: 'native.text_a1c1f8f5fe',
  variables: 'native.text_0a13d19d88',
  regex: 'native.text_fc7e4f6228',
  collaboration: 'native.text_780d3f6ed3',
};
const NATIVE_PREFIX =
  /^\/(?:package\/nativeRisu\/(?:card|module)|program\/nativeRisuPreset\/preset)(?=\/|$)/u;

const label = (key: string): LocationPart => ({ text: t(key) });
const identifier = (path: string[]): LocationPart => ({
  text: path.join('/'),
  identifier: true,
});

function resourceField(path: string[]): LocationPart[] {
  const pointer = `/${path.join('/')}`;
  const native = /^\/package\/nativeRisu\/(card|module)\/(name|description)$/u.exec(pointer);
  if (native)
    return [
      label(contentSections.basic),
      label(
        native[2] === 'name'
          ? 'native.text_9aa18e5071'
          : native[1] === 'module'
            ? 'native.text_9e7348ca61'
            : 'native.text_08117feaa5'
      ),
    ];
  const relative = pointer.replace(NATIVE_PREFIX, '').split('/').filter(Boolean);
  if (pointer.startsWith('/program/nativeRisuPreset/')) {
    const section = presetSection(pointer);
    return section
      ? [label(presetSections[section])]
      : [label(presetSections.options), identifier(relative)];
  }
  const found = pointer.startsWith('/package/') ? contentSection(pointer) : null;
  if (!found) return [identifier(relative)];
  return [
    label(contentSections[found.section]),
    ...(found.advanced ? [label(contentAdvancedTabs[found.advanced])] : []),
  ];
}

function resourceList(location: Extract<HelperChangeLocation, { kind: 'resource-list' }>) {
  const parts = [label(listSections[location.section])];
  const item = location.item;
  if (item)
    parts.push({
      text:
        item.name ??
        (item.type && promptBlockTypeLabels()[item.type]) ??
        item.type ??
        `#${formatNumber(item.index + 1)}`,
    });
  const [field] = location.field;
  if (field !== undefined) {
    const key = itemFields[location.section][field];
    parts.push(key ? label(key) : identifier(location.field));
  }
  return parts;
}

export function helperChangeLocationParts(location: HelperChangeLocation | string): LocationPart[] {
  if (typeof location === 'string') return [{ text: location }];
  switch (location.kind) {
    case 'scene':
      return [
        location.scene === null
          ? label('helperChanges.excludedScene')
          : { text: t('reader.sceneValue', { v0: formatNumber(location.scene) }) },
        label(sceneFields[location.field]),
      ];
    case 'resource-field':
      return resourceField(location.path);
    case 'resource-list':
      return resourceList(location);
    case 'resource-more':
      return [{ text: t('helperChanges.moreChanges', { count: location.count }) }];
    case 'outline': {
      const known = outlineLevels.has(location.level);
      return [
        known ? label(`prompts.level.${location.level}`) : identifier([location.level]),
        { text: location.title },
        ...(location.field === 'title'
          ? [label('prompts.uiName')]
          : location.field === 'intent'
            ? [known ? label(`reader.outlineContent.${location.level}`) : identifier(['intent'])]
            : []),
      ];
    }
    case 'note':
      return [
        noteKinds[location.noteKind]
          ? label(noteKinds[location.noteKind]!)
          : identifier([location.noteKind]),
        { text: location.text },
      ];
    case 'setting':
      return [
        settingsLabels[location.setting]
          ? label(settingsLabels[location.setting]!)
          : identifier([location.setting]),
      ];
    case 'chat-lore':
      return [label('helperChanges.chatLore')];
  }
}
