import type { Store } from './store.js';
import { fields, HttpError, number, record, text } from './request-validation.js';

export function sceneTitles(store: Store, chatId: string): Map<string, string> {
  return new Map(
    store.db
      .prepare(
        "SELECT s.id,m.value FROM sources s JOIN app_metadata m ON m.key='source-title:' || s.id WHERE s.chat_id=?"
      )
      .all(chatId)
      .map((row) => [String(row.id), String(row.value)])
  );
}

/** A scene can link several plans; prefer its smallest unit, then the earliest association. */
export function outlineSceneTitles(store: Store, chatId: string): Map<string, string> {
  const titles = new Map<string, string>();
  for (const row of store.db
    .prepare(`SELECT s.id,n.title FROM outline_writings w
    JOIN outline_nodes n ON n.id=w.node_id
    LEFT JOIN scene_commands c ON c.id=w.command_id
    JOIN sources s ON s.id=COALESCE(w.source_id,c.source_revision)
    WHERE s.chat_id=? AND n.chat_id=s.chat_id
    ORDER BY CASE n.level WHEN 'beat' THEN 0 WHEN 'episode' THEN 1 WHEN 'arc' THEN 2 WHEN 'mainStory' THEN 3 ELSE 4 END,
      w.created_at,w.id`)
    .all(chatId)) {
    const id = String(row.id);
    if (!titles.has(id)) titles.set(id, String(row.title));
  }
  return titles;
}

export function setSceneTitle(store: Store, sourceId: string, value: unknown) {
  const body = record(value);
  fields(body, ['title', 'expectedTitle']);
  const title = text(body.title, 'scene title', 200, true).trim();
  const expected = text(body.expectedTitle, 'expected scene title', 200, true);
  return store.transaction(() => {
    const source = store.sourceMetadata(sourceId);
    const key = `source-title:${sourceId}`;
    const current = String(
      store.db.prepare('SELECT value FROM app_metadata WHERE key=?').get(key)?.value ?? ''
    );
    if (current !== expected && current !== title)
      throw new HttpError(409, '장면 이름이 바뀌었어요. 목록을 다시 열어 확인해 주세요.');
    if (title)
      store.db
        .prepare('INSERT OR REPLACE INTO app_metadata(key,value) VALUES(?,?)')
        .run(key, title);
    else store.db.prepare('DELETE FROM app_metadata WHERE key=?').run(key);
    store.event(source.chatId, 'scene.title-changed', sourceId);
    return { chatId: source.chatId, title };
  });
}

export function restoreSceneTitles(store: Store, sourceIds: string[], value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new HttpError(400, '장면 이름 목록을 확인해 주세요.');
  for (const item of value) {
    const entry = record(item);
    const index = number(entry.atIndex, 'scene title index', 0, sourceIds.length - 1);
    const title = text(entry.title, 'scene title', 200).trim();
    store.db
      .prepare('INSERT OR REPLACE INTO app_metadata(key,value) VALUES(?,?)')
      .run(`source-title:${sourceIds[index]}`, title);
  }
}
