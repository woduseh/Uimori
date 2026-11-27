import { UiError, uiMessage, type UiMessage } from './ui-message.js';
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
  options: string;
};
export type NativeToggleLine = {
  raw: string;
  ending: string;
  definition: NativeToggleDefinition | null;
};

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
    throw new UiError(uiMessage('native.toggleFieldInvalid'));
  }
  if (['toggle', 'select', 'text', 'textarea'].includes(item.type) && !item.key) {
    throw new UiError(uiMessage('native.variableKeyRequired'));
  }
  if (item.type === 'toggle') return `${item.key}=${item.label}`;
  if (item.type === 'select') return `${item.key}=${item.label}=select=${item.options}`;
  return `${item.key}=${item.label}=${item.type}`;
}

export function nativeToggleGroupWarnings(lines: NativeToggleLine[]): UiMessage[] {
  const warnings: UiMessage[] = [];
  let open = false;
  for (const [index, line] of lines.entries()) {
    if (line.definition?.type === 'group') {
      if (open) warnings.push(uiMessage('native.nestedGroup', { line: index + 1 }));
      open = true;
    } else if (line.definition?.type === 'groupEnd') {
      if (!open) warnings.push(uiMessage('native.unmatchedGroup', { line: index + 1 }));
      open = false;
    }
  }
  if (open) warnings.push(uiMessage('native.unclosedGroup'));
  return warnings;
}
