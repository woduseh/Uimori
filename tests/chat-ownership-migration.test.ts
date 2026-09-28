import { afterEach, expect, test } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { migrateChatOwnership } from '../server/migrate-chat-ownership.js';

const directories: string[] = [];
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) if (db.isOpen) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});
const json = JSON.stringify;
function fixture(version: 13 | 14) {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-chat-owner-'));
  directories.push(directory);
  const path = join(directory, 'synthetic.sqlite');
  const db = new DatabaseSync(path);
  databases.push(db);
  db.exec('PRAGMA foreign_keys=OFF');
  db.exec(
    readFileSync(new URL(`./fixtures/personal-schema-${version}.sql`, import.meta.url), 'utf8')
  );
  const chat = db.prepare('SELECT * FROM chats').get()!;
  const branch = db.prepare('SELECT id FROM branches').get()!;
  const source = db.prepare('SELECT * FROM sources').get()!;
  const run = db.prepare("SELECT * FROM runs WHERE status='queued'").get()!;
  const scopeKey = `chat:${chat.id}:${branch.id}`;
  const plan = {
    version: 1,
    status: 'ready',
    budget: { inputTokenLimit: 10000, estimator: 'o200k_base-v1' },
    dependencyKey: 'kept',
    compacted: [],
    summary: 'Preserved summary',
    recentSourceRevisions: [source.id],
    estimatedInputTokens: 100,
    summaryCalls: 1,
    usage: { modelCalls: 1 },
    error: null,
  };
  const hash = createHash('sha256')
    .update(
      json([
        scopeKey,
        3,
        { dependencyKey: plan.dependencyKey, compacted: [], summary: plan.summary },
      ])
    )
    .digest('hex');
  const ref = { id: 'kept-checkpoint', revision: 3, hash };
  const snapshot = JSON.parse(String(run.snapshot));
  snapshot.contextBase = { scopeKey, activeRevision: 3, notesRevision: 0, checkpoint: ref };
  snapshot.contextPlan = { ...plan, checkpoint: ref };
  // Authored properties with the same name must never be erased by recursive conversion.
  snapshot.profile = {
    ...snapshot.profile,
    variableState: { revision: 1, values: { branchId: 'authored value' } },
  };
  db.prepare('UPDATE runs SET snapshot=? WHERE id=?').run(json(snapshot), run.id);
  db.prepare('INSERT INTO context_checkpoints VALUES(?,?,?,?,?,?,?,?,?)').run(
    ref.id,
    scopeKey,
    chat.id,
    3,
    hash,
    'edit',
    json(plan),
    '2026-09-28',
    1
  );
  db.prepare('INSERT INTO context_heads VALUES(?,?,?,?)').run(scopeKey, chat.id, 3, ref.id);
  db.prepare('INSERT INTO context_commands VALUES(?,?,?,?,?)').run(
    scopeKey,
    chat.id,
    'old-edit',
    'old-hash-only',
    3
  );
  db.prepare(
    'INSERT INTO context_jobs(id,chat_id,branch_id,request_key,command,status,snapshot,checkpoint,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)'
  ).run(
    'kept-context-job',
    chat.id,
    branch.id,
    'context-key',
    json({
      branchId: branch.id,
      expectedRevision: 3,
      expectedHeadRevision: source.id,
      idempotencyKey: 'context-key',
    }),
    'failed',
    json(snapshot),
    json(ref),
    '2026-09-28',
    '2026-09-28'
  );
  const helperScope = { kind: 'chat', chatId: chat.id, branchId: branch.id };
  db.prepare(
    'INSERT INTO helper_conversations(id,scope_key,creation_key,creation_hash,chat_id,branch_id,scope,title,auto_title,revision,persona,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(
    'kept-helper',
    json(helperScope),
    'creation-key',
    'title-hash',
    chat.id,
    branch.id,
    json(helperScope),
    'Helper title',
    0,
    2,
    'Persona',
    '2026-09-28',
    '2026-09-28'
  );
  db.prepare(
    'INSERT INTO helper_tasks(id,conversation_id,request_key,request,status,generation,owner,snapshot,usage,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)'
  ).run(
    'kept-task',
    'kept-helper',
    'task-key',
    'Uncertain helper request',
    'running',
    7,
    'worker-owner',
    json({ scope: helperScope, writing: snapshot, context: { checkpoint: ref } }),
    '{}',
    '2026-09-28',
    '2026-09-28'
  );
  db.prepare('INSERT INTO chat_option_pending VALUES(?,?,?,?)').run(
    'kept-option',
    chat.id,
    branch.id,
    json({ id: 'kept-option', chatId: chat.id, branchId: branch.id, values: { tone: 'quiet' } })
  );
  db.prepare('INSERT INTO chat_option_operations VALUES(?,?,?,?,?,?)').run(
    'kept-operation',
    chat.id,
    'request',
    'kept-hash-only',
    2,
    '2026-09-28'
  );
  db.prepare('INSERT INTO chat_override_operations VALUES(?,?,?,?,?,?)').run(
    'kept-override',
    chat.id,
    'request',
    'kept-hash-only',
    '{}',
    '2026-09-28'
  );
  db.prepare('INSERT INTO author_note_commands VALUES(?,?,?,?)').run(
    chat.id,
    'note-key',
    json({ branchId: branch.id, text: 'Author note', idempotencyKey: 'note-key' }),
    '{}'
  );
  db.prepare(
    'INSERT INTO outline_nodes(id,chat_id,branch_id,level,position,title,intent,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)'
  ).run(
    'kept-outline',
    chat.id,
    branch.id,
    'scene',
    0,
    'Outline title',
    'Keep intent',
    2,
    '2026-09-28',
    '2026-09-28'
  );
  db.prepare('INSERT INTO outline_batches VALUES(?,?,?,?,?,?,?)').run(
    chat.id,
    branch.id,
    'outline-key',
    'user',
    '[{"op":"create","title":"Outline title"}]',
    '[{"id":"kept-outline"}]',
    '2026-09-28'
  );
  db.prepare(
    'INSERT INTO jobs(id,chat_id,source_revision,source_hash,kind,status,generation,owner,input,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)'
  ).run(
    'kept-job',
    chat.id,
    source.id,
    source.hash,
    'translation',
    'running',
    9,
    'job-owner',
    json({ snapshot, translationLayout: { paragraphs: ['layout must stay'] } }),
    '2026-09-28',
    '2026-09-28'
  );
  db.prepare('INSERT INTO job_results VALUES(?,?,?,?)').run(
    'kept-job',
    9,
    json({ text: 'Translation', translationLayout: { paragraphs: ['layout must stay'] } }),
    '2026-09-28'
  );
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  return { db, path, chatId: String(chat.id), runId: String(run.id), ref };
}
function migrate(db: DatabaseSync, version: number) {
  db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
  try {
    migrateChatOwnership(db, version);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    db.exec('PRAGMA user_version=15; COMMIT; PRAGMA foreign_keys=ON');
  } catch (error) {
    db.exec('ROLLBACK; PRAGMA foreign_keys=ON');
    throw error;
  }
}
function stable(db: DatabaseSync) {
  return Object.fromEntries(
    [
      'chats',
      'sources',
      'job_results',
      'chat_variable_outputs',
      'chat_option_operations',
      'chat_override_operations',
      'attempts',
    ].map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()])
  );
}

test.each([13, 14] as const)(
  'Store opens real schema%s through its atomic initializer',
  (version) => {
    const { db, path, runId } = fixture(version);
    const before = stable(db);
    db.close();
    const store = new Store(path);
    try {
      expect(stable(store.db)).toEqual(before);
      expect(store.db.prepare('PRAGMA user_version').get()!.user_version).toBe(15);
      expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(store.db.prepare('PRAGMA foreign_keys').get()!.foreign_keys).toBe(1);
      expect(store.run(runId).status).toBe('queued');
    } finally {
      store.close();
    }
  }
);

test.each([13, 14] as const)(
  'real schema%s keeps current data, queued admission, worker identity and checkpoint references',
  (version) => {
    const { db, path, chatId, runId, ref } = fixture(version);
    const before = stable(db);
    const reading = db.prepare('SELECT target FROM reading_positions').get()!;
    const expectedTarget = JSON.parse(String(reading.target));
    delete expectedTarget.branchId;
    migrate(db, version);
    expect(stable(db)).toEqual(before);
    expect(
      db.prepare("SELECT name FROM sqlite_schema WHERE name='branches'").get()
    ).toBeUndefined();
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE sql LIKE '%branch_id%'").all()).toEqual(
      []
    );
    expect(
      JSON.parse(String(db.prepare('SELECT target FROM reading_positions').get()!.target))
    ).toEqual(expectedTarget);
    expect(db.prepare('SELECT generation,owner,status FROM helper_tasks').get()).toEqual({
      generation: 7,
      owner: 'worker-owner',
      status: 'running',
    });
    expect(db.prepare('SELECT generation,owner,status FROM jobs').get()).toEqual({
      generation: 9,
      owner: 'job-owner',
      status: 'running',
    });
    expect(
      JSON.parse(String(db.prepare('SELECT snapshot FROM runs WHERE id=?').get(runId)!.snapshot))
        .profile.variableState.values
    ).toEqual({ branchId: 'authored value' });
    expect(db.prepare('SELECT command_hash FROM context_commands').get()!.command_hash).toBe(
      'old-hash-only'
    );
    expect(
      JSON.parse(String(db.prepare('SELECT scope FROM helper_conversations').get()!.scope))
    ).toEqual({ kind: 'chat', chatId });
    expect(db.prepare('SELECT title,intent,revision FROM outline_nodes').get()).toEqual({
      title: 'Outline title',
      intent: 'Keep intent',
      revision: 2,
    });
    expect(db.prepare('PRAGMA integrity_check').get()!.integrity_check).toBe('ok');
    const command = JSON.parse(
      String(db.prepare('SELECT command FROM runs WHERE id=?').get(runId)!.command)
    );
    command.idempotencyKey = 'schema13-pending-key';
    const nextHash = String(
      db.prepare('SELECT hash FROM context_checkpoints WHERE id=?').get(ref.id)!.hash
    );
    expect(nextHash).not.toBe(ref.hash);
    db.close();
    let store = new Store(path);
    try {
      expect(stable(store.db)).toEqual(before);
      const replay = store.createRun(chatId, command, () => {
        throw new Error('Never admit or call a provider again');
      });
      expect(replay.created).toBe(false);
      expect(replay.run.id).toBe(runId);
      expect(replay.run.snapshot).not.toHaveProperty('branchId');
      expect(store.context.checkpoint({ ...ref, hash: nextHash }).scopeKey).toBe(`chat:${chatId}`);
      expect(() =>
        store.createRun(chatId, { ...command, request: 'Different' }, () => {
          throw new Error('Must conflict first');
        })
      ).toThrow('Idempotency');
      store.close();
      store = new Store(path);
      expect(stable(store.db)).toEqual(before);
      expect(store.db.prepare('PRAGMA foreign_keys').get()!.foreign_keys).toBe(1);
    } finally {
      store.close();
    }
  }
);

test.each(['head', 'owner', 'reference'] as const)(
  'schema13 %s mismatch rolls back all data and columns',
  (kind) => {
    const { db } = fixture(13);
    if (kind === 'head') db.exec('UPDATE branches SET head_revision=NULL');
    if (kind === 'owner') db.exec("UPDATE chat_variable_states SET branch_id='unknown'");
    if (kind === 'reference')
      db.exec(
        "UPDATE runs SET snapshot=json_set(snapshot,'$.contextBase.checkpoint.hash','wrong') WHERE status='queued'"
      );
    const before = stable(db);
    const runs = db.prepare('SELECT * FROM runs').all();
    expect(() => migrate(db, 13)).toThrow(/DATABASE_/);
    expect(stable(db)).toEqual(before);
    expect(db.prepare('SELECT * FROM runs').all()).toEqual(runs);
    expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(13);
    expect(db.prepare('SELECT COUNT(*) AS n FROM branches').get()!.n).toBe(1);
    expect(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys).toBe(1);
    db.close();
  }
);
