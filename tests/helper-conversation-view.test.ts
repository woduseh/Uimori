import { expect, test } from 'vitest';
import type { HelperConversation, HelperEvent, HelperMessage } from '../core/helper.js';
import { mergeHelperView, replayMessageEvents } from '../web/useHelperConversation.js';

const conversation = (historyRevision: number) =>
  ({ id: 'c', revision: 1, historyRevision }) as HelperConversation;
const message = (n: number, extra: Partial<HelperMessage> = {}): HelperMessage => ({
  id: `m${n}`,
  conversationId: 'c',
  taskId: `t${n}`,
  role: 'user',
  text: `text ${n}`,
  artifacts: [],
  createdAt: '',
  ...extra,
});
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, index) => from + index);
const changed = (seq: number, data: object): HelperEvent => ({
  seq,
  conversationId: 'c',
  taskId: null,
  kind: 'messages.changed',
  data: { revision: 2, ...data },
});
const view = (messages: HelperMessage[], historyRevision: number, hasOlderMessages: boolean) => ({
  conversation: conversation(historyRevision),
  messages,
  tasks: [],
  hasOlderMessages,
  hasOlderTasks: false,
});

test('a refresh keeps known messages older than the latest 100 and applies replayed edits and deletions to them', () => {
  const known = view(
    range(1, 110).map((n) => message(n)),
    5,
    false
  );
  const events: HelperEvent[] = [
    changed(5, { updatedMessage: { id: 'm1', text: 'already applied' } }),
    changed(6, { deletedMessageIds: ['m3'] }),
    { seq: 7, conversationId: 'c', taskId: 't5', kind: 'task.updated', data: {} },
    changed(8, { updatedMessage: { id: 'm5', text: 'edited' } }),
    changed(9, { deletedMessageIds: ['m105'] }),
    changed(10, { deletedMessageIds: ['m6'] }),
  ];
  const replayed = replayMessageEvents(known, events, 9);
  const server = range(1, 111)
    .filter((n) => n !== 3 && n !== 105)
    .map((n) => message(n, n === 5 ? { text: 'edited' } : {}));
  const merged = mergeHelperView(replayed, {
    messages: server.slice(-100),
    tasks: [],
    conversation: conversation(9),
  });
  expect(merged.messages).toEqual(server);
  expect(merged.conversation.historyRevision).toBe(9);
  expect(merged.hasOlderMessages).toBe(false);
});

test('a refresh drops a superseded request-group answer but keeps older answers of groups outside the latest page', () => {
  const known = view(
    [
      message(1, { requestGroupId: 'g1', taskId: 'a', latestTaskId: 'a' }),
      message(2, { requestGroupId: 'g2', taskId: 'b', latestTaskId: 'b' }),
    ],
    1,
    false
  );
  const merged = mergeHelperView(known, {
    messages: [message(3, { requestGroupId: 'g2', taskId: 'c', latestTaskId: 'c' })],
    tasks: [],
    conversation: conversation(1),
  });
  expect(merged.messages.map((item) => item.id)).toEqual(['m1', 'm3']);
});

test('hasOlderMessages stays true only while the latest page is full and older history may remain unloaded', () => {
  const page = (count: number) => ({
    messages: range(1, count).map((n) => message(n)),
    tasks: [],
    conversation: conversation(1),
  });
  const known = (hasOlderMessages: boolean) => view([], 1, hasOlderMessages);
  expect(mergeHelperView(undefined, page(100)).hasOlderMessages).toBe(true);
  expect(mergeHelperView(undefined, page(99)).hasOlderMessages).toBe(false);
  expect(mergeHelperView(known(true), page(100)).hasOlderMessages).toBe(true);
  expect(mergeHelperView(known(false), page(100)).hasOlderMessages).toBe(false);
  expect(mergeHelperView(known(true), page(99)).hasOlderMessages).toBe(false);
});

test('a refresh keeps a newer local conversation revision', () => {
  const known = view([message(1)], 1, false);
  known.conversation = { ...known.conversation, revision: 5 };
  const merged = mergeHelperView(known, {
    messages: [message(1)],
    tasks: [],
    conversation: conversation(1),
  });
  expect(merged.conversation.revision).toBe(5);
  expect(merged.conversation.historyRevision).toBe(1);
});
