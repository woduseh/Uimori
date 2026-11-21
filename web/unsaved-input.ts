import { useEffect, useSyncExternalStore } from 'react';
import type { HelperRollbackTouch } from '../core/helper.js';
import { editorContextChanged, hasUnsavedResourceEditor } from './resource-editor.js';

export type UnsavedInputTarget =
  | { domain: 'scene'; sourceId: string; field: 'original' | 'translation' }
  | { domain: 'outline' | 'notes'; chatId: string };

const open = new Map<symbol, UnsavedInputTarget>();
let version = 0;
const changed = () => window.dispatchEvent(new Event(editorContextChanged));

export function useUnsavedInput(target: UnsavedInputTarget | null) {
  const key = target ? JSON.stringify(target) : '';
  useEffect(() => {
    if (!key) return;
    const token = Symbol(key);
    open.set(token, JSON.parse(key) as UnsavedInputTarget);
    changed();
    return () => {
      open.delete(token);
      changed();
    };
  }, [key]);
}

export function hasUnsavedInput(touch: HelperRollbackTouch) {
  if (touch.domain === 'resource') return hasUnsavedResourceEditor(touch.kind, touch.id);
  return [...open.values()].some((target) =>
    touch.domain === 'scene'
      ? target.domain === 'scene' &&
        target.sourceId === touch.sourceId &&
        touch.fields.includes(target.field)
      : target.domain === touch.domain && target.chatId === touch.chatId
  );
}

const subscribe = (listener: () => void) => {
  const update = () => {
    version++;
    listener();
  };
  window.addEventListener(editorContextChanged, update);
  return () => window.removeEventListener(editorContextChanged, update);
};

export function useUnsavedInputVersion() {
  return useSyncExternalStore(subscribe, () => version);
}
