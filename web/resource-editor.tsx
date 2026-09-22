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
import type { EditorContext, ResourceKind, ResourceModel } from '../core/resource-editing.js';
import { ResourceEditorSession, type EditorDocument } from './resource-editor-session.js';
import './resource-editor.css';

const sessions = new Map<symbol, ResourceEditorSession>();
const saveCommands = new Map<ResourceEditorSession, () => Promise<boolean>>();
let focused: symbol | null = null;
export const editorContextChanged = 'uimori-editor-context-changed';
const changed = () => window.dispatchEvent(new Event(editorContextChanged));
const activeSession = () =>
  (focused ? sessions.get(focused) : null) ?? [...sessions.values()].at(-1) ?? null;
export type ActiveEditorContext = EditorContext & { editorKey: string };
function context(session: ResourceEditorSession | null): ActiveEditorContext | null {
  const state = session?.snapshot();
  if (!session || !state?.ready) return null;
  return {
    kind: session.options.kind,
    targetId: state.document.targetId,
    revision: state.document.baseRevision,
    title: 'title' in state.local.model ? state.local.model.title : '현재 프롬프트',
    editorKey: session.options.editorKey,
    model: state.local.model,
  };
}
export const getActiveEditorContext = () => context(activeSession());
export async function flushActiveEditor() {
  const session = activeSession();
  await session?.flush();
  return context(session);
}
export async function discardActiveEditor(editorKey?: string) {
  const session = editorKey
    ? [...sessions.values()].find((item) => item.options.editorKey === editorKey)
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

type Options = {
  editorKey: string;
  kind: ResourceKind;
  targetId: string | null;
  model: ResourceModel;
  enabled?: boolean;
  onRestore: (document: EditorDocument) => void;
};
export function useResourceEditor(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const session = useMemo(
    () =>
      new ResourceEditorSession({
        editorKey: options.editorKey,
        kind: options.kind,
        targetId: options.targetId,
        initialModel: latest.current.model,
      }),
    [options.editorKey, options.kind, options.targetId]
  );
  const state = useSyncExternalStore(session.subscribe, session.snapshot);
  const token = useMemo(() => Symbol(options.editorKey), [options.editorKey]);
  const observed = useRef(options.model);
  const observedRestore = useRef(0);
  useEffect(() => {
    if (options.enabled === false) return;
    sessions.set(token, session);
    focused = token;
    changed();
    void session.open().catch(() => {});
    const refresh = () => {
      void session.refresh().catch(() => {});
    };
    window.addEventListener('focus', refresh);
    window.addEventListener('uimori-helper-updated', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('uimori-helper-updated', refresh);
      sessions.delete(token);
      if (focused === token) focused = null;
      session.dispose();
      changed();
    };
  }, [session, token, options.enabled]);
  useEffect(() => {
    const restored = session.snapshot();
    if (restored.ready && restored.restoreVersion === state.restoreVersion) {
      observed.current = restored.local.model;
      latest.current.onRestore({ ...restored.document, ...restored.local });
    }
  }, [session, state.restoreVersion]);
  useEffect(() => {
    if (observedRestore.current !== state.restoreVersion) {
      observedRestore.current = state.restoreVersion;
      return;
    }
    if (state.ready && observed.current !== options.model) {
      observed.current = options.model;
      session.setModel(options.model);
    }
  }, [session, options.model, state.ready, state.restoreVersion]);
  const activate = useCallback(() => {
    focused = token;
    changed();
  }, [token]);
  return { session, state, activate };
}

const EditorContextValue = createContext<ReturnType<typeof useResourceEditor> | null>(null);
export function ResourceEditorProvider({
  value,
  children,
}: {
  value: ReturnType<typeof useResourceEditor>;
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
  const latest = useRef({ editor, initial });
  latest.current = { editor, initial };
  const readInitial = () =>
    typeof latest.current.initial === 'function'
      ? (latest.current.initial as () => T)()
      : latest.current.initial;
  const decode = () => {
    const raw = latest.current.editor?.state.local.rawFields[path];
    const fallback = readInitial();
    if (raw === undefined) return fallback;
    try {
      return (typeof fallback === 'string' ? raw : JSON.parse(raw)) as T;
    } catch {
      return fallback;
    }
  };
  const [value, setValue] = useState<T>(decode);
  const current = useRef(value);
  current.current = value;
  const restore = editor?.state.restoreVersion ?? 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Restore only on resource adoption, not on each keystroke.
  useEffect(() => {
    const next = decode();
    current.current = next;
    setValue(next);
  }, [path, restore]);
  const initialSignature = options?.syncPristineInitial ? JSON.stringify(readInitial()) : '';
  const previousInitial = useRef(initialSignature);
  useEffect(() => {
    if (!options?.syncPristineInitial || previousInitial.current === initialSignature) return;
    if (JSON.stringify(current.current) === previousInitial.current) {
      const next = JSON.parse(initialSignature) as T;
      current.current = next;
      setValue(next);
      latest.current.editor?.session.setField(
        path,
        typeof next === 'string' ? next : initialSignature
      );
    }
    previousInitial.current = initialSignature;
  }, [initialSignature, path, options?.syncPristineInitial]);
  const update = useCallback<Dispatch<SetStateAction<T>>>(
    (action) => {
      const next =
        typeof action === 'function' ? (action as (old: T) => T)(current.current) : action;
      if (Object.is(next, current.current)) return;
      current.current = next;
      setValue(next);
      latest.current.editor?.session.setField(
        path,
        typeof next === 'string' ? next : JSON.stringify(next)
      );
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
  value: ReturnType<typeof useResourceEditor>;
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
              : '저장됨'}
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
export function ResourceEditorActions({ value }: { value: ReturnType<typeof useResourceEditor> }) {
  const [error, setError] = useState('');
  const action = (work: () => Promise<unknown>) => {
    setError('');
    void work().catch((caught) => setError((caught as Error).message));
  };
  return (
    <div className="resource-editor-actions">
      <ResourceEditorStatus value={value} />
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
          onClick={() => action(() => value.session.undo())}
        />
      )}
      {error && <small role="alert">{error}</small>}
    </div>
  );
}
