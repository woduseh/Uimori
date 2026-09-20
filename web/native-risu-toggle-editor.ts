export const nativeToggleTypes = [
  'toggle',
  'select',
  'text',
  'textarea',
  'divider',
  'caption',
  'group',
  'groupEnd',
] as const;
export type NativeToggleType = (typeof nativeToggleTypes)[number];
export type NativeToggleDefinition = {
  type: NativeToggleType;
  key: string;
  label: string;
  /** Comma-separated native options, including deliberately empty options. */
  options: string;
};
export type NativeToggleLine = {
  raw: string;
  ending: string;
  definition: NativeToggleDefinition | null;
};

/** Only expose grammar we can edit without interpreting away unknown fields. */
function definition(raw: string): NativeToggleDefinition | null {
  const parts = raw.split('=');
  if (parts.length < 2 || parts.length > 4) return null;
  const [key = '', label = '', marker, options = ''] = parts;
  if (marker === undefined && key) return { type: 'toggle', key, label, options: '' };
  if (!nativeToggleTypes.some((type) => type !== 'toggle' && type === marker)) return null;
  const type = marker as NativeToggleType;
  if (parts.length > 3 && type !== 'select') return null;
  if (['toggle', 'select', 'text', 'textarea'].includes(type) && !key) return null;
  return { type, key, label, options };
}

export function parseNativeToggleLines(value: string): NativeToggleLine[] {
  if (!value) return [];
  const lines: NativeToggleLine[] = [];
  const pattern = /([^\r\n]*)(\r\n|\r|\n|$)/g;
  for (const match of value.matchAll(pattern)) {
    if (!match[0]) continue;
    const raw = match[1] ?? '';
    lines.push({ raw, ending: match[2] ?? '', definition: definition(raw) });
  }
  return lines;
}

export function serializeNativeToggleLines(lines: NativeToggleLine[]): string {
  return lines.map((line) => line.raw + line.ending).join('');
}

export function serializeNativeToggleDefinition(item: NativeToggleDefinition): string {
  if ([item.key, item.label, item.options].some((part) => /[=\r\n]/.test(part))) {
    throw new Error('정의 필드에는 등호나 줄바꿈을 넣을 수 없어요. 원문에서 편집해 주세요.');
  }
  if (['toggle', 'select', 'text', 'textarea'].includes(item.type) && !item.key) {
    throw new Error('변수 키를 입력해 주세요.');
  }
  if (item.type === 'toggle') return `${item.key}=${item.label}`;
  if (item.type === 'select') return `${item.key}=${item.label}=select=${item.options}`;
  return `${item.key}=${item.label}=${item.type}`;
}

export function editNativeToggleLine(
  value: string,
  index: number,
  patch: Partial<NativeToggleDefinition>
): string {
  const lines = parseNativeToggleLines(value);
  const line = lines[index];
  if (!line?.definition) return value;
  const next = { ...line.definition, ...patch };
  if (
    Object.keys(patch).every(
      (key) =>
        next[key as keyof NativeToggleDefinition] ===
        line.definition?.[key as keyof NativeToggleDefinition]
    )
  )
    return value;
  line.raw = serializeNativeToggleDefinition(next);
  return serializeNativeToggleLines(lines);
}

export function addNativeToggleLine(value: string, type: NativeToggleType): string {
  const lines = parseNativeToggleLines(value);
  // An unknown suffix can still be a working toggle in Risu; reserve its key too.
  const keys = new Set(lines.map((line) => line.raw.split('=')[0]));
  let key = 'new_toggle';
  for (let i = 2; keys.has(key); i++) key = `new_toggle_${i}`;
  const control = ['toggle', 'select', 'text', 'textarea'].includes(type);
  const raw = serializeNativeToggleDefinition({
    type,
    key: control ? key : '',
    label: type === 'groupEnd' ? '' : '새 항목',
    options: type === 'select' ? '선택 1,선택 2' : '',
  });
  const ending = lines.find((line) => line.ending)?.ending ?? '\n';
  const last = lines.at(-1);
  const separator = last && !last.ending ? ending : '';
  return value + separator + raw;
}

export function removeNativeToggleLine(value: string, index: number): string {
  return serializeNativeToggleLines(parseNativeToggleLines(value).filter((_, i) => i !== index));
}

export function moveNativeToggleLine(value: string, index: number, delta: number): string {
  const lines = parseNativeToggleLines(value);
  const target = index + delta;
  if (!lines[index] || !lines[target]) return value;
  // Keep line separators at their positions, including an absent final newline.
  const source = lines[index];
  const other = lines[target];
  lines[index] = { ...other, ending: source.ending };
  lines[target] = { ...source, ending: other.ending };
  return serializeNativeToggleLines(lines);
}

export function nativeToggleGroupWarnings(lines: NativeToggleLine[]): string[] {
  const warnings: string[] = [];
  let open = false;
  for (const [index, line] of lines.entries()) {
    if (line.definition?.type === 'group') {
      if (open) warnings.push(`${index + 1}행: Risu 그룹은 중첩할 수 없어요.`);
      open = true;
    } else if (line.definition?.type === 'groupEnd') {
      if (!open) warnings.push(`${index + 1}행: 대응하는 그룹 시작이 없어요.`);
      open = false;
    }
  }
  if (open) warnings.push('닫히지 않은 그룹이 있어요. 그룹 끝 항목을 추가해 주세요.');
  return warnings;
}
