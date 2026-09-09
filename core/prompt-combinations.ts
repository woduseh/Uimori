import type {
  CurrentPrompt,
  PromptCombinationOwner,
  PromptRole,
  SavedPromptCombination,
} from './product.js';
import type { PromptProgram } from './prompt-program.js';

export function combinationOwner(current: CurrentPrompt, role: PromptRole): PromptCombinationOwner {
  return current.presetId ? { kind: 'preset', id: current.presetId } : { kind: 'workspace', role };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export function matchesPromptCombination(
  item: SavedPromptCombination,
  owner: PromptCombinationOwner,
  role: PromptRole,
  program: PromptProgram
): boolean {
  return (
    item.role === role &&
    item.owner !== undefined &&
    item.controls !== undefined &&
    canonical(item.owner) === canonical(owner) &&
    canonical(item.controls) === canonical(program.controls)
  );
}
