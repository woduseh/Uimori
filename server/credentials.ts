import type { DatabaseSync } from 'node:sqlite';
import { AppError } from './app-errors.js';

export class CredentialStore {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  status(id: string): { revision: number; configured: boolean } {
    const row = this.db
      .prepare('SELECT revision,value IS NOT NULL AS configured FROM credentials WHERE id=?')
      .get(id);
    return { revision: Number(row?.revision ?? 0), configured: row?.configured === 1 };
  }

  get(id: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM credentials WHERE id=?').get(id);
    return typeof row?.value === 'string' ? row.value : undefined;
  }

  set(id: string, value: string | null, expectedRevision?: number): void {
    const current = this.status(id);
    if (expectedRevision !== undefined && current.revision !== expectedRevision)
      throw new AppError(409, 'REVISION_CONFLICT');
    this.db
      .prepare(`INSERT INTO credentials(id,revision,value) VALUES(?,?,?)
      ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,value=excluded.value`)
      .run(id, current.revision + 1, value);
  }
}

export function apiKey(value: unknown): string | null {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 4096 || !/^[\x21-\x7e]+$/u.test(value.trim()))
    throw new AppError(400, 'API_KEY_INVALID');
  return value.trim();
}

export function initCredentials(db: DatabaseSync): void {
  db.exec('CREATE TABLE credentials(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,value TEXT)');
  db.exec('CREATE TABLE access_sessions(token_hash TEXT PRIMARY KEY,authority_hash TEXT NOT NULL)');
}
