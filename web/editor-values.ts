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
  const keys = Object.keys(before).filter((key) => before[key] !== undefined);
  return (
    keys.length === Object.keys(after).filter((key) => after[key] !== undefined).length &&
    keys.every((key) => Object.hasOwn(after, key) && sameEditorValue(before[key], after[key]))
  );
}

const container = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object';
const pointer = (key: string) => key.replaceAll('~', '~0').replaceAll('/', '~1');

export function changedValuePaths(left: unknown, right: unknown, path = ''): string[] {
  if (sameEditorValue(left, right)) return [];
  if (!container(left) || !container(right) || Array.isArray(left) !== Array.isArray(right))
    return [path];
  const lists = Array.isArray(left) && Array.isArray(right);
  const keys = lists
    ? Array.from({ length: Math.max(left.length, right.length) }, (_, index) => String(index))
    : [...new Set([...Object.keys(left), ...Object.keys(right)])];
  const paths = keys.flatMap((key) =>
    changedValuePaths(
      lists ? (left[Number(key)] ?? null) : left[key],
      lists ? (right[Number(key)] ?? null) : right[key],
      `${path}/${pointer(key)}`
    )
  );
  return paths.length ? paths : [path];
}
