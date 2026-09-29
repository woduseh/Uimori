/** Editor models are plain JSON data. Shared branches need no serialization. */
export function sameEditorValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) return false;
    for (let i = 0; i < left.length; i++)
      if (!sameEditorValue(left[i] ?? null, right[i] ?? null)) return false;
    return true;
  }
  if (Array.isArray(right)) return false;
  const before = left as Record<string, unknown>;
  const after = right as Record<string, unknown>;
  // Optional undefined fields are omitted from saves, as they were by JSON.stringify.
  const keys = Object.keys(before).filter((key) => before[key] !== undefined);
  return (
    keys.length === Object.keys(after).filter((key) => after[key] !== undefined).length &&
    keys.every((key) => Object.hasOwn(after, key) && sameEditorValue(before[key], after[key]))
  );
}
