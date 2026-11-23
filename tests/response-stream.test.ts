import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  initResponseStreams,
  pruneUnreachableResponseChunks,
  ResponseStreamStore,
  responseStreamRoutes,
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
  test('batches tokens, delivers them from memory before persisting, supports cursor recovery, and separates attempt/segment text', () => {
    vi.useFakeTimers();
    const state = fixture();
    const reader = new DatabaseSync(state.path, { readOnly: true });
    databases.add(reader);
    const persisted = () =>
      Number(
        (
          reader.prepare('SELECT COUNT(*) AS total FROM response_stream_chunks').get() as {
            total: number;
          }
        ).total
      );
    const writer = state.create();
    const notices: number[] = [];
    state.streams.subscribe({ taskKind: 'helper', taskId: 'task-1' }, () => {
      notices.push(persisted());
    });
    for (let offset = 1; offset <= 1000; offset++)
      writer.progress({ attemptId: 'attempt-1', segment: 0, offset, text: 'a' });
    expect(state.streams.read('helper', 'task-1').chunks).toEqual([]);
    vi.advanceTimersByTime(50);
    expect(notices).toEqual([0]);
    const delivered = state.streams.read('helper', 'task-1');
    vi.advanceTimersByTime(750);
    expect(persisted()).toBe(1);
    expect(notices).toEqual([0]);
    const first = state.streams.read('helper', 'task-1');
    expect(first).toEqual(delivered);
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
    writer.flush();
    const next = state.streams.read('helper', 'task-1', first.cursor);
    expect(next.status).toBe('running');
    expect(next.chunks).toHaveLength(1);
    expect(next.chunks[0]).toMatchObject({
      attemptId: 'attempt-2',
      segment: 1,
      offset: 2,
      text: '다음',
    });
    writer.finish('completed');
    expect(state.streams.read('helper', 'task-1', next.cursor)).toMatchObject({
      status: 'completed',
      chunks: [],
    });
  });

  test('a thought summary is delivered from memory only, bounded, and gone once cleared or finished', () => {
    vi.useFakeTimers();
    const state = fixture();
    const writer = state.create();
    let notices = 0;
    state.streams.subscribe({ taskKind: 'helper', taskId: 'task-1' }, () => notices++);
    writer.thought('자료를 ');
    writer.thought('확인하는 중');
    expect(state.streams.read('helper', 'task-1')).toMatchObject({
      thought: '자료를 확인하는 중',
      chunks: [],
    });
    vi.advanceTimersByTime(50);
    expect(notices).toBe(1);
    writer.thought(null);
    expect(notices).toBe(2);
    expect(state.streams.read('helper', 'task-1')).not.toHaveProperty('thought');
    writer.thought('가'.repeat(5000));
    expect(state.streams.read('helper', 'task-1').thought).toHaveLength(4000);
    writer.finish('failed');
    expect(state.streams.read('helper', 'task-1')).not.toHaveProperty('thought');
    expect(state.db.prepare('SELECT COUNT(*) AS n FROM response_stream_chunks').get()).toEqual({
      n: 0,
    });
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
    writer.flush();
    active = false;
    writer.progress({ attemptId: 'attempt-1', segment: 0, text: '확인 전', offset: 6 });
    writer.flush();
    writer.progress({ attemptId: 'attempt-1', segment: 0, text: '늦음', offset: 8 });
    writer.finish('partial');
    expect(state.streams.read('main', 'run-1').chunks.map((chunk) => chunk.text)).toEqual(['부분']);
    expect(state.db.prepare('SELECT text FROM response_stream_chunks ORDER BY seq').all()).toEqual([
      { text: '부분' },
    ]);
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

  test('a cursor sees one gapless sequence across memory delivery, a second reader and persistence', () => {
    vi.useFakeTimers();
    const state = fixture();
    const reader = new DatabaseSync(state.path, { readOnly: true });
    databases.add(reader);
    const stored = () =>
      reader
        .prepare(
          'SELECT seq,attempt_id AS attemptId,segment,offset,text FROM response_stream_chunks ORDER BY seq'
        )
        .all()
        .map((row) => ({ ...row }));
    const writer = state.create();
    const texts = ['하나', '둘', '셋'];
    for (const [index, text] of texts.entries()) {
      writer.progress({
        attemptId: 'attempt-1',
        segment: 0,
        offset: texts.slice(0, index + 1).join('').length,
        text,
      });
      vi.advanceTimersByTime(50);
    }
    const live = state.streams.read('helper', 'task-1');
    expect(live.chunks.map((chunk) => chunk.text)).toEqual(texts);
    expect(live.chunks.map((chunk) => chunk.seq)).toEqual([
      live.chunks[0].seq,
      live.chunks[0].seq + 1,
      live.chunks[0].seq + 2,
    ]);
    expect(stored()).toEqual([]);
    expect(state.streams.read('helper', 'task-1', live.chunks[0].seq).chunks).toEqual(
      live.chunks.slice(1)
    );
    vi.advanceTimersByTime(750);
    expect(stored()).toEqual(live.chunks);
    expect(state.streams.read('helper', 'task-1')).toEqual(live);
    expect(state.streams.read('helper', 'task-1', live.chunks[1].seq).chunks).toEqual(
      live.chunks.slice(2)
    );
    writer.progress({ attemptId: 'attempt-1', segment: 0, offset: 5, text: '넷' });
    vi.advanceTimersByTime(50);
    const merged = state.streams.read('helper', 'task-1');
    expect(merged.chunks.map((chunk) => chunk.text)).toEqual([...texts, '넷']);
    expect(merged.chunks[3].seq).toBe(live.cursor + 1);
    expect(state.streams.read('helper', 'task-1', live.cursor).chunks).toEqual([merged.chunks[3]]);
    writer.finish('partial');
    expect(state.streams.read('helper', 'task-1')).toEqual({ ...merged, status: 'partial' });
    expect(stored()).toEqual(merged.chunks);
  });

  test('a restart drops only the unpersisted tail and never reuses a delivered sequence number', () => {
    vi.useFakeTimers();
    const state = fixture();
    state.db.prepare('INSERT INTO runs(id) VALUES(?)').run('run-1');
    const writer = state.streams.createWriter({
      taskKind: 'main',
      taskId: 'run-1',
      chatId: 'chat-1',
      signal: state.signal.signal,
      isActive: () => true,
    });
    writer.progress({ attemptId: 'attempt-1', segment: 0, offset: 2, text: '저장' });
    writer.flush();
    writer.progress({ attemptId: 'attempt-1', segment: 0, offset: 4, text: '유실' });
    vi.advanceTimersByTime(50);
    const before = state.streams.read('main', 'run-1');
    expect(before.chunks.map((chunk) => chunk.text)).toEqual(['저장', '유실']);
    vi.clearAllTimers();
    state.db.close();
    databases.delete(state.db);
    const reopened = new ResponseStreamStore(connection(state.path));
    reopened.recover();
    expect(reopened.read('main', 'run-1')).toMatchObject({
      status: 'interrupted',
      chunks: [{ text: '저장' }],
    });
    const resumed = reopened.createWriter({
      taskKind: 'main',
      taskId: 'run-1',
      chatId: 'chat-1',
      signal: new AbortController().signal,
      isActive: () => true,
      resume: true,
    });
    resumed.progress({ attemptId: 'attempt-2', segment: 0, offset: 2, text: '재개' });
    vi.advanceTimersByTime(50);
    const after = reopened.read('main', 'run-1', before.cursor);
    expect(after.chunks).toMatchObject([{ attemptId: 'attempt-2', text: '재개' }]);
    expect(after.chunks[0].seq).toBeGreaterThan(before.cursor);
    resumed.finish('partial');
    expect(reopened.read('main', 'run-1').chunks.map((chunk) => chunk.text)).toEqual([
      '저장',
      '재개',
    ]);
  });

  test('a translation task restarts under the same id, wakes chat subscribers and keeps no text after it ends', async () => {
    vi.useFakeTimers();
    const state = fixture();
    const woken: string[] = [];
    const unsubscribe = state.streams.subscribeChat('chat-1', (identity) =>
      woken.push(`${identity.taskKind}:${identity.taskId}`)
    );
    const translation = () =>
      state.streams.createWriter({
        taskKind: 'translation',
        taskId: 'job-1',
        chatId: 'chat-1',
        signal: state.signal.signal,
      });
    const first = translation();
    expect(state.streams.runningTasks('chat-1')).toEqual([
      { taskKind: 'translation', taskId: 'job-1' },
    ]);
    expect(state.streams.runningTasks('chat-2')).toEqual([]);
    first.progress({ attemptId: 'attempt-1', segment: 0, offset: 2, text: '거절' });
    vi.advanceTimersByTime(50);
    expect(woken).toEqual(['translation:job-1', 'translation:job-1']);
    expect(state.streams.read('translation', 'job-1').chunks).toMatchObject([{ text: '거절' }]);
    first.finish('failed');
    expect(woken).toHaveLength(3);
    expect(state.streams.read('translation', 'job-1')).toMatchObject({
      status: 'failed',
      chunks: [],
    });
    expect(state.streams.runningTasks('chat-1')).toEqual([]);
    const stale = translation();
    const second = translation();
    stale.progress({ attemptId: 'attempt-2', segment: 0, offset: 2, text: '밀림' });
    second.progress({ attemptId: 'attempt-3', segment: 0, offset: 2, text: '번역' });
    vi.advanceTimersByTime(50);
    expect(state.streams.read('translation', 'job-1').chunks).toMatchObject([
      { attemptId: 'attempt-3', text: '번역' },
    ]);
    stale.finish('completed');
    expect(state.streams.read('translation', 'job-1').status).toBe('running');
    expect(state.streams.runningTasks('chat-1')).toHaveLength(1);
    vi.advanceTimersByTime(750);
    vi.useRealTimers();
    const app = Fastify();
    responseStreamRoutes(app, state.streams, { authenticated: () => true });
    expect((await app.inject('/api/response-streams/translation/job-1')).json()).toMatchObject({
      taskKind: 'translation',
      status: 'running',
      chunks: [{ text: '번역' }],
    });
    expect((await app.inject('/api/response-streams/unknown/job-1')).statusCode).toBe(404);
    await app.close();
    unsubscribe();
    state.db.close();
    databases.delete(state.db);
    const reopened = new ResponseStreamStore(connection(state.path));
    reopened.recover();
    expect(reopened.read('translation', 'job-1')).toMatchObject({
      status: 'interrupted',
      chunks: [],
    });
    expect(reopened.runningTasks('chat-1')).toEqual([]);
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
      expect(reconnected.body).not.toContain(' 그리고 끝');
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

test('startup cleanup drops main-run chunks that no screen can show any more', () => {
  const directory = mkdtempSync(join(tmpdir(), 'uimori-stream-'));
  directories.push(directory);
  const { db } = connection(join(directory, 'synthetic.sqlite'));
  db.exec(`CREATE TABLE chats(id TEXT PRIMARY KEY); INSERT INTO chats VALUES('chat-1'),('chat-2');
    CREATE TABLE runs(id TEXT PRIMARY KEY, chat_id TEXT, status TEXT, command TEXT, partial_text TEXT, source_revision TEXT);
    CREATE TABLE helper_tasks(id TEXT PRIMARY KEY); INSERT INTO helper_tasks VALUES('task-1');`);
  initResponseStreams(db);
  const run = db.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?)');
  const retry = (of: string) => JSON.stringify({ retryOf: of });
  run.run('refused-retried', 'chat-1', 'refused', '{}', null, null);
  run.run('retry', 'chat-1', 'completed', retry('refused-retried'), null, 'source-1');
  run.run('cancelled-retried', 'chat-1', 'cancelled', '{}', '', null);
  run.run('retry-2', 'chat-1', 'running', retry('cancelled-retried'), null, null);
  run.run('failed-pending', 'chat-1', 'failed', '{}', '부분', null);
  run.run('refused-copied', 'chat-1', 'refused', '{}', null, null);
  run.run('copy', 'chat-2', 'completed', retry('refused-copied'), null, 'source-2');
  run.run('partial-saved', 'chat-1', 'partial', '{}', '부분', 'source-3');
  run.run('running', 'chat-1', 'running', '{}', null, null);
  const task = db.prepare("INSERT INTO response_stream_tasks VALUES(?,?,?,?,?,'owner',?,'t','t')");
  const chunk = db.prepare(
    "INSERT INTO response_stream_chunks(task_kind,task_id,attempt_id,segment,offset,text) VALUES(?,?,'a',0,2,'부분')"
  );
  const ids = [
    'refused-retried',
    'cancelled-retried',
    'failed-pending',
    'refused-copied',
    'partial-saved',
    'running',
  ];
  for (const id of ids) {
    task.run('main', id, 'chat-1', id, null, id === 'running' ? 'running' : 'failed');
    chunk.run('main', id);
  }
  task.run('helper', 'task-1', 'chat-1', null, 'task-1', 'failed');
  chunk.run('helper', 'task-1');
  expect(pruneUnreachableResponseChunks(db)).toBe(2);
  expect(
    db
      .prepare('SELECT task_id FROM response_stream_chunks ORDER BY task_id')
      .all()
      .map((row) => row.task_id)
  ).toEqual(['cancelled-retried', 'failed-pending', 'refused-copied', 'running', 'task-1']);
  expect(db.prepare('SELECT count(*) AS n FROM response_stream_tasks').get()!.n).toBe(7);
});
