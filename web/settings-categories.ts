import type { LucideIcon } from 'lucide-react';
import { ChartNoAxesColumn, Info, Palette } from 'lucide-react';
import { t } from './i18n.js';
import {
  AgentIcon,
  ConnectionIcon,
  DataIcon,
  IllustrationIcon,
  LibraryIcon,
  ModelIcon,
  PromptIcon,
  SettingsIcon,
} from './ui-icons.js';

type SettingsDestination = { label: string; terms: string; anchor?: string };
export type SettingsGroup = 'display' | 'generation' | 'system';
type SettingsCategory = {
  key: string;
  label: string;
  icon: LucideIcon;
  group: SettingsGroup;
  terms?: string;
  destinations?: SettingsDestination[];
};

export function getSettingsGroupLabels(): Record<SettingsGroup, string> {
  return {
    display: t('chatsettings.groupDisplay'),
    generation: t('chatsettings.groupGeneration'),
    system: t('chatsettings.groupSystem'),
  };
}

export function getSettingsCategories(sessionRequired: boolean): SettingsCategory[] {
  return [
    {
      key: 'general',
      label: t('chatsettings.m15'),
      icon: SettingsIcon,
      group: 'display',
      destinations: [
        {
          label: t('chatsettings.m16'),
          terms: `${t('chatsettings.m17')} ${t('shortcuts.setting')}`,
          anchor: 'display',
        },
        {
          label: t('chatsettings.m18'),
          terms: `${t('chatsettings.m19')} ${t('settings.newChatDefaults')} ${t('settings.m92')} ${t('storyUi.enable')} ${t('storyUi.style')}`,
          anchor: 'generation',
        },
        {
          label: t('chatsettings.readingSettings'),
          terms: t('chatsettings.m20'),
          anchor: 'reading',
        },
        { label: t('chatsettings.m21'), terms: t('chatsettings.m22'), anchor: 'services' },
        ...(sessionRequired
          ? [{ label: t('chatsettings.m23'), terms: t('chatsettings.m24'), anchor: 'session' }]
          : []),
      ],
    },
    {
      key: 'themes',
      label: t('chatsettings.m25'),
      icon: Palette,
      group: 'display',
      terms: t('chatsettings.m26'),
    },
    {
      key: 'models',
      label: t('chatsettings.m27'),
      icon: ModelIcon,
      group: 'generation',
      terms: `${t('chatsettings.m28')} ${t('settings.helperTaskTimeout')}`,
    },
    {
      key: 'prompts',
      label: t('chatsettings.m29'),
      icon: PromptIcon,
      group: 'generation',
      terms: t('chatsettings.m30'),
    },
    {
      key: 'connections',
      label: t('chatsettings.m31'),
      icon: ConnectionIcon,
      group: 'generation',
      terms: t('chatsettings.m32'),
    },
    {
      key: 'lore',
      label: t('chatsettings.m33'),
      icon: LibraryIcon,
      group: 'generation',
      terms: t('chatsettings.m34'),
    },
    {
      key: 'agents',
      label: t('chatsettings.m35'),
      icon: AgentIcon,
      group: 'generation',
      terms: t('chatsettings.m36'),
    },
    {
      key: 'illustrations',
      label: t('chatsettings.m37'),
      icon: IllustrationIcon,
      group: 'generation',
      terms: t('chatsettings.m38'),
    },
    {
      key: 'usage',
      label: t('chatsettings.m39'),
      icon: ChartNoAxesColumn,
      group: 'system',
      terms: t('chatsettings.m40'),
    },
    {
      key: 'data',
      label: t('chatsettings.m41'),
      icon: DataIcon,
      group: 'system',
      destinations: [
        {
          label: t('chatsettings.m42'),
          terms: t('chatsettings.m43'),
        },
      ],
    },
    {
      key: 'about',
      label: t('chatsettings.m44'),
      icon: Info,
      group: 'system',
      terms: t('chatsettings.m45'),
    },
  ];
}
