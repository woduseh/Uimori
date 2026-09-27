import { SOURCE_TEXT_MAX_CHARS } from './content-limits.js';
import { parseComfyWorkflow } from './illustration-workflow.js';

/** Portable visual direction, independent of provider credentials and execution policy. */
export type IllustrationPresetDefinition = {
  title: string;
  description: string;
  styleGuidance: string;
  comfyui: { workflow: string; negativeGuidance: string };
};
export type IllustrationPreset = IllustrationPresetDefinition & { id: string; revision: number };
export type IllustrationPresetStamp = Pick<IllustrationPreset, 'id' | 'revision' | 'title'>;
export type IllustrationPresetScope = { botId?: string; chatId?: string };
export type IllustrationPresetPreferences = {
  revision: number;
  defaultPresetId: string;
  botPresets: Record<string, string>;
  chatPresets: Record<string, string>;
};
export type IllustrationPresetCatalog = {
  presets: IllustrationPreset[];
  preferences: IllustrationPresetPreferences;
};
export const ILLUSTRATION_PRESET_FORMAT = 'uimori-illustration-preset';
export const ILLUSTRATION_WORKFLOW_MAX_CHARS = 400_000;
export const ILLUSTRATION_PRESET_FILE_MAX_BYTES = 16 * 1024 * 1024;
export const DEFAULT_ILLUSTRATION_PRESET_ID = 'builtin:illustration-default';
export function emptyIllustrationPreset(title = '새 삽화 프리셋'): IllustrationPresetDefinition {
  return {
    title,
    description: '',
    styleGuidance: '',
    comfyui: { workflow: '', negativeGuidance: '' },
  };
}
export const BUILTIN_ILLUSTRATION_PRESET: IllustrationPreset = {
  ...emptyIllustrationPreset('기본'),
  id: DEFAULT_ILLUSTRATION_PRESET_ID,
  revision: 1,
  description: '추가 화풍 지침 없이 장면과 캐릭터를 따라 그려요. ComfyUI는 워크플로가 필요해요.',
};
export function defaultIllustrationPresetPreferences(): IllustrationPresetPreferences {
  return {
    revision: 0,
    defaultPresetId: DEFAULT_ILLUSTRATION_PRESET_ID,
    botPresets: {},
    chatPresets: {},
  };
}
export function illustrationPresetIds(
  p: IllustrationPresetPreferences,
  scope: IllustrationPresetScope
) {
  return [
    scope.chatId && p.chatPresets[scope.chatId],
    scope.botId && p.botPresets[scope.botId],
    p.defaultPresetId,
    DEFAULT_ILLUSTRATION_PRESET_ID,
  ].filter((id): id is string => !!id);
}
export function resolveIllustrationPreset(
  catalog: IllustrationPresetCatalog,
  scope: IllustrationPresetScope
): IllustrationPreset {
  for (const id of illustrationPresetIds(catalog.preferences, scope)) {
    const preset = catalog.presets.find((item) => item.id === id);
    if (preset) return preset;
  }
  return BUILTIN_ILLUSTRATION_PRESET;
}
export function illustrationPresetStamp(preset: IllustrationPreset): IllustrationPresetStamp {
  return { id: preset.id, revision: preset.revision, title: preset.title };
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('삽화 프리셋 객체가 필요해요.');
  return value as Record<string, unknown>;
}
function string(value: unknown, label: string, limit: number): string {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > limit)
    throw new Error(`${label}: 최대 ${limit.toLocaleString()}자의 문자열을 입력해 주세요.`);
  return value;
}
/** Explicit projection also strips local identities and environment fields on import/export. */
export function validateIllustrationPreset(value: unknown): IllustrationPresetDefinition {
  const v = object(value);
  const title = string(v.title, '프리셋 이름', 100).trim();
  if (!title) throw new Error('프리셋 이름을 입력해 주세요.');
  const comfyui = v.comfyui === undefined ? {} : object(v.comfyui);
  const workflow = string(comfyui.workflow, 'ComfyUI 워크플로', ILLUSTRATION_WORKFLOW_MAX_CHARS);
  if (workflow.trim()) parseComfyWorkflow(workflow);
  return {
    title,
    description: string(v.description, '설명', 2000),
    styleGuidance: string(v.styleGuidance, '그림 지침', SOURCE_TEXT_MAX_CHARS),
    comfyui: {
      workflow,
      negativeGuidance: string(comfyui.negativeGuidance, '제외 지침', SOURCE_TEXT_MAX_CHARS),
    },
  };
}
export function illustrationPresetDefinition(
  preset: IllustrationPreset
): IllustrationPresetDefinition {
  const { id: _id, revision: _revision, ...definition } = preset;
  return definition;
}
export function illustrationPresetFile(preset: IllustrationPresetDefinition) {
  return {
    format: ILLUSTRATION_PRESET_FORMAT,
    version: 1,
    preset: validateIllustrationPreset(preset),
  };
}
export function parseIllustrationPresetFile(value: unknown): IllustrationPresetDefinition {
  const file = object(value);
  if (file.format !== ILLUSTRATION_PRESET_FORMAT || file.version !== 1)
    throw new Error('Uimori 삽화 프리셋 v1 파일이 아니에요.');
  return validateIllustrationPreset(file.preset);
}
