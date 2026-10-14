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

test.each(['{', 'null', '[]', '{"source": 42}', '{"start":-1,"end":3}'])(
  'ignores invalid optional cache %s',
  (value) => {
    vi.stubGlobal('localStorage', { getItem: () => value });
    vi.stubGlobal('sessionStorage', { getItem: () => value });
    expect(readReadingPosition('reading:chat')).toBeNull();
    expect(readDraftCursor('cursor')).toBeNull();
  }
);

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
  // A fresh tab has a new sessionStorage but shares the same persistent reading location.
  vi.stubGlobal('sessionStorage', memoryStorage());
  expect(readReadingPosition('reading:chat')).toEqual(position);
});

test('legacy tab-local reading position moves to persistent storage', () => {
  const local = memoryStorage();
  const session = memoryStorage();
  session.setItem('reading:chat', JSON.stringify(position));
  vi.stubGlobal('localStorage', local);
  vi.stubGlobal('sessionStorage', session);
  expect(readReadingPosition('reading:chat')).toEqual(position);
  expect(JSON.parse(local.getItem('reading:chat')!)).toEqual(position);
  expect(session.getItem('reading:chat')).toBeNull();
});

test('quota fallback preserves the previous durable position without restoring it in this tab', () => {
  const local = memoryStorage();
  const session = memoryStorage();
  const next = { ...position, source: 'source-2', top: 460 };
  local.setItem('reading:chat', JSON.stringify(position));
  local.setItem.mockImplementation(() => {
    throw new Error('quota');
  });
  vi.stubGlobal('localStorage', local);
  vi.stubGlobal('sessionStorage', session);
  writeViewCache('reading:chat', next);
  expect(JSON.parse(local.getItem('reading:chat')!)).toEqual(position);
  expect(readReadingPosition('reading:chat')).toEqual(next);
  vi.stubGlobal('sessionStorage', memoryStorage());
  expect(readReadingPosition('reading:chat')).toEqual(position);
});

test('blocked persistent storage falls back to the current tab', () => {
  const local = memoryStorage();
  local.setItem.mockImplementation(() => {
    throw new Error('quota');
  });
  const session = memoryStorage();
  vi.stubGlobal('localStorage', local);
  vi.stubGlobal('sessionStorage', session);
  writeViewCache('reading:chat', position);
  expect(readReadingPosition('reading:chat')).toEqual(position);
  clearReadingPosition('reading:chat');
  expect(session.getItem('reading:chat')).toBeNull();
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
