import type { CbsDiagnostic } from './cbs-analysis.js';

export const EDITOR_FOCUS_SELECTION_MAX_CHARS = 2000;
export const EDITOR_FOCUS_DIAGNOSTICS_MAX = 10;
export const EDITOR_FOCUS_LABEL_MAX_CHARS = 200;
export const EDITOR_FOCUS_NAME_MAX_CHARS = 100;
export const EDITOR_FOCUS_SECTIONS_MAX = 32;

export type EditorFocusLanguage = 'cbs' | 'html' | 'lua';
export type EditorFocusItem = { index: number; label: string; id?: string };
export type EditorFocusField = {
  section: string;
  item: number | null;
  field: string;
  label: string;
  language: EditorFocusLanguage;
  length: number;
  usesCbs?: true;
};
export type EditorFocusSelection = { from: number; to: number; text: string; truncated?: true };
export type EditorFocusDiagnostic = {
  code: CbsDiagnostic['code'];
  severity: CbsDiagnostic['severity'];
  from: number;
  to: number;
  line: number;
  column: number;
  name?: string;
};
export type EditorFocus = {
  section: string;
  item?: EditorFocusItem;
  field?: EditorFocusField;
  selection?: EditorFocusSelection;
  diagnostics?: EditorFocusDiagnostic[];
  diagnosticsOmitted?: number;
  diagnostic?: EditorFocusDiagnostic;
  unsavedSections?: string[];
};

const DIAGNOSTIC_CODES: readonly CbsDiagnostic['code'][] = [
  'cbs.unclosed-call',
  'cbs.unclosed-block',
  'cbs.stray-closer',
  'cbs.else-outside-when',
  'cbs.unknown-function',
];
const LANGUAGES: readonly EditorFocusLanguage[] = ['cbs', 'html', 'lua'];

export function editorFocusSelection(
  text: string,
  from: number,
  to: number
): EditorFocusSelection | undefined {
  const start = Math.max(0, Math.min(from, to, text.length));
  const end = Math.min(text.length, Math.max(from, to));
  if (end <= start) return undefined;
  const truncated = end - start > EDITOR_FOCUS_SELECTION_MAX_CHARS;
  return {
    from: start,
    to: end,
    text: text.slice(start, truncated ? start + EDITOR_FOCUS_SELECTION_MAX_CHARS : end),
    ...(truncated ? { truncated: true as const } : {}),
  };
}

function position(text: string, offset: number) {
  let line = 1;
  let start = 0;
  for (let at = text.indexOf('\n'); at >= 0 && at < offset; at = text.indexOf('\n', at + 1)) {
    line++;
    start = at + 1;
  }
  return { line, column: offset - start + 1 };
}

export function editorFocusDiagnostic(
  text: string,
  diagnostic: CbsDiagnostic
): EditorFocusDiagnostic {
  return {
    code: diagnostic.code,
    severity: diagnostic.severity,
    from: diagnostic.from,
    to: diagnostic.to,
    ...position(text, diagnostic.from),
    ...(diagnostic.name ? { name: diagnostic.name.slice(0, EDITOR_FOCUS_NAME_MAX_CHARS) } : {}),
  };
}

export function editorFocusDiagnostics(text: string, diagnostics: readonly CbsDiagnostic[]) {
  return {
    diagnostics: diagnostics
      .slice(0, EDITOR_FOCUS_DIAGNOSTICS_MAX)
      .map((diagnostic) => editorFocusDiagnostic(text, diagnostic)),
    omitted: Math.max(0, diagnostics.length - EDITOR_FOCUS_DIAGNOSTICS_MAX),
  };
}

export function editorFocusKey(focus: EditorFocus | null | undefined) {
  if (!focus) return '';
  return JSON.stringify([
    focus.section,
    focus.item?.index ?? null,
    focus.field ? `${focus.field.section}:${focus.field.item ?? ''}:${focus.field.field}` : null,
    focus.selection ? [focus.selection.from, focus.selection.to] : null,
    focus.diagnostic ? [focus.diagnostic.code, focus.diagnostic.from] : null,
  ]);
}

function fail(what: string): never {
  throw new Error(`Invalid editor focus: ${what}`);
}
function object(value: unknown, what: string, keys: readonly string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(what);
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${what}.${key}`);
  return value as Record<string, unknown>;
}
function string(value: unknown, what: string, max: number, empty = false) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value)) fail(what);
  return value;
}
function count(value: unknown, what: string, minimum = 0) {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) fail(what);
  return value as number;
}
function diagnostic(value: unknown, what: string): EditorFocusDiagnostic {
  const input = object(value, what, ['code', 'severity', 'from', 'to', 'line', 'column', 'name']);
  if (!DIAGNOSTIC_CODES.includes(input.code as CbsDiagnostic['code'])) fail(`${what}.code`);
  if (input.severity !== 'error' && input.severity !== 'warning') fail(`${what}.severity`);
  const from = count(input.from, `${what}.from`);
  const to = count(input.to, `${what}.to`);
  if (to < from) fail(`${what}.to`);
  return {
    code: input.code as CbsDiagnostic['code'],
    severity: input.severity,
    from,
    to,
    line: count(input.line, `${what}.line`, 1),
    column: count(input.column, `${what}.column`, 1),
    ...(input.name === undefined
      ? {}
      : { name: string(input.name, `${what}.name`, EDITOR_FOCUS_NAME_MAX_CHARS) }),
  };
}

export function parseEditorFocus(value: unknown): EditorFocus {
  const input = object(value, 'focus', [
    'section',
    'item',
    'field',
    'selection',
    'diagnostics',
    'diagnosticsOmitted',
    'diagnostic',
    'unsavedSections',
  ]);
  const focus: EditorFocus = {
    section: string(input.section, 'section', EDITOR_FOCUS_NAME_MAX_CHARS),
  };
  if (input.item !== undefined) {
    const item = object(input.item, 'item', ['index', 'label', 'id']);
    focus.item = {
      index: count(item.index, 'item.index'),
      label: string(item.label, 'item.label', EDITOR_FOCUS_LABEL_MAX_CHARS, true),
      ...(item.id === undefined
        ? {}
        : { id: string(item.id, 'item.id', EDITOR_FOCUS_NAME_MAX_CHARS) }),
    };
  }
  if (input.field !== undefined) {
    const field = object(input.field, 'field', [
      'section',
      'item',
      'field',
      'label',
      'language',
      'length',
      'usesCbs',
    ]);
    if (!LANGUAGES.includes(field.language as EditorFocusLanguage)) fail('field.language');
    if (field.usesCbs !== undefined && field.usesCbs !== true) fail('field.usesCbs');
    focus.field = {
      section: string(field.section, 'field.section', EDITOR_FOCUS_NAME_MAX_CHARS),
      item: field.item === null ? null : count(field.item, 'field.item'),
      field: string(field.field, 'field.field', EDITOR_FOCUS_NAME_MAX_CHARS),
      label: string(field.label, 'field.label', EDITOR_FOCUS_LABEL_MAX_CHARS, true),
      language: field.language as EditorFocusLanguage,
      length: count(field.length, 'field.length'),
      ...(field.usesCbs ? { usesCbs: true as const } : {}),
    };
  }
  if (input.selection !== undefined) {
    if (!focus.field) fail('selection');
    const selection = object(input.selection, 'selection', ['from', 'to', 'text', 'truncated']);
    const from = count(selection.from, 'selection.from');
    const to = count(selection.to, 'selection.to');
    const text = string(selection.text, 'selection.text', EDITOR_FOCUS_SELECTION_MAX_CHARS);
    if (to <= from || to > focus.field.length) fail('selection.to');
    if (selection.truncated !== undefined && selection.truncated !== true)
      fail('selection.truncated');
    if (text.length !== (selection.truncated ? EDITOR_FOCUS_SELECTION_MAX_CHARS : to - from))
      fail('selection.text');
    focus.selection = { from, to, text, ...(selection.truncated ? { truncated: true } : {}) };
  }
  if (input.diagnostics !== undefined) {
    if (!focus.field) fail('diagnostics');
    if (
      !Array.isArray(input.diagnostics) ||
      input.diagnostics.length > EDITOR_FOCUS_DIAGNOSTICS_MAX
    )
      fail('diagnostics');
    focus.diagnostics = input.diagnostics.map((entry, index) =>
      diagnostic(entry, `diagnostics.${index}`)
    );
  }
  if (input.diagnosticsOmitted !== undefined) {
    if (!focus.diagnostics) fail('diagnosticsOmitted');
    focus.diagnosticsOmitted = count(input.diagnosticsOmitted, 'diagnosticsOmitted', 1);
  }
  if (input.diagnostic !== undefined) {
    if (!focus.field) fail('diagnostic');
    focus.diagnostic = diagnostic(input.diagnostic, 'diagnostic');
  }
  if (input.unsavedSections !== undefined) {
    if (
      !Array.isArray(input.unsavedSections) ||
      input.unsavedSections.length > EDITOR_FOCUS_SECTIONS_MAX
    )
      fail('unsavedSections');
    focus.unsavedSections = input.unsavedSections.map((section, index) =>
      string(section, `unsavedSections.${index}`, EDITOR_FOCUS_NAME_MAX_CHARS)
    );
  }
  return focus;
}
