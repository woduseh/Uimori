import { evaluationFail, inspectRuntimeValue, PromptBudget } from './prompt-values.js';

/** Branch-owned overrides. Missing keys continue to resolve from authored defaults. */
export interface ChatVariableState {
  revision: number;
  values: Record<string, string>;
}

export const CHAT_VARIABLE_LIMITS = {
  maxEntries: 2000,
  maxValueChars: 200_000,
  maxTotalChars: 1_000_000,
} as const;

/** Shared validation for authored defaults and stored overrides; keys are authored data. */
export function validateChatVariableValues(value: unknown): Record<string, string> {
  inspectRuntimeValue(
    value,
    new PromptBudget(
      {
        maxCollectionLength: CHAT_VARIABLE_LIMITS.maxEntries,
        maxValueChars: CHAT_VARIABLE_LIMITS.maxTotalChars,
      },
      'deterministic'
    )
  );
  if (!value || typeof value !== 'object' || Array.isArray(value))
    evaluationFail('TEMPLATE_VARIABLE_DEFAULTS_INVALID');
  for (const text of Object.values(value))
    if (typeof text !== 'string' || text.length > CHAT_VARIABLE_LIMITS.maxValueChars)
      evaluationFail('TEMPLATE_VARIABLE_DEFAULTS_INVALID');
  return structuredClone(value) as Record<string, string>;
}

export function validateChatVariableState(value: unknown): ChatVariableState {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    evaluationFail('CHAT_VARIABLE_STATE_INVALID');
  const proto = Object.getPrototypeOf(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    (proto !== Object.prototype && proto !== null) ||
    Reflect.ownKeys(value).length !== 2 ||
    !descriptors.revision ||
    !descriptors.values ||
    !Object.hasOwn(descriptors.revision, 'value') ||
    !Object.hasOwn(descriptors.values, 'value') ||
    !descriptors.revision.enumerable ||
    !descriptors.values.enumerable
  )
    evaluationFail('CHAT_VARIABLE_STATE_INVALID');
  const revision = descriptors.revision.value;
  if (!Number.isSafeInteger(revision) || revision < 0)
    evaluationFail('CHAT_VARIABLE_STATE_INVALID');
  const values = validateChatVariableValues(descriptors.values.value);
  if (revision === 0 && Object.keys(values).length) evaluationFail('CHAT_VARIABLE_STATE_INVALID');
  return { revision, values };
}
