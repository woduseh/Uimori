import { afterEach, expect, test } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { DATABASE_SCHEMA_VERSION } from '../server/database-schema.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-scope-migration-'));
  directories.push(directory);
  const path = join(directory, 'synthetic.sqlite');
  const seed = new DatabaseSync(path);
  try {
    seed.exec('PRAGMA foreign_keys=OFF');
    seed.exec(readFileSync(new URL('./fixtures/personal-schema-13.sql', import.meta.url), 'utf8'));
  } finally {
    seed.close();
  }
  return path;
}

function retained(db: DatabaseSync) {
  return Object.fromEntries(
    [
      'chats',
      'runs',
      'sources',
      'bookmarks',
      'reading_positions',
      'chat_variable_states',
      'app_metadata',
    ].map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()])
  );
}

test('real schema13 migration keeps stable scope IDs, pending command bytes and current user data through restart', () => {
  const path = fixture();
  const old = new DatabaseSync(path);
  const before = retained(old);
  old.close();
  let store = new Store(path);
  try {
    expect(retained(store.db)).toEqual(before);
    const chatId = String(before.chats[0].id);
    expect(store.product.branch(chatId)).toEqual({
      id: 'retained-singleton-scope',
      chatId,
      headRevision: before.chats[0].head_revision,
    });
    expect(
      store.db
        .prepare('PRAGMA table_info(branches)')
        .all()
        .map((column) => column.name)
    ).toEqual(['id', 'chat_id']);
    expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(store.db.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
    expect(() =>
      store.db.prepare('INSERT INTO branches VALUES(?,?)').run('duplicate', chatId)
    ).toThrow();
    const command = JSON.parse(
      String(
        store.db
          .prepare("SELECT value FROM app_metadata WHERE key='schema13-pending-command'")
          .get()!.value
      )
    );
    const replay = store.createRun(chatId, command, () => {
      throw new Error('Must reuse admission');
    });
    expect(replay.created).toBe(false);
    expect(replay.run.request).toBe(command.request);
    expect(replay.run.snapshot.branchId).toBe(command.branchId);
    expect(retained(store.db)).toEqual(before);
    store.close();
    store = new Store(path);
    expect(retained(store.db)).toEqual(before);
    expect(store.db.prepare('PRAGMA user_version').get()?.user_version).toBe(
      DATABASE_SCHEMA_VERSION
    );
  } finally {
    store.close();
  }
});

test('schema13 head disagreement rolls back without changing old scope columns or pending work', () => {
  const path = fixture();
  const old = new DatabaseSync(path);
  old.prepare('UPDATE branches SET head_revision=NULL').run();
  const rows = old.prepare('SELECT * FROM branches').all();
  const before = retained(old);
  old.close();
  expect(() => new Store(path)).toThrow('DATABASE_CHAT_HEAD_MISMATCH');
  const preserved = new DatabaseSync(path);
  try {
    expect(preserved.prepare('SELECT * FROM branches').all()).toEqual(rows);
    expect(retained(preserved)).toEqual(before);
    expect(preserved.prepare('PRAGMA user_version').get()?.user_version).toBe(13);
  } finally {
    preserved.close();
  }
});
