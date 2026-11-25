import type { ToolEvent } from './types.js';

export function toolResultChars(result: unknown): number | null {
  try {
    return JSON.stringify(result)?.length ?? null;
  } catch {
    return null;
  }
}

export function unofferedToolCall<Call extends { name: string }>(
  offered: readonly { name: string }[],
  calls: readonly Call[]
): Call | undefined {
  return calls.find((call) => !offered.some((tool) => tool.name === call.name));
}

export function toolCorrectionOutcome(event: ToolEvent): 'continue' | 'denied' {
  return !event.denied || event.errorKind === 'recoverable' ? 'continue' : 'denied';
}
