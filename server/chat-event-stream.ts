import type { ServerResponse } from 'node:http';
import {
  RESPONSE_TASK_KINDS,
  type ResponseStreamPage,
  type ResponseStreamStatus,
  type ResponseTaskIdentity,
  type ResponseTaskKind,
} from '../core/response-stream.js';
import { HttpError } from './request-validation.js';

type TaskCursor = ResponseTaskIdentity & {
  after: number;
  status?: ResponseStreamStatus;
  thought?: string;
};

export type ChatEventResume = { cursor?: number; streams: TaskCursor[] };
export type ChatEventStreamPage = ResponseStreamPage & { after: number };
export type ChatEventSources = {
  events(chatId: string, after: number): { seq: number }[];
  latestEventSequence(chatId: string): number;
  streams: {
    read(taskKind: ResponseTaskKind, taskId: string, after?: number): ResponseStreamPage;
    runningTasks(chatId: string | null): ResponseTaskIdentity[];
    subscribeChat(
      chatId: string | null,
      listener: (identity: ResponseTaskIdentity) => void
    ): () => void;
  };
};

type Connection = {
  chatId: string | null;
  response: ServerResponse;
  authorized: () => boolean;
  cursor: number;
  tasks: Map<string, TaskCursor>;
  dirty: Set<string>;
  blocked: boolean;
};

export const MAX_LISTED_STREAMS = 16;
const KEEPALIVE_MS = 15_000;
const taskKinds: ReadonlySet<string> = new Set(RESPONSE_TASK_KINDS);
const keyOf = (identity: ResponseTaskIdentity) => `${identity.taskKind}:${identity.taskId}`;

export function formatStreamCursors(tasks: Iterable<TaskCursor>) {
  return [...tasks]
    .map((task) => `${task.taskKind}:${encodeURIComponent(task.taskId)}:${task.after}`)
    .join(',');
}

function parseStreamCursors(value: string, into: Map<string, TaskCursor>) {
  if (!value) return;
  const entries = value.split(',');
  if (entries.length > MAX_LISTED_STREAMS) throw new HttpError(400, 'Invalid stream cursor');
  for (const entry of entries) {
    const match = /^([a-z]+):([^:,;]+):(\d+)$/u.exec(entry);
    const after = Number(match?.[3]);
    if (!match || !taskKinds.has(match[1]) || !Number.isSafeInteger(after))
      throw new HttpError(400, 'Invalid stream cursor');
    let taskId: string;
    try {
      taskId = decodeURIComponent(match[2]);
    } catch {
      throw new HttpError(400, 'Invalid stream cursor');
    }
    const task = { taskKind: match[1] as ResponseTaskKind, taskId, after };
    const known = into.get(keyOf(task));
    if (!known || known.after < after) into.set(keyOf(task), task);
  }
}

export function chatEventResume(lastEventId: unknown, streamAfter: unknown): ChatEventResume {
  const streams = new Map<string, TaskCursor>();
  if (streamAfter !== undefined) {
    if (typeof streamAfter !== 'string') throw new HttpError(400, 'Invalid stream cursor');
    parseStreamCursors(streamAfter, streams);
  }
  if (lastEventId === undefined) return { streams: [...streams.values()] };
  if (typeof lastEventId !== 'string') throw new HttpError(400, 'Invalid event cursor');
  const separator = lastEventId.indexOf(';');
  const rawCursor = separator === -1 ? lastEventId : lastEventId.slice(0, separator);
  const cursor = Number(rawCursor);
  if (!/^\d+$/u.test(rawCursor) || !Number.isSafeInteger(cursor))
    throw new HttpError(400, 'Invalid event cursor');
  if (separator !== -1) parseStreamCursors(lastEventId.slice(separator + 1), streams);
  return { cursor, streams: [...streams.values()] };
}

export function createChatEventStreams(sources: ChatEventSources) {
  const connections = new Map<string | null, Set<Connection>>();

  const eventId = (connection: Connection) => {
    const streams = formatStreamCursors(connection.tasks.values());
    return streams ? `${connection.cursor};${streams}` : String(connection.cursor);
  };
  const send = (connection: Connection, data: string, event?: string) => {
    connection.blocked = !connection.response.write(
      `${event ? `event: ${event}\n` : ''}id: ${eventId(connection)}\ndata: ${data}\n\n`
    );
    return !connection.blocked;
  };
  const readPage = (task: TaskCursor) => {
    try {
      return sources.streams.read(task.taskKind, task.taskId, task.after);
    } catch (error) {
      if (error instanceof HttpError && error.statusCode === 404) return undefined;
      throw error;
    }
  };
  const pump = (connection: Connection) => {
    const { response } = connection;
    if (
      connection.blocked ||
      response.writableNeedDrain ||
      response.destroyed ||
      response.writableEnded
    )
      return;
    if (!connection.authorized()) {
      response.end();
      return;
    }
    if (connection.chatId !== null)
      for (const event of sources.events(connection.chatId, connection.cursor)) {
        connection.cursor = event.seq;
        if (!send(connection, JSON.stringify(event))) return;
      }
    for (const key of connection.dirty) {
      const task = connection.tasks.get(key);
      for (;;) {
        const page = task && readPage(task);
        if (!task || !page) {
          connection.dirty.delete(key);
          connection.tasks.delete(key);
          break;
        }
        const frame: ChatEventStreamPage = { ...page, after: task.after };
        const changed =
          page.chunks.length > 0 || page.status !== task.status || page.thought !== task.thought;
        task.after = page.cursor;
        task.status = page.status;
        task.thought = page.thought;
        if (!page.hasMore) {
          connection.dirty.delete(key);
          if (page.status !== 'running') connection.tasks.delete(key);
        }
        if (changed && !send(connection, JSON.stringify(frame), 'stream')) return;
        if (!page.hasMore) break;
      }
    }
  };

  return {
    publish(chatId: string) {
      for (const connection of connections.get(chatId) ?? []) pump(connection);
    },
    publishAll() {
      for (const listeners of connections.values())
        for (const connection of listeners) pump(connection);
    },
    closeChat(chatId: string, data: object) {
      for (const { response, authorized } of connections.get(chatId) ?? []) {
        if (authorized()) response.write(`data: ${JSON.stringify(data)}\n\n`);
        response.end();
      }
      connections.delete(chatId);
    },
    closeAll() {
      for (const listeners of connections.values())
        for (const { response } of listeners) response.end();
    },
    connect(
      chatId: string | null,
      resume: ChatEventResume,
      response: ServerResponse,
      authorized: () => boolean,
      options: { keepalive?: boolean } = {}
    ) {
      const connection: Connection = {
        chatId,
        response,
        authorized,
        cursor: chatId === null ? 0 : (resume.cursor ?? sources.latestEventSequence(chatId)),
        tasks: new Map(),
        dirty: new Set(),
        blocked: false,
      };
      const listeners = connections.get(chatId) ?? new Set<Connection>();
      connections.set(chatId, listeners);
      listeners.add(connection);
      const track = (task: TaskCursor) => {
        const key = keyOf(task);
        if (!connection.tasks.has(key)) connection.tasks.set(key, task);
        connection.dirty.add(key);
      };
      const scopes = chatId === null ? [null] : [chatId, null];
      const unsubscribes = scopes.map((scope) =>
        sources.streams.subscribeChat(scope, ({ taskKind, taskId }) => {
          track({ taskKind, taskId, after: 0 });
          pump(connection);
        })
      );
      const running = scopes.flatMap((scope) => sources.streams.runningTasks(scope));
      const runningKeys = new Set(running.map(keyOf));
      for (const { taskKind, taskId, after } of resume.streams) {
        const listed = { taskKind, taskId, after };
        if (runningKeys.has(keyOf(listed)) || (readPage(listed)?.status ?? 'running') !== 'running')
          track(listed);
      }
      for (const { taskKind, taskId } of running) track({ taskKind, taskId, after: 0 });
      const drain = () => {
        connection.blocked = false;
        pump(connection);
      };
      const heartbeat =
        options.keepalive === false
          ? undefined
          : setInterval(() => {
              if (!authorized()) response.end();
              else if (!connection.blocked && !response.destroyed && !response.writableEnded)
                connection.blocked = !response.write(': keepalive\n\n');
            }, KEEPALIVE_MS);
      heartbeat?.unref();
      response.on('drain', drain);
      response.on('close', () => {
        clearInterval(heartbeat);
        for (const unsubscribe of unsubscribes) unsubscribe();
        response.off('drain', drain);
        listeners.delete(connection);
        if (!listeners.size && connections.get(chatId) === listeners) connections.delete(chatId);
      });
      if (
        chatId === null ||
        send(connection, JSON.stringify({ kind: 'snapshot', chatId, seq: connection.cursor }))
      )
        pump(connection);
    },
  };
}
