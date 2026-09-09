import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  initResponseStreams,
  normalizeResponseStreamArchiveRow,
  ResponseStreamStore,
  responseStreamRoutes,
  validateResponseStreamArchive,
} from '../server/response-stream.js';
import { executeProvider } from '../core/transport.js';
import { loopbackProvider, sse } from './fixtures/loopback-provider.js';

const directories: string[] = [];
const databases = new Set<DatabaseSync>();
afterEach(() => {
  vi.useRealTimers();
  for (const db of databases) db.close();
  databases.clear();
  for (const directory of directories.splice(0)) {
    const inside = relative(resolve(tmpdir()), resolve(directory));
    if (isAbsolute(inside) || inside.startsWith('..') || !inside.startsWith('uimori-stream-'))
      throw new Error('Unsafe test cleanup');
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('response stream archive receipts', () => {
  function archiveFixture() {
    const state = fixture();
    state.db.exec(`
      ALTER TABLE runs ADD COLUMN chat_id TEXT;
      ALTER TABLE helper_tasks ADD COLUMN conversation_id TEXT;
      CREATE TABLE helper_conversations(id TEXT PRIMARY KEY,chat_id TEXT);
      INSERT INTO helper_conversations VALUES('conversation-1','chat-1');
      UPDATE helper_tasks SET conversation_id='conversation-1';
      CREATE TABLE attempts(id TEXT PRIMARY KEY,chat_id TEXT,run_id TEXT,job_id TEXT,role TEXT);
      CREATE TABLE helper_task_attempts(attempt_id TEXT PRIMARY KEY,task_id TEXT,segment INTEGER,purpose TEXT);
      INSERT INTO attempts VALUES('attempt-1','chat-1',NULL,NULL,'helper'),('attempt-2','chat-1',NULL,NULL,'helper');
      INSERT INTO helper_task_attempts VALUES('attempt-1','task-1',0,'helper'),('attempt-2','task-1',1,'helper');
    `);
    const writer = state.create();
    writer.progress({ attemptId: 'attempt-1', segment: 0, offset: 2, text: '첫째' });
    writer.flush();
    writer.progress({ attemptId: 'attempt-1', segment: 0, offset: 4, text: '문장' });
    writer.flush();
    writer.progress({ attemptId: 'attempt-2', segment: 1, offset: 2, text: '다음' });
    writer.finish('completed');
    return state;
  }
  test('restored active rows lose their lease and preserve partial output without replay', () => {
    const state = archiveFixture();
    const row = state.db.prepare('SELECT * FROM response_stream_tasks').get()!;
    const oldOwner = row.owner;
    row.status = 'running';
    normalizeResponseStreamArchiveRow('response_stream_tasks', row);
    expect(row).toMatchObject({ status: 'interrupted' });
    expect(row.owner).not.toBe(oldOwner);
    state.db
      .prepare('UPDATE response_stream_tasks SET owner=?,status=?')
      .run(row.owner, row.status);
    expect(() => validateResponseStreamArchive(state)).not.toThrow();
    expect(state.streams.read('helper', 'task-1').chunks.map((chunk) => chunk.text)).toEqual([
      '첫째',
      '문장',
      '다음',
    ]);
  });
  test('archive validation rejects corrupt cursors, offsets, segments and reopened attempts', () => {
    const state = archiveFixture();
    expect(() => validateResponseStreamArchive(state)).not.toThrow();
    const corruptions = [
      'UPDATE response_stream_chunks SET seq=-1 WHERE seq=1',
      'UPDATE response_stream_chunks SET offset=5 WHERE seq=2',
      "UPDATE response_stream_chunks SET text='' WHERE seq=1",
      'UPDATE response_stream_chunks SET segment=-1 WHERE seq=1',
      'UPDATE response_stream_chunks SET segment=0 WHERE seq=3',
      "INSERT INTO response_stream_chunks(task_kind,task_id,attempt_id,segment,offset,text) VALUES('helper','task-1','attempt-1',1,6,'복귀')",
    ];
    for (const sql of corruptions) {
      state.db.exec('SAVEPOINT corruption');
      state.db.exec(sql);
      expect(() => validateResponseStreamArchive(state), sql).toThrow(
        'Invalid response stream archive'
      );
      state.db.exec('ROLLBACK TO corruption; RELEASE corruption');
    }
  });
  test('archive validation binds helper chunks to their public role, task, segment and chat', () => {
    const state = archiveFixture();
    const corruptions = [
      "UPDATE response_stream_tasks SET task_kind='unknown'",
      "UPDATE response_stream_tasks SET owner='invalid'",
      "UPDATE response_stream_tasks SET status='running'",
      "UPDATE response_stream_tasks SET updated_at='invalid'",
      'UPDATE response_stream_tasks SET chat_id=NULL',
      'UPDATE response_stream_tasks SET helper_task_id=NULL',
      "UPDATE attempts SET chat_id=NULL WHERE id='attempt-1'",
      "UPDATE attempts SET role='context' WHERE id='attempt-1'",
      "UPDATE helper_task_attempts SET task_id='other' WHERE attempt_id='attempt-1'",
      "UPDATE helper_task_attempts SET purpose='context' WHERE attempt_id='attempt-1'",
      "DELETE FROM attempts WHERE id='attempt-1'",
    ];
    for (const sql of corruptions) {
      state.db.exec('PRAGMA defer_foreign_keys=ON; SAVEPOINT corruption');
      state.db.exec(sql);
      expect(() => validateResponseStreamArchive(state), sql).toThrow(
        'Invalid response stream archive'
      );
      state.db.exec('ROLLBACK TO corruption; RELEASE corruption');
    }
  });
  test('main streams require their own main attempt, while library helper streams allow null chat', () => {
    const state = archiveFixture();
    state.db.exec(
      "INSERT INTO runs VALUES('run-1','chat-1'); INSERT INTO attempts VALUES('main-attempt','chat-1','run-1',NULL,'main')"
    );
    const writer = state.streams.createWriter({
      taskKind: 'main',
      taskId: 'run-1',
      chatId: 'chat-1',
      signal: new AbortController().signal,
      isActive: () => true,
    });
    writer.progress({ attemptId: 'main-attempt', segment: 0, offset: 2, text: '본문' });
    writer.finish('completed');
    state.db.exec(
      "UPDATE helper_conversations SET chat_id=NULL; UPDATE response_stream_tasks SET chat_id=NULL WHERE task_kind='helper'; UPDATE attempts SET chat_id=NULL WHERE role='helper'"
    );
    expect(() => validateResponseStreamArchive(state)).not.toThrow();
    state.db.exec("UPDATE attempts SET run_id=NULL WHERE id='main-attempt'");
    expect(() => validateResponseStreamArchive(state)).toThrow('main attempt');
  });
});
function connection(path: string) {
  const db = new DatabaseSync(path);
  databases.add(db);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
  return {
    db,
    transaction: <T>(action: () => T): T => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = action();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-stream-'));
  directories.push(directory);
  const path = join(directory, 'synthetic.sqlite');
  const store = connection(path);
  store.db.exec(
    "CREATE TABLE chats(id TEXT PRIMARY KEY); INSERT INTO chats VALUES('chat-1'); CREATE TABLE runs(id TEXT PRIMARY KEY); CREATE TABLE helper_tasks(id TEXT PRIMARY KEY); INSERT INTO helper_tasks VALUES('task-1');"
  );
  initResponseStreams(store.db);
  const streams = new ResponseStreamStore(store);
  const signal = new AbortController();
  return {
    ...store,
    streams,
    path,
    signal,
    create: (taskId = 'task-1') =>
      streams.createWriter({
        taskKind: 'helper',
        taskId,
        chatId: 'chat-1',
        signal: signal.signal,
        isActive: () => true,
      }),
  };
}

describe('durable public response batches', () => {
  test('batches tokens before publishing, supports cursor recovery, and separates attempt/segment text', () => {
    vi.useFakeTimers();
    const state = fixture();
    const reader = new DatabaseSync(state.path, { readOnly: true });
    databases.add(reader);
    const notices: number[] = [];
    state.streams.subscribe({ taskKind: 'helper', taskId: 'task-1' }, () => {
      notices.push(
        Number(
          (
            reader.prepare('SELECT COUNT(*) AS total FROM response_stream_chunks').get() as {
              total: number;
            }
          ).total
        )
      );
    });
    const writer = state.create();
    for (let offset = 1; offset <= 1000; offset++)
      writer.progress({ attemptId: 'attempt-1', segment: 0, offset, text: 'a' });
    expect(state.streams.read('helper', 'task-1').chunks).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(notices).toEqual([1]);
    const first = state.streams.read('helper', 'task-1');
    expect(first.chunks).toEqual([
      {
        seq: first.cursor,
        attemptId: 'attempt-1',
        segment: 0,
        offset: 1000,
        text: 'a'.repeat(1000),
      },
    ]);
    writer.progress({ attemptId: 'attempt-2', segment: 1, offset: 2, text: '다음' });
    writer.finish('completed');
    const next = state.streams.read('helper', 'task-1', first.cursor);
    expect(next.status).toBe('completed');
    expect(next.chunks).toHaveLength(1);
    expect(next.chunks[0]).toMatchObject({
      attemptId: 'attempt-2',
      segment: 1,
      offset: 2,
      text: '다음',
    });
    expect(state.streams.read('helper', 'task-1', next.cursor).chunks).toEqual([]);
  });

  test('cancel flushes admitted partial text and ignores late deltas and final results', () => {
    const state = fixture();
    const writer = state.create();
    writer.progress({ attemptId: 'attempt-1', segment: 0, offset: 2, text: '부분' });
    state.signal.abort();
    writer.progress({ attemptId: 'attempt-1', segment: 0, offset: 4, text: '늦음' });
    writer.finish('completed');
    expect(state.streams.read('helper', 'task-1')).toMatchObject({
      status: 'cancelled',
      chunks: [{ text: '부분', offset: 2 }],
    });
  });

  test('server restart marks durable partial output interrupted and never replays the task', () => {
    const state = fixture();
    const writer = state.create();
    writer.progress({ attemptId: 'attempt-1', segment: 0, offset: 2, text: '부분' });
    writer.flush();
    state.db.close();
    databases.delete(state.db);
    const reopened = new ResponseStreamStore(connection(state.path));
    reopened.recover();
    expect(reopened.read('helper', 'task-1')).toMatchObject({
      status: 'interrupted',
      chunks: [{ text: '부분' }],
    });
    expect(() =>
      reopened.createWriter({
        taskKind: 'helper',
        taskId: 'task-1',
        signal: new AbortController().signal,
        isActive: () => true,
      })
    ).toThrow();
  });

  test('offset duplicates are harmless but gaps and backward segments cannot corrupt a stream', () => {
    const state = fixture();
    const writer = state.create();
    const progress = { attemptId: 'attempt-1', segment: 1, offset: 2, text: '부분' };
    writer.progress(progress);
    writer.progress(progress);
    expect(() => writer.progress({ ...progress, text: 'gap', offset: 8 })).toThrow('OFFSET');
    expect(() =>
      writer.progress({ attemptId: 'attempt-2', segment: 0, offset: 1, text: 'x' })
    ).toThrow('INVALID');
    writer.finish('partial');
    expect(
      state.streams
        .read('helper', 'task-1')
        .chunks.map((chunk) => chunk.text)
        .join('')
    ).toBe('부분');
  });

  test('inactive owners cannot append and deleting a run cascades its public stream', () => {
    const state = fixture();
    state.db.prepare('INSERT INTO runs(id) VALUES(?)').run('run-1');
    let active = true;
    const writer = state.streams.createWriter({
      taskKind: 'main',
      taskId: 'run-1',
      chatId: 'chat-1',
      signal: state.signal.signal,
      isActive: () => active,
    });
    writer.progress({ attemptId: 'attempt-1', segment: 0, text: '부분', offset: 2 });
    active = false;
    writer.progress({ attemptId: 'attempt-1', segment: 0, text: '늦음', offset: 4 });
    writer.finish('partial');
    expect(state.streams.read('main', 'run-1').chunks.map((chunk) => chunk.text)).toEqual(['부분']);
    state.db.prepare('DELETE FROM runs WHERE id=?').run('run-1');
    expect(() => state.streams.read('main', 'run-1')).toThrow('not found');
    expect(state.db.prepare('SELECT COUNT(*) AS count FROM response_stream_chunks').get()).toEqual({
      count: 0,
    });
    const helper = state.create();
    helper.progress({ attemptId: 'attempt-2', segment: 0, text: '도우미', offset: 3 });
    helper.finish('completed');
    state.db.prepare('DELETE FROM helper_tasks WHERE id=?').run('task-1');
    expect(() => state.streams.read('helper', 'task-1')).toThrow('not found');
  });

  test('loopback provider reaches durable public chunks before EOF and reconnect route returns only missing batches', async () => {
    const state = fixture();
    const writer = state.create();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = await loopbackProvider(async (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(sse({ type: 'opaque_state', state: 'PRIVATE_OPAQUE' }));
      response.write(sse({ type: 'text_delta', delta: '먼저 받은 부분' }));
      await barrier;
      response.end(
        sse({ type: 'text_delta', delta: ' 그리고 끝' }) + sse({ type: 'done', reason: 'stop' })
      );
    });
    const app = Fastify();
    responseStreamRoutes(app, state.streams, { authenticated: () => true });
    try {
      const appOrigin = await app.listen({ port: 0, host: '127.0.0.1' });
      let done = false;
      const resultPromise = executeProvider(
        { id: 'synthetic', protocol: 'fixture-sse-v1', endpoint: provider.endpoint },
        {
          role: 'main',
          modelId: 'synthetic-model',
          stable: { contract: 'Synthetic response', tools: [] },
          input: { task: 'Answer.', controls: {} },
        },
        {
          approvedOrigins: [provider.origin],
          signal: state.signal.signal,
          onProgress: (progress) =>
            writer.progress({ ...progress, attemptId: 'attempt-1', segment: 0 }),
        }
      ).then((result) => {
        done = true;
        return result;
      });
      await vi.waitFor(() => expect(state.streams.read('helper', 'task-1').chunks).toHaveLength(1));
      expect(done).toBe(false);
      const first = (await app.inject('/api/response-streams/helper/task-1')).json();
      expect(first.chunks[0].text).toBe('먼저 받은 부분');
      const live = await fetch(`${appOrigin}/api/response-streams/helper/task-1/events`);
      const reader = live.body!.getReader();
      expect((await reader.read()).done).toBe(false);
      await reader.cancel();
      expect(state.signal.signal.aborted).toBe(false);
      expect(done).toBe(false);
      release();
      expect((await resultPromise).status).toBe('completed');
      writer.finish('completed');
      const reconnected = await app.inject({
        url: '/api/response-streams/helper/task-1/events',
        headers: { 'last-event-id': String(first.cursor) },
      });
      expect(reconnected.body).toContain(' 그리고 끝');
      expect(reconnected.body).not.toContain('먼저 받은 부분');
      expect(reconnected.body).not.toContain('PRIVATE_OPAQUE');
      expect(reconnected.body).toContain('"status":"completed"');
    } finally {
      release();
      writer.finish('failed');
      await provider.close();
      await app.close();
    }
  });
});
