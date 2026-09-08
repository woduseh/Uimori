import type { ToolEvent } from './types.js';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/** Local tool correction only. Provider uncertainty and unclassified denials remain terminal. */
export function createToolCorrectionPolicy() {
  let failures = 0;
  const repeated = new Map<string, number>();
  return (event: ToolEvent, args: Record<string, unknown>): 'continue' | 'denied' | 'exhausted' => {
    if (!event.denied) return 'continue';
    if (event.errorKind !== 'recoverable') return 'denied';
    const key = `${event.name}:${canonical(args)}`;
    const count = (repeated.get(key) ?? 0) + 1;
    repeated.set(key, count);
    failures++;
    return failures > 3 || count >= 2 ? 'exhausted' : 'continue';
  };
}
