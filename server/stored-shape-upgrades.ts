import type { DatabaseSync } from 'node:sqlite';
import { upgradeChatTitleStoredShapes } from './stored-shape-upgrades-chat.js';
import { upgradeHelperStoredShapes } from './stored-shape-upgrades-helper.js';
import { upgradeIllustrationStoredShapes } from './stored-shape-upgrades-illustrations.js';

const upgrades: ((db: DatabaseSync) => void)[] = [
  upgradeChatTitleStoredShapes,
  upgradeHelperStoredShapes,
  upgradeIllustrationStoredShapes,
];

export function upgradeStoredShapes(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const upgrade of upgrades) upgrade(db);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
