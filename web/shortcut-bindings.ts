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
};

const outsideOverlay: ShortcutCondition = {
  insideOverlay: false,
  ignoresSetting: false,
  quietAfterOverlayMs: 0,
  confirmByRepeat: false,
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
  'search.open': { key: { code: 'KeyF', mod: true, shift: true }, when: outsideOverlay },
  'run.stop': {
    key: { code: 'Escape' },
    when: { ...outsideOverlay, quietAfterOverlayMs: 1500, confirmByRepeat: true },
  },
  'theme.safeMode': {
    key: { code: 'Period', mod: true },
    when: { ...outsideOverlay, insideOverlay: true, ignoresSetting: true },
  },
} satisfies Record<string, { key: ShortcutKey; when: ShortcutCondition }>;

export type ShortcutAction = keyof typeof shortcutActions;
export type ShortcutBindings = Record<ShortcutAction, ShortcutKey>;

export const shortcutActionIds = Object.keys(shortcutActions) as ShortcutAction[];

export function readShortcutBindings(): ShortcutBindings {
  return Object.fromEntries(
    shortcutActionIds.map((action) => [action, shortcutActions[action].key])
  ) as ShortcutBindings;
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
  Comma: ',',
  Period: '.',
  Escape: 'Esc',
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
