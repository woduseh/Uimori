import { legacyMessage } from './i18n.js';
import { api, ApiError, definiteRejection, libraryChangedKey } from './api.js';
import {
  editableResource,
  type ResourceKind,
  type ResourceModel,
  type SavedResource,
  type ResourceSaveResult,
} from '../core/resource-editing.js';
import {
  readRecovery,
  writeRecovery,
  deleteRecoveryIfToken,
  type RecoveryBuffer,
} from './editor-recovery.js';
import { sameEditorValue } from './editor-values.js';

export type EditorBuffer = {
  model: ResourceModel;
  rawFields: Record<string, string>;
  unappliedFields: string[];
};
export type EditorDocument = {
  targetId: string | null;
  baseRevision: number | null;
  baseModel: ResourceModel;
};
export type EditorState = {
  document: EditorDocument;
  local: EditorBuffer;
  ready: boolean;
  dirty: boolean;
  saving: boolean;
  /** The frozen creation must be confirmed before a new save intent can begin. */
  creationPending: boolean;
  /** New edits can autosave; recovered input waits for an explicit save. */
  autosavePending: boolean;
  error: string;
  conflict: boolean;
  recovery: 'none' | 'pending' | 'saved' | 'failed';
  restoreVersion: number;
};

type PendingCreation = { key: string; copy: boolean; model: ResourceModel };
function editorTabScope(): string {
  try {
    const key = 'uimori:editor-tab-scope';
    const stored = sessionStorage.getItem(key);
    if (stored) return stored;
    const next = crypto.randomUUID();
    sessionStorage.setItem(key, next);
    return next;
  } catch {
    // A storage-restricted tab still saves, but cannot recover an unknown result after reload.
    return crypto.randomUUID();
  }
}

/** The sole owner of a resource's editable model, raw input, baseline and save state. */
export class ResourceEditorSession {
  private state: EditorState;
  private readonly listeners = new Set<() => void>();
  private opening: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private recoveryWrites = Promise.resolve();
  private readonly recoveryTokens = new Map<string, string | undefined>();
  private generation = 0;
  private pendingCreation: PendingCreation | null = null;
  private creationReadFailed = false;
  private readonly creationScope = editorTabScope();
  private get creationKey() {
    return `resource-creation:${this.options.editorKey}:${this.creationScope}`;
  }
  private loadVersion = 0;
  private readonly preparations = new Map<string, (model: ResourceModel) => ResourceModel>();
  private disposed = false;
  constructor(
    readonly options: {
      editorKey: string;
      kind: ResourceKind;
      targetId: string | null;
      initialModel: ResourceModel;
    }
  ) {
    this.state = {
      document: {
        targetId: options.targetId,
        baseRevision: null,
        baseModel: options.initialModel,
      },
      local: { model: options.initialModel, rawFields: {}, unappliedFields: [] },
      ready: false,
      dirty: false,
      saving: false,
      creationPending: false,
      autosavePending: false,
      error: '',
      conflict: false,
      recovery: 'none',
      restoreVersion: 0,
    };
  }
  get editorKey() {
    const id = this.state.document.targetId;
    return id ? `${this.options.kind}:${id}` : this.options.editorKey;
  }
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private emit(update: Partial<EditorState>) {
    this.state = { ...this.state, ...update };
    for (const listener of this.listeners) listener();
  }
  private isDirty(local: EditorBuffer, baseline = this.state.document.baseModel) {
    return Object.keys(local.rawFields).length > 0 || !sameEditorValue(local.model, baseline);
  }
  private adopt(model: ResourceModel, targetId: string | null, revision: number | null) {
    this.generation++;
    this.emit({
      local: { model, rawFields: {}, unappliedFields: [] },
      document: { targetId, baseRevision: revision, baseModel: model },
      ready: true,
      dirty: false,
      creationPending: !!this.pendingCreation,
      autosavePending: false,
      conflict: false,
      error: '',
      recovery: 'none',
      restoreVersion: this.state.restoreVersion + 1,
    });
  }
  private path() {
    return `/resources/${this.options.kind}/${encodeURIComponent(this.state.document.targetId ?? '')}`;
  }
  open(): Promise<void> {
    this.disposed = false;
    if (this.opening) return this.opening;
    const load = ++this.loadVersion;
    this.opening = (async () => {
      try {
        const saved = this.options.targetId ? await api<SavedResource>(this.path()) : null;
        if (this.disposed || load !== this.loadVersion) return;
        // Stay uneditable until recovery is read. Closing during this read must not
        // delete a buffer that this session has never loaded.
        let recovered: RecoveryBuffer<ResourceModel> | undefined;
        let recoveryFailed = false;
        try {
          recovered = await readRecovery<ResourceModel>(this.editorKey);
        } catch {
          recoveryFailed = true;
        }
        try {
          const savedRequest = await readRecovery<PendingCreation>(this.creationKey);
          const pending = savedRequest?.model;
          if (
            pending &&
            typeof pending.key === 'string' &&
            pending.key.length > 0 &&
            typeof pending.copy === 'boolean' &&
            pending.model &&
            typeof pending.model === 'object'
          )
            this.pendingCreation = pending;
        } catch {
          this.creationReadFailed = true;
          recoveryFailed = true;
        }
        if (this.disposed || load !== this.loadVersion) return;
        this.adopt(
          saved ? editableResource(this.options.kind, saved) : this.options.initialModel,
          this.options.targetId,
          saved?.revision ?? null
        );
        if (recovered) {
          this.recoveryTokens.set(this.editorKey, recovered.token);
          const local = {
            model: recovered.model,
            rawFields: recovered.rawFields,
            unappliedFields: [],
          };
          const dirty = this.isDirty(local);
          this.emit({
            local,
            dirty,
            conflict: dirty && recovered.revision !== this.state.document.baseRevision,
            recovery: dirty ? 'saved' : 'none',
            restoreVersion: this.state.restoreVersion + 1,
          });
        } else if (recoveryFailed) this.emit({ recovery: 'failed' });
      } catch (error) {
        if (!this.disposed && load === this.loadVersion) {
          this.opening = null;
          this.emit({ error: (error as Error).message });
        }
        throw error;
      }
    })();
    return this.opening;
  }
  private queueRecovery(remove = false, key = this.editorKey) {
    clearTimeout(this.timer);
    const generation = this.generation;
    const value =
      remove || !this.state.dirty
        ? undefined
        : {
            token: crypto.randomUUID(),
            revision: this.state.document.baseRevision,
            model: this.state.local.model,
            rawFields: this.state.local.rawFields,
          };
    this.recoveryWrites = this.recoveryWrites
      .catch(() => {})
      .then(async () => {
        if (value) {
          await writeRecovery(key, value);
          this.recoveryTokens.set(key, value.token);
        } else if (this.recoveryTokens.has(key)) {
          await deleteRecoveryIfToken(key, this.recoveryTokens.get(key));
          this.recoveryTokens.delete(key);
        }
      })
      .then(
        () => {
          if (generation === this.generation && key === this.editorKey)
            this.emit({ recovery: value ? 'saved' : 'none' });
        },
        () => {
          if (generation === this.generation && key === this.editorKey)
            this.emit({ recovery: 'failed' });
        }
      );
    return this.recoveryWrites;
  }
  private change(local: EditorBuffer) {
    if (!this.state.ready || this.disposed) return;
    const dirty = this.isDirty(local);
    this.generation++;
    this.emit({ local, dirty, autosavePending: dirty, recovery: 'pending' });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.queueRecovery(), 350);
  }
  setModel(action: ResourceModel | ((current: ResourceModel) => ResourceModel)) {
    const model = typeof action === 'function' ? action(this.state.local.model) : action;
    if (sameEditorValue(model, this.state.local.model)) return;
    this.change({ ...this.state.local, model });
  }
  setField(path: string, value: string | undefined) {
    if (this.state.local.rawFields[path] === value) return;
    const rawFields = { ...this.state.local.rawFields };
    if (value === undefined) delete rawFields[path];
    else rawFields[path] = value;
    this.change({ ...this.state.local, rawFields });
  }
  pendingField(path: string, pending: boolean) {
    if (this.state.local.unappliedFields.includes(path) === pending) return;
    this.emit({
      local: {
        ...this.state.local,
        unappliedFields: pending
          ? [...this.state.local.unappliedFields, path]
          : this.state.local.unappliedFields.filter((item) => item !== path),
      },
    });
  }
  prepareOnSave(path: string, prepare: (model: ResourceModel) => ResourceModel) {
    this.preparations.set(path, prepare);
    return () => {
      this.preparations.delete(path);
    };
  }
  private prepared(model: ResourceModel): ResourceModel {
    for (const prepare of this.preparations.values()) model = prepare(model);
    if (this.state.local.unappliedFields.some((path) => !this.preparations.has(path)))
      throw new Error(legacyMessage('shared.syntaxError'));
    return model;
  }
  /** Capture the exact editable document before the caller's first asynchronous step. */
  captureForHelper() {
    const state = this.state;
    if (!state.ready) return null;
    const document = state.document;
    const model =
      state.dirty || !document.targetId
        ? structuredClone(this.prepared(state.local.model))
        : undefined;
    return {
      kind: this.options.kind,
      targetId: document.targetId,
      revision: document.baseRevision,
      title:
        model && 'title' in model
          ? model.title
          : 'title' in state.local.model
            ? state.local.model.title
            : '현재 프롬프트',
      source: model ? ('unsaved' as const) : ('saved' as const),
      ...(model ? { model } : {}),
    };
  }
  async flush() {
    await this.open();
    await this.queueRecovery();
  }
  async refresh() {
    if (this.disposed) return;
    await this.open();
    if (!this.state.document.targetId || this.state.saving) return;
    const load = ++this.loadVersion;
    const saved = await api<SavedResource>(this.path());
    if (this.disposed || load !== this.loadVersion || this.state.saving) return;
    if (saved.revision <= (this.state.document.baseRevision ?? 0)) return;
    if (this.state.dirty) this.emit({ conflict: true });
    else
      this.adopt(
        editableResource(this.options.kind, saved),
        this.state.document.targetId,
        saved.revision
      );
  }
  async reloadSaved() {
    await this.open();
    if (this.pendingCreation) throw new Error(legacyMessage('shared.resourceCreationUncertain'));
    if (this.state.saving) return;
    const load = ++this.loadVersion;
    const generation = this.generation;
    const id = this.state.document.targetId;
    const saved = id ? await api<SavedResource>(this.path()) : null;
    if (this.disposed || load !== this.loadVersion || generation !== this.generation) return;
    this.adopt(
      saved ? editableResource(this.options.kind, saved) : this.options.initialModel,
      id,
      saved?.revision ?? null
    );
    await this.queueRecovery(true);
  }
  /** Read a comparison copy without adopting it or changing local recovery input. */
  async readSaved() {
    const id = this.state.document.targetId;
    if (!id) return null;
    const saved = await api<SavedResource>(this.path());
    return { revision: saved.revision, model: editableResource(this.options.kind, saved) };
  }
  async save(
    model?: ResourceModel,
    options?: { copy?: boolean }
  ): Promise<ResourceSaveResult & { creationIntent: boolean }> {
    await this.open();
    if (this.state.saving) throw new Error(legacyMessage('shared.alreadySaving'));
    if (this.creationReadFailed)
      throw new Error(legacyMessage('shared.resourceCreationReadFailed'));
    if (this.state.conflict && !options?.copy && !this.pendingCreation)
      throw new Error(legacyMessage('shared.resourceChangedHelp'));
    if (model) this.setModel(model);
    const creating = !!options?.copy || !this.state.document.targetId || !!this.pendingCreation;
    const previousCreation = this.pendingCreation;
    let prepared: ResourceModel;
    try {
      // A pending creation already has frozen, validated input. Confirm its admission
      // without parsing newer unsaved fields that may still be incomplete.
      prepared = previousCreation?.model ?? this.prepared(this.state.local.model);
    } catch (error) {
      this.emit({ error: (error as Error).message });
      throw error;
    }
    if (creating && !previousCreation)
      this.pendingCreation = {
        key: crypto.randomUUID(),
        copy: !!options?.copy,
        model: structuredClone(prepared),
      };
    const creation = this.pendingCreation;
    const document = this.state.document;
    const generation = this.generation;
    const previousKey = this.editorKey;
    this.loadVersion++;
    this.emit({ saving: true, creationPending: !!creation, error: '' });
    let admitted = false;
    let persisted = false;
    try {
      // A separate, tab-owned outbox cannot overwrite another tab's unsaved editor buffer.
      if (creation) {
        await writeRecovery(this.creationKey, {
          token: creation.key,
          revision: null,
          model: creation,
          rawFields: {},
        });
        persisted = true;
      }
      const result = await api<ResourceSaveResult>('/resources/save', {
        kind: this.options.kind,
        id: creation ? null : document.targetId,
        expectedRevision: creation ? undefined : (document.baseRevision ?? undefined),
        model: creation?.model ?? prepared,
        ...(creation ? { idempotencyKey: creation.key } : {}),
      });
      admitted = true;
      this.pendingCreation = null;
      const targetId =
        this.options.kind === 'prompt-workspace' ? 'current' : (result.saved as { id: string }).id;
      const savedModel = editableResource(this.options.kind, result.saved);
      // All user-created resources start at revision 1. Old compact receipts store only
      // the ID, so a later revision on replay also detects changes for existing receipts.
      const changedAfterCreation = !!creation && !result.created && result.saved.revision > 1;
      if (
        generation === this.generation &&
        (!creation || this.isDirty(this.state.local, creation.model) === false)
      ) {
        this.adopt(savedModel, targetId, result.saved.revision);
      } else {
        const baseline = changedAfterCreation ? creation!.model : savedModel;
        const dirty = this.isDirty(this.state.local, baseline);
        this.emit({
          document: {
            targetId,
            baseRevision: changedAfterCreation ? 1 : result.saved.revision,
            baseModel: baseline,
          },
          dirty,
          autosavePending: dirty,
          creationPending: false,
          conflict: dirty && changedAfterCreation,
        });
      }
      if (creation) await deleteRecoveryIfToken(this.creationKey, creation.key).catch(() => {});
      // Finish old-key cleanup before storing edits under a newly created/copied resource.
      if (previousKey !== this.editorKey) await this.queueRecovery(true, previousKey);
      await this.queueRecovery();
      this.notifySaved();
      return { ...result, creationIntent: !!creation };
    } catch (error) {
      if (
        !admitted &&
        creation &&
        ((error instanceof ApiError &&
          error.status === 410 &&
          error.code === 'RESOURCE_CREATION_REMOVED') ||
          (!previousCreation &&
            (!persisted ||
              (persisted &&
                definiteRejection(error) &&
                !(error instanceof ApiError && error.status === 429)))))
      ) {
        this.pendingCreation = null;
        if (persisted) await deleteRecoveryIfToken(this.creationKey, creation.key).catch(() => {});
      }
      this.emit({
        error: (error as Error).message,
        creationPending: !!this.pendingCreation,
        conflict: this.state.conflict || (error instanceof ApiError && error.status === 409),
      });
      throw error;
    } finally {
      this.emit({ saving: false });
    }
  }
  async undo() {
    if (!this.state.document.targetId || this.state.dirty || this.state.saving)
      throw new Error(legacyMessage('shared.unsavedRequired'));
    const generation = this.generation;
    const load = ++this.loadVersion;
    const result = await api<ResourceSaveResult>(`${this.path()}/undo`, {
      expectedRevision: this.state.document.baseRevision,
    });
    if (!this.disposed && load === this.loadVersion && generation === this.generation) {
      this.adopt(
        editableResource(this.options.kind, result.saved),
        this.state.document.targetId,
        result.saved.revision
      );
    }
    this.notifySaved();
  }
  async discard() {
    await this.reloadSaved();
  }
  dispose() {
    this.disposed = true;
    this.loadVersion++;
    clearTimeout(this.timer);
    if (this.state.ready) {
      // Only pending edits/reverts need a close-time flush. A failed initial read
      // is not permission to erase an existing recovery buffer.
      if (this.state.dirty || this.state.recovery === 'pending') void this.queueRecovery();
    } else this.opening = null;
  }
  private notifySaved() {
    window.dispatchEvent(new Event('uimori-resource-saved'));
    if (this.options.kind !== 'content')
      window.dispatchEvent(new Event('prompt-workspace-changed'));
    try {
      localStorage.setItem(libraryChangedKey, String(Date.now()));
    } catch {
      /* Resource is already saved. */
    }
  }
}
