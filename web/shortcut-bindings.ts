import { tryParseJson } from './json.js';

export type ShortcutKey = {
  code: string;
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
};

export type ShortcutCondition = {
  insideOverlay: boolean;
  ignoresSetting: boolean;
  quietAfterOverlayMs: number;
  confirmByRepeat: boolean;
  rebindable: boolean;
};

const outsideOverlay: ShortcutCondition = {
  insideOverlay: false,
  ignoresSetting: false,
  quietAfterOverlayMs: 0,
  confirmByRepeat: false,
  rebindable: true,
};

export const shortcutActions = {
  'palette.open': { key: { code: 'KeyK', mod: true }, when: outsideOverlay },
  'navigation.toggle': { key: { code: 'KeyB', mod: true }, when: outsideOverlay },
  'rightPanel.toggle': { key: { code: 'Backslash', mod: true }, when: outsideOverlay },
  'settings.open': { key: { code: 'Comma', mod: true }, when: outsideOverlay },
  'editor.save': {
    key: { code: 'KeyS', mod: true },
    when: { ...outsideOverlay, insideOverlay: true },
  },
  'editor.askHelper': { key: { code: 'KeyI', alt: true }, when: outsideOverlay },
  'search.open': { key: { code: 'KeyF', mod: true, shift: true }, when: outsideOverlay },
  'helper.mode': {
    key: { code: 'KeyM', alt: true },
    when: { ...outsideOverlay, insideOverlay: true },
  },
  'run.stop': {
    key: { code: 'Escape' },
    when: { ...outsideOverlay, quietAfterOverlayMs: 1500, confirmByRepeat: true },
  },
  'theme.safeMode': {
    key: { code: 'Period', mod: true },
    when: { ...outsideOverlay, insideOverlay: true, ignoresSetting: true, rebindable: false },
  },
} satisfies Record<string, { key: ShortcutKey; when: ShortcutCondition }>;

export type ShortcutAction = keyof typeof shortcutActions;
export type ShortcutBindings = Record<ShortcutAction, ShortcutKey>;

export const shortcutActionIds = Object.keys(shortcutActions) as ShortcutAction[];

export const isApplePlatform = () =>
  /^(Mac|iPhone|iPad)/.test(globalThis.navigator?.platform ?? '');

export function defaultShortcutBindings(apple = isApplePlatform()): ShortcutBindings {
  const defaults = Object.fromEntries(
    shortcutActionIds.map((action) => [action, { ...shortcutActions[action].key }])
  ) as ShortcutBindings;
  if (apple) defaults['editor.askHelper'] = { code: 'KeyU', mod: true, shift: true };
  return defaults;
}

export function normalizeShortcutKey(key: ShortcutKey): ShortcutKey {
  return {
    code: key.code,
    ...(key.mod ? { mod: true } : {}),
    ...(key.shift ? { shift: true } : {}),
    ...(key.alt ? { alt: true } : {}),
  };
}

export function sameShortcutKey(a: ShortcutKey, b: ShortcutKey) {
  return a.code === b.code && !!a.mod === !!b.mod && !!a.shift === !!b.shift && !!a.alt === !!b.alt;
}

const MODIFIER_CODES = new Set([
  'ControlLeft',
  'ControlRight',
  'ShiftLeft',
  'ShiftRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
  'OSLeft',
  'OSRight',
  'CapsLock',
  'NumLock',
  'ScrollLock',
  'Fn',
  'FnLock',
  'ContextMenu',
]);

export function isModifierCode(code: string) {
  return MODIFIER_CODES.has(code);
}

const MOD_ONLY_RESERVED = new Set([
  'KeyA',
  'KeyC',
  'KeyF',
  'KeyH',
  'KeyJ',
  'KeyL',
  'KeyN',
  'KeyQ',
  'KeyR',
  'KeyT',
  'KeyV',
  'KeyW',
  'KeyX',
  'KeyZ',
  'Tab',
  'F4',
  'F5',
  'Digit0',
  'Digit1',
  'Digit2',
  'Digit3',
  'Digit4',
  'Digit5',
  'Digit6',
  'Digit7',
  'Digit8',
  'Digit9',
  'Equal',
  'Minus',
  'NumpadAdd',
  'NumpadSubtract',
  'Numpad0',
]);

const MOD_SHIFT_RESERVED = new Set([
  'KeyT',
  'KeyW',
  'KeyN',
  'KeyR',
  'KeyI',
  'KeyJ',
  'KeyC',
  'Tab',
  'Delete',
]);

const ALT_ONLY_RESERVED = new Set(['Tab', 'F4', 'ArrowLeft', 'ArrowRight', 'Home']);
const BARE_RESERVED = new Set(['F5', 'F11', 'F12']);
const FUNCTION_KEY = /^F(?:[1-9]|1[0-2])$/u;

export function isBrowserReservedShortcut(key: ShortcutKey) {
  const mod = !!key.mod;
  const shift = !!key.shift;
  const alt = !!key.alt;
  if (mod && !alt && !shift) return MOD_ONLY_RESERVED.has(key.code);
  if (mod && shift && !alt) return MOD_SHIFT_RESERVED.has(key.code);
  if (!mod && alt && !shift) return ALT_ONLY_RESERVED.has(key.code);
  if (!mod && !alt && !shift) return BARE_RESERVED.has(key.code);
  return false;
}

export type ShortcutValidation =
  | { ok: true }
  | { ok: false; reason: 'fixed' | 'modifier-only' | 'modifier-required' | 'browser-reserved' }
  | { ok: false; reason: 'conflict'; conflictWith: ShortcutAction };

export function validateShortcutBinding(
  action: ShortcutAction,
  rawKey: ShortcutKey,
  bindings: ShortcutBindings
): ShortcutValidation {
  if (!shortcutActions[action].when.rebindable) return { ok: false, reason: 'fixed' };
  const key = normalizeShortcutKey(rawKey);
  if (!key.code || isModifierCode(key.code)) return { ok: false, reason: 'modifier-only' };
  if (!key.mod && !key.alt && key.code !== 'Escape' && !FUNCTION_KEY.test(key.code))
    return { ok: false, reason: 'modifier-required' };
  if (isBrowserReservedShortcut(key)) return { ok: false, reason: 'browser-reserved' };
  for (const other of shortcutActionIds) {
    if (other !== action && sameShortcutKey(bindings[other], key))
      return { ok: false, reason: 'conflict', conflictWith: other };
  }
  return { ok: true };
}

export function shortcutKeyFromEvent(
  event: Pick<ShortcutEvent, 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>
): ShortcutKey | null {
  if (!event.code || isModifierCode(event.code)) return null;
  return normalizeShortcutKey({
    code: event.code,
    mod: event.ctrlKey || event.metaKey,
    shift: event.shiftKey,
    alt: event.altKey,
  });
}

function validStoredKey(value: unknown): ShortcutKey | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.code !== 'string' || !record.code || record.code.length > 32) return null;
  for (const flag of ['mod', 'shift', 'alt'])
    if (record[flag] !== undefined && typeof record[flag] !== 'boolean') return null;
  return normalizeShortcutKey({
    code: record.code,
    mod: record.mod as boolean | undefined,
    shift: record.shift as boolean | undefined,
    alt: record.alt as boolean | undefined,
  });
}

export function parseShortcutOverrides(raw: string | null): ShortcutBindings {
  const defaults = defaultShortcutBindings();
  if (!raw) return defaults;
  const parsed = tryParseJson(raw, null);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return defaults;
  const input = parsed as Record<string, unknown>;
  const candidate: ShortcutBindings = { ...defaults };
  const overridden = new Set<ShortcutAction>();
  for (const action of shortcutActionIds) {
    if (!shortcutActions[action].when.rebindable || !Object.hasOwn(input, action)) continue;
    const key = validStoredKey(input[action]);
    if (!key) continue;
    if (!key.mod && !key.alt && key.code !== 'Escape' && !FUNCTION_KEY.test(key.code)) continue;
    if (isModifierCode(key.code) || isBrowserReservedShortcut(key)) continue;
    candidate[action] = key;
    overridden.add(action);
  }
  for (const action of overridden) {
    const collides = shortcutActionIds.some(
      (other) => other !== action && sameShortcutKey(candidate[other], candidate[action])
    );
    if (collides) candidate[action] = defaults[action];
  }
  return candidate;
}

export function serializeShortcutOverrides(bindings: ShortcutBindings): string {
  const defaults = defaultShortcutBindings();
  const overrides: Partial<ShortcutBindings> = {};
  for (const action of shortcutActionIds) {
    if (!shortcutActions[action].when.rebindable) continue;
    const current = normalizeShortcutKey(bindings[action]);
    if (!sameShortcutKey(current, defaults[action])) overrides[action] = current;
  }
  return Object.keys(overrides).length ? JSON.stringify(overrides) : '';
}

export function readShortcutBindings(raw?: string | null): ShortcutBindings {
  return raw === undefined ? defaultShortcutBindings() : parseShortcutOverrides(raw);
}

export type ShortcutEvent = {
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  isComposing: boolean;
  keyCode: number;
  defaultPrevented: boolean;
};

export type ShortcutState = {
  enabled: boolean;
  overlayOpen: boolean;
  sinceOverlayClosedMs: number;
};

const matches = (key: ShortcutKey, event: ShortcutEvent) =>
  key.code === event.code &&
  !!key.mod === (event.ctrlKey || event.metaKey) &&
  !!key.shift === event.shiftKey &&
  !!key.alt === event.altKey;

export function resolveShortcut(
  bindings: ShortcutBindings,
  event: ShortcutEvent,
  state: ShortcutState
): ShortcutAction | null {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return null;
  for (const action of shortcutActionIds.toReversed()) {
    if (!matches(bindings[action], event)) continue;
    const when: ShortcutCondition = shortcutActions[action].when;
    if (
      (state.enabled || when.ignoresSetting) &&
      (!state.overlayOpen || when.insideOverlay) &&
      state.sinceOverlayClosedMs >= when.quietAfterOverlayMs
    )
      return action;
  }
  return null;
}

const keyLabels: Record<string, string> = {
  Backslash: '\\',
  Slash: '/',
  Comma: ',',
  Period: '.',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
  Escape: 'Esc',
  Space: 'Space',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
};

export function shortcutKeyLabel(key: ShortcutKey, apple: boolean) {
  const name = keyLabels[key.code] ?? key.code.replace(/^Key|^Digit/u, '');
  return [
    key.mod ? (apple ? 'Cmd' : 'Ctrl') : '',
    key.alt ? (apple ? 'Option' : 'Alt') : '',
    key.shift ? 'Shift' : '',
    name,
  ]
    .filter(Boolean)
    .join('+');
}
