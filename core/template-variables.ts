import { nativeRisuPresetVariableDefaults, type NativeRisuPreset } from './risu-native-preset.js';
import type { ProfileSnapshot } from './product.js';
import { PromptEvaluationError } from './prompt-values.js';
import { validateChatVariableValues, validateChatVariableState } from './chat-variables.js';

/** Minimal frozen declaration view, also usable before a new chat exists. */
export type TemplateVariableProfile = Pick<
  ProfileSnapshot,
  'packageAttachments' | 'packages' | 'variableState'
> & {
  promptPresets?: { main?: { program: { nativeRisuPreset: NativeRisuPreset } } };
};

/** Keys are authored data: preserve Unicode, whitespace and empty names exactly. */
export const validateTemplateVariableDefaults = validateChatVariableValues;

/** Read frozen declarations only. Attachment order wins; the main preset is the fallback. */
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
  for (const ref of profile?.packageAttachments ?? []) {
    const declaration = profile?.packages?.find(
      (pkg) => pkg.id === ref.id && pkg.revision === ref.revision
    )?.variableDefaults;
    if (declaration?.attachmentRoles && !declaration.attachmentRoles.includes(ref.role)) continue;
    append(declaration?.values);
  }
  const preset = profile?.promptPresets?.main?.program.nativeRisuPreset;
  if (preset) append(nativeRisuPresetVariableDefaults(preset));
  // Omit an empty value map when no source declares variables.
  return overflow
    ? { ...revision, variableDefaultsError: 'TEMPLATE_VARIABLE_DEFAULTS_LIMIT' }
    : result === undefined
      ? {}
      : { ...revision, variables: result };
}
