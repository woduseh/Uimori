import type { DatabaseSync } from 'node:sqlite';
import { upgradeChatTitleStoredShapes } from './stored-shape-upgrades-chat.js';

const upgrades: ((db: DatabaseSync) => void)[] = [
  upgradeChatTitleStoredShapes,
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
