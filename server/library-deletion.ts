import { removeIllustrationPresetScope } from './illustration-presets.js';
import { pruneUnusedData } from './unused-data.js';
import { HttpError, fields, number, record } from './request-validation.js';
import type { FastifyInstance } from 'fastify';
import type { Store } from './store.js';
import { promptWorkspace, savePromptWorkspace } from './prompt-workspace.js';
import { forgetHelperResourceChanges } from './helper-changes.js';
import { forgetHelperConfirmationTargets } from './helper-argument-retention.js';
import { recordPromptWorkspaceUpdate } from './prompt-workspace-events.js';

export type LibraryKind =
  | 'content'
  | 'prompt-preset'
  | 'prompt-combination'
  | 'connection'
  | 'model';
export function assertLibraryVisible(store: Store, kind: string, id: string) {
  if (store.db.prepare('SELECT 1 FROM library_hidden WHERE kind=? AND id=?').get(kind, id))
    throw new HttpError(404, 'Library item not found');
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
    if (kind === 'prompt-preset') {
      const workspace = promptWorkspace(store);
      if (workspace.main.presetId === id || workspace.translation.presetId === id)
        throw new HttpError(
          409,
          '기본 프롬프트로 사용 중이에요. 다른 프롬프트를 선택한 뒤 삭제해 주세요.'
        );
    }
    if (kind === 'connection') {
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
      for (const role of ['main', 'translation'] as const) {
        const selected = workspace.modelRoutes[role];
        if (selected && store.product.isHidden('model', selected.id)) {
          workspace.modelRoutes[role] = null;
          changed = true;
        }
      }
      const collaboration = workspace.main.program.collaboration;
      let collaborationChanged = false;
      for (const agent of collaboration?.agents ?? []) {
        if (agent.model && store.product.isHidden('model', agent.model.id)) {
          agent.model = null;
          collaboration!.enabled = false;
          changed = true;
          collaborationChanged = true;
        }
      }
      if (changed) {
        if (collaborationChanged) {
          const current = workspace.main;
          const preset = store.product.promptPreset(
            {
              title: current.title,
              role: 'main',
              program: current.program,
              values: current.defaultValues,
              expectedRevision: current.presetRevision,
            },
            current.presetId,
            true
          );
          current.presetRevision = preset.revision;
        }
        workspace.revision++;
        savePromptWorkspace(store, workspace);
        recordPromptWorkspaceUpdate(store.db);
      }
    }
    if (kind === 'content') {
      removeIllustrationPresetScope(store, 'bot', id);
      store.db.prepare('DELETE FROM app_metadata WHERE key=?').run(`bot-defaults:${id}`);
    }
    if (kind === 'content' || kind === 'prompt-preset')
      forgetHelperResourceChanges(store.db, kind, id);
    forgetHelperConfirmationTargets(store.db, [{ kind, id }]);
    store.libraryOrganization.remove(kind, id);
    pruneUnusedData(store.db);
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
    app.delete<{ Params: { id: string } }>(`/api/${path}/:id`, async (request) =>
      deleteLibraryItem(store, kind, request.params.id, request.body)
    );
  }
}
