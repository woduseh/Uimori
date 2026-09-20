export type RisuRegexRecord = Record<string, unknown>;

export const regexRecord = (value: unknown): value is RisuRegexRecord =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export const regexText = (value: unknown) => (typeof value === 'string' ? value : '');

/** Native in/out own execution. Keep existing editor aliases aligned only when that field changes. */
export function patchNativeRegex(entry: RisuRegexRecord, patch: RisuRegexRecord) {
  const next = { ...entry, ...patch };
  if (Object.hasOwn(patch, 'in') && Object.hasOwn(entry, 'find')) next.find = patch.in;
  if (Object.hasOwn(patch, 'out') && Object.hasOwn(entry, 'replace')) next.replace = patch.out;
  return next;
}

export function readNativeRegexFlags(flag: string) {
  const actions: string[] = [];
  const flags = flag.replace(/<([^>]+)>/gu, (_tag, body: string) => {
    actions.push(...body.split(',').map((part) => part.trim()));
    return '';
  });
  let order = 0;
  for (const action of actions)
    if (action.startsWith('order ')) order = Number.parseInt(action.slice(6), 10) || 0;
  return { flags, actions, order };
}

/** Edit only the selected character outside tags, preserving unknown native flag extensions. */
export function toggleNativeRegexFlag(flag: string, key: string) {
  if (!readNativeRegexFlags(flag).flags.includes(key)) return flag + key;
  return flag
    .split(/(<[^>]+>)/u)
    .map((part) => (part.startsWith('<') ? part : part.replaceAll(key, '')))
    .join('');
}

function removeAction(flag: string, matches: (action: string) => boolean) {
  return flag.replace(/<([^>]+)>/gu, (tag, body: string) => {
    const parts = body.split(',');
    if (!parts.some((part) => matches(part.trim()))) return tag;
    const keep = parts.filter((part) => !matches(part.trim()));
    return keep.length ? `<${keep.join(',')}>` : '';
  });
}

export function toggleNativeRegexAction(flag: string, action: string) {
  return readNativeRegexFlags(flag).actions.includes(action)
    ? removeAction(flag, (part) => part === action)
    : `${flag}<${action}>`;
}

export function setNativeRegexOrder(flag: string, order: number) {
  return `${removeAction(flag, (part) => part.startsWith('order '))}<order ${order}>`;
}

export function parseNativeRegexJson(text: string): RisuRegexRecord[] {
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value) || value.some((item) => !regexRecord(item)))
    throw new Error('정규식은 JSON 객체의 배열이어야 해요.');
  return value;
}
