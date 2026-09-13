import type { ProfileSnapshot } from './product.js';
import { historicalPersonaExcluded } from './persona-scope.js';
import {
  evaluationFail,
  inspectRuntimeValue,
  PromptBudget,
  PromptEvaluationError,
} from './prompt-values.js';

/** Minimal frozen declaration view, also usable before a new chat exists. */
export type TemplateVariableProfile = Pick<
  ProfileSnapshot,
  'packageAttachments' | 'packages' | 'personaReference'
> & {
  promptPresets?: { main?: { program: { variableDefaults?: Record<string, string> } } };
};

/** Declaration limits fit the existing prompt AST and runtime value budgets. */
export const TEMPLATE_VARIABLE_LIMITS = {
  maxEntries: 2000,
  maxValueChars: 200_000,
  maxTotalChars: 1_000_000,
} as const;

/** Keys are authored data: preserve Unicode, whitespace and empty names exactly. */
export function validateTemplateVariableDefaults(value: unknown): Record<string, string> {
  inspectRuntimeValue(
    value,
    new PromptBudget(
      {
        maxCollectionLength: TEMPLATE_VARIABLE_LIMITS.maxEntries,
        maxValueChars: TEMPLATE_VARIABLE_LIMITS.maxTotalChars,
      },
      'deterministic'
    )
  );
  if (!value || typeof value !== 'object' || Array.isArray(value))
    evaluationFail('TEMPLATE_VARIABLE_DEFAULTS_INVALID');
  for (const text of Object.values(value))
    if (typeof text !== 'string' || text.length > TEMPLATE_VARIABLE_LIMITS.maxValueChars)
      evaluationFail('TEMPLATE_VARIABLE_DEFAULTS_INVALID');
  return structuredClone(value) as Record<string, string>;
}

/** Read frozen declarations only. Attachment order wins; the main preset is the fallback. */
export type TemplateVariableContext = {
  variables?: Record<string, string>;
  variableDefaultsError?: 'TEMPLATE_VARIABLE_DEFAULTS_LIMIT';
};

export function resolveTemplateVariableContext(
  profile: TemplateVariableProfile | undefined,
  target = 'main'
): TemplateVariableContext {
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
    ? { variableDefaultsError: 'TEMPLATE_VARIABLE_DEFAULTS_LIMIT' }
    : result === undefined
      ? {}
      : { variables: result };
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
