import { readIllustrationPreset, saveIllustrationPreset } from './illustration-presets.js';
import { imageDataHashes, pruneUnusedData } from './unused-data.js';
import { readTheme, saveTheme } from './themes.js';
import type { Store } from './store.js';
import type {
  ContentEditModel,
  ResourceKind,
  ResourceModel,
  SavedResource,
} from '../core/resource-editing.js';
import { promptWorkspace, updatePromptWorkspace } from './prompt-workspace.js';
import { editableResource } from '../core/resource-editing.js';
import { HttpError } from './request-validation.js';

export function readResource(store: Store, kind: ResourceKind, id: string): SavedResource {
  if (kind === 'illustration-preset') return readIllustrationPreset(store, id);
  if (kind === 'theme') return readTheme(store, id);
  return kind === 'prompt-workspace' ? promptWorkspace(store) : store.product.get(kind, id);
}

export function saveResource(
  store: Store,
  edit: {
    kind: ResourceKind;
    id: string | null;
    expectedRevision?: number;
    model: ResourceModel;
  }
) {
  return store.transaction(() => {
    const id = edit.kind === 'prompt-workspace' ? 'current' : edit.id;
    const previous = id ? readResource(store, edit.kind, id) : null;
    const oldUndo = id
      ? store.db.prepare('SELECT model FROM resource_undo WHERE kind=? AND id=?').get(edit.kind, id)
          ?.model
      : null;
    if (previous && previous.revision !== edit.expectedRevision)
      throw new HttpError(409, '저장된 자료가 변경됐어요. 최신 자료를 확인해 주세요.');
    const input = { ...edit.model, expectedRevision: edit.expectedRevision };
    const saved: SavedResource =
      edit.kind === 'illustration-preset'
        ? saveIllustrationPreset(store, edit.model, id ?? undefined, edit.expectedRevision)
        : edit.kind === 'theme'
          ? saveTheme(store, edit.model, id ?? undefined, edit.expectedRevision)
          : edit.kind === 'prompt-workspace'
            ? updatePromptWorkspace(store, input)
            : edit.kind === 'content'
              ? (store.product.content(input, id ?? undefined) as SavedResource)
              : (store.product.promptPreset(input, id ?? undefined) as SavedResource);
    if (previous && id)
      store.db
        .prepare(`INSERT INTO resource_undo(kind,id,saved_revision,model) VALUES(?,?,?,?)
      ON CONFLICT(kind,id) DO UPDATE SET saved_revision=excluded.saved_revision,model=excluded.model`)
        .run(edit.kind, id, saved.revision, JSON.stringify(editableResource(edit.kind, previous)));
    if (typeof oldUndo === 'string') {
      const retained = JSON.stringify([saved, previous]);
      const removedImage = [...oldUndo.matchAll(/[a-f0-9]{64}/gu)].some(
        ([hash]) =>
          !retained.includes(hash) &&
          !!store.db.prepare('SELECT 1 FROM image_blobs WHERE hash=?').get(hash)
      );
      if (removedImage) pruneUnusedData(store.db, imageDataHashes(oldUndo));
    }
    return { saved, created: previous === null };
  });
}

/** Clone saved authorship, without the source's selection, history or undo state. */
export function cloneResource(
  store: Store,
  request: {
    kind: 'content' | 'prompt-preset';
    sourceId: string;
    expectedSourceRevision: number;
    title: string;
  }
) {
  return store.transaction(() => {
    store.product.assertAvailable(request.kind, request.sourceId);
    const source = readResource(store, request.kind, request.sourceId);
    if (source.revision !== request.expectedSourceRevision)
      throw new HttpError(409, '원본 자료가 변경됐어요. 최신 자료를 확인한 뒤 복제해 주세요.');
    const model = structuredClone(editableResource(request.kind, source));
    if (request.kind === 'content') {
      const content = model as ContentEditModel;
      content.title = request.title;
      content.relatedIds = [];
      content.package.title = request.title;
      const native = content.package.nativeRisu;
      if (!Object.keys(native.card).length && native.module) native.module.name = request.title;
      else native.card.name = request.title;
    } else {
      // The library title and authored native preset name are independent fields.
      (model as { title: string }).title = request.title;
    }
    return {
      ...saveResource(store, { kind: request.kind, id: null, model }),
      source: { id: request.sourceId, revision: source.revision },
    };
  });
}

export function undoResource(store: Store, kind: ResourceKind, id: string, revision: number) {
  const row = store.db
    .prepare('SELECT saved_revision,model FROM resource_undo WHERE kind=? AND id=?')
    .get(kind, id);
  if (!row) throw new HttpError(404, '직전 저장본이 없어요.');
  if (row.saved_revision !== revision)
    throw new HttpError(409, '최근 저장 이후 자료가 변경됐어요.');
  return saveResource(store, {
    kind,
    id,
    expectedRevision: revision,
    model: JSON.parse(String(row.model)),
  });
}
