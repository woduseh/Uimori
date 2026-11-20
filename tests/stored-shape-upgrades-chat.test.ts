import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { Store } from '../server/store.js';
import { createFixtureChat } from './fixtures/chat.js';

const owned: { store?: Store; path: string }[] = [];
afterEach(() => {
  for (const item of owned.splice(0)) {
    item.store?.close();
    const within = relative(tmpdir(), item.path);
    if (isAbsolute(within) || within.startsWith('..') || !within.startsWith('uimori-upgrade-'))
      throw new Error('Unsafe cleanup');
    rmSync(item.path, { recursive: true, force: true });
  }
});

test('title enrollments holding a chat ID are rewritten to the Korean locale once', () => {
  const path = mkdtempSync(join(tmpdir(), 'uimori-upgrade-'));
  const file = join(path, 'story.sqlite');
  const item: { store?: Store; path: string } = { store: new Store(file), path };
  owned.push(item);
  const legacy = createFixtureChat(item.store!, 'Legacy enrollment');
  const current = createFixtureChat(item.store!, 'Current enrollment');
  const insert = item.store!.db.prepare(
    "INSERT INTO events(chat_id,kind,entity_id,at) VALUES (?,'chat.title.eligible',?,'2026-01-01T00:00:00.000Z')"
  );
  insert.run(legacy.id, legacy.id);
  insert.run(current.id, 'ja');
  const enrollments = () =>
    item
      .store!.db.prepare(
        "SELECT seq,chat_id,entity_id,at FROM events WHERE kind='chat.title.eligible' ORDER BY seq"
      )
      .all();
  const before = enrollments();
  const reopen = () => {
    item.store!.close();
    item.store = undefined;
    item.store = new Store(file);
  };

  reopen();
  const upgraded = enrollments();
  expect(upgraded).toEqual([
    { ...before[0], entity_id: 'ko' },
    { ...before[1], entity_id: 'ja' },
  ]);
  reopen();
  expect(enrollments()).toEqual(upgraded);
});
