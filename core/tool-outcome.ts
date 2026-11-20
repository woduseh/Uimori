import type { ToolEvent } from './types.js';

export function toolResultChars(result: unknown): number | null {
  try {
    return JSON.stringify(result)?.length ?? null;
  } catch {
    return null;
  }
}

export function toolCorrectionOutcome(event: ToolEvent): 'continue' | 'denied' {
  return !event.denied || event.errorKind === 'recoverable' ? 'continue' : 'denied';
}
