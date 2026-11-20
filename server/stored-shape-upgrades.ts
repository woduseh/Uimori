import type { DatabaseSync } from 'node:sqlite';
import { upgradeChatTitleStoredShapes } from './stored-shape-upgrades-chat.js';
import { upgradeHelperStoredShapes } from './stored-shape-upgrades-helper.js';
import { upgradeIllustrationStoredShapes } from './stored-shape-upgrades-illustrations.js';
import { upgradeProviderStoredShapes } from './stored-shape-upgrades-provider.js';

const upgrades: ((db: DatabaseSync) => void)[] = [
  upgradeChatTitleStoredShapes,
  upgradeHelperStoredShapes,
  upgradeIllustrationStoredShapes,
  upgradeProviderStoredShapes,
];

export function upgradeStoredShapes(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const upgrade of upgrades) upgrade(db);
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
