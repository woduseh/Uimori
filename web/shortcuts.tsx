import { useEffect, useRef, useSyncExternalStore, type RefObject } from 'react';
import { isApplePlatform } from './ChatComposer.js';
import { readPresentationChoice, writePresentationSetting } from './presentation-settings.js';
import {
  readShortcutBindings,
  resolveShortcut,
  shortcutActions,
  shortcutKeyLabel,
  type ShortcutAction,
} from './shortcut-bindings.js';
import { useTransientNotice } from './TransientNotice.js';

type Registration = {
  run: () => unknown;
  ready?: () => boolean;
  confirmNotice?: string;
  scope?: RefObject<Element | null>;
};
type Entry = { current: Registration };

const registrations = new Map<ShortcutAction, Set<Entry>>();
const repeatWindowMs = 2000;

const enabledKey = 'uimori:shortcuts';
const enabledListeners = new Set<() => void>();
let enabled = readPresentationChoice(enabledKey, ['true', 'false'], 'true') === 'true';

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

export function shortcutLabel(action: ShortcutAction) {
  return shortcutKeyLabel(readShortcutBindings()[action], isApplePlatform());
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
    'dialog:modal, details.action-menu[open], [aria-modal="true"]:not([hidden])'
  );

export function ShortcutKeys() {
  const notify = useTransientNotice();
  const latestNotify = useRef(notify);
  latestNotify.current = notify;
  useEffect(() => {
    let overlayClosedAt = Number.NEGATIVE_INFINITY;
    let armed: { entry: Entry; at: number } | null = null;
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
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented && event.key === 'Escape') overlayClosed();
      const now = performance.now();
      const action = resolveShortcut(readShortcutBindings(), event, {
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
    window.addEventListener('keydown', keydown);
    document.addEventListener('close', closed, true);
    document.addEventListener('toggle', toggled, true);
    return () => {
      window.removeEventListener('keydown', keydown);
      document.removeEventListener('close', closed, true);
      document.removeEventListener('toggle', toggled, true);
    };
  }, []);
  return null;
}
