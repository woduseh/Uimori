import { expect, test } from 'vitest';
import {
  defaultShortcutBindings,
  isBrowserReservedShortcut,
  parseShortcutOverrides,
  readShortcutBindings,
  resolveShortcut,
  serializeShortcutOverrides,
  shortcutKeyFromEvent,
  shortcutKeyLabel,
  validateShortcutBinding,
  type ShortcutEvent,
  type ShortcutState,
} from '../web/shortcut-bindings.js';

const press = (code: string, keys: Partial<ShortcutEvent> = {}): ShortcutEvent => ({
  code,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  isComposing: false,
  keyCode: 0,
  defaultPrevented: false,
  ...keys,
});
const idle: ShortcutState = {
  enabled: true,
  overlayOpen: false,
  sinceOverlayClosedMs: Number.POSITIVE_INFINITY,
};
const resolve = (event: ShortcutEvent, state: Partial<ShortcutState> = {}) =>
  resolveShortcut(readShortcutBindings(), event, { ...idle, ...state });

test('default bindings resolve with Ctrl or Cmd and exact Shift and Alt state', () => {
  expect(resolve(press('KeyK', { ctrlKey: true }))).toBe('palette.open');
  expect(resolve(press('KeyK', { metaKey: true }))).toBe('palette.open');
  expect(resolve(press('KeyB', { ctrlKey: true }))).toBe('navigation.toggle');
  expect(resolve(press('Backslash', { ctrlKey: true }))).toBe('rightPanel.toggle');
  expect(resolve(press('Comma', { metaKey: true }))).toBe('settings.open');
  expect(resolve(press('KeyS', { ctrlKey: true }))).toBe('editor.save');
  expect(resolve(press('KeyF', { ctrlKey: true, shiftKey: true }))).toBe('search.open');
  expect(resolve(press('KeyM', { altKey: true }))).toBe('helper.mode');
  expect(resolve(press('Escape'))).toBe('run.stop');
  expect(resolve(press('Period', { ctrlKey: true }))).toBe('theme.safeMode');

  expect(resolve(press('KeyF', { ctrlKey: true }))).toBeNull();
  expect(resolve(press('KeyK'))).toBeNull();
  expect(resolve(press('KeyK', { ctrlKey: true, shiftKey: true }))).toBeNull();
  expect(resolve(press('KeyS', { ctrlKey: true, altKey: true }))).toBeNull();
  expect(resolve(press('Escape', { shiftKey: true }))).toBeNull();
  expect(resolve(press('KeyM'))).toBeNull();
  expect(resolve(press('KeyM', { ctrlKey: true, altKey: true }))).toBeNull();
});

test('handled events and IME composition never resolve', () => {
  for (const event of [
    press('KeyK', { ctrlKey: true, defaultPrevented: true }),
    press('Escape', { isComposing: true }),
    press('Period', { ctrlKey: true, keyCode: 229 }),
  ])
    expect(resolve(event)).toBeNull();
});

test('an open dialog or menu keeps only the actions that apply inside it', () => {
  const overlay = { overlayOpen: true };
  expect(resolve(press('KeyK', { ctrlKey: true }), overlay)).toBeNull();
  expect(resolve(press('KeyB', { ctrlKey: true }), overlay)).toBeNull();
  expect(resolve(press('Escape'), overlay)).toBeNull();
  expect(resolve(press('KeyS', { ctrlKey: true }), overlay)).toBe('editor.save');
  expect(resolve(press('KeyM', { altKey: true }), overlay)).toBe('helper.mode');
  expect(resolve(press('Period', { ctrlKey: true }), overlay)).toBe('theme.safeMode');
});

test('Escape does not count for 1.5 seconds after a dialog or menu closed', () => {
  expect(resolve(press('Escape'), { sinceOverlayClosedMs: 1499 })).toBeNull();
  expect(resolve(press('Escape'), { sinceOverlayClosedMs: 1500 })).toBe('run.stop');
  expect(resolve(press('KeyK', { ctrlKey: true }), { sinceOverlayClosedMs: 0 })).toBe(
    'palette.open'
  );
});

test('turning shortcuts off leaves only the theme safe mode', () => {
  const off = { enabled: false };
  expect(resolve(press('KeyK', { ctrlKey: true }), off)).toBeNull();
  expect(resolve(press('Escape'), off)).toBeNull();
  expect(resolve(press('KeyS', { ctrlKey: true }), off)).toBeNull();
  expect(resolve(press('Period', { ctrlKey: true }), off)).toBe('theme.safeMode');
});

test('a later binding for the same key wins while its condition holds', () => {
  const bindings = { ...readShortcutBindings(), 'run.stop': { code: 'KeyK', mod: true } };
  const event = press('KeyK', { ctrlKey: true });
  expect(resolveShortcut(bindings, event, idle)).toBe('run.stop');
  expect(resolveShortcut(bindings, event, { ...idle, sinceOverlayClosedMs: 0 })).toBe(
    'palette.open'
  );
});

test('labels name Cmd on Apple platforms and Ctrl elsewhere', () => {
  const bindings = readShortcutBindings();
  expect(shortcutKeyLabel(bindings['search.open'], true)).toBe('Cmd+Shift+F');
  expect(shortcutKeyLabel(bindings['rightPanel.toggle'], false)).toBe('Ctrl+\\');
  expect(shortcutKeyLabel(bindings['run.stop'], false)).toBe('Esc');
  expect(shortcutKeyLabel(bindings['helper.mode'], false)).toBe('Alt+M');
  expect(shortcutKeyLabel(bindings['helper.mode'], true)).toBe('Option+M');
});

test('validation rejects fixed actions, browser-reserved combos, bare keys and conflicts', () => {
  const defaults = defaultShortcutBindings();
  expect(validateShortcutBinding('theme.safeMode', { code: 'KeyU', mod: true }, defaults)).toEqual({
    ok: false,
    reason: 'fixed',
  });
  expect(isBrowserReservedShortcut({ code: 'KeyW', mod: true })).toBe(true);
  expect(isBrowserReservedShortcut({ code: 'KeyT', mod: true })).toBe(true);
  expect(isBrowserReservedShortcut({ code: 'KeyF', mod: true })).toBe(true);
  expect(isBrowserReservedShortcut({ code: 'KeyF', mod: true, shift: true })).toBe(false);
  expect(
    validateShortcutBinding('navigation.toggle', { code: 'KeyW', mod: true }, defaults)
  ).toEqual({
    ok: false,
    reason: 'browser-reserved',
  });
  expect(validateShortcutBinding('navigation.toggle', { code: 'KeyB' }, defaults)).toEqual({
    ok: false,
    reason: 'modifier-required',
  });
  expect(validateShortcutBinding('navigation.toggle', { code: 'F8' }, defaults)).toEqual({
    ok: true,
  });
  expect(validateShortcutBinding('run.stop', { code: 'Escape' }, defaults)).toEqual({ ok: true });
  expect(
    validateShortcutBinding('navigation.toggle', { code: 'KeyK', mod: true }, defaults)
  ).toEqual({
    ok: false,
    reason: 'conflict',
    conflictWith: 'palette.open',
  });
  expect(
    validateShortcutBinding('navigation.toggle', { code: 'KeyB', alt: true }, defaults)
  ).toEqual({ ok: true });
});

test('shortcutKeyFromEvent normalizes keyboard events and ignores lone modifiers', () => {
  expect(shortcutKeyFromEvent(press('ControlLeft', { ctrlKey: true }))).toBeNull();
  expect(shortcutKeyFromEvent(press('KeyB', { altKey: true }))).toEqual({
    code: 'KeyB',
    alt: true,
  });
  expect(shortcutKeyFromEvent(press('KeyP', { metaKey: true, shiftKey: true }))).toEqual({
    code: 'KeyP',
    mod: true,
    shift: true,
  });
});

test('parseShortcutOverrides tolerates corrupt storage, drops invalid keys and preserves valid swaps', () => {
  const defaults = defaultShortcutBindings();
  expect(parseShortcutOverrides(null)).toEqual(defaults);
  expect(parseShortcutOverrides('{bad json')).toEqual(defaults);

  const parsed = parseShortcutOverrides(
    JSON.stringify({
      'theme.safeMode': { code: 'KeyU', mod: true },
      'navigation.toggle': { code: 'KeyW', mod: true },
      'rightPanel.toggle': { code: 'KeyJ', alt: true },
    })
  );
  expect(parsed['theme.safeMode']).toEqual(defaults['theme.safeMode']);
  expect(parsed['navigation.toggle']).toEqual(defaults['navigation.toggle']);
  expect(parsed['rightPanel.toggle']).toEqual({ code: 'KeyJ', alt: true });

  const swapped = parseShortcutOverrides(
    JSON.stringify({
      'palette.open': defaults['navigation.toggle'],
      'navigation.toggle': defaults['palette.open'],
    })
  );
  expect(swapped['palette.open']).toEqual(defaults['navigation.toggle']);
  expect(swapped['navigation.toggle']).toEqual(defaults['palette.open']);

  expect(serializeShortcutOverrides(defaults)).toBe('');
  const serialized = serializeShortcutOverrides({
    ...defaults,
    'navigation.toggle': { code: 'KeyB', alt: true },
  });
  expect(parseShortcutOverrides(serialized)['navigation.toggle']).toEqual({
    code: 'KeyB',
    alt: true,
  });
});
