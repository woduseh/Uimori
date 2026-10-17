import type { DatabaseSync } from 'node:sqlite';
import type { Store } from './store.js';
import { HttpError, fields, number, record, text } from './request-validation.js';
import { REQUEST_TEXT_MAX_CHARS } from '../core/content-limits.js';

import type { SceneContext } from '../core/scene-context.js';
export type { SceneContext } from '../core/scene-context.js';

export const DEFAULT_SCENE_CONTEXT: SceneContext = {
  revision: 0,
  requestText: null,
  requestEnabled: true,
  sceneEnabled: true,
};

export function initSceneContext(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS scene_context (
    source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    request_text TEXT,
    request_enabled INTEGER NOT NULL DEFAULT 1 CHECK(request_enabled IN (0,1)),
    scene_enabled INTEGER NOT NULL DEFAULT 1 CHECK(scene_enabled IN (0,1))
  );`);
}

export function readSceneContext(db: DatabaseSync, sourceId: string): SceneContext {
  const row = db
    .prepare(
      'SELECT revision,request_text,request_enabled,scene_enabled FROM scene_context WHERE source_id=?'
    )
    .get(sourceId) as
    | {
        revision: number;
        request_text: string | null;
        request_enabled: number;
        scene_enabled: number;
      }
    | undefined;
  return row
    ? {
        revision: row.revision,
        requestText: row.request_text,
        requestEnabled: row.request_enabled === 1,
        sceneEnabled: row.scene_enabled === 1,
      }
    : { ...DEFAULT_SCENE_CONTEXT };
}

export function updateSceneContext(store: Store, sourceId: string, value: unknown): SceneContext {
  const body = record(value);
  fields(body, ['expectedRevision', 'requestText', 'requestEnabled', 'sceneEnabled']);
  const expected = number(body.expectedRevision, 'scene context revision', 0);
  const requestText =
    body.requestText === undefined
      ? undefined
      : body.requestText === null
        ? null
        : text(body.requestText, 'request text', REQUEST_TEXT_MAX_CHARS, true);
  const requestEnabled = body.requestEnabled;
  const sceneEnabled = body.sceneEnabled;
  if (requestEnabled !== undefined && typeof requestEnabled !== 'boolean')
    throw new HttpError(400, 'Invalid requestEnabled');
  if (sceneEnabled !== undefined && typeof sceneEnabled !== 'boolean')
    throw new HttpError(400, 'Invalid sceneEnabled');
  if (requestText === undefined && requestEnabled === undefined && sceneEnabled === undefined)
    throw new HttpError(400, 'Nothing to change');
  return store.transaction(() => {
    const source = store.sourceMetadata(sourceId);
    const active = store.db
      .prepare("SELECT 1 FROM runs WHERE chat_id=? AND status IN ('queued','running') LIMIT 1")
      .get(source.chatId);
    if (active) throw new HttpError(409, '장면 생성 중에는 이전 기록을 변경할 수 없어요.');
    const current = readSceneContext(store.db, sourceId);
    if (current.revision !== expected) throw new HttpError(409, 'Scene context revision conflict');
    const next: SceneContext = {
      revision: expected + 1,
      requestText: requestText === undefined ? current.requestText : requestText,
      requestEnabled: requestEnabled === undefined ? current.requestEnabled : requestEnabled,
      sceneEnabled: sceneEnabled === undefined ? current.sceneEnabled : sceneEnabled,
    };
    if (
      next.requestText === current.requestText &&
      next.requestEnabled === current.requestEnabled &&
      next.sceneEnabled === current.sceneEnabled
    )
      return current;
    store.db
      .prepare(`INSERT INTO scene_context(source_id,revision,request_text,request_enabled,scene_enabled)
      VALUES(?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET revision=excluded.revision,
      request_text=excluded.request_text,request_enabled=excluded.request_enabled,scene_enabled=excluded.scene_enabled`)
      .run(
        sourceId,
        next.revision,
        next.requestText,
        Number(next.requestEnabled),
        Number(next.sceneEnabled)
      );
    store.event(source.chatId, 'source.context', sourceId);
    return next;
  });
}
