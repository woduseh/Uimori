import type { ToolEvent } from './types.js';

/** Count the serialized result without retaining another copy of its content. */
export function toolResultChars(result: unknown): number | null {
  try {
    return JSON.stringify(result)?.length ?? null;
  } catch {
    return null;
  }
}

/** Call, time and context budgets bound correction in the owning loop.
 * Provider uncertainty and unclassified denials remain terminal.
 */
export function toolCorrectionOutcome(event: ToolEvent): 'continue' | 'denied' {
  return !event.denied || event.errorKind === 'recoverable' ? 'continue' : 'denied';
}
