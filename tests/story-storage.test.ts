import { afterEach, expect, test, vi } from 'vitest';
import {
  clearReadingPosition,
  readDraftCursor,
  readReadingPosition,
  writeViewCache,
} from '../web/story-storage.js';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
  };
}

const position = { target: 'source-1', source: 'source-1', anchor: 'p1', offset: 12, top: 150 };

afterEach(() => vi.unstubAllGlobals());

test.each(['{', '{"source": 42}'])('ignores invalid optional cache %s', (value) => {
  vi.stubGlobal('localStorage', { getItem: () => value });
  vi.stubGlobal('sessionStorage', { getItem: () => value });
  expect(readReadingPosition('reading:chat')).toBeNull();
  expect(readDraftCursor('cursor')).toBeNull();
});

test('reading position persists across tabs while draft cursor stays in the session', () => {
  const local = memoryStorage();
  const session = memoryStorage();
  vi.stubGlobal('localStorage', local);
  vi.stubGlobal('sessionStorage', session);
  writeViewCache('reading:chat', position);
  writeViewCache('cursor:draft', { start: 2, end: 4 });
  expect(JSON.parse(local.getItem('reading:chat')!)).toEqual(position);
  expect(session.getItem('reading:chat')).toBeNull();
  expect(local.getItem('cursor:draft')).toBeNull();
  expect(readDraftCursor('cursor:draft')).toEqual({ start: 2, end: 4 });
  vi.stubGlobal('sessionStorage', memoryStorage());
  expect(readReadingPosition('reading:chat')).toEqual(position);
});

test('local write failure falls back to the current tab until cleared or overwritten locally', () => {
  const older = { source: 's0', anchor: 'p0', offset: 0, top: 0 };
  const newer = { source: 's', anchor: 'p', offset: 1, top: 10 };
  const local = memoryStorage();
  const session = memoryStorage();
  local.setItem('reading:chat', JSON.stringify(older));
  local.setItem.mockImplementation(() => {
    throw new Error('QuotaExceededError');
  });
  vi.stubGlobal('localStorage', local);
  vi.stubGlobal('sessionStorage', session);

  writeViewCache('reading:chat', newer);
  expect(readReadingPosition('reading:chat')).toEqual(newer);
  expect(JSON.parse(local.getItem('reading:chat')!)).toEqual(older);

  clearReadingPosition('reading:chat');
  expect(readReadingPosition('reading:chat')).toBeNull();
  expect(session.getItem('reading:chat')).toBeNull();
  expect(local.getItem('reading:chat')).toBeNull();
});

test('unavailable optional storage does not prevent rendering', () => {
  const unavailable = {
    getItem: () => {
      throw new Error('blocked');
    },
  };
  vi.stubGlobal('localStorage', unavailable);
  vi.stubGlobal('sessionStorage', unavailable);
  expect(readReadingPosition('reading:chat')).toBeNull();
  expect(readDraftCursor('cursor')).toBeNull();
});
