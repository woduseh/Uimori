import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { snapshotStorageTriggers } from './snapshot-storage-schema.js';

const refsKey = '__snapshot_texts_v1';
const digest = (body: string) => createHash('sha256').update(body).digest('hex');

/** Disk representation is confined to this boundary. Domain/portable archive rows stay expanded. */
export class SnapshotDatabase extends DatabaseSync {
  constructor(path: string) {
    super(path);
    this.function('snapshot_pack', (value) => this.pack(String(value)));
    this.function('snapshot_text', (value, path) => {
      const snapshot = JSON.parse(String(value));
      const hash = snapshot[refsKey]?.[String(path)];
      if (hash) return this.readText(hash);
      return (
        JSON.parse(String(path)).reduce((node: any, key: string) => node?.[key], snapshot) ?? null
      );
    });
  }
  private readText(hash: string): string {
    const row = super.prepare('SELECT body FROM snapshot_texts WHERE hash=?').get(hash);
    if (!row || typeof row.body !== 'string' || digest(row.body) !== hash)
      throw new Error('SNAPSHOT_TEXT_INTEGRITY');
    const value: unknown = JSON.parse(row.body);
    if (typeof value !== 'string') throw new Error('SNAPSHOT_TEXT_INVALID');
    return value;
  }
  private expand(value: string): string {
    if (!value.includes(`"${refsKey}"`)) return value;
    const snapshot = JSON.parse(value);
    if (!Object.hasOwn(snapshot, refsKey)) return value;
    const refs = snapshot[refsKey];
    if (!refs || typeof refs !== 'object' || Array.isArray(refs))
      throw new Error('SNAPSHOT_REFS_INVALID');
    const cache = new Map<string, string>();
    for (const [path, hash] of Object.entries(refs)) {
      if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))
        throw new Error('SNAPSHOT_REFS_INVALID');
      const keys: unknown = JSON.parse(path);
      if (!Array.isArray(keys) || !keys.length || keys.some((key) => typeof key !== 'string'))
        throw new Error('SNAPSHOT_REFS_INVALID');
      let node = snapshot;
      for (const key of keys.slice(0, -1)) {
        if (!node || typeof node !== 'object' || !Object.hasOwn(node, key))
          throw new Error('SNAPSHOT_REFS_INVALID');
        node = node[key];
      }
      const key = keys.at(-1)!;
      if (!node || typeof node !== 'object' || !Object.hasOwn(node, key) || node[key] !== '')
        throw new Error('SNAPSHOT_REFS_INVALID');
      if (!cache.has(hash)) cache.set(hash, this.readText(hash));
      Object.defineProperty(node, key, {
        value: cache.get(hash),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    delete snapshot[refsKey];
    return JSON.stringify(snapshot);
  }
  private pack(value: string): string {
    const snapshot = JSON.parse(this.expand(value));
    const refs: Record<string, string> = {};
    const insert = super.prepare('INSERT OR IGNORE INTO snapshot_texts(hash,body) VALUES(?,?)');
    const seen = new Map<string, string>();
    const visit = (node: any, path: string[]) => {
      if (!node || typeof node !== 'object') return;
      for (const [key, child] of Object.entries(node)) {
        if (typeof child === 'string' && child.length >= 256) {
          let hash = seen.get(child);
          if (!hash) {
            const body = JSON.stringify(child);
            hash = digest(body);
            insert.run(hash, body);
            seen.set(child, hash);
          }
          refs[JSON.stringify([...path, key])] = hash;
          node[key] = '';
        } else if (typeof child === 'object') visit(child, [...path, key]);
      }
    };
    visit(snapshot, []);
    snapshot[refsKey] = refs;
    return JSON.stringify(snapshot);
  }
  override prepare(sql: string): StatementSync {
    const statement = super.prepare(sql);
    const expandRow = (row: any) => {
      if (row && typeof row.snapshot === 'string') row.snapshot = this.expand(row.snapshot);
      return row;
    };
    const get = statement.get.bind(statement),
      all = statement.all.bind(statement),
      iterate = statement.iterate.bind(statement);
    statement.get = (...args) => expandRow(Reflect.apply(get, statement, args));
    statement.all = (...args) => Reflect.apply(all, statement, args).map(expandRow);
    statement.iterate = function* (...args) {
      for (const row of Reflect.apply(iterate, statement, args)) yield expandRow(row);
      return undefined;
    };
    return statement;
  }
}

export function initSnapshotStorage(db: DatabaseSync): void {
  db.exec(`CREATE TABLE snapshot_texts(hash TEXT PRIMARY KEY,body TEXT NOT NULL);
    CREATE TABLE snapshot_text_refs(owner_table TEXT NOT NULL,owner_id TEXT NOT NULL,hash TEXT NOT NULL REFERENCES snapshot_texts(hash),PRIMARY KEY(owner_table,owner_id,hash));
    CREATE INDEX snapshot_text_refs_hash ON snapshot_text_refs(hash);
    CREATE TRIGGER snapshot_text_immutable BEFORE UPDATE ON snapshot_texts BEGIN SELECT RAISE(ABORT,'Immutable snapshot text'); END;`);
  for (const trigger of snapshotStorageTriggers()) db.exec(trigger.sql);
}
