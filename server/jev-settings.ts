import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_JEV_SETTINGS, type JevSettings } from '../core/jev-provider.js';

export const JEV_SETTINGS_KEY = 'jev-settings';

/** Server-wide opt-ins; existing installations retain text-only, standard-context judgments. */
export function jevSettings(db: DatabaseSync): JevSettings {
  const row = db.prepare('SELECT value FROM app_metadata WHERE key=?').get(JEV_SETTINGS_KEY);
  return row ? (JSON.parse(String(row.value)) as JevSettings) : { ...DEFAULT_JEV_SETTINGS };
}
