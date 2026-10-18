import { promptControls } from './risu-prompt.js';
import type {
  CurrentPrompt,
  PromptCombinationOwner,
  PromptRole,
  SavedPromptCombination,
} from './product.js';
import type { RisuPrompt } from './risu-prompt.js';

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
  program: RisuPrompt
): boolean {
  return (
    ownsPromptCombination(item, owner, role) &&
    item.controls !== undefined &&
    canonical(item.controls) === canonical(promptControls(program))
  );
}

/** Management keeps obsolete definitions visible; application still requires an exact match. */
export function ownsPromptCombination(
  item: SavedPromptCombination,
  owner: PromptCombinationOwner,
  role: PromptRole
): boolean {
  return (
    item.role === role && item.owner !== undefined && canonical(item.owner) === canonical(owner)
  );
}

/** Only values whose meaning and accepted type survive a definition change are prefilled. */
export function repairPromptCombinationValues(
  item: SavedPromptCombination,
  program: RisuPrompt
): SavedPromptCombination['values'] {
  const previous = item.controls ?? [];
  return Object.fromEntries(
    promptControls(program).flatMap((control) => {
      const old = previous.find((entry) => entry.id === control.id);
      const value = item.values[control.id];
      if (
        !old ||
        old.type !== control.type ||
        old.input !== control.input ||
        old.nativeKey !== control.nativeKey ||
        old.label !== control.label ||
        value === undefined
      )
        return [];
      if (control.type === 'select' && !control.options?.some((option) => option.value === value))
        return [];
      if (
        control.type === 'select' &&
        old.options?.find((option) => option.value === value)?.label !==
          control.options?.find((option) => option.value === value)?.label
      )
        return [];
      if (control.type === 'text' && typeof value !== 'string') return [];
      return [[control.id, value]];
    })
  );
}
