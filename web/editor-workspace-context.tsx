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
import type {
  DraftChange,
  DraftImpact,
  DraftPatchResult,
  DraftSavedOperation,
  DraftSaveResult,
  EditDraft,
  EditDraftKind,
  EditDraftModel,
} from '../core/edit-drafts.js';
import { api, ApiError, libraryChangedKey } from './api.js';
import { ReviewIcon } from './ui-icons.js';
import './editor-drafts.css';

type Buffer = {
  model: EditDraftModel;
  rawFields: Record<string, string>;
  unappliedFields: string[];
};
type PendingWrite = { operationId: string; expectedRevision: number };
type PendingCopy = {
  kind: 'content' | 'prompt-preset';
  model: EditDraftModel;
  editorKey: string;
  createId: string;
  saveId: string;
  draft?: EditDraft;
};
type CachedBuffer = {
  draftId?: string;
  revision?: number;
  local?: Buffer;
  dirty?: boolean;
  pendingPatch?: (PendingWrite & Buffer) | null;
  pendingSave?: (PendingWrite & { sent: Buffer }) | null;
  pendingCopy?: PendingCopy | null;
};
type SessionState = {
  draft: EditDraft | null;
  local: Buffer;
  ready: boolean;
  syncing: boolean;
  error: string;
  conflict: boolean;
  restoreVersion: number;
  dirty: boolean;
};
const serialize = (value: unknown) => JSON.stringify(value);
const buffer = (draft: EditDraft): Buffer => ({
  model: draft.model,
  rawFields: draft.rawFields,
  unappliedFields: draft.unappliedFields,
});
const sessions = new Map<symbol, EditorDraftSession>();
let focused: symbol | null = null;
export const editorContextChanged = 'uimori-editor-context-changed';
function changed() {
  window.dispatchEvent(new Event(editorContextChanged));
}
function activeSession() {
  return (focused ? sessions.get(focused) : null) ?? [...sessions.values()].at(-1) ?? null;
}
export type ActiveEditorContext = {
  draftId: string;
  revision: number;
  kind: EditDraftKind;
  targetId: string | null;
  title: string;
  editorKey: string;
};
export function getActiveEditorContext(): ActiveEditorContext | null {
  return sessionContext(activeSession());
}
function sessionContext(session: EditorDraftSession | null): ActiveEditorContext | null {
  const draft = session?.snapshot().draft;
  if (!session || !draft || draft.status !== 'active') return null;
  const model = session.snapshot().local.model;
  return {
    draftId: draft.id,
    revision: draft.revision,
    kind: draft.kind,
    targetId: draft.targetId,
    title: 'title' in model ? model.title : '현재 프롬프트',
    editorKey: draft.editorKey,
  };
}
export async function flushActiveEditor(): Promise<ActiveEditorContext | null> {
  const session = activeSession();
  if (!session) return null;
  await session.flush();
  return sessionContext(session);
}
export async function discardActiveEditor(editorKey?: string): Promise<void> {
  const session =
    editorKey === undefined
      ? activeSession()
      : [...sessions.values()].filter((value) => value.options.editorKey === editorKey).at(-1);
  await session?.discard();
}
export function refreshActiveEditor(): Promise<void> {
  return activeSession()?.refresh() ?? Promise.resolve();
}

/** A per-editor local buffer with serialized network writes and recoverable operation identities. */
export class EditorDraftSession {
  private state: SessionState;
  private listeners = new Set<() => void>();
  private opening: Promise<void> | null = null;
  private inflight: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private acknowledged = '';
  private pendingPatch: (PendingWrite & Buffer) | null = null;
  private pendingSave: (PendingWrite & { sent: Buffer }) | null = null;
  private pendingCopy: PendingCopy | null = null;
  private createOperation = crypto.randomUUID();
  private stopped = false;
  private storageKey: string;
  constructor(
    readonly options: {
      editorKey: string;
      kind: EditDraftKind;
      targetId: string | null;
      initialModel: EditDraftModel;
    }
  ) {
    this.storageKey = `uimori:editor-buffer:${options.editorKey}`;
    this.state = {
      draft: null,
      local: { model: structuredClone(options.initialModel), rawFields: {}, unappliedFields: [] },
      ready: false,
      syncing: false,
      error: '',
      conflict: false,
      restoreVersion: 0,
      dirty: false,
    };
  }
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private emit(next: Partial<SessionState> = {}) {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
    changed();
  }
  private cache() {
    try {
      localStorage.setItem(
        this.storageKey,
        serialize({
          draftId: this.state.draft?.id,
          revision: this.state.draft?.revision,
          local: this.state.local,
          dirty: this.state.dirty,
          pendingPatch: this.pendingPatch,
          pendingSave: this.pendingSave,
          pendingCopy: this.pendingCopy,
        })
      );
    } catch {
      /* The in-memory buffer remains available when browser storage is restricted. */
    }
  }
  private adopt(draft: EditDraft) {
    const local = buffer(draft);
    this.acknowledged = serialize(local);
    this.emit({
      draft,
      local,
      ready: true,
      dirty: false,
      conflict: false,
      error: '',
      restoreVersion: this.state.restoreVersion + 1,
    });
    this.cache();
  }
  open(): Promise<void> {
    if (this.opening) return this.opening;
    this.opening = (async () => {
      try {
        const found = await api<EditDraft[]>(
          `/edit-drafts?editorKey=${encodeURIComponent(this.options.editorKey)}`
        );
        const draft =
          found[0] ??
          (await api<EditDraft>('/edit-drafts', {
            ...this.options,
            model: this.options.initialModel,
            initialModel: undefined,
            operationId: this.createOperation,
          }));
        let cached: CachedBuffer | null = null;
        try {
          cached = JSON.parse(localStorage.getItem(this.storageKey) ?? 'null');
        } catch {
          /* Ignore invalid local cache. */
        }
        this.pendingCopy = cached?.pendingCopy ?? null;
        this.adopt(draft);
        if (cached?.draftId === draft.id && (cached.dirty || cached.pendingSave) && cached.local) {
          this.pendingPatch = cached.pendingPatch ?? null;
          this.pendingSave = cached.pendingSave ?? null;
          this.emit({
            local: cached.local,
            dirty: true,
            conflict: cached.revision !== draft.revision && !this.pendingPatch && !this.pendingSave,
            restoreVersion: this.state.restoreVersion + 1,
          });
          this.cache();
        }
        await this.refreshPristineTarget();
      } catch (error) {
        this.emit({ error: (error as Error).message });
        this.opening = null;
        throw error;
      }
    })();
    return this.opening;
  }
  private update(local: Buffer) {
    if (!this.state.ready || this.stopped || serialize(local) === serialize(this.state.local))
      return;
    const dirty = serialize(local) !== this.acknowledged;
    this.emit({ local, dirty });
    this.cache();
    clearTimeout(this.timer);
    if (dirty && !this.state.conflict)
      this.timer = setTimeout(() => {
        void this.flush().catch(() => {});
      }, 450);
  }
  setModel(model: EditDraftModel) {
    this.update({ ...this.state.local, model });
  }
  setField(path: string, value: string) {
    this.update({
      ...this.state.local,
      rawFields: { ...this.state.local.rawFields, [path]: value },
    });
  }
  pendingField(path: string, pending: boolean) {
    const fields = new Set(this.state.local.unappliedFields);
    if (pending) fields.add(path);
    else fields.delete(path);
    this.update({ ...this.state.local, unappliedFields: [...fields].sort() });
  }
  async flush(): Promise<void> {
    await this.open();
    clearTimeout(this.timer);
    if (this.pendingSave)
      throw new Error(
        '이전 저장의 응답을 확인하지 못했어요. 저장을 다시 눌러 결과를 확인해 주세요.'
      );
    if (this.state.conflict)
      throw new Error('다른 곳에서 초안이 바뀌었어요. 두 내용을 확인한 뒤 다시 적용해 주세요.');
    if (this.stopped) throw new Error('폐기된 초안이에요.');
    if (this.inflight) {
      await this.inflight;
      if (this.state.dirty) return this.flush();
      return;
    }
    this.inflight = (async () => {
      this.emit({ syncing: true, error: '' });
      try {
        while (this.state.dirty || this.pendingPatch) {
          const draft = this.state.draft!;
          const pending = this.pendingPatch ?? {
            ...structuredClone(this.state.local),
            expectedRevision: draft.revision,
            operationId: crypto.randomUUID(),
          };
          this.pendingPatch = pending;
          this.cache();
          const result = await api<DraftPatchResult>(`/edit-drafts/${draft.id}`, pending, 'PATCH');
          this.pendingPatch = null;
          if (result.status === 'conflict') {
            this.emit({
              draft: result.draft,
              conflict: true,
              error: '다른 편집이 먼저 반영됐어요. 내 입력과 제안을 보존했어요.',
            });
            this.cache();
            throw new Error(this.state.error);
          }
          this.acknowledged = serialize({
            model: pending.model,
            rawFields: pending.rawFields,
            unappliedFields: pending.unappliedFields,
          });
          this.emit({
            draft: result.draft,
            dirty: serialize(this.state.local) !== this.acknowledged,
          });
          this.cache();
        }
      } catch (error) {
        this.emit({ error: (error as Error).message });
        this.cache();
        throw error;
      } finally {
        this.emit({ syncing: false });
      }
    })();
    try {
      await this.inflight;
    } finally {
      this.inflight = null;
    }
  }
  private canRefresh() {
    return (
      this.state.ready &&
      !this.inflight &&
      !this.state.dirty &&
      !this.state.conflict &&
      !this.pendingPatch &&
      !this.pendingSave &&
      !this.pendingCopy &&
      !this.stopped
    );
  }
  private async refreshPristineTarget() {
    const before = this.state.draft;
    if (
      !this.canRefresh() ||
      !before?.targetId ||
      before.status !== 'active' ||
      serialize(before.model) !== serialize(before.baseModel) ||
      Object.keys(this.state.local.rawFields).length > 0 ||
      this.state.local.unappliedFields.length > 0
    )
      return;
    try {
      const target = await api<{ revision: number } | null>(
        `/edit-drafts/${before.id}/saved-target`
      );
      if (
        !target ||
        target.revision === before.baseRevision ||
        !this.canRefresh() ||
        this.state.draft !== before
      )
        return;
      const sent = serialize(this.state.local);
      this.inflight = (async () => {
        const result = await api<EditDraft>(`/edit-drafts/${before.id}/rebase`, {
          expectedRevision: before.revision,
          expectedTargetRevision: target.revision,
          mode: 'pristine',
          operationId: crypto.randomUUID(),
        });
        if (this.stopped) return;
        if (serialize(this.state.local) === sent) this.adopt(result);
        else {
          // Typing against the old saved model needs an explicit comparison with the new base.
          this.acknowledged = serialize(buffer(result));
          this.emit({
            draft: result,
            dirty: true,
            conflict: true,
            error: '저장본을 불러오는 동안 입력이 바뀌었어요. 두 초안을 비교해 주세요.',
          });
          this.cache();
        }
      })();
      try {
        await this.inflight;
      } finally {
        this.inflight = null;
      }
    } catch (error) {
      this.emit({ error: (error as Error).message });
    }
  }
  async refresh() {
    await this.open();
    if (!this.canRefresh()) return;
    const before = this.state.draft!;
    const draft = await api<EditDraft>(`/edit-drafts/${before.id}`);
    // A delayed read must not replace input or a newer acknowledgement received while it waited.
    if (!this.canRefresh() || this.state.draft !== before) return;
    if (draft.revision !== before.revision) {
      if (draft.status === 'discarded')
        this.emit({
          draft,
          error: '다른 곳에서 초안을 폐기했어요. 현재 입력은 보존했어요.',
          conflict: true,
        });
      else this.adopt(draft);
    }
    await this.refreshPristineTarget();
  }
  async reapply() {
    const latest = this.state.draft!;
    if (latest.status !== 'active') throw new Error('초안이 폐기됐어요. 새 초안을 열어 주세요.');
    this.pendingPatch = null;
    this.pendingSave = null;
    this.acknowledged = serialize(buffer(latest));
    this.emit({ draft: latest, conflict: false, dirty: true, error: '' });
    await this.flush();
  }
  async adoptServer() {
    const latest = await api<EditDraft>(`/edit-drafts/${this.state.draft!.id}`);
    this.pendingPatch = null;
    this.pendingSave = null;
    this.adopt(latest);
  }
  async reloadSaved(reviewedRevision?: number, mode: 'saved' | 'keep-draft' = 'saved') {
    await this.open();
    if (this.inflight) await this.inflight;
    const draft = this.state.draft!;
    if (!draft.targetId) throw new Error('아직 저장된 자료가 없어요.');
    const target =
      reviewedRevision === undefined
        ? await api<{ revision: number }>(`/edit-drafts/${draft.id}/saved-target`)
        : { revision: reviewedRevision };
    const result = await api<EditDraft>(`/edit-drafts/${draft.id}/rebase`, {
      expectedRevision: draft.revision,
      expectedTargetRevision: target.revision,
      mode,
      operationId: crypto.randomUUID(),
    });
    this.pendingPatch = null;
    this.pendingSave = null;
    this.adopt(result);
  }
  async save(model?: EditDraftModel): Promise<DraftSaveResult> {
    await this.open();
    if (model) this.setModel(model);
    if (!this.pendingSave) await this.flush();
    const draft = this.state.draft!;
    const pending = this.pendingSave ?? {
      expectedRevision: draft.revision,
      operationId: crypto.randomUUID(),
      sent: structuredClone(this.state.local),
    };
    this.pendingSave = pending;
    this.cache();
    try {
      const result = await api<DraftSaveResult>(`/edit-drafts/${draft.id}/save`, {
        expectedRevision: pending.expectedRevision,
        operationId: pending.operationId,
      });
      this.pendingSave = null;
      if (serialize(this.state.local) === serialize(pending.sent)) this.adopt(result.draft);
      else {
        this.acknowledged = serialize(buffer(result.draft));
        this.emit({
          draft: result.draft,
          dirty: serialize(this.state.local) !== this.acknowledged,
        });
        this.cache();
      }
      try {
        localStorage.setItem(libraryChangedKey, `${Date.now()}:${crypto.randomUUID()}`);
      } catch {
        /* Saved. */
      }
      dispatchEvent(new Event('prompt-workspace-changed'));
      return result;
    } catch (error) {
      if (error instanceof ApiError && error.status < 500) this.pendingSave = null;
      this.emit({ error: (error as Error).message });
      this.cache();
      throw error;
    }
  }
  async copy(kind: PendingCopy['kind'], model: EditDraftModel): Promise<DraftSaveResult> {
    await this.flush();
    const pending = this.pendingCopy ?? {
      kind,
      model: structuredClone(model),
      editorKey: `new:copy:${crypto.randomUUID()}`,
      createId: crypto.randomUUID(),
      saveId: crypto.randomUUID(),
    };
    this.pendingCopy = pending;
    this.cache();
    pending.draft ??= await api<EditDraft>('/edit-drafts', {
      kind: pending.kind,
      model: pending.model,
      targetId: null,
      editorKey: pending.editorKey,
      operationId: pending.createId,
    });
    this.cache();
    const result = await api<DraftSaveResult>(`/edit-drafts/${pending.draft.id}/save`, {
      expectedRevision: pending.draft.revision,
      operationId: pending.saveId,
    });
    this.pendingCopy = null;
    this.cache();
    try {
      localStorage.setItem(libraryChangedKey, `${Date.now()}:${crypto.randomUUID()}`);
    } catch {
      /* Saved. */
    }
    return result;
  }
  async undo(savedOperationId: string) {
    await this.flush();
    const draft = this.state.draft!;
    const result = await api<DraftSaveResult>(`/edit-drafts/${draft.id}/undo`, {
      savedOperationId,
      expectedRevision: draft.revision,
      operationId: crypto.randomUUID(),
    });
    this.adopt(result.draft);
    try {
      localStorage.setItem(libraryChangedKey, `${Date.now()}:${crypto.randomUUID()}`);
    } catch {
      /* Saved. */
    }
    dispatchEvent(new Event('prompt-workspace-changed'));
  }
  async discard() {
    await this.open();
    clearTimeout(this.timer);
    if (this.inflight) await this.inflight.catch(() => {});
    const draft = this.state.draft!;
    const result = await api<EditDraft>(
      `/edit-drafts/${draft.id}`,
      { expectedRevision: draft.revision, operationId: crypto.randomUUID() },
      'DELETE'
    );
    this.stopped = true;
    this.emit({ draft: result, dirty: false });
    try {
      localStorage.removeItem(this.storageKey);
    } catch {
      /* Discarded on server. */
    }
  }
  dispose() {
    clearTimeout(this.timer);
    this.cache();
    if (this.state.dirty && !this.state.conflict && !this.stopped)
      void this.flush().catch(() => {});
  }
}

type SessionOptions = {
  editorKey: string;
  kind: EditDraftKind;
  targetId: string | null;
  model: EditDraftModel;
  enabled?: boolean;
  onRestore: (draft: EditDraft) => void;
};
export function useServerEditDraft(options: SessionOptions) {
  const latest = useRef(options);
  latest.current = options;
  const session = useMemo(
    () =>
      new EditorDraftSession({
        editorKey: options.editorKey,
        kind: options.kind,
        targetId: options.targetId,
        initialModel: latest.current.model,
      }),
    [options.editorKey, options.kind, options.targetId]
  );
  const state = useSyncExternalStore(session.subscribe, session.snapshot);
  const token = useMemo(() => Symbol(options.editorKey), [options.editorKey]);
  const observed = useRef(serialize(options.model));
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
    const storage = (event: StorageEvent) => {
      if (event.key?.startsWith('uimori:editor-buffer:')) refresh();
    };
    window.addEventListener('focus', refresh);
    window.addEventListener('storage', storage);
    window.addEventListener('uimori-helper-updated', refresh);
    const interval = setInterval(refresh, 4000);
    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('storage', storage);
      window.removeEventListener('uimori-helper-updated', refresh);
      sessions.delete(token);
      if (focused === token) focused = null;
      session.dispose();
      changed();
    };
  }, [session, token, options.enabled]);
  useEffect(() => {
    const restored = session.snapshot();
    if (restored.restoreVersion === state.restoreVersion && restored.ready && restored.draft) {
      observed.current = serialize(restored.local.model);
      latest.current.onRestore({ ...restored.draft, ...restored.local });
    }
  }, [session, state.restoreVersion]);
  useEffect(() => {
    const signature = serialize(options.model);
    if (observedRestore.current !== state.restoreVersion) {
      observedRestore.current = state.restoreVersion;
      return;
    }
    if (state.ready && observed.current !== signature) {
      observed.current = signature;
      session.setModel(options.model);
    }
  }, [session, options.model, state.ready, state.restoreVersion]);
  const activate = useCallback(() => {
    focused = token;
    changed();
  }, [token]);
  return { session, state, activate };
}

const DraftContext = createContext<ReturnType<typeof useServerEditDraft> | null>(null);
const FieldPrefix = createContext('');
export function EditorDraftFieldScope({
  prefix,
  children,
}: {
  prefix: string;
  children: ReactNode;
}) {
  const parent = useContext(FieldPrefix);
  return <FieldPrefix.Provider value={`${parent}${prefix}.`}>{children}</FieldPrefix.Provider>;
}
export function EditorDraftProvider({
  value,
  children,
}: {
  value: ReturnType<typeof useServerEditDraft>;
  children: ReactNode;
}) {
  return (
    <DraftContext.Provider value={value}>
      <div className="editor-draft-surface" onFocusCapture={value.activate}>
        {children}
      </div>
    </DraftContext.Provider>
  );
}
/** Use stable semantic field keys (including item IDs), not labels or browser-generated IDs. */
export function useBufferedEditorState<T>(
  path: string,
  initial: T | (() => T)
): [T, Dispatch<SetStateAction<T>>] {
  const context = useContext(DraftContext);
  path = `${useContext(FieldPrefix)}${path}`;
  const initialRef = useRef(initial);
  initialRef.current = initial;
  const initialSignature = serialize(
    typeof initial === 'function' ? (initial as () => T)() : initial
  );
  const decode = () => {
    const value =
      typeof initialRef.current === 'function'
        ? (initialRef.current as () => T)()
        : initialRef.current;
    const raw = context?.state.local.rawFields[path];
    if (raw === undefined) return value;
    try {
      return (typeof value === 'string' ? raw : JSON.parse(raw)) as T;
    } catch {
      return value;
    }
  };
  const [value, setValue] = useState<T>(decode);
  const current = useRef(value);
  current.current = value;
  const contextRef = useRef(context);
  contextRef.current = context;
  const restore = context?.state.restoreVersion ?? 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Restoring buffers is triggered only by an adopted remote revision or a different field, never by typing.
  useEffect(() => {
    const next = decode();
    current.current = next;
    setValue(next);
  }, [path, restore, initialSignature]);
  const update = useCallback<Dispatch<SetStateAction<T>>>(
    (action) => {
      const next =
        typeof action === 'function' ? (action as (prior: T) => T)(current.current) : action;
      if (serialize(next) === serialize(current.current)) return;
      current.current = next;
      setValue(next);
      contextRef.current?.session.setField(path, typeof next === 'string' ? next : serialize(next));
    },
    [path]
  );
  return [value, update];
}
export function useUnappliedEditorField(path: string, pending: boolean) {
  path = `${useContext(FieldPrefix)}${path}`;
  const context = useContext(DraftContext),
    session = context?.session;
  useEffect(() => {
    session?.pendingField(path, pending);
  }, [session, path, pending]);
}

export function EditorDraftStatus({
  value,
  hideSyncError = false,
}: {
  value: ReturnType<typeof useServerEditDraft>;
  hideSyncError?: boolean;
}) {
  const { state, session } = value;
  const [comparison, setComparison] = useState(false);
  const [actionError, setActionError] = useState('');
  const [working, setWorking] = useState(false);
  const [review, setReview] = useState<{
    changes: DraftChange[];
    impact: DraftImpact;
    operations: DraftSavedOperation[];
    target: { revision: number; model: EditDraftModel } | null;
  } | null>(null);
  const [undo, setUndo] = useState<DraftSavedOperation | null>(null);
  const work = (action: () => Promise<unknown>) => {
    if (working) return;
    setWorking(true);
    setActionError('');
    void action()
      .catch((error: Error) => setActionError(error.message))
      .finally(() => setWorking(false));
  };
  const inspect = async () => {
    await session.flush();
    const id = session.snapshot().draft!.id;
    const [difference, impact, operations, target] = await Promise.all([
      api<{ changes: DraftChange[] }>(`/edit-drafts/${id}/diff`),
      api<DraftImpact>(`/edit-drafts/${id}/impact`),
      api<DraftSavedOperation[]>(`/edit-drafts/${id}/saved-operations`),
      api<{ revision: number; model: EditDraftModel } | null>(`/edit-drafts/${id}/saved-target`),
    ]);
    setReview({ changes: difference.changes, impact, operations, target });
    setUndo(null);
  };
  return (
    <div className="editor-draft-status" data-testid="editor-draft-status">
      <div className="editor-draft-toolbar">
        <small role="status">
          {!state.ready
            ? '저장된 초안을 불러오는 중이에요…'
            : state.syncing
              ? '초안을 동기화하고 있어요…'
              : state.dirty
                ? '이 기기에 입력을 보관했어요.'
                : '초안을 동기화했어요. 자료 저장은 별도예요.'}
        </small>
        {state.ready && (
          <button
            type="button"
            className="secondary editor-draft-review-open"
            disabled={working || state.conflict}
            onClick={() => work(inspect)}
          >
            <ReviewIcon size={18} aria-hidden="true" />
            변경 검토
          </button>
        )}
      </div>
      {(actionError || (!hideSyncError && state.error)) && (
        <p role="alert">{actionError || state.error}</p>
      )}
      {state.conflict ? (
        <>
          <button type="button" className="secondary" onClick={() => setComparison(!comparison)}>
            두 초안 비교
          </button>
          {comparison && (
            <div className="editor-draft-review">
              <p>서버 초안</p>
              <pre>{JSON.stringify(state.draft && buffer(state.draft), null, 2)}</pre>
              <p>이 기기의 입력</p>
              <pre>{JSON.stringify(state.local, null, 2)}</pre>
              <button
                type="button"
                disabled={working}
                onClick={() => work(() => session.reapply())}
              >
                확인한 서버 초안에 내 입력 적용
              </button>
              <button
                type="button"
                disabled={working}
                className="secondary"
                onClick={() => work(() => session.adoptServer())}
              >
                서버 초안으로 돌아가기
              </button>
            </div>
          )}
        </>
      ) : (
        state.error && (
          <button type="button" className="secondary" onClick={() => work(() => session.flush())}>
            초안 동기화 다시 시도
          </button>
        )
      )}
      {review && (
        <section className="editor-draft-review" aria-label="편집 변경 검토">
          <div className="editor-draft-toolbar">
            <strong>편집 변경 검토</strong>
            <button type="button" className="ghost" onClick={() => setReview(null)}>
              닫기
            </button>
          </div>
          <p>
            {review.impact.scope === 'all-chats'
              ? '모든 채팅의 다음 요청에 반영해요.'
              : review.impact.scope === 'saved-preset'
                ? '저장된 프리셋을 갱신해요. 적용된 현재 프롬프트는 그대로 유지해요.'
                : review.impact.scope === 'new-item'
                  ? '새 자료로 저장해요.'
                  : `공유 자료 ${review.impact.contents.length}개와 연결된 채팅 ${review.impact.chats.length}개에 영향을 줄 수 있어요. 다음 요청부터 사용해요.`}
          </p>
          {!!review.impact.chats.length && (
            <ul>
              {review.impact.chats.map((chat) => (
                <li key={chat.id}>{chat.title}</li>
              ))}
            </ul>
          )}
          <details>
            <summary>저장본과 비교 · {review.changes.length}곳</summary>
            <DraftChanges changes={review.changes} />
          </details>
          {!!state.local.unappliedFields.length && (
            <p>아직 적용하지 않은 입력: {state.local.unappliedFields.join(', ')}</p>
          )}
          {review.target && review.target.revision !== state.draft?.baseRevision && (
            <div>
              <p role="alert">
                저장본이 개정 {review.target.revision}로 바뀌었어요. 최신 내용과 내 초안을 확인해
                주세요.
              </p>
              <details>
                <summary>최신 저장본 보기</summary>
                <pre>{JSON.stringify(review.target.model, null, 2)}</pre>
              </details>
              <button
                type="button"
                disabled={working}
                onClick={() =>
                  work(async () => {
                    await session.reloadSaved(review.target!.revision, 'keep-draft');
                    setReview(null);
                  })
                }
              >
                이 저장본을 기준으로 내 초안 유지
              </button>
              <button
                type="button"
                className="secondary"
                disabled={working}
                onClick={() =>
                  work(async () => {
                    await session.reloadSaved(review.target!.revision);
                    setReview(null);
                  })
                }
              >
                확인한 저장본으로 돌아가기
              </button>
            </div>
          )}
          <details>
            <summary>최근 저장 이력 · {review.operations.length}건</summary>
            {review.operations.map((operation) => (
              <div key={operation.operationId}>
                <p>
                  개정 {operation.savedRevision} · {new Date(operation.createdAt).toLocaleString()}
                </p>
                <DraftChanges changes={operation.changes} />
                {operation.created ? (
                  <small>새 자료를 없애려면 자료 삭제 메뉴를 사용해 주세요.</small>
                ) : (
                  <button type="button" className="secondary" onClick={() => setUndo(operation)}>
                    이 저장 되돌리기 검토
                  </button>
                )}
              </div>
            ))}
          </details>
          {undo && (
            <div>
              <p>다음 차이를 새 개정으로 저장해요. 이후 편집이 있으면 되돌리기를 중단해요.</p>
              <DraftChanges changes={undo.undoChanges} />
              <button
                type="button"
                disabled={working}
                onClick={() =>
                  work(async () => {
                    await session.undo(undo.operationId);
                    await inspect();
                  })
                }
              >
                확인한 저장 되돌리기
              </button>
              <button type="button" className="secondary" onClick={() => setUndo(null)}>
                취소
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function DraftChanges({ changes }: { changes: DraftChange[] }) {
  return changes.length ? (
    <ul className="editor-draft-changes">
      {changes.map((change) => (
        <li key={change.path}>
          <code>{change.path}</code>
          <p>이전</p>
          <pre>{JSON.stringify(change.before, null, 2)}</pre>
          <p>이후</p>
          <pre>{JSON.stringify(change.after, null, 2)}</pre>
        </li>
      ))}
    </ul>
  ) : (
    <p>변경된 항목이 없어요.</p>
  );
}
