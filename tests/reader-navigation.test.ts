import { expect, test } from 'vitest';
import {
  transitionReaderNavigation as move,
  type ReaderNavigation,
  type ReaderNavigationAction,
} from '../web/reader-navigation.js';

const original: ReaderNavigation = Object.freeze({
  chat: 'A',
  branch: 'branch-A',
  source: 'source-A',
  destination: 'story',
  epoch: 4,
});

test('changing chats atomically releases the previous branch and source', () => {
  expect(move(original, { kind: 'chat', chat: 'B' })).toEqual({
    chat: 'B',
    branch: '',
    source: '',
    destination: 'story',
    epoch: 5,
  });
  expect(original.branch).toBe('branch-A');
  expect(original.source).toBe('source-A');
});

test('branch selection preserves chat and takes the chosen source, including an empty source', () => {
  expect(move(original, { kind: 'branch', branch: 'other', source: '' })).toEqual({
    ...original,
    branch: 'other',
    source: '',
    epoch: 5,
  });
  expect(move(original, { kind: 'branch', branch: 'other', source: 'selected' }).source).toBe(
    'selected'
  );
});

test('visiting the library retains the reading address without retaining the old intent', () => {
  expect(move(original, { kind: 'library' })).toEqual({
    ...original,
    destination: 'library',
    epoch: 5,
  });
});

test('history restoration replaces all address fields but never rewinds intent', () => {
  expect(
    move(original, {
      kind: 'restore',
      view: { chat: 'B', branch: 'B1', source: 'B2', destination: 'library' },
    })
  ).toEqual({ chat: 'B', branch: 'B1', source: 'B2', destination: 'library', epoch: 5 });
});

test('deleting a chat releases its whole address', () => {
  expect(move(original, { kind: 'chat-deleted' })).toEqual({
    chat: '',
    branch: '',
    source: '',
    destination: 'library',
    epoch: 5,
  });
});

test('binding the opened default is address reconciliation, not a new navigation', () => {
  const implicit = { ...original, branch: '' };
  expect(move(implicit, { kind: 'bind-default', branch: 'opened' })).toEqual({
    ...implicit,
    branch: 'opened',
  });
});

test('late default reconciliation cannot replace an explicit branch', () => {
  expect(move(original, { kind: 'bind-default', branch: 'different' })).toBe(original);
});

test('rebasing native authored output preserves reader intent and the branch', () => {
  expect(move(original, { kind: 'rebase-source', source: 'replacement' })).toEqual({
    ...original,
    source: 'replacement',
  });
});

test('A to B to A cannot authorize an operation captured at the first A', () => {
  const saved = original.epoch;
  const next = move(move(original, { kind: 'chat', chat: 'B' }), { kind: 'chat', chat: 'A' });
  expect(next.chat).toBe(original.chat);
  expect(next.epoch).not.toBe(saved);
});

test('same-source clicks still supersede pending navigation', () => {
  const next = move(original, { kind: 'source', source: original.source });
  expect(next.source).toBe(original.source);
  expect(next.epoch).toBe(original.epoch + 1);
});

test('consecutive synchronous transitions consume the preceding complete state', () => {
  const sequence: ReaderNavigationAction[] = [
    { kind: 'chat', chat: 'B' },
    { kind: 'branch', branch: 'B-branch', source: 'B-source' },
    { kind: 'library' },
  ];
  const next = sequence.reduce(move, original);
  expect(next).toEqual({
    chat: 'B',
    branch: 'B-branch',
    source: 'B-source',
    destination: 'library',
    epoch: 7,
  });
});
