import type { DatabaseSync } from 'node:sqlite';
import { UI_LOCALES } from '../core/ui-locale.js';

export function upgradeChatTitleStoredShapes(db: DatabaseSync): void {
  db.prepare(
    `UPDATE events SET entity_id='ko' WHERE kind='chat.title.eligible' AND entity_id NOT IN (${UI_LOCALES.map(() => '?').join(',')})`
  ).run(...UI_LOCALES);
}
