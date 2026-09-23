import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import type {
  ResponseChunk,
  ResponseProgress,
  ResponseStreamPage,
  ResponseStreamStatus,
  ResponseTaskKind,
} from '../core/response-stream.js';
import { HttpError } from './request-validation.js';
import type { Store } from './store.js';

export function initResponseStreams(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE response_stream_tasks (
      task_kind TEXT NOT NULL, task_id TEXT NOT NULL,
      chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE,
      run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
      helper_task_id TEXT REFERENCES helper_tasks(id) ON DELETE CASCADE,
      owner TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(task_kind, task_id)
    );
    CREATE TABLE response_stream_chunks (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      task_kind TEXT NOT NULL, task_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
      segment INTEGER NOT NULL, offset INTEGER NOT NULL, text TEXT NOT NULL,
      FOREIGN KEY(task_kind, task_id) REFERENCES response_stream_tasks(task_kind, task_id) ON DELETE CASCADE,
      UNIQUE(task_kind, task_id, attempt_id, segment, offset)
    );
    CREATE INDEX response_stream_cursor ON response_stream_chunks(task_kind, task_id, seq);
  `);
}

type StreamIdentity = { taskKind: ResponseTaskKind; taskId: string; chatId?: string | null };
type StreamRow = { owner: string; status: ResponseStreamStatus };
const keyOf = (identity: StreamIdentity) => JSON.stringify([identity.taskKind, identity.taskId]);

/** Public text has its own cursor; streaming never requires reloading the whole chat. */
export class ResponseStreamStore {
  private readonly listeners = new Map<string, Set<() => void>>();
  constructor(private readonly store: Pick<Store, 'db' | 'transaction'>) {}

  recover() {
    this.store.db
      .prepare(
        "UPDATE response_stream_tasks SET status='interrupted',updated_at=? WHERE status='running'"
      )
      .run(new Date().toISOString());
  }

  private row(identity: StreamIdentity): StreamRow | undefined {
    return this.store.db
      .prepare('SELECT owner,status FROM response_stream_tasks WHERE task_kind=? AND task_id=?')
      .get(identity.taskKind, identity.taskId) as StreamRow | undefined;
  }

  read(taskKind: ResponseTaskKind, taskId: string, after = 0): ResponseStreamPage {
    if (!Number.isSafeInteger(after) || after < 0)
      throw new HttpError(400, 'Invalid stream cursor');
    const identity = { taskKind, taskId };
    const row = this.row(identity);
    if (!row) throw new HttpError(404, 'Response stream not found');
    const rows = this.store.db
      .prepare(
        `SELECT seq,attempt_id AS attemptId,segment,offset,text FROM response_stream_chunks
       WHERE task_kind=? AND task_id=? AND seq>? ORDER BY seq LIMIT 257`
      )
      .all(taskKind, taskId, after) as ResponseChunk[];
    const chunks = rows.slice(0, 256);
    return {
      taskKind,
      taskId,
      status: row.status,
      chunks,
      cursor: chunks.at(-1)?.seq ?? after,
      hasMore: rows.length > 256,
    };
  }

  subscribe(identity: StreamIdentity, listener: () => void) {
    const key = keyOf(identity);
    const listeners = this.listeners.get(key) ?? new Set<() => void>();
    this.listeners.set(key, listeners);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(key);
    };
  }

  private publish(identity: StreamIdentity) {
    const listeners = this.listeners.get(keyOf(identity));
    for (const listener of listeners ?? []) {
      try {
        listener();
      } catch {
        // A disconnected subscriber cannot fail or cancel the server-owned provider request.
        listeners?.delete(listener);
      }
    }
  }

  createWriter(options: StreamIdentity & { signal: AbortSignal; isActive: () => boolean }) {
    const owner = randomUUID();
    const timestamp = new Date().toISOString();
    this.store.db
      .prepare(
        `INSERT INTO response_stream_tasks(task_kind,task_id,chat_id,run_id,helper_task_id,owner,status,created_at,updated_at)
       VALUES(?,?,?,?,?,?,'running',?,?)`
      )
      .run(
        options.taskKind,
        options.taskId,
        options.chatId ?? null,
        options.taskKind === 'main' ? options.taskId : null,
        options.taskKind === 'helper' ? options.taskId : null,
        owner,
        timestamp,
        timestamp
      );
    let buffer: ResponseProgress | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    let fault: unknown;
    let latestSegment = -1;
    const offsets = new Map<string, { offset: number; lastText: string }>();
    const clearTimer = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
    };
    const flush = () => {
      clearTimer();
      if (fault) throw fault;
      const pending = buffer;
      if (!pending) return;
      buffer = undefined;
      const inserted = this.store.transaction(() => {
        const row = this.row(options);
        if (!row || row.owner !== owner || row.status !== 'running') return false;
        const previous = this.store.db
          .prepare(
            `SELECT offset FROM response_stream_chunks WHERE task_kind=? AND task_id=?
           AND attempt_id=? AND segment=? ORDER BY seq DESC LIMIT 1`
          )
          .get(options.taskKind, options.taskId, pending.attemptId, pending.segment) as
          | { offset: number }
          | undefined;
        if ((previous?.offset ?? 0) + pending.text.length !== pending.offset)
          throw new Error('RESPONSE_STREAM_OFFSET_MISMATCH');
        this.store.db
          .prepare(
            `INSERT INTO response_stream_chunks(task_kind,task_id,attempt_id,segment,offset,text)
           VALUES(?,?,?,?,?,?)`
          )
          .run(
            options.taskKind,
            options.taskId,
            pending.attemptId,
            pending.segment,
            pending.offset,
            pending.text
          );
        return true;
      });
      // Subscribers can only observe committed batches. Already admitted text may flush on cancel.
      if (inserted) this.publish(options);
    };
    const finish = (status: Exclude<ResponseStreamStatus, 'running'>) => {
      if (closed) return;
      flush();
      closed = true;
      options.signal.removeEventListener('abort', onAbort);
      const changed = this.store.db
        .prepare(
          `UPDATE response_stream_tasks SET status=?,updated_at=?
         WHERE task_kind=? AND task_id=? AND owner=? AND status='running'`
        )
        .run(
          options.signal.aborted ? 'cancelled' : status,
          new Date().toISOString(),
          options.taskKind,
          options.taskId,
          owner
        );
      if (changed.changes && status === 'completed' && !options.signal.aborted) {
        this.store.db
          .prepare('DELETE FROM response_stream_chunks WHERE task_kind=? AND task_id=?')
          .run(options.taskKind, options.taskId);
      }
      if (changed.changes) this.publish(options);
    };
    const onAbort = () => {
      try {
        finish('cancelled');
      } catch (error) {
        fault = error;
        clearTimer();
      }
    };
    options.signal.addEventListener('abort', onAbort, { once: true });
    if (options.signal.aborted) onAbort();
    return {
      progress: (progress: ResponseProgress) => {
        if (fault) throw fault;
        if (closed || options.signal.aborted || !options.isActive()) return;
        if (!progress.text) return;
        if (
          !progress.attemptId ||
          !Number.isSafeInteger(progress.segment) ||
          progress.segment < 0 ||
          progress.segment < latestSegment ||
          !Number.isSafeInteger(progress.offset) ||
          progress.offset < progress.text.length
        )
          throw new Error('INVALID_RESPONSE_PROGRESS');
        const key = JSON.stringify([progress.attemptId, progress.segment]);
        const previous = offsets.get(key);
        if (previous?.offset === progress.offset && previous.lastText === progress.text) return;
        if ((previous?.offset ?? 0) + progress.text.length !== progress.offset)
          throw new Error('RESPONSE_STREAM_OFFSET_MISMATCH');
        if (
          buffer &&
          (buffer.attemptId !== progress.attemptId || buffer.segment !== progress.segment)
        )
          flush();
        latestSegment = progress.segment;
        offsets.set(key, { offset: progress.offset, lastText: progress.text });
        buffer = { ...progress, text: (buffer?.text ?? '') + progress.text };
        if (buffer.text.length >= 1024) flush();
        else if (!timer) {
          timer = setTimeout(() => {
            try {
              flush();
            } catch (error) {
              fault = error;
            }
          }, 100);
          timer.unref();
        }
      },
      flush,
      finish,
    };
  }
}

export function responseStreamRoutes(
  app: FastifyInstance,
  streams: ResponseStreamStore,
  options: { authenticated: (cookie: string | undefined) => boolean }
) {
  const connections = new Set<ServerResponse>();
  app.addHook('preClose', async () => {
    for (const response of connections) response.end();
    connections.clear();
  });
  const identity = (params: { taskKind: string; taskId: string }): StreamIdentity => {
    if (!['main', 'helper'].includes(params.taskKind))
      throw new HttpError(404, 'Unknown response stream kind');
    return { taskKind: params.taskKind as ResponseTaskKind, taskId: params.taskId };
  };
  const cursor = (value: unknown) => {
    if (value === undefined || value === '') return 0;
    if (typeof value !== 'string' || !/^\d+$/u.test(value))
      throw new HttpError(400, 'Invalid stream cursor');
    const result = Number(value);
    if (!Number.isSafeInteger(result)) throw new HttpError(400, 'Invalid stream cursor');
    return result;
  };
  app.get<{ Params: { taskKind: string; taskId: string }; Querystring: { after?: string } }>(
    '/api/response-streams/:taskKind/:taskId',
    (request) => {
      const target = identity(request.params);
      return streams.read(target.taskKind, target.taskId, cursor(request.query.after));
    }
  );
  app.get<{ Params: { taskKind: string; taskId: string }; Querystring: { after?: string } }>(
    '/api/response-streams/:taskKind/:taskId/events',
    async (request, reply) => {
      const target = identity(request.params);
      let after = cursor(request.headers['last-event-id'] ?? request.query.after);
      streams.read(target.taskKind, target.taskId, after);
      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      let unsubscribe = () => {};
      let blocked = false;
      connections.add(reply.raw);
      const heartbeat = setInterval(() => {
        if (!options.authenticated(request.headers.cookie)) reply.raw.end();
        else if (!blocked && !reply.raw.destroyed) blocked = !reply.raw.write(': keepalive\n\n');
      }, 15_000);
      heartbeat.unref();
      const send = () => {
        if (blocked || reply.raw.destroyed || reply.raw.writableEnded) return;
        if (!options.authenticated(request.headers.cookie)) {
          unsubscribe();
          reply.raw.end();
          return;
        }
        let page: ResponseStreamPage;
        do {
          page = streams.read(target.taskKind, target.taskId, after);
          blocked = !reply.raw.write(`id: ${page.cursor}\ndata: ${JSON.stringify(page)}\n\n`);
          // write(false) still accepts this page. Resume after it, never send it twice.
          after = page.cursor;
        } while (page.hasMore && !blocked);
        if (!page.hasMore && page.status !== 'running') {
          unsubscribe();
          reply.raw.end();
        }
      };
      const drain = () => {
        blocked = false;
        send();
      };
      reply.raw.on('drain', drain);
      unsubscribe = streams.subscribe(target, send);
      reply.raw.on('close', () => {
        clearInterval(heartbeat);
        connections.delete(reply.raw);
        reply.raw.off('drain', drain);
        unsubscribe();
      });
      send();
    }
  );
}
