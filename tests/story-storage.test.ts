import { afterEach, expect, test, vi } from 'vitest';
import { commandStorageKey, readDraftCursor, readReadingPosition } from '../web/story-storage.js';
afterEach(() => vi.unstubAllGlobals());
test('main keeps its historical address and a new default keeps its own branch address', () => {
  expect(commandStorageKey('chat', 'main:chat')).toBe('command:chat');
  expect(commandStorageKey('chat', '')).toBe('command:chat');
  expect(commandStorageKey('chat', 'branch-2')).toBe('command:chat:branch-2');
});
test.each(['{', 'null', '[]', '{"source": 42}', '{"start":-1,"end":3}'])(
  'ignores invalid disposable cache %s',
  (value) => {
    vi.stubGlobal('sessionStorage', { getItem: () => value });
    expect(readReadingPosition('reading')).toBeNull();
    expect(readDraftCursor('cursor')).toBeNull();
  }
);
test('unavailable optional storage does not prevent rendering', () => {
  vi.stubGlobal('sessionStorage', {
    getItem: () => {
      throw new Error('blocked');
    },
  });
  expect(readReadingPosition('reading')).toBeNull();
  expect(readDraftCursor('cursor')).toBeNull();
});
