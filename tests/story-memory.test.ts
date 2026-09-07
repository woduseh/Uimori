import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, test } from 'vitest';
import { StoryMemory } from '../server/story-memory.js';
import type { Store } from '../server/store.js';
import { memoryHash, resolveMemoryCheckpoint, type MemoryEntry } from '../core/memory.js';

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

/** Actual isolated SQLite transactions with the Store boundary projected onto synthetic records. */
function fixture() {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE chats(id TEXT PRIMARY KEY);
    CREATE TABLE sources(id TEXT PRIMARY KEY,chat_id TEXT REFERENCES chats(id),parent_revision TEXT,text TEXT,hash TEXT);
    CREATE TABLE branches(id TEXT PRIMARY KEY,chat_id TEXT REFERENCES chats(id),head_revision TEXT);
    CREATE TABLE story_jobs(id TEXT PRIMARY KEY,chat_id TEXT REFERENCES chats(id),source_revision TEXT REFERENCES sources(id),source_hash TEXT,kind TEXT,status TEXT,snapshot TEXT NOT NULL,generation INTEGER NOT NULL DEFAULT 0,owner TEXT,error TEXT,updated_at TEXT);
    CREATE TABLE story_memories(id TEXT PRIMARY KEY,chat_id TEXT REFERENCES chats(id),job_id TEXT REFERENCES story_jobs(id),entry TEXT,retired_at TEXT,replaces_id TEXT);
    CREATE TABLE story_indexes(chat_id TEXT REFERENCES chats(id),source_revision TEXT REFERENCES sources(id),source_hash TEXT,job_id TEXT REFERENCES story_jobs(id),PRIMARY KEY(chat_id,source_revision,source_hash));
    CREATE TABLE events(chat_id TEXT,kind TEXT,entity_id TEXT);
    INSERT INTO chats VALUES('chat'),('other');`);
  const source = (id: string) => {
    const row = db
      .prepare(
        'SELECT id,chat_id AS chatId,parent_revision AS parentRevision,text,hash FROM sources WHERE id=?'
      )
      .get(id) as
      | { id: string; chatId: string; parentRevision: string | null; text: string; hash: string }
      | undefined;
    if (!row) throw new Error('Missing source');
    return row;
  };
  const store = {
    db,
    source,
    chat(id: string) {
      const row = db.prepare('SELECT * FROM chats WHERE id=?').get(id);
      if (!row) throw new Error('Missing chat');
      return row;
    },
    history(head: string | null) {
      const items: { revision: string; text: string; contentHash: string }[] = [];
      while (head) {
        const row = source(head);
        items.unshift({ revision: row.id, text: row.text, contentHash: row.hash });
        head = row.parentRevision;
      }
      return items;
    },
    product: {
      branch(chatId: string, id = `main:${chatId}`) {
        const row = db
          .prepare('SELECT id,head_revision AS headRevision FROM branches WHERE id=? AND chat_id=?')
          .get(id, chatId);
        if (!row) throw new Error('Missing branch');
        return row;
      },
    },
    transaction<T>(fn: () => T): T {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    event(chatId: string, kind: string, id: string) {
      db.prepare('INSERT INTO events VALUES(?,?,?)').run(chatId, kind, id);
    },
  } as unknown as Store;
  const memory = new StoryMemory(store);
  const add = (id: string, text: string, parent: string | null = null, chatId = 'chat') => {
    db.prepare('INSERT INTO sources VALUES(?,?,?,?,?)').run(
      id,
      chatId,
      parent,
      text,
      memoryHash(text)
    );
    return source(id);
  };
  const job = (id: string, revision: string) => {
    const src = source(revision);
    const scope = memory.scope(src.chatId, src.parentRevision);
    const snapshot = {
      chatId: src.chatId,
      parentRevision: src.parentRevision,
      history: scope.history,
      story: { canonHash: memory.canonHash(scope) },
    };
    db.prepare(
      'INSERT INTO story_jobs(id,chat_id,source_revision,source_hash,kind,status,snapshot) VALUES(?,?,?,?,?,?,?)'
    ).run(id, src.chatId, revision, src.hash, 'memory', 'running', JSON.stringify(snapshot));
  };
  const complete = (id: string, revision: string, entries: unknown[]) =>
    store.transaction(() => {
      const result = memory.completeInTransaction(
        id,
        'chat',
        source(revision),
        store.history(revision),
        entries
      );
      db.prepare("UPDATE story_jobs SET status='completed' WHERE id=?").run(id);
      return result;
    });
  const observed = (revision: string): MemoryEntry => {
    const src = source(revision);
    return {
      id: 'provider-controlled-id',
      chatId: src.chatId,
      atRevision: revision,
      atHash: src.hash,
      kind: 'observed-story',
      text: src.text,
      sources: [{ revision, hash: src.hash, start: 0, end: src.text.length, quote: src.text }],
    };
  };
  return { db, store, memory, add, job, complete, observed };
}

describe('S04 durable memory source identity and authored retcon', () => {
  test('validates the entire extraction before inserts, rejects forged/cross-chat evidence and preserves atomic rollback', () => {
    const { db, memory, store, add, job, observed } = fixture();
    const src = add('r1', 'A door opens.');
    add('private', 'Private elsewhere.', null, 'other');
    job('j1', 'r1');
    const good = observed('r1');
    const bad = {
      ...good,
      sources: [
        {
          revision: 'private',
          hash: memoryHash('Private elsewhere.'),
          start: 0,
          end: 7,
          quote: 'Private',
        },
      ],
    };
    expect(() =>
      store.transaction(() =>
        memory.completeInTransaction('j1', 'chat', src, store.history('r1'), [good, bad])
      )
    ).toThrow();
    expect(db.prepare('SELECT count(*) AS n FROM story_memories').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM story_indexes').get()).toEqual({ n: 0 });
    expect(() =>
      store.transaction(() =>
        memory.completeInTransaction('j1', 'other', src, store.history('r1'), [good])
      )
    ).toThrow('ownership');
    expect(() =>
      store.transaction(() => {
        memory.completeInTransaction('j1', 'chat', src, store.history('r1'), [good]);
        throw new Error('Crash before completion');
      })
    ).toThrow('Crash before completion');
    expect(db.prepare('SELECT count(*) AS n FROM story_memories').get()).toEqual({ n: 0 });
    expect(() => memory.scope('chat', 'private')).toThrow('outside chat');
  });
  test('extractor cannot create author canon, choose IDs or anchor at another revision', () => {
    const { memory, store, add, job, complete, observed } = fixture();
    add('r1', 'First.');
    add('r2', 'Second.', 'r1');
    job('j2', 'r2');
    const canon = {
      id: 'forged',
      chatId: 'chat',
      atRevision: 'r2',
      atHash: memoryHash('Second.'),
      text: 'Claim.',
      kind: 'author-canon',
      declaration: { author: 'user', text: 'Claim.' },
    };
    expect(() => complete('j2', 'r2', [canon])).toThrow('cannot author canon');
    expect(() => complete('j2', 'r2', [observed('r1')])).toThrow('anchor');
    const completed = complete('j2', 'r2', [observed('r2')]);
    expect(completed[0].id).not.toBe('provider-controlled-id');
    expect(memory.entries(memory.scope('chat', 'r2'))).toEqual(completed);
    expect(memory.entries(memory.scope('chat', 'r1'))).toEqual([]);
    expect(() =>
      memory.entries({ chatId: 'chat', history: [{ revision: 'r2', text: 'forged' }] })
    ).toThrow('ancestry or content changed');
    expect(store.history('r2')).toHaveLength(2);
  });
  test('shared-ancestor retcon changes only the selected descendant branch and preserves stored earlier snapshots', () => {
    const { db, memory, add } = fixture();
    add('root', 'Beginning.');
    db.prepare('INSERT INTO branches VALUES(?,?,?)').run('main:chat', 'chat', 'root');
    const original = memory.authored('chat', { text: 'Moon is blue.', author: 'user' });
    const snapshot = JSON.stringify(
      memory.plan(memory.scope('chat', 'root'), {
        enabled: true,
        model: null,
        recentCount: 2,
        maxPacketChars: 5000,
      })
    );
    const originalHash = memory.canonHash(memory.scope('chat', 'root'));
    add('left', 'Left path.', 'root');
    add('right', 'Right path.', 'root');
    db.prepare('UPDATE branches SET head_revision=? WHERE id=?').run('left', 'main:chat');
    db.prepare('INSERT INTO branches VALUES(?,?,?)').run('right-branch', 'chat', 'right');
    const replacement = memory.authored(
      'chat',
      { text: 'Moon is red.', author: 'user' },
      original.id
    );
    expect(memory.entries(memory.scope('chat', 'left'))).toEqual([replacement]);
    expect(memory.entries(memory.scope('chat', 'right'))).toEqual([original]);
    expect(memory.entries(memory.scope('chat', 'root'))).toEqual([original]);
    expect(memory.canonHash(memory.scope('chat', 'left'))).not.toBe(originalHash);
    expect(memory.canonHash(memory.scope('chat', 'right'))).toBe(originalHash);
    expect(JSON.parse(snapshot).entries).toEqual([original]);
    expect(
      db.prepare('SELECT retired_at FROM story_memories WHERE id=?').get(original.id)?.retired_at
    ).toBeTruthy();
    expect(
      db.prepare('SELECT replaces_id FROM story_memories WHERE id=?').get(replacement.id)
        ?.replaces_id
    ).toBe(original.id);
    expect(() =>
      memory.authored(
        'chat',
        { text: 'Wrong branch.', author: 'user', branchId: 'right-branch' },
        replacement.id
      )
    ).toThrow('outside current scope');
    const again = memory.authored(
      'chat',
      { text: 'Moon is gold.', author: 'user' },
      replacement.id
    );
    expect(memory.entries(memory.scope('chat', 'left'))).toEqual([again]);
    expect(memory.entries(memory.scope('chat', 'right'))).toEqual([original]);
    expect(db.prepare('SELECT count(*) AS n FROM story_memories').get()?.n).toBe(3);
    expect(
      db.prepare('SELECT count(*) AS n FROM events WHERE kind=?').get('story.memory.updated')?.n
    ).toBe(3);
  });
  test('pre-transcript authored declaration uses null anchor and GET helpers never write', () => {
    const { db, memory } = fixture();
    db.prepare('INSERT INTO branches VALUES(?,?,NULL)').run('main:chat', 'chat');
    const authored = memory.authored('chat', { text: 'A fictional sea.', author: 'user' });
    expect(authored).toMatchObject({ atRevision: null, atHash: null, kind: 'author-canon' });
    const before = db.prepare('SELECT total_changes() AS n').get()?.n;
    const scope = memory.scope('chat', null);
    memory.entries(scope);
    memory.checkpoint(scope);
    memory.canonHash(scope);
    memory.plan(scope, { enabled: true, model: null, recentCount: 2, maxPacketChars: 5000 });
    expect(db.prepare('SELECT total_changes() AS n').get()?.n).toBe(before);
  });
});

describe('S05 persisted indexing checkpoint', () => {
  test('ancestral retcon invalidates descendant extraction and receipts; rebuilding preserves old rows and stored snapshots', () => {
    const { db, memory, add, job, complete, observed } = fixture();
    add('root', 'Shared beginning.');
    add('descendant', 'Alice believes the moon is blue.', 'root');
    db.prepare('INSERT INTO branches VALUES(?,?,?)').run('main:chat', 'chat', 'root');
    const canon = memory.authored('chat', { author: 'user', text: 'The moon is blue.' });
    job('old', 'descendant');
    const old = complete('old', 'descendant', [observed('descendant')]);
    const oldSnapshot = db
      .prepare('SELECT snapshot FROM story_jobs WHERE id=?')
      .get('old')!.snapshot;
    expect(memory.checkpoint(memory.scope('chat', 'descendant')).indexed).toHaveLength(1);
    memory.authored('chat', { author: 'user', text: 'The moon is red.' }, canon.id);
    expect(
      db.prepare('SELECT status,generation FROM story_jobs WHERE id=?').get('old')
    ).toMatchObject({ status: 'stale', generation: 1 });
    const scope = memory.scope('chat', 'descendant');
    expect(memory.entries(scope).some((entry) => entry.id === old[0].id)).toBe(false);
    expect(memory.checkpoint(scope).indexed).toEqual([]);
    expect(db.prepare('SELECT snapshot FROM story_jobs WHERE id=?').get('old')!.snapshot).toBe(
      oldSnapshot
    );
    job('new', 'descendant');
    const replacement = complete('new', 'descendant', [observed('descendant')]);
    expect(memory.entries(scope).some((entry) => entry.id === replacement[0].id)).toBe(true);
    expect(memory.checkpoint(scope).indexed).toHaveLength(1);
    expect(
      db.prepare('SELECT job_id FROM story_indexes WHERE source_revision=?').get('descendant')!
        .job_id
    ).toBe('new');
    expect(
      JSON.parse(
        String(db.prepare('SELECT entry FROM story_memories WHERE id=?').get(old[0].id)!.entry)
      )
    ).toEqual(old[0]);
  });

  test('read-only freshness excludes stale semantic data even before status refresh and receipt replacement remains possible', () => {
    const { db, memory, add, job, complete, observed } = fixture();
    add('root', 'Original ancestry.');
    add('descendant', 'Unchanged descendant text.', 'root');
    job('old', 'descendant');
    complete('old', 'descendant', [observed('descendant')]);
    db.prepare('UPDATE sources SET text=?,hash=? WHERE id=?').run(
      'Edited ancestry.',
      memoryHash('Edited ancestry.'),
      'root'
    );
    const scope = memory.scope('chat', 'descendant');
    const before = db.prepare('SELECT total_changes() AS n').get()!.n;
    expect(memory.entries(scope)).toEqual([]);
    expect(memory.checkpoint(scope).indexed).toEqual([]);
    expect(db.prepare('SELECT total_changes() AS n').get()!.n).toBe(before);
    expect(db.prepare('SELECT status FROM story_jobs WHERE id=?').get('old')!.status).toBe(
      'completed'
    );
    job('new', 'descendant');
    const next = complete('new', 'descendant', [observed('descendant')]);
    expect(memory.entries(scope)).toEqual(next);
    expect(db.prepare('SELECT count(*) AS n FROM story_memories').get()!.n).toBe(2);
  });

  test('re-extraction replaces a stale receipt while retaining previous artifacts outside current visibility', () => {
    const { db, memory, add, job, complete, observed } = fixture();
    add('r1', 'One.');
    job('old', 'r1');
    const old = complete('old', 'r1', [observed('r1')]);
    job('replacement', 'r1');
    expect(() => complete('replacement', 'r1', [observed('r1')])).toThrow('already indexed');
    db.prepare("UPDATE story_jobs SET status='stale' WHERE id='old'").run();
    const scope = memory.scope('chat', 'r1');
    expect(memory.entries(scope)).toEqual([]);
    expect(memory.checkpoint(scope).indexed).toEqual([]);
    const updated = complete('replacement', 'r1', [observed('r1')]);
    expect(updated[0].id).not.toBe(old[0].id);
    expect(memory.entries(scope)).toEqual(updated);
    expect(memory.checkpoint(scope).indexed).toHaveLength(1);
    expect(db.prepare('SELECT job_id FROM story_indexes').get()?.job_id).toBe('replacement');
    expect(db.prepare('SELECT count(*) AS n FROM story_memories').get()?.n).toBe(2);
    expect(
      JSON.parse(
        String(db.prepare('SELECT entry FROM story_memories WHERE id=?').get(old[0].id)?.entry)
      )
    ).toEqual(old[0]);
  });

  test('completed no-facts receipt advances progress but pending work cannot skip a hole', () => {
    const { memory, add, job, complete } = fixture();
    add('r1', 'One.');
    add('r2', 'Two.', 'r1');
    job('j1', 'r1');
    job('j2', 'r2');
    complete('j2', 'r2', []);
    const scope = memory.scope('chat', 'r2');
    expect(resolveMemoryCheckpoint(scope, memory.checkpoint(scope)).watermark).toBeNull();
    complete('j1', 'r1', []);
    expect(resolveMemoryCheckpoint(scope, memory.checkpoint(scope))).toMatchObject({
      watermark: 'r2',
      indexedCount: 2,
    });
    expect(memory.entries(scope)).toEqual([]);
  });
  test('source hash changes rewind progress and a completed receipt never leaks into sibling scope', () => {
    const { db, memory, add, job, complete } = fixture();
    add('r1', 'One.');
    add('left', 'Left.', 'r1');
    add('right', 'Right.', 'r1');
    job('j1', 'r1');
    job('jleft', 'left');
    complete('j1', 'r1', []);
    complete('jleft', 'left', []);
    const right = memory.scope('chat', 'right');
    expect(memory.checkpoint(right).indexed.map((item) => item.revision)).toEqual(['r1']);
    db.prepare('UPDATE sources SET text=?,hash=? WHERE id=?').run(
      'Retconned.',
      memoryHash('Retconned.'),
      'r1'
    );
    const edited = memory.scope('chat', 'left');
    expect(resolveMemoryCheckpoint(edited, memory.checkpoint(edited)).watermark).toBeNull();
    expect(
      memory.plan(edited, { enabled: true, model: null, recentCount: 1, maxPacketChars: 5000 }).plan
        .recentHistory
    ).toHaveLength(2);
  });
});
