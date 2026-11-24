import type { ServerResponse } from 'node:http';
import {
  latestPromptWorkspaceUpdate,
  PROMPT_WORKSPACE_UPDATED,
} from './prompt-workspace-events.js';
import type { Store } from './store.js';

export const LIVE_PAGE_SIZE = 500;
export const LIVE_KEEPALIVE_MS = 15_000;
export const LIVE_FRAME_EVENTS = ['live', 'chats', 'helper', 'invalidate'] as const;
export type LiveFrameEvent = (typeof LIVE_FRAME_EVENTS)[number];

type Connection = {
  response: ServerResponse;
  authorized: () => boolean;
  blocked: boolean;
  missed: boolean;
};

const frame = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export function createLiveHub(
  store: Pick<Store, 'db'>,
  options: { instanceId: string; publishChat: (chatId: string) => void }
) {
  const { db } = store;
  const connections = new Set<Connection>();
  const chats = new Set<string>();
  let scheduled: ReturnType<typeof setImmediate> | undefined;
  let closed = false;

  const latestChatSequence = () =>
    Math.max(
      Number(
        (db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events').get() as { seq: number }).seq
      ),
      latestPromptWorkspaceUpdate(db)?.seq ?? 0
    );
  const latestHelperSequence = () =>
    Number(
      (db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM helper_events').get() as { seq: number })
        .seq
    );
  let chatsSeq = latestChatSequence();
  let helperSeq = latestHelperSequence();
  let invalidations = 0;
  const liveFrame = () =>
    frame('live', { chatsSeq, helperSeq, invalidations, instanceId: options.instanceId });

  const open = (connection: Connection) =>
    !connection.response.destroyed && !connection.response.writableEnded;
  const write = (connection: Connection, text: string) => {
    if (!open(connection)) return;
    if (!connection.authorized()) {
      connection.response.end();
      return;
    }
    if (connection.blocked || connection.response.writableNeedDrain) {
      connection.missed = true;
      return;
    }
    connection.blocked = !connection.response.write(text);
  };
  const broadcast = (text: string) => {
    for (const connection of connections) write(connection, text);
  };

  const chatPage = () => {
    const rows = db
      .prepare(
        'SELECT seq,chat_id AS chatId,kind,entity_id AS entityId FROM events WHERE seq>? ORDER BY seq LIMIT ?'
      )
      .all(chatsSeq, LIVE_PAGE_SIZE) as {
      seq: number;
      chatId: string | null;
      kind: string;
      entityId: string | null;
    }[];
    const workspace = latestPromptWorkspaceUpdate(db);
    const bound = rows.length === LIVE_PAGE_SIZE ? rows.at(-1)!.seq : Number.POSITIVE_INFINITY;
    if (workspace && workspace.seq > chatsSeq && workspace.seq <= bound) {
      const update = {
        seq: workspace.seq,
        chatId: null,
        kind: PROMPT_WORKSPACE_UPDATED,
        entityId: null,
      };
      const position = rows.findIndex((row) => row.seq > update.seq);
      rows.splice(position < 0 ? rows.length : position, 0, update);
    }
    if (rows.length) chatsSeq = rows.at(-1)!.seq;
    return {
      text: rows.map((row) => frame('chats', row)).join(''),
      full: bound !== Number.POSITIVE_INFINITY,
    };
  };
  const helperPage = () => {
    const rows = db
      .prepare(
        'SELECT seq,conversation_id AS conversationId,task_id AS taskId,kind FROM helper_events WHERE seq>? ORDER BY seq LIMIT ?'
      )
      .all(helperSeq, LIVE_PAGE_SIZE) as { seq: number }[];
    if (rows.length) helperSeq = rows.at(-1)!.seq;
    return {
      text: rows.map((row) => frame('helper', row)).join(''),
      full: rows.length === LIVE_PAGE_SIZE,
    };
  };
  const pump = () => {
    for (const page of [chatPage, helperPage])
      for (;;) {
        const { text, full } = page();
        if (text) broadcast(text);
        if (!full) break;
      }
  };
  const flush = () => {
    scheduled = undefined;
    if (closed) return;
    try {
      const changed = [...chats];
      chats.clear();
      for (const chatId of changed) options.publishChat(chatId);
      for (const connection of connections)
        if (open(connection) && !connection.authorized()) connection.response.end();
      pump();
    } catch {
      process.stderr.write('LIVE_EVENTS_FAILED\n');
    }
  };

  return {
    notify(chatId?: string | null) {
      if (closed) return;
      if (chatId) chats.add(chatId);
      scheduled ??= setImmediate(flush);
    },
    invalidate(name: string) {
      broadcast(frame('invalidate', { name, seq: ++invalidations }));
    },
    inject(event: LiveFrameEvent, data: Record<string, unknown>) {
      broadcast(frame(event, data));
    },
    connect(response: ServerResponse, authorized: () => boolean) {
      const connection: Connection = { response, authorized, blocked: false, missed: false };
      connections.add(connection);
      const drain = () => {
        connection.blocked = false;
        if (!connection.missed) return;
        connection.missed = false;
        write(connection, liveFrame());
      };
      const heartbeat = setInterval(() => {
        if (!authorized()) response.end();
        else write(connection, 'event: keepalive\ndata: 0\n\n');
      }, LIVE_KEEPALIVE_MS);
      heartbeat.unref();
      response.on('drain', drain);
      response.on('close', () => {
        clearInterval(heartbeat);
        response.off('drain', drain);
        connections.delete(connection);
      });
      write(connection, liveFrame());
    },
    closeAll() {
      closed = true;
      if (scheduled) clearImmediate(scheduled);
      scheduled = undefined;
      for (const { response } of connections) response.end();
    },
  };
}

export type LiveHub = ReturnType<typeof createLiveHub>;
