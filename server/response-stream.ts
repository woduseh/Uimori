import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import type {
  ResponseChunk,
  ResponseProgress,
  ResponseStreamPage,
  ResponseStreamStatus,
  ResponseTaskIdentity,
  ResponseTaskKind,
} from '../core/response-stream.js';
import { RESPONSE_TASK_KINDS } from '../core/response-stream.js';
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

export function pruneUnreachableResponseChunks(db: DatabaseSync): number {
  return Number(
    db
      .prepare(`DELETE FROM response_stream_chunks WHERE task_kind='main' AND task_id IN (
      SELECT r.id FROM runs r WHERE r.status NOT IN ('queued','running')
        AND r.id IN (SELECT DISTINCT task_id FROM response_stream_chunks WHERE task_kind='main')
        AND (r.source_revision IS NOT NULL OR (
          EXISTS(SELECT 1 FROM runs newer WHERE newer.chat_id=r.chat_id AND json_extract(newer.command,'$.retryOf')=r.id)
          AND NOT (r.status='cancelled' AND COALESCE(r.partial_text,'')=''))))`)
      .run().changes
  );
}

type StreamIdentity = ResponseTaskIdentity & { chatId?: string | null };
type StreamRow = { owner: string; status: ResponseStreamStatus };
type ActiveStream = {
  identity: ResponseTaskIdentity;
  chatId: string | null;
  tail: ResponseChunk[];
  durableSeq: number;
  revoked: boolean;
  thought: string;
};
type ChatListener = (identity: ResponseTaskIdentity) => void;
const keyOf = (identity: ResponseTaskIdentity) =>
  JSON.stringify([identity.taskKind, identity.taskId]);
const DELIVERY_INTERVAL_MS = 50;
const DELIVERY_CHARS = 1024;
const PERSIST_INTERVAL_MS = 750;
const PERSIST_CHARS = 4096;
const SEQUENCE_BLOCK = 1024;
const PAGE_CHUNKS = 256;
const THOUGHT_CHARS = 4000;

export class ResponseStreamStore {
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly chatListeners = new Map<string, Set<ChatListener>>();
  private readonly active = new Map<string, ActiveStream>();
  private sequenceState: { next: number; reserved: number } | undefined;
  private readonly store: Pick<Store, 'db' | 'transaction'>;
  constructor(store: Pick<Store, 'db' | 'transaction'>) {
    this.store = store;
  }

  recover() {
    this.store.db
      .prepare(
        "UPDATE response_stream_tasks SET status='interrupted',updated_at=? WHERE status='running'"
      )
      .run(new Date().toISOString());
    this.store.db.prepare("DELETE FROM response_stream_chunks WHERE task_kind='translation'").run();
  }

  private row(identity: ResponseTaskIdentity): StreamRow | undefined {
    return this.store.db
      .prepare('SELECT owner,status FROM response_stream_tasks WHERE task_kind=? AND task_id=?')
      .get(identity.taskKind, identity.taskId) as StreamRow | undefined;
  }

  private sequence() {
    if (!this.sequenceState) {
      const row = this.store.db
        .prepare("SELECT seq FROM sqlite_sequence WHERE name='response_stream_chunks'")
        .get() as { seq: number } | undefined;
      const seq = Number(row?.seq ?? 0);
      this.sequenceState = { next: seq, reserved: seq };
    }
    return this.sequenceState;
  }

  private allocateSeq() {
    const state = this.sequence();
    if (state.next >= state.reserved) {
      const reserved = state.next + SEQUENCE_BLOCK;
      const updated = this.store.db
        .prepare("UPDATE sqlite_sequence SET seq=? WHERE name='response_stream_chunks'")
        .run(reserved);
      if (!updated.changes)
        this.store.db
          .prepare("INSERT INTO sqlite_sequence(name,seq) VALUES('response_stream_chunks',?)")
          .run(reserved);
      state.reserved = reserved;
    }
    return ++state.next;
  }

  read(taskKind: ResponseTaskKind, taskId: string, after = 0): ResponseStreamPage {
    if (!Number.isSafeInteger(after) || after < 0)
      throw new HttpError(400, 'Invalid stream cursor');
    const identity = { taskKind, taskId };
    const row = this.row(identity);
    if (!row) throw new HttpError(404, 'Response stream not found');
    const stream = this.active.get(keyOf(identity));
    const rows =
      stream && after >= stream.durableSeq
        ? []
        : (this.store.db
            .prepare(
              `SELECT seq,attempt_id AS attemptId,segment,offset,text FROM response_stream_chunks
       WHERE task_kind=? AND task_id=? AND seq>? ORDER BY seq LIMIT ?`
            )
            .all(taskKind, taskId, after, PAGE_CHUNKS + 1) as ResponseChunk[]);
    for (const chunk of stream?.tail ?? []) {
      if (rows.length > PAGE_CHUNKS) break;
      if (chunk.seq > after) rows.push({ ...chunk });
    }
    const chunks = rows.slice(0, PAGE_CHUNKS);
    return {
      taskKind,
      taskId,
      status: row.status,
      chunks,
      cursor: chunks.at(-1)?.seq ?? after,
      hasMore: rows.length > PAGE_CHUNKS,
      ...(stream?.thought && row.status === 'running' ? { thought: stream.thought } : {}),
    };
  }

  runningTasks(chatId: string): ResponseTaskIdentity[] {
    return [...this.active.values()]
      .filter((stream) => stream.chatId === chatId)
      .map((stream) => ({ ...stream.identity }));
  }

  subscribe(identity: ResponseTaskIdentity, listener: () => void) {
    const key = keyOf(identity);
    const listeners = this.listeners.get(key) ?? new Set<() => void>();
    this.listeners.set(key, listeners);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size && this.listeners.get(key) === listeners) this.listeners.delete(key);
    };
  }

  subscribeChat(chatId: string, listener: ChatListener) {
    const listeners = this.chatListeners.get(chatId) ?? new Set<ChatListener>();
    this.chatListeners.set(chatId, listeners);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size && this.chatListeners.get(chatId) === listeners)
        this.chatListeners.delete(chatId);
    };
  }

  private publish(identity: StreamIdentity) {
    const target = { taskKind: identity.taskKind, taskId: identity.taskId };
    const listeners = this.listeners.get(keyOf(target));
    for (const listener of [...(listeners ?? [])]) {
      try {
        listener();
      } catch {
        listeners?.delete(listener);
      }
    }
    const chatListeners = identity.chatId ? this.chatListeners.get(identity.chatId) : undefined;
    for (const listener of [...(chatListeners ?? [])]) {
      try {
        listener({ ...target });
      } catch {
        chatListeners?.delete(listener);
      }
    }
  }

  createWriter(
    options: StreamIdentity & {
      signal: AbortSignal;
      isActive?: () => boolean;
      resume?: boolean;
      abortStatus?: () => 'cancelled' | 'interrupted';
    }
  ) {
    const owner = randomUUID();
    const timestamp = new Date().toISOString();
    const key = keyOf(options);
    const restartable = options.taskKind === 'translation';
    const resumed =
      options.resume && options.taskKind === 'main' && options.isActive?.() !== false
        ? this.store.db
            .prepare(`UPDATE response_stream_tasks SET owner=?,status='running',updated_at=?
          WHERE task_kind='main' AND task_id=? AND status IN ('interrupted','cancelled')`)
            .run(owner, timestamp, options.taskId).changes
        : 0;
    if (!resumed)
      this.store.transaction(() => {
        if (restartable)
          this.store.db
            .prepare(
              "DELETE FROM response_stream_tasks WHERE task_kind='translation' AND task_id=?"
            )
            .run(options.taskId);
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
      });
    const replaced = this.active.get(key);
    if (replaced) {
      replaced.revoked = true;
      replaced.tail = [];
    }
    const stream: ActiveStream = {
      identity: { taskKind: options.taskKind, taskId: options.taskId },
      chatId: options.chatId ?? null,
      tail: [],
      durableSeq: this.sequence().next,
      revoked: false,
      thought: '',
    };
    this.active.set(key, stream);
    let buffer: ResponseProgress | undefined;
    let deliveryTimer: ReturnType<typeof setTimeout> | undefined;
    let persistTimer: ReturnType<typeof setTimeout> | undefined;
    let thoughtTimer: ReturnType<typeof setTimeout> | undefined;
    let tailChars = 0;
    let closed = false;
    let fault: unknown;
    let latestSegment = -1;
    const offsets = new Map<string, { offset: number; lastText: string }>();
    const clearTimers = () => {
      if (deliveryTimer) clearTimeout(deliveryTimer);
      if (persistTimer) clearTimeout(persistTimer);
      if (thoughtTimer) clearTimeout(thoughtTimer);
      deliveryTimer = undefined;
      persistTimer = undefined;
      thoughtTimer = undefined;
    };
    const guarded = (action: () => void) => () => {
      try {
        action();
      } catch (error) {
        fault = error;
        clearTimers();
      }
    };
    const persist = () => {
      if (persistTimer) clearTimeout(persistTimer);
      persistTimer = undefined;
      const pending = stream.tail;
      if (!pending.length) return;
      if (!stream.revoked && options.isActive?.() === false) stream.revoked = true;
      if (stream.revoked) {
        if (stream.tail === pending) stream.tail = [];
        tailChars = 0;
        return;
      }
      const inserted = this.store.transaction(() => {
        const row = this.row(options);
        if (!row || row.owner !== owner || row.status !== 'running') return false;
        for (const chunk of pending) {
          const previous = this.store.db
            .prepare(
              `SELECT offset FROM response_stream_chunks WHERE task_kind=? AND task_id=?
             AND attempt_id=? AND segment=? ORDER BY seq DESC LIMIT 1`
            )
            .get(options.taskKind, options.taskId, chunk.attemptId, chunk.segment) as
            | { offset: number }
            | undefined;
          if ((previous?.offset ?? 0) + chunk.text.length !== chunk.offset)
            throw new Error('RESPONSE_STREAM_OFFSET_MISMATCH');
          this.store.db
            .prepare(
              `INSERT INTO response_stream_chunks(seq,task_kind,task_id,attempt_id,segment,offset,text)
             VALUES(?,?,?,?,?,?,?)`
            )
            .run(
              chunk.seq,
              options.taskKind,
              options.taskId,
              chunk.attemptId,
              chunk.segment,
              chunk.offset,
              chunk.text
            );
        }
        return true;
      });
      if (stream.tail === pending) stream.tail = [];
      tailChars = 0;
      if (inserted) stream.durableSeq = pending[pending.length - 1].seq;
      else stream.revoked = true;
    };
    const deliver = () => {
      if (deliveryTimer) clearTimeout(deliveryTimer);
      deliveryTimer = undefined;
      const pending = buffer;
      buffer = undefined;
      if (!pending || stream.revoked) return;
      stream.tail.push({
        seq: this.allocateSeq(),
        attemptId: pending.attemptId,
        segment: pending.segment,
        offset: pending.offset,
        text: pending.text,
      });
      tailChars += pending.text.length;
      this.publish(options);
      if (tailChars >= PERSIST_CHARS) persist();
      else if (!persistTimer) {
        persistTimer = setTimeout(guarded(persist), PERSIST_INTERVAL_MS);
        persistTimer.unref();
      }
    };
    const flush = () => {
      if (fault) throw fault;
      deliver();
      persist();
    };
    const finish = (status: Exclude<ResponseStreamStatus, 'running'>) => {
      if (closed) return;
      if (restartable) {
        buffer = undefined;
        stream.tail = [];
      } else flush();
      closed = true;
      clearTimers();
      options.signal.removeEventListener('abort', onAbort);
      if (this.active.get(key) === stream) this.active.delete(key);
      const changed = this.store.db
        .prepare(
          `UPDATE response_stream_tasks SET status=?,updated_at=?
         WHERE task_kind=? AND task_id=? AND owner=? AND status='running'`
        )
        .run(
          options.signal.aborted ? (options.abortStatus?.() ?? 'cancelled') : status,
          new Date().toISOString(),
          options.taskKind,
          options.taskId,
          owner
        );
      if (changed.changes && (restartable || (status === 'completed' && !options.signal.aborted))) {
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
        clearTimers();
      }
    };
    options.signal.addEventListener('abort', onAbort, { once: true });
    this.publish(options);
    if (options.signal.aborted) onAbort();
    return {
      progress: (progress: ResponseProgress) => {
        if (fault) throw fault;
        if (closed || stream.revoked || options.signal.aborted) return;
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
        const progressKey = JSON.stringify([progress.attemptId, progress.segment]);
        const previous = offsets.get(progressKey);
        if (previous?.offset === progress.offset && previous.lastText === progress.text) return;
        if ((previous?.offset ?? 0) + progress.text.length !== progress.offset)
          throw new Error('RESPONSE_STREAM_OFFSET_MISMATCH');
        if (
          buffer &&
          (buffer.attemptId !== progress.attemptId || buffer.segment !== progress.segment)
        )
          flush();
        latestSegment = progress.segment;
        offsets.set(progressKey, { offset: progress.offset, lastText: progress.text });
        buffer = { ...progress, text: (buffer?.text ?? '') + progress.text };
        if (buffer.text.length >= DELIVERY_CHARS) deliver();
        else if (!deliveryTimer) {
          deliveryTimer = setTimeout(guarded(deliver), DELIVERY_INTERVAL_MS);
          deliveryTimer.unref();
        }
      },
      thought: (text: string | null) => {
        if (closed || stream.revoked || options.signal.aborted) return;
        if (text === null) {
          if (!stream.thought) return;
          stream.thought = '';
          if (thoughtTimer) clearTimeout(thoughtTimer);
          thoughtTimer = undefined;
          this.publish(options);
          return;
        }
        stream.thought = (stream.thought + text).slice(-THOUGHT_CHARS);
        if (thoughtTimer) return;
        thoughtTimer = setTimeout(() => {
          thoughtTimer = undefined;
          this.publish(options);
        }, DELIVERY_INTERVAL_MS);
        thoughtTimer.unref();
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
    const taskKind = RESPONSE_TASK_KINDS.find((kind) => kind === params.taskKind);
    if (!taskKind) throw new HttpError(404, 'Unknown response stream kind');
    return { taskKind, taskId: params.taskId };
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
