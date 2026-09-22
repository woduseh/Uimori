import { api, ApiError, libraryChangedKey } from './api.js';
import {
  editableResource,
  type ResourceKind,
  type ResourceModel,
  type SavedResource,
  type ResourceSaveResult,
} from '../core/resource-editing.js';
import { readRecovery, writeRecovery } from './editor-recovery.js';

export type EditorBuffer = {
  model: ResourceModel;
  rawFields: Record<string, string>;
  unappliedFields: string[];
};
export type EditorDocument = EditorBuffer & {
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
  error: string;
  conflict: boolean;
  recovery: 'none' | 'pending' | 'saved' | 'failed';
  restoreVersion: number;
};

/** Device-local editing state. Only Save/Copy/Undo writes an application resource. */
export class ResourceEditorSession {
  private state: EditorState;
  private readonly listeners = new Set<() => void>();
  private opening: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private recoveryWrites = Promise.resolve();
  private generation = 0;
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
    const local = { model: options.initialModel, rawFields: {}, unappliedFields: [] };
    this.state = {
      document: {
        ...local,
        targetId: options.targetId,
        baseRevision: null,
        baseModel: options.initialModel,
      },
      local,
      ready: false,
      dirty: false,
      saving: false,
      error: '',
      conflict: false,
      recovery: 'none',
      restoreVersion: 0,
    };
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
  private adopt(model: ResourceModel, targetId: string | null, revision: number | null) {
    const local = { model, rawFields: {}, unappliedFields: [] };
    this.generation++;
    this.emit({
      local,
      document: { ...local, targetId, baseRevision: revision, baseModel: model },
      ready: true,
      dirty: false,
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
    this.opening = (async () => {
      try {
        const saved = this.options.targetId ? await api<SavedResource>(this.path()) : null;
        this.adopt(
          saved ? editableResource(this.options.kind, saved) : this.options.initialModel,
          this.options.targetId,
          saved?.revision ?? null
        );
        try {
          const recovered = await readRecovery<ResourceModel>(this.options.editorKey);
          if (recovered && !this.state.dirty) {
            const local = {
              model: recovered.model,
              rawFields: recovered.rawFields,
              unappliedFields: [],
            };
            this.emit({
              local,
              document: { ...this.state.document, ...local },
              dirty: true,
              conflict: recovered.revision !== this.state.document.baseRevision,
              recovery: 'saved',
              restoreVersion: this.state.restoreVersion + 1,
            });
          }
        } catch {
          this.emit({ recovery: 'failed' });
        }
      } catch (error) {
        this.opening = null;
        this.emit({ error: (error as Error).message });
        throw error;
      }
    })();
    return this.opening;
  }
  private queueRecovery(remove = false) {
    clearTimeout(this.timer);
    const generation = this.generation;
    const value =
      remove || !this.state.dirty
        ? undefined
        : {
            revision: this.state.document.baseRevision,
            model: this.state.local.model,
            rawFields: this.state.local.rawFields,
          };
    this.recoveryWrites = this.recoveryWrites
      .catch(() => {})
      .then(() => writeRecovery(this.options.editorKey, value))
      .then(
        () => {
          if (generation === this.generation) this.emit({ recovery: value ? 'saved' : 'none' });
        },
        () => {
          if (generation === this.generation) this.emit({ recovery: 'failed' });
        }
      );
    return this.recoveryWrites;
  }
  private change(local: EditorBuffer) {
    if (!this.state.ready || this.disposed) return;
    this.generation++;
    this.emit({
      local,
      document: { ...this.state.document, ...local },
      dirty: true,
      recovery: 'pending',
    });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.queueRecovery(), 350);
  }
  setModel(model: ResourceModel) {
    const previous = this.state.local.model;
    if (
      Object.keys(model).length === Object.keys(previous).length &&
      Object.entries(model).every(([key, value]) =>
        Object.is(value, (previous as unknown as Record<string, unknown>)[key])
      )
    )
      return;
    this.change({ ...this.state.local, model });
  }
  setField(path: string, value: string) {
    if (this.state.local.rawFields[path] === value) return;
    this.change({
      ...this.state.local,
      rawFields: { ...this.state.local.rawFields, [path]: value },
    });
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
      throw new Error('문법 오류가 있는 입력을 확인해 주세요. 입력은 그대로 유지돼요.');
    return model;
  }
  async flush() {
    await this.open();
    await this.queueRecovery();
  }
  async refresh() {
    await this.open();
    if (!this.state.document.targetId || this.state.saving) return;
    const saved = await api<SavedResource>(this.path());
    if (saved.revision === this.state.document.baseRevision) return;
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
    if (this.state.document.targetId) {
      const saved = await api<SavedResource>(this.path());
      this.adopt(
        editableResource(this.options.kind, saved),
        this.state.document.targetId,
        saved.revision
      );
    } else this.adopt(this.options.initialModel, null, null);
    await this.queueRecovery(true);
  }
  async save(model?: ResourceModel): Promise<ResourceSaveResult> {
    await this.open();
    if (this.state.saving) throw new Error('저장 중이에요.');
    if (this.state.conflict)
      throw new Error('저장된 자료가 바뀌었어요. 입력을 복사해 두고 최신 저장본을 불러와 주세요.');
    if (model) this.setModel(model);

    const document = this.state.document;
    const sent = this.prepared(this.state.local.model);
    const generation = this.generation;
    this.emit({ saving: true, error: '' });
    try {
      const result = await api<ResourceSaveResult>('/resources/save', {
        kind: this.options.kind,
        id: document.targetId,
        expectedRevision: document.baseRevision ?? undefined,
        model: sent,
      });
      const targetId =
        this.options.kind === 'prompt-workspace' ? 'current' : (result.saved as { id: string }).id;
      const savedModel = editableResource(this.options.kind, result.saved);
      if (generation === this.generation) {
        this.adopt(savedModel, targetId, result.saved.revision);
        await this.queueRecovery(true);
      } else {
        this.emit({
          document: {
            ...this.state.document,
            targetId,
            baseRevision: result.saved.revision,
            baseModel: savedModel,
          },
          conflict: false,
        });
        await this.queueRecovery();
      }
      this.notifySaved();
      return result;
    } catch (error) {
      this.emit({
        error: (error as Error).message,
        conflict: error instanceof ApiError && error.status === 409,
      });
      throw error;
    } finally {
      this.emit({ saving: false });
    }
  }
  async copy(kind: 'content' | 'prompt-preset', model: ResourceModel): Promise<ResourceSaveResult> {
    const result = await api<ResourceSaveResult>('/resources/save', {
      kind,
      id: null,
      model: this.prepared(model),
    });
    this.notifySaved();
    return result;
  }
  async undo() {
    if (!this.state.document.targetId || this.state.dirty)
      throw new Error('미저장 입력을 먼저 저장하거나 취소해 주세요.');
    const result = await api<ResourceSaveResult>(`${this.path()}/undo`, {
      expectedRevision: this.state.document.baseRevision,
    });
    this.adopt(
      editableResource(this.options.kind, result.saved),
      this.state.document.targetId,
      result.saved.revision
    );
    this.notifySaved();
  }
  async discard() {
    await this.reloadSaved();
  }
  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    void this.queueRecovery();
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
