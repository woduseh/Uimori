import type { ToolEvent } from './types.js';

/** Call, time and context budgets bound correction in the owning loop.
 * Provider uncertainty and unclassified denials remain terminal.
 */
export function toolCorrectionOutcome(event: ToolEvent): 'continue' | 'denied' {
  return !event.denied || event.errorKind === 'recoverable' ? 'continue' : 'denied';
}
