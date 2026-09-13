import type { ProfileSnapshot } from './product.js';
import { historicalPersonaExcluded } from './persona-scope.js';
import { PromptEvaluationError } from './prompt-values.js';
import {
  CHAT_VARIABLE_LIMITS,
  validateChatVariableValues,
  validateChatVariableState,
} from './chat-variables.js';

/** Minimal frozen declaration view, also usable before a new chat exists. */
export type TemplateVariableProfile = Pick<
  ProfileSnapshot,
  'packageAttachments' | 'packages' | 'personaReference' | 'variableState'
> & {
  promptPresets?: { main?: { program: { variableDefaults?: Record<string, string> } } };
};

/** Declaration limits fit the existing prompt AST and runtime value budgets. */
export const TEMPLATE_VARIABLE_LIMITS = CHAT_VARIABLE_LIMITS;

/** Keys are authored data: preserve Unicode, whitespace and empty names exactly. */
export const validateTemplateVariableDefaults = validateChatVariableValues;

/** Read frozen declarations only. Attachment order wins; the main preset is the fallback. */
export type TemplateVariableContext = {
  variables?: Record<string, string>;
  variableStateRevision?: number;
  variableDefaultsError?: 'TEMPLATE_VARIABLE_DEFAULTS_LIMIT';
};

export function resolveTemplateVariableContext(
  profile: TemplateVariableProfile | undefined,
  target = 'main'
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
    if (historicalPersonaExcluded(profile, ref.role, target)) continue;
    const declaration = profile?.packages?.find(
      (pkg) => pkg.id === ref.id && pkg.revision === ref.revision
    )?.variableDefaults;
    if (declaration?.attachmentRoles && !declaration.attachmentRoles.includes(ref.role)) continue;
    append(declaration?.values);
  }
  append(profile?.promptPresets?.main?.program.variableDefaults);
  // Do not add an empty runtime field to historical profiles without declarations.
  return overflow
    ? { ...revision, variableDefaultsError: 'TEMPLATE_VARIABLE_DEFAULTS_LIMIT' }
    : result === undefined
      ? {}
      : { ...revision, variables: result };
}

/** Values-only facade for consumers that do not render a template or report diagnostics. */
export function resolveTemplateVariables(
  profile: TemplateVariableProfile | undefined,
  target = 'main'
): Record<string, string> | undefined {
  return resolveTemplateVariableContext(profile, target).variables;
}

/** Literal objects are authored data, not expressions that read host variables. */
export function templateReadsVariables(value: unknown): boolean {
  const pending = [value];
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== 'object') continue;
    if (!Array.isArray(node)) {
      if (Object.hasOwn(node, 'literal')) continue;
      const path = (node as Record<string, unknown>).context;
      if (Array.isArray(path) && path[0] === 'variables') return true;
    }
    pending.push(...Object.values(node));
  }
  return false;
}
