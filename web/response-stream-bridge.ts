import type { ResponseStreamPage, ResponseTaskKind } from '../core/response-stream.js';

export type PushedResponsePage = ResponseStreamPage & { after: number };
export type ResponseStreamReader = {
  cursor: () => number;
  receive: (page: PushedResponsePage) => void;
  disconnected: () => void;
};

const MAX_LISTED_STREAMS = 16;
const readers = new Map<string, Set<ResponseStreamReader>>();
let channel: { open: boolean; live: Set<string> } | undefined;

const keyOf = (taskKind: ResponseTaskKind, taskId: string) =>
  `${taskKind}:${encodeURIComponent(taskId)}`;

export function openResponseStreamChannel() {
  const own = { open: false, live: new Set<string>() };
  const drop = () => {
    const interrupted = channel === own && own.open;
    own.open = false;
    own.live.clear();
    if (interrupted)
      for (const group of readers.values()) for (const reader of group) reader.disconnected();
  };
  channel = own;
  return {
    connected() {
      if (channel === own) own.open = true;
    },
    disconnected: drop,
    deliver(data: string) {
      if (channel !== own) return;
      const page = JSON.parse(data) as PushedResponsePage;
      if (typeof page?.taskId !== 'string' || !Number.isSafeInteger(page.after)) return;
      own.open = true;
      const key = keyOf(page.taskKind, page.taskId);
      own.live.add(key);
      for (const reader of readers.get(key) ?? []) reader.receive(page);
    },
    close() {
      drop();
      if (channel === own) channel = undefined;
    },
  };
}

export function watchResponseStream(
  taskKind: ResponseTaskKind,
  taskId: string,
  reader: ResponseStreamReader
) {
  const key = keyOf(taskKind, taskId);
  const group = readers.get(key) ?? new Set<ResponseStreamReader>();
  readers.set(key, group);
  group.add(reader);
  return () => {
    group.delete(reader);
    if (!group.size && readers.get(key) === group) readers.delete(key);
  };
}

export function responseStreamIsPushed(taskKind: ResponseTaskKind, taskId: string) {
  return channel?.open === true && channel.live.has(keyOf(taskKind, taskId));
}

export function responseStreamCursors() {
  return [...readers]
    .slice(0, MAX_LISTED_STREAMS)
    .map(([key, group]) => `${key}:${Math.min(...[...group].map((reader) => reader.cursor()))}`)
    .join(',');
}
