import { t, translateMessage, useI18n } from './i18n.js';
import { LoadingState } from './LoadingState.js';
import { SaveConflictDialog } from './SaveConflictDialog.js';
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
  type RefObject,
  type SetStateAction,
} from 'react';
import type { EditorContext, ResourceModel } from '../core/resource-editing.js';
import type { RisuPrompt } from '../core/risu-prompt.js';
import type { ResourceEditorSession, EditorState } from './resource-editor-session.js';
import { libraryChangedKey } from './api.js';
import { useShortcut } from './shortcuts.js';
import './resource-editor.css';
import { helperDataFrame, promptWorkspaceFrame } from './live-frames.js';
import { watchLive } from './live-stream.js';
import { helperRefreshSpacing } from './poll-delays.js';

const sessions = new Map<symbol, ResourceEditorSession>();
const saveCommands = new Map<ResourceEditorSession, () => Promise<boolean>>();
let focused: symbol | null = null;
export const editorContextChanged = 'uimori-editor-context-changed';
const changed = () => window.dispatchEvent(new Event(editorContextChanged));
const activeSession = () =>
  (focused ? sessions.get(focused) : null) ?? [...sessions.values()].at(-1) ?? null;
const conflictReviewEvent = 'uimori-resource-conflict-review';
export function requestResourceConflictReview(session: ResourceEditorSession) {
  if (session.snapshot().conflict && !session.snapshot().creationPending)
    window.dispatchEvent(new CustomEvent(conflictReviewEvent, { detail: session }));
}
export function ResourceEditorLeaveWarning() {
  useI18n();
  const subscribe = useCallback((listener: () => void) => {
    window.addEventListener(editorContextChanged, listener);
    return () => window.removeEventListener(editorContextChanged, listener);
  }, []);
  const warning = useSyncExternalStore(subscribe, () => {
    const state = activeSession()?.snapshot();
    return state?.dirty && state.recovery === 'failed';
  });
  return warning ? (
    <p role="alert" className="error">
      {t('shared.recoveryWarning')}
    </p>
  ) : null;
}
export type EditorLocationItem = { index: number; label: string };
export type EditorLocation = { section: string; item?: EditorLocationItem };
export type ActiveEditorContext = EditorContext & {
  editorKey: string;
  dirty: boolean;
  location?: EditorLocation;
};
const locations = new WeakMap<ResourceEditorSession, EditorLocation>();
function context(session: ResourceEditorSession | null): ActiveEditorContext | null {
  const state = session?.snapshot();
  if (!session || !state?.ready) return null;
  const location = locations.get(session);
  return {
    ...(location ? { location } : {}),
    kind: session.options.kind,
    targetId: state.document.targetId,
    revision: state.document.baseRevision,
    title:
      'title' in state.local.model ? state.local.model.title : t('prompts.uiCurrentPromptPreset'),
    editorKey: session.editorKey,
    dirty: state.dirty,
    model: state.local.model,
  };
}
export const getActiveEditorContext = () => context(activeSession());
export function hasUnsavedResourceEditor(kind: string, id: string) {
  return [...sessions.values()].some((session) => {
    const state = session.snapshot();
    return (
      session.options.kind === kind &&
      (kind === 'prompt-workspace' ? id === 'current' : state.document.targetId === id) &&
      (state.dirty || state.saving || state.creationPending)
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
  if (session?.snapshot().conflict && !session.snapshot().creationPending) {
    requestResourceConflictReview(session);
    return Promise.resolve(false);
  }
  return (session && saveCommands.get(session)?.()) || Promise.resolve(false);
};

type ResourceEditorValue = {
  session: ResourceEditorSession;
  state: EditorState;
  activate: () => void;
};

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
    const workspace = session.options.kind === 'prompt-workspace';
    const live = watchLive({
      match: (frame) => helperDataFrame(frame) || (workspace && promptWorkspaceFrame(frame)),
      refresh: async () => refresh(),
      minIntervalMs: helperRefreshSpacing,
    });
    window.addEventListener('focus', refresh);
    window.addEventListener('uimori-resource-saved', refresh);
    window.addEventListener('storage', storage);
    return () => {
      live.dispose();
      window.removeEventListener('focus', refresh);
      window.removeEventListener('uimori-resource-saved', refresh);
      window.removeEventListener('storage', storage);
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
function SavedResourcePreview({ model }: { model: ResourceModel }) {
  useI18n();
  const promptText = (program: RisuPrompt) => {
    const blocks = program.nativeRisuPreset.preset.promptTemplate;
    return Array.isArray(blocks)
      ? blocks
          .flatMap((block) => {
            if (!block || typeof block !== 'object' || typeof block.text !== 'string') return [];
            return [block.text];
          })
          .join('\n\n')
      : '';
  };
  const sections =
    'program' in model
      ? [{ title: model.title, text: promptText(model.program) }]
      : 'main' in model && 'translation' in model
        ? [
            {
              title: t('shared.writingTitle', { title: model.main.title }),
              text: promptText(model.main.program),
            },
            {
              title: t('shared.translationTitle', { title: model.translation.title }),
              text: promptText(model.translation.program),
            },
          ]
        : 'text' in model
          ? [
              {
                title: model.title,
                text: [model.description, model.text || model.package.body]
                  .filter(Boolean)
                  .join('\n\n'),
              },
            ]
          : [];
  return (
    <section aria-label={t('shared.savedTextPreview')} className="resource-saved-preview">
      <h3>{t('shared.savedTextPreview')}</h3>
      {sections.map((section, index) => (
        <section key={index}>
          <h4>{section.title}</h4>
          <p>{section.text || t('shared.emptySavedText')}</p>
        </section>
      ))}
    </section>
  );
}
export function ResourceEditorProvider({
  value,
  saveButton,
  children,
}: {
  value: ResourceEditorValue;
  saveButton?: RefObject<HTMLButtonElement | null>;
  children: ReactNode;
}) {
  useI18n();
  const [reviewOpen, setReviewOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useShortcut('editor.save', () => saveButton?.current?.click(), {
    scope: root,
    active: !!saveButton,
  });
  useEffect(() => {
    const review = (event: Event) => {
      if ((event as CustomEvent<ResourceEditorSession>).detail === value.session)
        setReviewOpen(true);
    };
    window.addEventListener(conflictReviewEvent, review);
    return () => window.removeEventListener(conflictReviewEvent, review);
  }, [value.session]);
  return (
    <EditorContextValue.Provider value={value}>
      <div ref={root} className="resource-editor" onFocusCapture={value.activate}>
        {children}
        <SaveConflictDialog
          open={reviewOpen}
          title={t('shared.reviewChanged')}
          onClose={() => setReviewOpen(false)}
          readSaved={async () => {
            const saved = await value.session.readSaved();
            return () => ({
              content: saved ? (
                <>
                  <SavedResourcePreview model={saved.model} />
                  <p className="muted">{t('shared.copyBeforeDiscard')}</p>
                </>
              ) : (
                <p>{t('shared.noSavedResource')}</p>
              ),
            });
          }}
        />
      </div>
    </EditorContextValue.Provider>
  );
}

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
    } catch {}
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

export function useEditorSavePreparation(
  path: string,
  prepare: (model: ResourceModel) => ResourceModel
) {
  const session = useContext(EditorContextValue)?.session;
  const latest = useRef(prepare);
  latest.current = prepare;
  useEffect(() => session?.prepareOnSave(path, (model) => latest.current(model)), [session, path]);
}
export function usePublishedEditorLocation(location: EditorLocation) {
  const session = useContext(EditorContextValue)?.session;
  useEffect(() => {
    if (!session) return;
    locations.set(session, location);
    changed();
  }, [session, location]);
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
  showUnsaved = true,
}: {
  value: ResourceEditorValue;
  hideSyncError?: boolean;
  showUnsaved?: boolean;
}) {
  useI18n();
  const { state, session } = value;
  return (
    <div
      className={`resource-editor-status${!state.ready ? ' resource-editor-status-loading' : ''}`}
    >
      {!state.ready ? (
        <LoadingState
          presentation="region"
          loading={!state.error}
          error={state.error}
          label={t('shared.loadingResources')}
          onRetry={() => void session.open().catch(() => {})}
        />
      ) : (
        <span role="status">
          {state.saving
            ? t('shared.saving')
            : state.dirty
              ? showUnsaved
                ? t('shared.unsaved')
                : ''
              : state.document.targetId
                ? ''
                : t('shared.notRegistered')}
        </span>
      )}
      {state.creationPending && !state.saving && (
        <small role="alert">{t('shared.resourceCreationUncertain')}</small>
      )}
      {state.recovery === 'failed' && <small role="alert">{t('shared.recoveryFailure')}</small>}
      {state.conflict && (
        <small role="alert">
          {t('shared.resourceChanged')}{' '}
          {!state.creationPending && (
            <button
              type="button"
              className="ghost"
              onClick={() => requestResourceConflictReview(session)}
            >
              {t('shared.reviewSaved')}
            </button>
          )}
        </small>
      )}
      {state.ready && !hideSyncError && state.error && (
        <small role="alert">{translateMessage(state.error)}</small>
      )}
    </div>
  );
}
export function useResourceEditorCommands(value: ResourceEditorValue) {
  const [error, setError] = useState('');
  const run = (work: () => Promise<unknown>) => {
    setError('');
    return work().then(
      () => {},
      (caught) => setError((caught as Error).message)
    );
  };
  const { session, state } = value;
  const [restoredRevision, setRestoredRevision] = useState<{
    session: ResourceEditorSession;
    revision: number;
  } | null>(null);
  useEffect(() => {
    if (state.dirty) setRestoredRevision(null);
  }, [state.dirty]);
  return {
    value,
    error,
    canDiscard: state.dirty,
    discard: () => run(() => session.discard()),
    restored:
      restoredRevision?.session === session &&
      !state.dirty &&
      state.document.baseRevision === restoredRevision.revision,
    restore: async () => {
      setError('');
      setRestoredRevision(null);
      setRestoredRevision({ session, revision: await session.undo() });
    },
    undoRestore: () =>
      run(async () => {
        setRestoredRevision(null);
        await session.undo();
      }),
    dismissRestored: () => setRestoredRevision(null),
  };
}
export type ResourceEditorCommands = ReturnType<typeof useResourceEditorCommands>;

export function ResourceEditorActions({
  value,
  commands,
  hideSyncError = false,
  changes,
}: {
  value: ResourceEditorValue;
  commands?: ResourceEditorCommands;
  hideSyncError?: boolean;
  changes?: ReactNode;
}) {
  useI18n();
  const own = useResourceEditorCommands(value);
  const { error, canDiscard, discard } = commands ?? own;
  return (
    <div className="resource-editor-actions">
      <ResourceEditorStatus value={value} hideSyncError={hideSyncError} showUnsaved={!changes} />
      {value.state.dirty && changes}
      {canDiscard && (
        <button
          type="button"
          className="ghost resource-editor-discard"
          disabled={value.state.saving}
          onClick={() => void discard()}
        >
          {t('shared.cancelEditing')}
        </button>
      )}
      {error && <small role="alert">{translateMessage(error)}</small>}
    </div>
  );
}
