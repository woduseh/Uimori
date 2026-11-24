import { nativeRisuPresetVariableDefaults, type NativeRisuPreset } from './risu-native-preset.js';
import type { ProfileSnapshot } from './product.js';
import type { ContentRole } from './risu-content.js';
import { PromptEvaluationError } from './prompt-values.js';
import { validateChatVariableValues, validateChatVariableState } from './chat-variables.js';

export type TemplateVariableProfile = Pick<
  ProfileSnapshot,
  'packageAttachments' | 'packages' | 'variableState'
> & {
  promptPresets?: {
    main?: { title?: string; program: { nativeRisuPreset: NativeRisuPreset } };
  };
};

export type TemplateVariableOrigin =
  | { kind: 'package'; role: ContentRole; title: string }
  | { kind: 'preset'; title: string };

function templateVariableSources(profile: TemplateVariableProfile | undefined) {
  const sources: { origin: TemplateVariableOrigin; values: Record<string, string> }[] = [];
  for (const ref of profile?.packageAttachments ?? []) {
    const content = profile?.packages?.find(
      (pkg) => pkg.id === ref.id && pkg.revision === ref.revision
    );
    const declaration = content?.variableDefaults;
    if (!content || !declaration) continue;
    if (declaration.attachmentRoles && !declaration.attachmentRoles.includes(ref.role)) continue;
    sources.push({
      origin: { kind: 'package', role: ref.role, title: content.title },
      values: declaration.values,
    });
  }
  const preset = profile?.promptPresets?.main;
  const presetDefaults =
    preset && nativeRisuPresetVariableDefaults(preset.program.nativeRisuPreset);
  if (preset && presetDefaults)
    sources.push({
      origin: { kind: 'preset', title: preset.title ?? '' },
      values: presetDefaults,
    });
  return sources;
}

export function templateVariableOrigins(
  profile: TemplateVariableProfile | undefined
): Record<string, TemplateVariableOrigin> {
  const origins: Record<string, TemplateVariableOrigin> = {};
  for (const { origin, values } of templateVariableSources(profile))
    for (const key of Object.keys(values)) if (!Object.hasOwn(origins, key)) origins[key] = origin;
  return origins;
}

export const validateTemplateVariableDefaults = validateChatVariableValues;

export type TemplateVariableContext = {
  variables?: Record<string, string>;
  variableStateRevision?: number;
  variableDefaultsError?: 'TEMPLATE_VARIABLE_DEFAULTS_LIMIT';
};

export function resolveTemplateVariableContext(
  profile: TemplateVariableProfile | undefined
): TemplateVariableContext {
  const state =
    profile?.variableState === undefined
      ? undefined
      : validateChatVariableState(profile.variableState);
  const revision = state ? { variableStateRevision: state.revision } : {};
  let result: Record<string, string> | undefined;
  let overflow = false;
  const append = (defaults: Record<string, string> | undefined) => {
    if (defaults === undefined || overflow) return;
    const values = validateTemplateVariableDefaults(defaults);
    result ??= {};
    for (const [key, value] of Object.entries(values))
      if (!Object.hasOwn(result, key)) result[key] = value;
    try {
      validateTemplateVariableDefaults(result);
    } catch (error) {
      if (!(error instanceof PromptEvaluationError)) throw error;
      overflow = true;
      result = undefined;
    }
  };
  if (state) append(state.values);
  for (const { values } of templateVariableSources(profile)) append(values);
  return overflow
    ? { ...revision, variableDefaultsError: 'TEMPLATE_VARIABLE_DEFAULTS_LIMIT' }
    : result === undefined
      ? {}
      : { ...revision, variables: result };
}
