import { useEffect, useRef, useSyncExternalStore, type RefObject } from 'react';
import { isApplePlatform } from './ChatComposer.js';
import {
  readPresentationChoice,
  readPresentationSetting,
  removePresentationSetting,
  writePresentationSetting,
} from './presentation-settings.js';
import {
  defaultShortcutBindings,
  normalizeShortcutKey,
  parseShortcutOverrides,
  resolveShortcut,
  sameShortcutKey,
  serializeShortcutOverrides,
  shortcutActionIds,
  shortcutActions,
  shortcutKeyLabel,
  validateShortcutBinding,
  type ShortcutAction,
  type ShortcutBindings,
  type ShortcutKey,
  type ShortcutValidation,
} from './shortcut-bindings.js';
import { useTransientNotice } from './TransientNotice.js';
import { storageKeys } from './storage-keys.js';

type Registration = {
  run: () => unknown;
  ready?: () => boolean;
  confirmNotice?: string;
  scope?: RefObject<Element | null>;
};
type Entry = { current: Registration };

const registrations = new Map<ShortcutAction, Set<Entry>>();
const repeatWindowMs = 2000;

const enabledKey = storageKeys.shortcuts;
const bindingsKey = storageKeys.shortcutBindings;
const enabledListeners = new Set<() => void>();
const bindingListeners = new Set<() => void>();
let enabled = readPresentationChoice(enabledKey, ['true', 'false'], 'true') === 'true';
let currentBindings: ShortcutBindings = parseShortcutOverrides(
  readPresentationSetting(bindingsKey)
);
let capturingCount = 0;

function notifyBindingListeners() {
  for (const listener of bindingListeners) listener();
}

export function setShortcutsEnabled(value: boolean) {
  enabled = value;
  writePresentationSetting(enabledKey, String(value));
  for (const listener of enabledListeners) listener();
}

export function useShortcutsEnabled() {
  return useSyncExternalStore(
    (listener) => {
      enabledListeners.add(listener);
      return () => enabledListeners.delete(listener);
    },
    () => enabled
  );
}

export function useShortcutBindings() {
  return useSyncExternalStore(
    (listener) => {
      bindingListeners.add(listener);
      return () => bindingListeners.delete(listener);
    },
    () => currentBindings
  );
}

function saveBindings(next: ShortcutBindings) {
  currentBindings = next;
  const serialized = serializeShortcutOverrides(next);
  if (serialized) writePresentationSetting(bindingsKey, serialized);
  else removePresentationSetting(bindingsKey);
  notifyBindingListeners();
}

export function setShortcutBinding(action: ShortcutAction, key: ShortcutKey): ShortcutValidation {
  const result = validateShortcutBinding(action, key, currentBindings);
  if (!result.ok) return result;
  saveBindings({ ...currentBindings, [action]: normalizeShortcutKey(key) });
  return result;
}

export function resetShortcutBinding(action: ShortcutAction) {
  if (!shortcutActions[action].when.rebindable) return;
  const defaults = defaultShortcutBindings();
  const next = { ...currentBindings };
  const visited = new Set<ShortcutAction>();
  let current: ShortcutAction | null = action;
  while (current && !visited.has(current)) {
    const activeAction: ShortcutAction = current;
    visited.add(activeAction);
    const target: ShortcutKey = defaults[activeAction];
    const conflict: ShortcutAction | undefined = shortcutActionIds.find(
      (other) => other !== activeAction && sameShortcutKey(next[other], target)
    );
    next[activeAction] = target;
    current = conflict ?? null;
  }
  saveBindings(next);
}

export function resetAllShortcutBindings() {
  saveBindings(defaultShortcutBindings());
}

export function setShortcutCapturing(active: boolean) {
  capturingCount = Math.max(0, capturingCount + (active ? 1 : -1));
}

export function useShortcutLabel(action: ShortcutAction) {
  const bindings = useShortcutBindings();
  return shortcutKeyLabel(bindings[action], isApplePlatform());
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === enabledKey) {
      enabled = readPresentationChoice(enabledKey, ['true', 'false'], 'true') === 'true';
      for (const listener of enabledListeners) listener();
    } else if (event.key === bindingsKey) {
      currentBindings = parseShortcutOverrides(readPresentationSetting(bindingsKey));
      notifyBindingListeners();
    }
  });
}

export function useShortcut(
  action: ShortcutAction,
  run: Registration['run'],
  options: Omit<Registration, 'run'> & { active?: boolean } = {}
) {
  const entry = useRef<Registration>({ run });
  entry.current = { ...options, run };
  const active = options.active ?? true;
  useEffect(() => {
    if (!active) return;
    const entries = registrations.get(action) ?? new Set<Entry>();
    registrations.set(action, entries);
    entries.add(entry);
    return () => {
      entries.delete(entry);
    };
  }, [action, active]);
}

const ownDialog = (element: Element) => element.closest('dialog');

function registrationFor(action: ShortcutAction, target: Element | null) {
  let scoped: { entry: Entry; root: Element } | null = null;
  let global: Entry | null = null;
  for (const entry of registrations.get(action) ?? []) {
    const scope = entry.current.scope;
    if (!scope) {
      global = entry;
      continue;
    }
    const root = scope.current;
    if (!root || !target || !root.contains(target) || ownDialog(root) !== ownDialog(target))
      continue;
    if (!scoped || scoped.root.contains(root)) scoped = { entry, root };
  }
  return scoped?.entry ?? global;
}

const keyboardOverlayOpen = () =>
  !!document.querySelector(
    'dialog:modal, details.action-menu[open], [aria-modal="true"]:not([hidden]), [data-keyboard-overlay]'
  );

export function ShortcutKeys() {
  const notify = useTransientNotice();
  const latestNotify = useRef(notify);
  latestNotify.current = notify;
  useEffect(() => {
    let overlayClosedAt = Number.NEGATIVE_INFINITY;
    let armed: { entry: Entry; at: number } | null = null;
    const own = new WeakSet<Event>();
    const overlayClosed = () => {
      overlayClosedAt = performance.now();
      armed = null;
    };
    const closed = (event: Event) => {
      if (event.target instanceof HTMLDialogElement) overlayClosed();
    };
    const toggled = (event: Event) => {
      const target = event.target;
      if (target instanceof HTMLDetailsElement && target.matches('.action-menu') && !target.open)
        overlayClosed();
    };
    const watch = (event: Event) => {
      if (keyboardOverlayOpen()) overlayClosed();
      else if (event instanceof KeyboardEvent && event.key === 'Escape')
        setTimeout(() => {
          if (event.defaultPrevented && !own.has(event)) overlayClosed();
        });
    };
    const keydown = (event: KeyboardEvent) => {
      if (capturingCount > 0) return;
      const now = performance.now();
      const action = resolveShortcut(currentBindings, event, {
        enabled,
        overlayOpen: keyboardOverlayOpen(),
        sinceOverlayClosedMs: now - overlayClosedAt,
      });
      if (!action) return;
      const target = event.target instanceof Element ? event.target : null;
      const entry = registrationFor(action, target);
      if (!entry) return;
      const registration = entry.current;
      if (shortcutActions[action].when.confirmByRepeat) {
        if (registration.ready && !registration.ready()) return;
        own.add(event);
        event.preventDefault();
        if (armed?.entry === entry && now - armed.at <= repeatWindowMs) {
          armed = null;
          registration.run();
        } else {
          armed = { entry, at: now };
          if (registration.confirmNotice) latestNotify.current(registration.confirmNotice);
        }
        return;
      }
      if (registration.run() === false) return;
      event.preventDefault();
    };
    window.addEventListener('keydown', watch, true);
    window.addEventListener('pointerdown', watch, true);
    window.addEventListener('keydown', keydown);
    document.addEventListener('close', closed, true);
    document.addEventListener('toggle', toggled, true);
    return () => {
      window.removeEventListener('keydown', watch, true);
      window.removeEventListener('pointerdown', watch, true);
      window.removeEventListener('keydown', keydown);
      document.removeEventListener('close', closed, true);
      document.removeEventListener('toggle', toggled, true);
    };
  }, []);
  return null;
}
