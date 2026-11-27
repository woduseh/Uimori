import { createHash } from 'node:crypto';
import { readImportReceipt, saveImportReceipt } from './import-operations.js';
import { readIllustrationPreset, saveIllustrationPreset } from './illustration-presets.js';
import { imageDataHashes, pruneUnusedData } from './unused-data.js';
import { readTheme, saveTheme } from './themes.js';
import type { Store } from './store.js';
import type {
  ContentEditModel,
  PromptEditModel,
  ResourceKind,
  ResourceModel,
  SavedResource,
} from '../core/resource-editing.js';
import { promptWorkspace, updatePromptWorkspace } from './prompt-workspace.js';
import { editableResource } from '../core/resource-editing.js';
import { HttpError } from './request-validation.js';
import { pruneThemeAssets, themeAssetHashes } from './theme-assets.js';
import { AppError, assertRevision } from './app-errors.js';
import type { CloneResource } from '#contracts';

type CreationReceipt = { kind: ResourceKind; id: string; organizationRevision?: number };

function creationReceipt(key: string, payload: unknown) {
  const receiptKey = `resource:save:${key}`;
  const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  return { receiptKey, digest };
}

export function readResource(store: Store, kind: ResourceKind, id: string): SavedResource {
  if (kind === 'prompt-workspace') return promptWorkspace(store);
  try {
    if (kind === 'illustration-preset') return readIllustrationPreset(store, id);
    if (kind === 'theme') return readTheme(store, id);
    store.product.assertAvailable(kind, id);
    return store.product.get(kind, id);
  } catch (error) {
    if (error instanceof HttpError && error.statusCode === 404)
      throw new AppError(404, 'LIBRARY_ITEM_DELETED');
    throw error;
  }
}

function readForEdit(store: Store, kind: ResourceKind, id: string): SavedResource {
  try {
    return readResource(store, kind, id);
  } catch (error) {
    if (error instanceof HttpError && error.statusCode === 404)
      throw new AppError(409, 'REVISION_CONFLICT');
    throw error;
  }
}

function readCreatedResource(store: Store, receipt: CreationReceipt): SavedResource {
  try {
    return readResource(store, receipt.kind, receipt.id);
  } catch (error) {
    if (error instanceof HttpError && error.statusCode === 404)
      throw new AppError(410, 'RESOURCE_CREATION_REMOVED');
    throw error;
  }
}

export function saveResource(
  store: Store,
  edit: {
    kind: ResourceKind;
    id: string | null;
    expectedRevision?: number;
    model: ResourceModel;
    idempotencyKey?: string;
  }
) {
  return store.transaction(() => {
    const receipt =
      !edit.id && edit.kind !== 'prompt-workspace' && edit.idempotencyKey
        ? creationReceipt(edit.idempotencyKey, { kind: edit.kind, model: edit.model })
        : null;
    if (receipt) {
      const previous = readImportReceipt<CreationReceipt>(
        store,
        receipt.receiptKey,
        receipt.digest
      );
      if (previous)
        return {
          saved: readCreatedResource(store, previous),
          created: false,
          ...(previous.organizationRevision === undefined
            ? {}
            : { creationOrganizationRevision: previous.organizationRevision }),
        };
    }
    const id = edit.kind === 'prompt-workspace' ? 'current' : edit.id;
    const previous = id ? readForEdit(store, edit.kind, id) : null;
    const oldUndo = id
      ? store.db.prepare('SELECT model FROM resource_undo WHERE kind=? AND id=?').get(edit.kind, id)
          ?.model
      : null;
    if (previous && previous.revision !== edit.expectedRevision)
      throw new AppError(409, 'REVISION_CONFLICT');
    const input = { ...edit.model, expectedRevision: edit.expectedRevision };
    const saved: SavedResource =
      edit.kind === 'illustration-preset'
        ? saveIllustrationPreset(store, edit.model, id ?? undefined, edit.expectedRevision)
        : edit.kind === 'theme'
          ? saveTheme(store, edit.model, id ?? undefined, edit.expectedRevision)
          : edit.kind === 'prompt-workspace'
            ? updatePromptWorkspace(store, { ...edit.model, expectedRevision: previous!.revision })
            : edit.kind === 'content'
              ? (store.product.content(input, id ?? undefined) as SavedResource)
              : (store.product.promptPreset(input, id ?? undefined) as SavedResource);
    if (previous && id)
      store.db
        .prepare(`INSERT INTO resource_undo(kind,id,saved_revision,model) VALUES(?,?,?,?)
      ON CONFLICT(kind,id) DO UPDATE SET saved_revision=excluded.saved_revision,model=excluded.model`)
        .run(edit.kind, id, saved.revision, JSON.stringify(editableResource(edit.kind, previous)));
    if (edit.kind === 'theme' && typeof oldUndo === 'string')
      pruneThemeAssets(store.db, themeAssetHashes(JSON.parse(oldUndo)));
    if (typeof oldUndo === 'string') {
      const retained = JSON.stringify([saved, previous]);
      const removedImage = [...oldUndo.matchAll(/[a-f0-9]{64}/gu)].some(
        ([hash]) =>
          !retained.includes(hash) &&
          !!store.db.prepare('SELECT 1 FROM image_blobs WHERE hash=?').get(hash)
      );
      if (removedImage) pruneUnusedData(store.db, imageDataHashes(oldUndo));
    }
    const organizationRevision =
      !previous && (edit.kind === 'content' || edit.kind === 'prompt-preset')
        ? (
            store.db
              .prepare('SELECT revision FROM library_organization_state WHERE id=1')
              .get() as {
              revision: number;
            }
          ).revision
        : undefined;
    if (receipt)
      saveImportReceipt(store, receipt.receiptKey, receipt.digest, {
        kind: edit.kind,
        id: (saved as { id: string }).id,
        ...(organizationRevision === undefined ? {} : { organizationRevision }),
      });
    return {
      saved,
      created: previous === null,
      ...(organizationRevision === undefined
        ? {}
        : { creationOrganizationRevision: organizationRevision }),
    };
  });
}

export function cloneResource(store: Store, request: CloneResource) {
  return store.transaction(() => {
    const source = readForEdit(store, request.kind, request.sourceId);
    assertRevision(source.revision, request.expectedSourceRevision);
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
      const preset = model as PromptEditModel;
      preset.title = request.title;
      if (request.syncNativeName) preset.program.nativeRisuPreset.preset.name = request.title;
    }
    const result = saveResource(store, { kind: request.kind, id: null, model });
    return { ...result, source: { id: request.sourceId, revision: source.revision } };
  });
}

export function readPreviousResource(store: Store, kind: ResourceKind, id: string) {
  const row = store.db
    .prepare('SELECT saved_revision,model FROM resource_undo WHERE kind=? AND id=?')
    .get(kind, id);
  const model = row ? parsedObject(String(row.model)) : null;
  if (!row || !model) throw new AppError(404, 'RESOURCE_UNDO_UNAVAILABLE');
  return { savedRevision: Number(row.saved_revision), model: model as ResourceModel };
}

function parsedObject(value: string): object | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function undoResource(store: Store, kind: ResourceKind, id: string, revision: number) {
  const previous = readPreviousResource(store, kind, id);
  if (previous.savedRevision !== revision) throw new AppError(409, 'REVISION_CONFLICT');
  return saveResource(store, { kind, id, expectedRevision: revision, model: previous.model });
}
