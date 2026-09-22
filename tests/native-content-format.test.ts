import { expect, test } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertRisuContent, validateRisuContent } from '../core/risu-content.js';
import { compileContentAttachment } from '../core/package-runtime.js';
import { databaseSchemaVersion, DATABASE_SCHEMA_VERSION } from '../server/database-schema.js';
import { nativeContent } from './fixtures/native-content.js';

const current = () =>
  nativeContent({
    name: 'Current native card',
    description: 'Body {{char}}',
    post_history_instructions: 'Active global note {{user}}',
    character_book: {
      entries: [
        { keys: [], comment: 'World', content: 'Pinned world', constant: true, enabled: true },
      ],
    },
  });

test('current content has one native instruction owner and no legacy projection field', () => {
  const pkg = current();
  expect(pkg.version).toBe(2);
  expect(pkg.nativeRisu.version).toBe(1);
  expect(pkg.nativeRisu.card.post_history_instructions).toBe('Active global note {{user}}');
  expect(pkg).not.toHaveProperty('instructions');
  const before = structuredClone(pkg);
  expect(validateRisuContent(pkg)).toEqual(pkg);
  const compiled = compileContentAttachment(
    pkg,
    { id: pkg.id, revision: pkg.revision, role: 'bot' },
    { chatId: 'test' }
  );
  expect(Object.keys(compiled).sort()).toEqual(['pinned', 'resources']);
  expect(compiled.pinned.map((item) => item.text)).toEqual(
    expect.arrayContaining(['Body {{char}}', 'Pinned world'])
  );
  expect(JSON.stringify(compiled)).not.toContain('Active global note');
  expect(pkg).toEqual(before);
});

test('old content versions and even empty retired instruction arrays are rejected, not upgraded', () => {
  const old = { ...current(), version: 1 };
  const before = structuredClone(old);
  expect(() => assertRisuContent(old)).toThrow('PACKAGE_VERSION_UNSUPPORTED');
  expect(() => validateRisuContent(old)).toThrow('PACKAGE_VERSION_UNSUPPORTED');
  expect(old).toEqual(before);
  for (const instructions of [[], [{ id: 'old', target: 'main', text: 'Do not restore me' }]]) {
    const retired = { ...current(), instructions };
    expect(() => assertRisuContent(retired)).toThrow('PACKAGE_INVALID_FIELDS');
    expect(() => validateRisuContent(retired)).toThrow('PACKAGE_INVALID_FIELDS');
  }
});

test('schema-23 admission refuses before rewriting the database or supplying a migration', () => {
  expect(DATABASE_SCHEMA_VERSION).toBe(4);
  const directory = mkdtempSync(join(tmpdir(), 'uimori-format-boundary-'));
  const file = join(directory, 'old.sqlite');
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file);
    db.exec(
      "CREATE TABLE saved_text(body TEXT); INSERT INTO saved_text VALUES('preserve'); PRAGMA user_version=23;"
    );
    db.close();
    db = undefined;
    const before = readFileSync(file);
    db = new DatabaseSync(file);
    expect(() => databaseSchemaVersion(db!)).toThrow(
      'Database version 23 is not the personal-v1 format'
    );
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(23);
    expect(db.prepare('SELECT body FROM saved_text').get()?.body).toBe('preserve');
    db.close();
    db = undefined;
    expect(readFileSync(file)).toEqual(before);
  } finally {
    db?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
