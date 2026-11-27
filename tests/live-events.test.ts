import type { ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, expect, test } from 'vitest';
import { acknowledgeActivities } from '../server/activity-feed.js';
import { chatEventResume, createChatEventStreams } from '../server/chat-event-stream.js';
import { deleteChat } from '../server/chat-deletion.js';
import { markHelperConversationRead } from '../server/helper-read-state.js';
import { HelperWorkspace } from '../server/helper-workspace.js';
import { createLiveHub } from '../server/live-events.js';
import { Store } from '../server/store.js';
import { ResponseStreamStore } from '../server/response-stream.js';
import { createFixtureChat } from './fixtures/chat.js';

const owned: { directory: string; store: Store; raws: Writable[] }[] = [];
afterEach(async () => {
  for (const item of owned.splice(0)) {
    for (const raw of item.raws) raw.destroy();
    await tick();
    item.store.close();
    const target = resolve(item.directory),
      inside = relative(resolve(tmpdir()), target);
    if (
      isAbsolute(inside) ||
      inside.startsWith('..') ||
      !basename(target).startsWith('Uimori live ')
    )
      throw new Error('Unexpected cleanup path');
    await rm(target, { recursive: true, force: true });
  }
});
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

type Frame = { event: string; id?: string; data: Record<string, unknown> };

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'Uimori live '));
  const store = new Store(join(directory, 'story.sqlite'));
  const item = { directory, store, raws: [] as Writable[] };
  owned.push(item);
  const chat = createFixtureChat(store, 'Live hub fixture');
  const workspace = new HelperWorkspace(store);
  const conversation = workspace.open({ kind: 'chat', chatId: chat.id });
  const chatEvents = createChatEventStreams({
    events: (chatId, after) => store.events(chatId, after),
    latestEventSequence: (chatId) => store.latestEventSequence(chatId),
    streams: new ResponseStreamStore(store),
  });
  const published: string[] = [];
  const hub = createLiveHub(store, {
    instanceId: 'instance-1',
    publishChat: (chatId) => {
      published.push(chatId);
      chatEvents.publish(chatId);
    },
  });
  store.observeChanges((chatId) => hub.notify(chatId));
  store.observeInvalidations((name) => hub.invalidate(name));
  const client = (options: { stalled?: boolean; highWaterMark?: number } = {}) => {
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
    item.raws.push(raw);
    const frames = (): Frame[] =>
      written
        .join('')
        .split('\n\n')
        .filter((text) => text && !text.startsWith(':'))
        .map((text) => {
          const lines = text.split('\n');
          const field = (name: string) =>
            lines.find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2);
          return {
            event: field('event') ?? 'message',
            id: field('id'),
            data: JSON.parse(field('data')!),
          };
        });
    return { raw, response: raw as unknown as ServerResponse, written, queued, frames };
  };
  return { store, chat, workspace, conversation, chatEvents, hub, published, client };
}

test('global frames carry no id, so the chat cursor on the same connection stays the only Last-Event-ID', async () => {
  const live = await fixture();
  const reader = live.client();
  live.hub.connect(reader.response, () => true);
  live.chatEvents.connect(
    live.chat.id,
    chatEventResume(undefined, undefined),
    reader.response,
    () => true,
    {
      keepalive: false,
    }
  );
  live.store.event(live.chat.id, 'run.progress', 'run-1');
  live.workspace.event(live.conversation.id, null, 'artifact.saved');
  await tick();

  const frames = reader.frames();
  expect(frames[0]).toMatchObject({
    event: 'live',
    id: undefined,
    data: { instanceId: 'instance-1' },
  });
  const global = frames.filter((frame) => frame.event !== 'message');
  expect(global.map((frame) => frame.event)).toEqual(['live', 'chats', 'chats', 'helper']);
  expect(global.every((frame) => frame.id === undefined)).toBe(true);
  expect(global.slice(1).map((frame) => frame.data.kind)).toEqual([
    'run.progress',
    'helper.artifact.saved',
    'artifact.saved',
  ]);
  expect(global[3].data).toMatchObject({ conversationId: live.conversation.id, taskId: null });
  const chat = frames.filter((frame) => frame.event === 'message');
  expect(chat.map((frame) => frame.data.kind)).toEqual([
    'snapshot',
    'run.progress',
    'helper.artifact.saved',
  ]);
  expect(chat.map((frame) => frame.id)).toEqual(chat.map((frame) => String(frame.data.seq)));
});

test('a rolled-back write produces no frame, and same-tick writes reach each client in one pump', async () => {
  const live = await fixture();
  const reader = live.client();
  live.hub.connect(reader.response, () => true);
  expect(() =>
    live.store.transaction(() => {
      live.store.event(live.chat.id, 'run.progress', 'discarded');
      throw new Error('rollback');
    })
  ).toThrow('rollback');
  await tick();
  expect(reader.frames().map((frame) => frame.event)).toEqual(['live']);
  expect(live.published).toEqual([live.chat.id]);

  const before = reader.written.length;
  live.published.length = 0;
  for (const kind of ['run.queued', 'run.running', 'run.completed'])
    live.store.event(live.chat.id, kind, 'run-1');
  await tick();
  expect(reader.written).toHaveLength(before + 1);
  expect(live.published).toEqual([live.chat.id]);
  expect(
    reader
      .frames()
      .slice(1)
      .map((frame) => frame.data.kind)
  ).toEqual(['run.queued', 'run.running', 'run.completed']);
});

test('a revoked session ends the connection on the next pump without sending what changed', async () => {
  const live = await fixture();
  let authorized = true;
  const reader = live.client();
  live.hub.connect(reader.response, () => authorized);
  authorized = false;
  live.hub.notify();
  await tick();
  expect(reader.raw.writableEnded).toBe(true);
  live.store.event(live.chat.id, 'run.progress', 'secret');
  await tick();
  expect(reader.frames().map((frame) => frame.event)).toEqual(['live']);
  reader.raw.destroy();
  await tick();
  expect(reader.raw.listenerCount('drain')).toBe(0);
});

test('a blocked client skips frames while full and gets a fresh live frame after drain', async () => {
  const live = await fixture();
  const slow = live.client({ stalled: true, highWaterMark: 16 });
  const fast = live.client();
  live.hub.connect(slow.response, () => true);
  live.hub.connect(fast.response, () => true);
  live.store.event(live.chat.id, 'run.progress', 'missed');
  live.hub.invalidate('helper-list');
  await tick();
  expect(fast.frames().map((frame) => frame.event)).toEqual(['live', 'invalidate', 'chats']);
  expect(slow.written).toHaveLength(1);

  while (slow.queued.length) {
    slow.queued.shift()!();
    await tick();
  }
  const frames = slow.frames();
  expect(frames.map((frame) => frame.event)).toEqual(['live', 'live']);
  expect(frames[1].data.chatsSeq).toBe(fast.frames()[2].data.seq);
});

test('helper list changes that write no helper event send one helper-list invalidation each, and replays send none', async () => {
  const live = await fixture();
  const reader = live.client();
  live.hub.connect(reader.response, () => true);
  const invalidations = () =>
    reader
      .frames()
      .filter((frame) => frame.event === 'invalidate' && frame.data.name === 'helper-list').length;
  const library = { kind: 'library' as const, workId: 'workspace' };

  live.workspace.open({ kind: 'chat', chatId: live.chat.id });
  const created = live.workspace.create(library, 'request:first');
  live.workspace.create(library, 'request:first');
  expect(invalidations()).toBe(1);

  const group = live.workspace.createGroup('Drafts', 'group:first');
  live.workspace.createGroup('Drafts', 'group:first');
  const renamed = live.workspace.renameGroup(group.id, group.revision, 'Renamed');
  expect(() => live.workspace.renameGroup(group.id, group.revision, 'Stale')).toThrow();
  live.workspace.deleteGroup(group.id, renamed.revision);
  expect(invalidations()).toBe(4);

  const copy = live.workspace.copy(
    created.id,
    'copy:first',
    live.workspace.deletionImpact(created.id).request
  );
  live.workspace.delete(copy.id, live.workspace.deletionImpact(copy.id).request);
  expect(invalidations()).toBe(6);

  live.workspace.event(created.id, null, 'task.completed');
  const sequence = live.workspace.latestEventSequence(created.id);
  markHelperConversationRead(live.store, created.id, sequence);
  markHelperConversationRead(live.store, created.id, sequence);
  expect(invalidations()).toBe(7);
});

test('activity acknowledgements and chat deletion invalidate once per real change, and the live frame counts invalidations', async () => {
  const live = await fixture();
  const reader = live.client();
  live.hub.connect(reader.response, () => true);
  const invalidations = () =>
    reader
      .frames()
      .filter((frame) => frame.event === 'invalidate')
      .map((frame) => [frame.data.name, frame.data.seq]);
  const key = JSON.stringify(['main', 'run-1', 0, '2026-01-01T00:00:00.000Z']);

  acknowledgeActivities(live.store, live.chat.id, [key]);
  acknowledgeActivities(live.store, live.chat.id, [key]);
  expect(invalidations()).toEqual([['activity', 1]]);

  deleteChat(live.store, live.chat.id);
  expect(invalidations()).toEqual([
    ['activity', 1],
    ['activity', 2],
    ['helper-list', 3],
  ]);
  const late = live.client();
  live.hub.connect(late.response, () => true);
  expect(late.frames()[0].data).toMatchObject({ invalidations: 3 });
});
