import type { ServerResponse } from 'node:http';
import { Writable } from 'node:stream';
import { afterEach, expect, test } from 'vitest';
import type {
  ResponseChunk,
  ResponseStreamPage,
  ResponseStreamStatus,
  ResponseTaskIdentity,
  ResponseTaskKind,
} from '../core/response-stream.js';
import {
  chatEventResume,
  createChatEventStreams,
  MAX_LISTED_STREAMS,
} from '../server/chat-event-stream.js';
import { HttpError } from '../server/request-validation.js';

const owned: Writable[] = [];
afterEach(async () => {
  for (const raw of owned.splice(0)) raw.destroy();
  await tick();
});
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

type Task = {
  chatId: string | null;
  status: ResponseStreamStatus;
  chunks: ResponseChunk[];
  thought?: string;
};

function fixture(pageSize = 256) {
  const events: { seq: number; chatId: string; kind: string }[] = [];
  const tasks = new Map<string, Task>();
  const listeners = new Map<string | null, Set<(identity: ResponseTaskIdentity) => void>>();
  const reads: string[] = [];
  let seq = 0;
  const keyOf = (taskKind: string, taskId: string) => `${taskKind}:${taskId}`;
  const notify = (taskKind: ResponseTaskKind, taskId: string) => {
    const chatId = tasks.get(keyOf(taskKind, taskId))!.chatId;
    for (const listener of [...(listeners.get(chatId) ?? [])]) listener({ taskKind, taskId });
  };
  const hub = createChatEventStreams({
    events: (chatId, after) =>
      events.filter((event) => event.chatId === chatId && event.seq > after),
    latestEventSequence: (chatId) => events.findLast((event) => event.chatId === chatId)?.seq ?? 0,
    streams: {
      read(taskKind, taskId, after = 0): ResponseStreamPage {
        const task = tasks.get(keyOf(taskKind, taskId));
        if (!task) throw new HttpError(404, 'Response stream not found');
        reads.push(`${keyOf(taskKind, taskId)}:${after}`);
        const rest = task.chunks.filter((chunk) => chunk.seq > after);
        const chunks = rest.slice(0, pageSize);
        return {
          taskKind,
          taskId,
          status: task.status,
          chunks,
          cursor: chunks.at(-1)?.seq ?? after,
          hasMore: rest.length > pageSize,
          ...(task.thought ? { thought: task.thought } : {}),
        };
      },
      runningTasks: (chatId) =>
        [...tasks]
          .filter(([, task]) => task.chatId === chatId && task.status === 'running')
          .map(([key]) => {
            const [taskKind, taskId] = key.split(':');
            return { taskKind: taskKind as ResponseTaskKind, taskId };
          }),
      subscribeChat(chatId, listener) {
        const group = listeners.get(chatId) ?? new Set();
        listeners.set(chatId, group);
        group.add(listener);
        return () => group.delete(listener);
      },
    },
  });
  return {
    hub,
    reads,
    listeners,
    event(chatId: string, kind: string) {
      events.push({ seq: events.length + 1, chatId, kind });
      hub.publish(chatId);
    },
    start(taskKind: ResponseTaskKind, taskId: string, chatId: string | null) {
      tasks.set(keyOf(taskKind, taskId), { chatId, status: 'running', chunks: [] });
      notify(taskKind, taskId);
    },
    append(taskKind: ResponseTaskKind, taskId: string, text: string, announce = true) {
      const task = tasks.get(keyOf(taskKind, taskId))!;
      const offset = (task.chunks.at(-1)?.offset ?? 0) + text.length;
      task.chunks.push({ seq: ++seq, attemptId: 'attempt', segment: 0, offset, text });
      if (announce) notify(taskKind, taskId);
    },
    think(taskKind: ResponseTaskKind, taskId: string, thought?: string) {
      tasks.get(keyOf(taskKind, taskId))!.thought = thought;
      notify(taskKind, taskId);
    },
    finish(taskKind: ResponseTaskKind, taskId: string, status: ResponseStreamStatus) {
      const task = tasks.get(keyOf(taskKind, taskId))!;
      task.status = status;
      if (status === 'completed') task.chunks = [];
      notify(taskKind, taskId);
    },
  };
}

type Frame = { event: string; id?: string; data: Record<string, unknown> };

function client(options: { stalled?: boolean; highWaterMark?: number } = {}) {
  const written: string[] = [];
  const queued: (() => void)[] = [];
  const raw = new Writable({
    highWaterMark: options.highWaterMark ?? 1 << 20,
    write(chunk, _encoding, callback) {
      written.push(String(chunk));
      if (options.stalled) queued.push(callback);
      else callback();
    },
  });
  owned.push(raw);
  const frames = (): Frame[] =>
    written
      .filter((text) => !text.startsWith(':'))
      .map((text) => {
        const lines = text.trimEnd().split('\n');
        const field = (name: string) =>
          lines.find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2);
        return {
          event: field('event') ?? 'message',
          id: field('id'),
          data: JSON.parse(field('data')!),
        };
      });
  return {
    raw,
    response: raw as unknown as ServerResponse,
    written,
    queued,
    frames,
    streamed: (taskId: string) =>
      frames()
        .filter((frame) => frame.event === 'stream' && frame.data.taskId === taskId)
        .map((frame) => frame.data as unknown as ResponseStreamPage & { after: number }),
  };
}

const text = (pages: ResponseStreamPage[]) =>
  pages.flatMap((page) => page.chunks.map((chunk) => chunk.text)).join('');

test('chat events keep their frames while response pages ride the same connection as stream events', async () => {
  const story = fixture();
  story.event('chat', 'run.queued');
  const reader = client();
  story.hub.connect('chat', chatEventResume(undefined, undefined), reader.response, () => true);
  story.start('main', 'run-1', 'chat');
  story.append('main', 'run-1', '미라는 ');
  story.event('chat', 'run.progress');
  story.append('main', 'run-1', '등대에 올랐다.');
  story.finish('main', 'run-1', 'partial');
  await tick();

  const frames = reader.frames();
  expect(frames[0]).toEqual({
    event: 'message',
    id: '1',
    data: { kind: 'snapshot', chatId: 'chat', seq: 1 },
  });
  expect(frames.filter((frame) => frame.event === 'message').map((frame) => frame.data)).toEqual([
    { kind: 'snapshot', chatId: 'chat', seq: 1 },
    { seq: 2, chatId: 'chat', kind: 'run.progress' },
  ]);
  const pages = reader.streamed('run-1');
  expect(text(pages)).toBe('미라는 등대에 올랐다.');
  expect(pages.map((page) => [page.after, page.cursor, page.status])).toEqual([
    [0, 0, 'running'],
    [0, 1, 'running'],
    [1, 2, 'running'],
    [2, 2, 'partial'],
  ]);
  expect(frames.map((frame) => frame.id)).toEqual([
    '1',
    '1;main:run-1:0',
    '1;main:run-1:1',
    '2;main:run-1:1',
    '2;main:run-1:2',
    '2',
  ]);
});

test('library helper text rides every connection, with or without a chat, and another chat stays out', async () => {
  const story = fixture();
  story.start('helper', 'library-task', null);
  story.append('helper', 'library-task', '서재 ');
  const library = client();
  story.hub.connect(null, chatEventResume(undefined, undefined), library.response, () => true);
  const reader = client();
  story.hub.connect('chat', chatEventResume(undefined, undefined), reader.response, () => true);
  story.start('main', 'other-run', 'other');
  story.append('main', 'other-run', '다른 채팅');
  story.append('helper', 'library-task', '도우미');
  story.event('chat', 'run.queued');
  await tick();

  for (const connection of [library, reader])
    expect(text(connection.streamed('library-task'))).toBe('서재 도우미');
  expect(library.streamed('other-run')).toEqual([]);
  expect(reader.streamed('other-run')).toEqual([]);
  expect(library.frames().filter((frame) => frame.event === 'message')).toEqual([]);
  expect(library.frames().map((frame) => frame.id)).toEqual([
    '0;helper:library-task:1',
    '0;helper:library-task:3',
  ]);
  expect(reader.frames().filter((frame) => frame.event === 'message')).toHaveLength(2);
  library.raw.destroy();
  reader.raw.destroy();
  await tick();
  expect(story.listeners.get(null)?.size).toBe(0);
});

test('a thought summary that changes without new text is pushed, and an unchanged page is not', async () => {
  const story = fixture();
  const reader = client();
  story.hub.connect('chat', chatEventResume(undefined, undefined), reader.response, () => true);
  story.start('helper', 'task-1', 'chat');
  story.think('helper', 'task-1', '자료를 확인하는 중');
  story.think('helper', 'task-1', '자료를 확인하는 중');
  story.think('helper', 'task-1');
  await tick();
  expect(reader.streamed('task-1').map((page) => page.thought)).toEqual([
    undefined,
    '자료를 확인하는 중',
    undefined,
  ]);
});

test('a reconnect resumes chat events and each response stream from its own cursor without loss or repeats', async () => {
  const story = fixture();
  story.event('chat', 'run.queued');
  story.start('main', 'run/1', 'chat');
  story.start('helper', 'help', 'chat');
  story.start('main', 'elsewhere', 'other-chat');
  story.start('main', 'failed', 'chat');
  for (const part of ['a', 'b', 'c']) {
    story.append('main', 'run/1', part);
    story.append('helper', 'help', part.toUpperCase());
    story.append('main', 'elsewhere', part);
    story.append('main', 'failed', part);
  }
  story.finish('main', 'failed', 'failed');
  const first = client();
  story.hub.connect('chat', chatEventResume(undefined, undefined), first.response, () => true);
  await tick();
  expect(text(first.streamed('run/1'))).toBe('abc');
  expect(text(first.streamed('help'))).toBe('ABC');
  expect(first.streamed('elsewhere')).toEqual([]);
  expect(first.streamed('failed')).toEqual([]);
  const lastId = first.frames().at(-1)!.id!;
  expect(lastId).toBe('1;main:run%2F1:9,helper:help:10');
  first.raw.destroy();
  await tick();

  story.event('chat', 'job.updated');
  story.append('main', 'run/1', 'd');
  story.append('helper', 'help', 'D');
  story.start('main', 'late', 'chat');
  story.append('main', 'late', 'z');
  const second = client();
  story.hub.connect(
    'chat',
    chatEventResume(lastId, 'main:run%2F1:1,main:elsewhere:1,main:failed:4,main:missing:9'),
    second.response,
    () => true
  );
  await tick();
  expect(second.frames()[0].data).toEqual({ kind: 'snapshot', chatId: 'chat', seq: 1 });
  expect(
    second
      .frames()
      .filter((frame) => frame.event === 'message')
      .map((frame) => frame.data.kind)
  ).toEqual(['snapshot', 'job.updated']);
  expect(second.streamed('run/1').map((page) => [page.after, text([page])])).toEqual([[9, 'd']]);
  expect(second.streamed('help').map((page) => [page.after, text([page])])).toEqual([[10, 'D']]);
  expect(second.streamed('late').map((page) => [page.after, text([page])])).toEqual([[0, 'z']]);
  expect(second.streamed('failed').map((page) => [page.after, page.status, text([page])])).toEqual([
    [4, 'failed', 'bc'],
  ]);
  expect(second.streamed('elsewhere')).toEqual([]);
  expect(second.streamed('missing')).toEqual([]);
});

test('resume cursors are validated before the stream opens', () => {
  expect(chatEventResume(undefined, undefined)).toEqual({ streams: [] });
  expect(chatEventResume('7', undefined)).toEqual({ cursor: 7, streams: [] });
  expect(chatEventResume('7;main:a:3', 'main:a:5,translation:job%3A1:2')).toEqual({
    cursor: 7,
    streams: [
      { taskKind: 'main', taskId: 'a', after: 5 },
      { taskKind: 'translation', taskId: 'job:1', after: 2 },
    ],
  });
  for (const [lastEventId, streamAfter] of [
    ['-1', undefined],
    ['abc', undefined],
    ['1;main:a', undefined],
    [undefined, 'other:a:1'],
    [undefined, 'main:a:-1'],
    [undefined, 'main:%E0:1'],
    [undefined, ['main:a:1', 'main:b:1']],
    [undefined, Array.from({ length: MAX_LISTED_STREAMS + 1 }, (_, n) => `main:${n}:0`).join(',')],
  ] as const)
    expect(() => chatEventResume(lastEventId, streamAfter)).toThrow(HttpError);
});

test('a stalled client pauses page reads, keeps server buffers bounded and resumes after what it accepted', async () => {
  const story = fixture(2);
  story.start('main', 'run', 'chat');
  for (let index = 0; index < 40; index++)
    story.append('main', 'run', String(index % 10).repeat(1024), false);
  const slow = client({ stalled: true, highWaterMark: 512 });
  const fast = client();
  story.hub.connect('chat', chatEventResume(undefined, undefined), slow.response, () => true);
  expect(story.reads).toEqual(['main:run:0']);
  story.hub.connect('chat', chatEventResume(undefined, undefined), fast.response, () => true);
  await tick();
  expect(fast.streamed('run').flatMap((page) => page.chunks)).toHaveLength(40);

  const reads = story.reads.length;
  const buffered = slow.raw.writableLength;
  story.append('main', 'run', 'tail');
  story.event('chat', 'run.progress');
  expect(story.reads).toHaveLength(reads + 1);
  expect(story.reads.at(-1)).toBe('main:run:40');
  expect(slow.written).toHaveLength(1);
  expect(slow.raw.writableLength).toBe(buffered);
  expect(buffered).toBeLessThan(8192);

  let released = 0;
  while (slow.queued.length && released++ < 100) {
    slow.queued.shift()!();
    await tick();
    expect(slow.raw.writableLength).toBeLessThan(8192);
  }
  const pages = slow.streamed('run');
  expect(pages.every((page) => page.chunks.length <= 2)).toBe(true);
  const sequences = pages.flatMap((page) => page.chunks.map((chunk) => chunk.seq));
  expect(sequences).toEqual(Array.from({ length: 41 }, (_, index) => index + 1));
  expect(pages.every((page, index) => index === 0 || page.after === pages[index - 1].cursor)).toBe(
    true
  );
  expect(
    slow
      .frames()
      .filter((frame) => frame.event === 'message')
      .map((frame) => frame.data.kind)
  ).toEqual(['snapshot', 'run.progress']);
});

test('a revoked session closes the stream on the next send and a closed stream releases its subscription', async () => {
  const story = fixture();
  story.start('main', 'run', 'chat');
  let authorized = true;
  const reader = client();
  story.hub.connect(
    'chat',
    chatEventResume(undefined, undefined),
    reader.response,
    () => authorized
  );
  story.append('main', 'run', 'visible');
  await tick();
  const before = reader.written.length;
  authorized = false;
  story.append('main', 'run', 'secret');
  await tick();
  expect(reader.written).toHaveLength(before);
  expect(reader.raw.writableEnded).toBe(true);
  expect(text(reader.streamed('run'))).toBe('visible');
  reader.raw.destroy();
  await tick();
  expect(story.listeners.get('chat')?.size).toBe(0);
  expect(reader.raw.listenerCount('drain')).toBe(0);

  const deleted = client();
  story.hub.connect('chat', chatEventResume(undefined, undefined), deleted.response, () => true);
  story.hub.closeChat('chat', { kind: 'chat.deleted', chatId: 'chat' });
  await tick();
  expect(deleted.written.at(-1)).toBe('data: {"kind":"chat.deleted","chatId":"chat"}\n\n');
  expect(deleted.raw.writableEnded).toBe(true);
});
