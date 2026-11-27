import { asContextFailureCode, type ContextFailureCode } from '../core/context-plan.js';
import { storedModelRequired } from './app-errors.js';
import { failureLabel } from './failure-label.js';

export function contextFailureCode(
  error: unknown,
  fallback: ContextFailureCode = 'CONTEXT_COMPACTION_FAILED'
): ContextFailureCode {
  const required = storedModelRequired(error);
  if (required) return required;
  const code = (error as { code?: unknown } | null)?.code;
  const known =
    asContextFailureCode(error instanceof Error ? error.message : '') ??
    (typeof code === 'string' ? asContextFailureCode(code) : undefined);
  if (known) return known;
  process.stderr.write(`CONTEXT_FAILURE_FOLDED ${fallback} ${failureLabel(error)}\n`);
  return fallback;
}
