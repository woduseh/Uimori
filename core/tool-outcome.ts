import type { ToolEvent } from './types.js';

/** Call, time and context budgets bound correction in the owning loop.
 * Provider uncertainty and unclassified denials remain terminal.
 */
export function createToolCorrectionPolicy() {
  return (event: ToolEvent, _args: Record<string, unknown>): 'continue' | 'denied' => {
    return !event.denied || event.errorKind === 'recoverable' ? 'continue' : 'denied';
  };
}
