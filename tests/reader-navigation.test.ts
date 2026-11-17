import { expect, test } from 'vitest';
import {
  transitionReaderNavigation as move,
  type ReaderNavigation,
} from '../web/reader-navigation.js';

const original: ReaderNavigation = Object.freeze({
  chat: 'A',
  source: 'source-A',
  destination: 'story',
  epoch: 4,
});

test('changing chats releases the previous source and returning cannot revive its intent', () => {
  const next = move(original, { kind: 'chat', chat: 'B' });
  expect(next).toEqual({
    chat: 'B',
    source: '',
    destination: 'story',
    epoch: 5,
  });
  expect(move(next, { kind: 'chat', chat: 'A' })).toEqual({
    chat: 'A',
    source: '',
    destination: 'story',
    epoch: 6,
  });
});

test('visiting the library retains the newly selected source and advances intent', () => {
  const chat = move(original, { kind: 'chat', chat: 'B' });
  const next = move(chat, { kind: 'source', source: 'B-source' });
  expect(move(next, { kind: 'library' })).toEqual({
    chat: 'B',
    source: 'B-source',
    destination: 'library',
    epoch: 7,
  });
});

test('history restoration replaces all address fields but never rewinds intent', () => {
  expect(
    move(original, {
      kind: 'restore',
      view: { chat: 'B', source: 'B2', destination: 'library' },
    })
  ).toEqual({ chat: 'B', source: 'B2', destination: 'library', epoch: 5 });
});

test('deleting a chat releases its whole address', () => {
  expect(move(original, { kind: 'chat-deleted' })).toEqual({
    chat: '',
    source: '',
    destination: 'library',
    epoch: 5,
  });
});

test('rebasing native authored output preserves the chat and reader intent', () => {
  expect(move(original, { kind: 'rebase-source', source: 'replacement' })).toEqual({
    ...original,
    source: 'replacement',
  });
});

test('same-source clicks still supersede pending navigation', () => {
  const next = move(original, { kind: 'source', source: original.source });
  expect(next.source).toBe(original.source);
  expect(next.epoch).toBe(original.epoch + 1);
});
