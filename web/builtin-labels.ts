import type { ProviderProtocol } from '../core/product.js';
import type { TokenizerProfileId } from '../core/tokenizer-profiles.js';
import type { UsageKind } from '../core/usage-report.js';
import type { BuiltinThemeId } from '../core/themes.js';
import type { BuiltinPaletteId } from '../core/theme-palettes.js';
import { DEFAULT_ILLUSTRATION_PRESET_ID } from '../core/illustration-presets.js';
import { t } from './i18n.js';

const providerLabels: Record<ProviderProtocol, () => string> = {
  'codex-app-server-v1': () => t('providers.m603'),
  'fixture-sse-v1': () => t('providers.m608'),
  'vertex-gemini-v1': () => 'Google Agent Platform',
  'google-gemini-v1': () => 'Google AI Studio Gemini',
  'openai-responses-v1': () => 'OpenAI Responses',
  'anthropic-messages-v1': () => 'Anthropic Messages',
  'vercel-chat-v1': () => 'Vercel AI Gateway',
  'deepseek-chat-v1': () => t('providers.m628'),
  'openai-chat-v1': () => t('providers.m632'),
};
const providerLimitationKeys: Record<ProviderProtocol, readonly string[]> = {
  'codex-app-server-v1': ['providers.m604', 'providers.m605', 'providers.m606', 'providers.m607'],
  'fixture-sse-v1': ['providers.m609', 'providers.m610'],
  'vertex-gemini-v1': ['providers.m612', 'providers.m613', 'providers.m614'],
  'google-gemini-v1': ['providers.m615', 'providers.m616', 'providers.m617'],
  'openai-responses-v1': ['providers.m618'],
  'anthropic-messages-v1': ['providers.m621', 'providers.m622'],
  'vercel-chat-v1': ['providers.m625', 'providers.m627'],
  'deepseek-chat-v1': ['providers.m629', 'providers.m630', 'providers.m631'],
  'openai-chat-v1': ['providers.m618'],
};
export const providerLabel = (protocol: ProviderProtocol): string => providerLabels[protocol]();
export const providerLimitations = (protocol: ProviderProtocol): string[] =>
  providerLimitationKeys[protocol].map((key) => t(key));

const tokenizerLabels: Record<TokenizerProfileId, () => string> = {
  'openai-o200k': () => 'OpenAI o200k_base',
  'openai-cl100k': () => 'OpenAI cl100k_base',
  'gemini-gemma3': () => t('providers.m637'),
  'gemini-gemma4': () => t('providers.m639'),
  'deepseek-v3': () => 'DeepSeek V3.2',
  'deepseek-v4': () => 'DeepSeek V4 Pro',
  'deepseek-v4.1': () => 'DeepSeek V4.1 Flash',
  'glm-4.7': () => 'GLM 4.5 / 4.6 / 4.7',
  'glm-5': () => 'GLM 5 / 5.1 / 5.2',
  'kimi-k2': () => 'Kimi K2 / K2.5',
  'claude-legacy': () => t('providers.m647'),
  'grok-estimate': () => t('providers.m649'),
  generic: () => t('providers.m651'),
};
export const tokenizerLabel = (id: TokenizerProfileId): string => tokenizerLabels[id]();

const usageKindKeys: Record<UsageKind, string> = {
  writing: 'visualpanels.usageWriting',
  translation: 'visualpanels.translation',
  'input-translation': 'visualpanels.usageInputTranslation',
  'story-guide': 'visualpanels.usageStoryGuide',
  summary: 'visualpanels.usageSummary',
  advisor: 'visualpanels.usageAdvisor',
  helper: 'visualpanels.helper',
  'helper-artifact': 'visualpanels.usageArtifact',
  judgment: 'visualpanels.usageJudgment',
  image: 'visualpanels.usageImage',
  status: 'visualpanels.usageStatus',
  script: 'visualpanels.cardScript',
  title: 'visualpanels.usageTitle',
  'connection-test': 'visualpanels.usageConnectionTest',
  unclassified: 'visualpanels.uncategorizedPurpose',
};
export const usageKindLabel = (kind: string): string =>
  t(
    Object.hasOwn(usageKindKeys, kind)
      ? usageKindKeys[kind as UsageKind]
      : usageKindKeys.unclassified
  );

type BuiltinText = { title: string; description: string };
const themeKeys: Record<BuiltinThemeId, BuiltinText> = {
  'builtin:forest': {
    title: 'visualpanels.layoutDefault',
    description: 'visualpanels.layoutDefaultDescription',
  },
  'builtin:cinematic': {
    title: 'visualpanels.layoutCinematic',
    description: 'visualpanels.layoutCinematicDescription',
  },
  'builtin:letter': {
    title: 'visualpanels.layoutLetter',
    description: 'visualpanels.layoutLetterDescription',
  },
  'builtin:scrapbook': {
    title: 'visualpanels.layoutScrapbook',
    description: 'visualpanels.layoutScrapbookDescription',
  },
  'builtin:classic-frame': {
    title: 'visualpanels.layoutClassicFrame',
    description: 'visualpanels.layoutClassicFrameDescription',
  },
};
const paletteKeys: Record<BuiltinPaletteId, BuiltinText> = {
  forest: {
    title: 'visualpanels.paletteForest',
    description: 'visualpanels.paletteForestDescription',
  },
  cream: {
    title: 'visualpanels.paletteCream',
    description: 'visualpanels.paletteCreamDescription',
  },
  charcoal: {
    title: 'visualpanels.paletteCharcoal',
    description: 'visualpanels.paletteCharcoalDescription',
  },
  midnight: {
    title: 'visualpanels.paletteMidnight',
    description: 'visualpanels.paletteMidnightDescription',
  },
  rose: { title: 'visualpanels.paletteRose', description: 'visualpanels.paletteRoseDescription' },
  sage: { title: 'visualpanels.paletteSage', description: 'visualpanels.paletteSageDescription' },
};

type Labeled = { id: string; title: string; description?: string };
const builtinText = (keys: Record<string, BuiltinText>, item: Labeled): BuiltinText =>
  Object.hasOwn(keys, item.id)
    ? { title: t(keys[item.id].title), description: t(keys[item.id].description) }
    : { title: item.title, description: item.description ?? '' };
export const themeText = (theme: Labeled): BuiltinText => builtinText(themeKeys, theme);
export const paletteText = (palette: Labeled & { revision?: number }): BuiltinText =>
  builtinText(palette.revision === undefined ? paletteKeys : {}, palette);
export const illustrationPresetText = (preset: Labeled): BuiltinText =>
  builtinText(
    {
      [DEFAULT_ILLUSTRATION_PRESET_ID]: {
        title: 'visualpanels.layoutDefault',
        description: 'visualpanels.defaultIllustrationPresetDescription',
      },
    },
    preset
  );
export const illustrationPresetTitle = (preset: Labeled): string =>
  illustrationPresetText(preset).title;
