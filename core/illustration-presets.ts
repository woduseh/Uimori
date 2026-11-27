import { SOURCE_TEXT_MAX_CHARS } from './content-limits.js';
import { parseComfyWorkflow } from './illustration-workflow.js';
import { ValidationError } from './validation-error.js';

export type IllustrationPresetGenerator = 'codex' | 'comfyui' | 'novelai';
export type IllustrationPresetDefinition = {
  title: string;
  generator: IllustrationPresetGenerator;
  description: string;
  styleGuidance: string;
  comfyui: { workflow: string; negativeGuidance: string };
  novelai: { negativeGuidance: string };
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
export const ILLUSTRATION_PRESET_TITLE_MAX_CHARS = 100;
export const ILLUSTRATION_WORKFLOW_MAX_CHARS = 400_000;
export const ILLUSTRATION_PRESET_FILE_MAX_BYTES = 16 * 1024 * 1024;
export const DEFAULT_ILLUSTRATION_PRESET_ID = 'builtin:illustration-default';
export function emptyIllustrationPreset(title = '새 삽화 프리셋'): IllustrationPresetDefinition {
  return {
    title,
    generator: 'codex',
    description: '',
    styleGuidance: '',
    comfyui: { workflow: '', negativeGuidance: '' },
    novelai: { negativeGuidance: '' },
  };
}
export const BUILTIN_ILLUSTRATION_PRESET: IllustrationPreset = {
  ...emptyIllustrationPreset('기본'),
  id: DEFAULT_ILLUSTRATION_PRESET_ID,
  revision: 1,
  description: '추가 화풍 지침 없이 Codex로 장면과 캐릭터를 따라 그려요.',
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
    throw new ValidationError(
      400,
      'ILLUSTRATION_PRESET_OBJECT_REQUIRED',
      'Expected an illustration preset object.'
    );
  return value as Record<string, unknown>;
}
function string(value: unknown, field: string, limit: number): string {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > limit)
    throw new ValidationError(
      400,
      'ILLUSTRATION_PRESET_FIELD_TOO_LONG',
      `${field}: expected a string of at most ${limit} characters.`,
      { field, limit }
    );
  return value;
}
export function validateIllustrationPreset(value: unknown): IllustrationPresetDefinition {
  const v = object(value);
  const title = string(v.title, 'title', ILLUSTRATION_PRESET_TITLE_MAX_CHARS).trim();
  if (!title)
    throw new ValidationError(400, 'ILLUSTRATION_PRESET_TITLE_REQUIRED', 'title: enter a name.');
  const comfyui = v.comfyui === undefined ? {} : object(v.comfyui);
  const workflow = string(comfyui.workflow, 'comfyui.workflow', ILLUSTRATION_WORKFLOW_MAX_CHARS);
  if (workflow.trim()) parseComfyWorkflow(workflow);
  const novelai = v.novelai === undefined ? {} : object(v.novelai);
  const generator =
    v.generator === undefined ? (workflow.trim() ? 'comfyui' : 'codex') : v.generator;
  if (generator !== 'codex' && generator !== 'comfyui' && generator !== 'novelai')
    throw new ValidationError(
      400,
      'ILLUSTRATION_PRESET_GENERATOR_INVALID',
      'generator: expected codex, comfyui or novelai.'
    );
  return {
    title,
    generator,
    description: string(v.description, 'description', 2000),
    styleGuidance: string(v.styleGuidance, 'styleGuidance', SOURCE_TEXT_MAX_CHARS),
    comfyui: {
      workflow,
      negativeGuidance: string(
        comfyui.negativeGuidance,
        'comfyui.negativeGuidance',
        SOURCE_TEXT_MAX_CHARS
      ),
    },
    novelai: {
      negativeGuidance: string(
        novelai.negativeGuidance,
        'novelai.negativeGuidance',
        SOURCE_TEXT_MAX_CHARS
      ),
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
    version: 2,
    preset: validateIllustrationPreset(preset),
  };
}
export function parseIllustrationPresetFile(value: unknown): IllustrationPresetDefinition {
  const file = object(value);
  if (
    file.format !== ILLUSTRATION_PRESET_FORMAT ||
    ![1, 2].includes(Number(file.version)) ||
    typeof file.version !== 'number'
  )
    throw new ValidationError(
      400,
      'ILLUSTRATION_PRESET_FILE_UNSUPPORTED',
      `Expected format "${ILLUSTRATION_PRESET_FORMAT}" with version 1 or 2.`
    );
  const preset = object(file.preset);
  if (file.version === 2 && preset.generator === undefined)
    throw new ValidationError(
      400,
      'ILLUSTRATION_PRESET_GENERATOR_REQUIRED',
      'preset.generator: a version 2 file needs codex, comfyui or novelai.'
    );
  return validateIllustrationPreset(
    file.version === 1 ? { ...preset, generator: undefined } : preset
  );
}
