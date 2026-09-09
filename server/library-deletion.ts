import { HttpError, fields, number, record } from './request-validation.js';
import type { FastifyInstance } from 'fastify';
import type { Store } from './store.js';
import { promptWorkspace } from './prompt-workspace.js';

export type LibraryKind =
  | 'content'
  | 'prompt-preset'
  | 'prompt-combination'
  | 'connection'
  | 'model';
/** Public library access is separate from immutable version/snapshot lookup. */
export function assertLibraryVisible(store: Store, kind: string, id: string) {
  if (store.db.prepare('SELECT 1 FROM library_hidden WHERE kind=? AND id=?').get(kind, id))
    throw new HttpError(404, 'Library item not found');
}

export function libraryDeletionImpact(store: Store, kind: LibraryKind, id: string) {
  assertLibraryVisible(store, kind, id);
  const item = store.product.get<{ revision: number }>(kind, id);
  return { kind, id, revision: item.revision, canDelete: true, blockers: [] };
}

export function deleteLibraryItem(store: Store, kind: LibraryKind, id: string, value: unknown) {
  const body = record(value);
  fields(body, ['expectedRevision']);
  const expected = number(body.expectedRevision, 'revision');
  return store.transaction(() => {
    assertLibraryVisible(store, kind, id);
    const latest = store.product.get<{ revision: number }>(kind, id);
    if (latest.revision !== expected)
      throw new HttpError(409, '항목이 변경됐어요. 새로고침한 뒤 다시 삭제해 주세요.');
    if (kind === 'connection') {
      // Revoke future sends, including workers holding an earlier frozen connection.
      // Credentials and already transmitted provider work are not deleted or replayed.
      store.db
        .prepare(`UPDATE provider_settings SET revision=revision+1,
        body=json_set(body,'$.enabled',json('false'),'$.revision',revision+1)
        WHERE kind='connection' AND id=?`)
        .run(id);
      store.db
        .prepare(`INSERT OR IGNORE INTO library_hidden(kind,id)
        SELECT 'model',id FROM provider_settings WHERE kind='model' AND json_extract(body,'$.connectionId')=?`)
        .run(id);
    }
    store.db.prepare('INSERT INTO library_hidden(kind,id) VALUES(?,?)').run(kind, id);
    if (kind === 'model' || kind === 'connection') {
      const workspace = promptWorkspace(store);
      let changed = false;
      if (workspace.titleModel && store.product.isHidden('model', workspace.titleModel.id)) {
        workspace.titleModel = null;
        changed = true;
      }
      for (const role of ['main', 'translation', 'status', 'image'] as const) {
        const selected = workspace.modelRoutes[role];
        if (selected && store.product.isHidden('model', selected.id)) {
          workspace.modelRoutes[role] = null;
          changed = true;
        }
      }
      if (
        workspace.translationPolicy.refusalModel &&
        store.product.isHidden('model', workspace.translationPolicy.refusalModel.id)
      ) {
        workspace.translationPolicy.refusalModel = null;
        changed = true;
      }
      const collaboration = workspace.main.program.collaboration;
      for (const agent of collaboration?.agents ?? []) {
        if (agent.model && store.product.isHidden('model', agent.model.id)) {
          agent.model = null;
          // Deleting a selected advisor must not silently send its instructions to another model.
          collaboration!.enabled = false;
          changed = true;
        }
      }
      if (changed) {
        workspace.revision++;
        store.db
          .prepare('UPDATE prompt_workspace SET body=? WHERE id=1')
          .run(JSON.stringify(workspace));
        for (const chat of store.chats()) store.event(chat.id, 'prompt-workspace.updated', chat.id);
      }
    }
    store.libraryOrganization.remove(kind, id);
    return { deleted: true, id };
  });
}

export function libraryDeletionRoutes(app: FastifyInstance, store: Store) {
  const routes: Record<LibraryKind, string> = {
    content: 'content',
    'prompt-preset': 'prompt-presets',
    'prompt-combination': 'prompt-combinations',
    connection: 'connections',
    model: 'model-presets',
  };
  for (const [kind, path] of Object.entries(routes) as [LibraryKind, string][]) {
    app.get<{ Params: { id: string } }>(`/api/${path}/:id/deletion-impact`, async (request) =>
      libraryDeletionImpact(store, kind, request.params.id)
    );
    app.delete<{ Params: { id: string } }>(`/api/${path}/:id`, async (request) =>
      deleteLibraryItem(store, kind, request.params.id, request.body)
    );
  }
}
