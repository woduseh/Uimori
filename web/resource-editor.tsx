import { IconButton } from './IconButton.js';
import { UndoIcon } from './ui-icons.js';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import type { EditorContext, ResourceModel } from '../core/resource-editing.js';
import type { ResourceEditorSession, EditorState } from './resource-editor-session.js';
import { libraryChangedKey } from './api.js';
import './resource-editor.css';

const sessions = new Map<symbol, ResourceEditorSession>();
const saveCommands = new Map<ResourceEditorSession, () => Promise<boolean>>();
let focused: symbol | null = null;
export const editorContextChanged = 'uimori-editor-context-changed';
const changed = () => window.dispatchEvent(new Event(editorContextChanged));
const activeSession = () =>
  (focused ? sessions.get(focused) : null) ?? [...sessions.values()].at(-1) ?? null;
export type ActiveEditorContext = EditorContext & { editorKey: string; dirty: boolean };
function context(session: ResourceEditorSession | null): ActiveEditorContext | null {
  const state = session?.snapshot();
  if (!session || !state?.ready) return null;
  return {
    kind: session.options.kind,
    targetId: state.document.targetId,
    revision: state.document.baseRevision,
    title: 'title' in state.local.model ? state.local.model.title : '현재 프롬프트',
    editorKey: session.editorKey,
    dirty: state.dirty,
    model: state.local.model,
  };
}
export const getActiveEditorContext = () => context(activeSession());
/** Check every mounted editor; the focused panel may be editing a different resource. */
export function hasUnsavedResourceEditor(kind: string, id: string) {
  return [...sessions.values()].some((session) => {
    const state = session.snapshot();
    return (
      session.options.kind === kind &&
      (kind === 'prompt-workspace' ? id === 'current' : state.document.targetId === id) &&
      (state.dirty || state.saving)
    );
  });
}
export const captureActiveEditorContext = () => activeSession()?.captureForHelper() ?? null;
export async function discardActiveEditor(editorKey?: string) {
  const session = editorKey
    ? [...sessions.values()].find((item) => item.editorKey === editorKey)
    : activeSession();
  await session?.discard();
}
export const refreshActiveEditor = () => activeSession()?.refresh() ?? Promise.resolve();
export function useEditorSaveCommand(session: ResourceEditorSession, save: () => Promise<boolean>) {
  const current = useRef(save);
  current.current = save;
  useEffect(() => {
    saveCommands.set(session, () => current.current());
    return () => {
      saveCommands.delete(session);
    };
  }, [session]);
}
export const saveActiveEditor = () => {
  const session = activeSession();
  return (session && saveCommands.get(session)?.()) || Promise.resolve(false);
};

type ResourceEditorValue = {
  session: ResourceEditorSession;
  state: EditorState;
  activate: () => void;
};

/** Subscribe to the owner; model updates never make a round trip through parent state. */
export function useResourceEditor<Model extends ResourceModel>(session: ResourceEditorSession) {
  const state = useSyncExternalStore(session.subscribe, session.snapshot);
  const token = useMemo(() => Symbol(session.editorKey), [session]);
  useEffect(() => {
    sessions.set(token, session);
    focused = token;
    changed();
    const unsubscribe = session.subscribe(changed);
    const reopening = session.snapshot().ready;
    void session
      .open()
      .then(() => {
        if (reopening) return session.refresh();
      })
      .catch(() => {});
    const refresh = () => {
      if (!session.snapshot().saving) void session.refresh().catch(() => {});
    };
    const storage = (event: StorageEvent) => {
      if (event.key === libraryChangedKey) refresh();
    };
    window.addEventListener('focus', refresh);
    window.addEventListener('uimori-helper-updated', refresh);
    window.addEventListener('uimori-resource-saved', refresh);
    window.addEventListener('storage', storage);
    if (session.options.kind === 'prompt-workspace')
      window.addEventListener('prompt-workspace-changed', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('uimori-helper-updated', refresh);
      window.removeEventListener('uimori-resource-saved', refresh);
      window.removeEventListener('storage', storage);
      window.removeEventListener('prompt-workspace-changed', refresh);
      sessions.delete(token);
      unsubscribe();
      if (focused === token) focused = null;
      session.dispose();
      changed();
    };
  }, [session, token]);
  const activate = useCallback(() => {
    focused = token;
    changed();
  }, [token]);
  const setModel = useCallback<Dispatch<SetStateAction<Model>>>(
    (action) =>
      session.setModel((current) =>
        typeof action === 'function' ? action(current as Model) : action
      ),
    [session]
  );
  return { session, state, activate, model: state.local.model as Model, setModel };
}

const EditorContextValue = createContext<ResourceEditorValue | null>(null);
export function ResourceEditorProvider({
  value,
  children,
}: {
  value: ResourceEditorValue;
  children: ReactNode;
}) {
  return (
    <EditorContextValue.Provider value={value}>
      <div className="resource-editor" onFocusCapture={value.activate}>
        {children}
      </div>
    </EditorContextValue.Provider>
  );
}

/** A field buffer may contain incomplete code; it is not a server document. */
export function useBufferedEditorState<T>(
  path: string,
  initial: T | (() => T),
  options?: { syncPristineInitial?: boolean }
): [T, Dispatch<SetStateAction<T>>] {
  const editor = useContext(EditorContextValue);
  const initialValue = typeof initial === 'function' ? (initial as () => T)() : initial;
  const signature = JSON.stringify(initialValue);
  const restore = editor?.state.restoreVersion ?? 0;
  const [standalone, setStandalone] = useState<T>(() => initialValue);
  const raw = editor?.state.local.rawFields[path];
  let value = editor ? initialValue : standalone;
  if (raw !== undefined) {
    try {
      value = (typeof initialValue === 'string' ? raw : JSON.parse(raw)) as T;
    } catch {
      // Device-local recovery can be stale; the current model remains the fallback.
    }
  }
  const current = useRef(value);
  current.current = value;
  const latest = useRef({ editor, initialValue, signature });
  latest.current = { editor, initialValue, signature };
  const previous = useRef({ path, restore, signature });
  useEffect(() => {
    const old = previous.current;
    previous.current = { path, restore, signature };
    if (
      !options?.syncPristineInitial ||
      old.path !== path ||
      old.restore !== restore ||
      old.signature === signature
    )
      return;
    const serialized = JSON.stringify(current.current);
    if (serialized !== old.signature && serialized !== signature) return;
    // A parent/accepted-model update is not new typing. The context already owns recovery.
    if (latest.current.editor) latest.current.editor.session.setField(path, undefined);
    else setStandalone(latest.current.initialValue);
  }, [path, restore, signature, options?.syncPristineInitial]);
  const update = useCallback<Dispatch<SetStateAction<T>>>(
    (action) => {
      const next =
        typeof action === 'function' ? (action as (old: T) => T)(current.current) : action;
      if (
        Object.is(next, current.current) ||
        JSON.stringify(next) === JSON.stringify(current.current)
      )
        return;
      current.current = next;
      const owner = latest.current;
      if (owner.editor)
        owner.editor.session.setField(
          path,
          JSON.stringify(next) === owner.signature
            ? undefined
            : typeof next === 'string'
              ? next
              : JSON.stringify(next)
        );
      else setStandalone(next);
    },
    [path]
  );
  return [value, update];
}

/** Input widgets prepare their own values at Save; no extra persisted draft or apply stage. */
export function useEditorSavePreparation(
  path: string,
  prepare: (model: ResourceModel) => ResourceModel
) {
  const session = useContext(EditorContextValue)?.session;
  const latest = useRef(prepare);
  latest.current = prepare;
  useEffect(() => session?.prepareOnSave(path, (model) => latest.current(model)), [session, path]);
}
export function useUnappliedEditorField(path: string, pending: boolean) {
  const session = useContext(EditorContextValue)?.session;
  useEffect(() => {
    session?.pendingField(path, pending);
  }, [session, path, pending]);
}

export function ResourceEditorStatus({
  value,
  hideSyncError = false,
}: {
  value: ResourceEditorValue;
  hideSyncError?: boolean;
}) {
  const { state, session } = value;
  return (
    <div className="resource-editor-status">
      <span role="status">
        {!state.ready
          ? '자료를 불러오는 중…'
          : state.saving
            ? '저장 중…'
            : state.dirty
              ? '미저장 변경'
              : state.document.targetId
                ? '저장됨'
                : '등록 전'}
      </span>
      {state.dirty && state.recovery === 'saved' && <small>이 기기에 복구용 입력 보관됨</small>}
      {state.recovery === 'failed' && (
        <small role="alert">복구용 입력을 보관하지 못했어요. 닫기 전에 저장해 주세요.</small>
      )}
      {state.conflict && (
        <small role="alert">저장된 자료가 변경됐어요. 현재 입력은 유지돼요.</small>
      )}
      {!hideSyncError && state.error && <small role="alert">{state.error}</small>}
      {!state.ready && state.error && (
        <button type="button" onClick={() => void session.open().catch(() => {})}>
          다시 불러오기
        </button>
      )}
    </div>
  );
}
export function ResourceEditorActions({
  value,
  hideSyncError = false,
}: {
  value: ResourceEditorValue;
  hideSyncError?: boolean;
}) {
  const [error, setError] = useState('');
  const action = (work: () => Promise<unknown>) => {
    setError('');
    void work().catch((caught) => setError((caught as Error).message));
  };
  return (
    <div className="resource-editor-actions">
      <ResourceEditorStatus value={value} hideSyncError={hideSyncError} />
      {value.state.dirty && (
        <button
          type="button"
          className="ghost"
          disabled={value.state.saving}
          onClick={() => action(() => value.session.discard())}
        >
          편집 취소
        </button>
      )}
      {!value.state.dirty && (value.state.document.baseRevision ?? 0) > 1 && (
        <IconButton
          className="ghost"
          label="직전 저장 되돌리기"
          icon={UndoIcon}
          disabled={value.state.saving}
          onClick={() => action(() => value.session.undo())}
        />
      )}
      {error && <small role="alert">{error}</small>}
    </div>
  );
}
