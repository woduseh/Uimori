import { afterEach, expect, test, vi } from 'vitest';
import {
  readOptionalJson,
  readOptionalStorage,
  removeOptionalStorage,
  writeOptionalStorage,
} from '../web/optional-storage.js';

afterEach(() => vi.unstubAllGlobals());

test('stored JSON is read as written and anything unreadable yields the fallback', () => {
  const values = new Map([
    ['null', 'null'],
    ['list', '[1]'],
    ['corrupt', '{'],
    ['empty', ''],
  ]);
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => values.get(key) ?? null });
  expect(readOptionalJson('session', 'null', 'fallback')).toBeNull();
  expect(readOptionalJson('session', 'list', 'fallback')).toEqual([1]);
  for (const key of ['missing', 'corrupt', 'empty'])
    expect(readOptionalJson('session', key, 'fallback')).toBe('fallback');
  expect(readOptionalStorage('session', 'empty')).toBe('');
});

test('unavailable storage reads as empty and reports failed writes without throwing', () => {
  vi.stubGlobal('localStorage', {
    getItem() {
      throw new Error('Storage disabled');
    },
    setItem() {
      throw new Error('Quota exceeded');
    },
    removeItem() {
      throw new Error('Storage disabled');
    },
  });
  expect(readOptionalStorage('local', 'key')).toBeNull();
  expect(readOptionalJson('local', 'key', [])).toEqual([]);
  expect(writeOptionalStorage('local', 'key', 'value')).toBe(false);
  expect(() => removeOptionalStorage('local', 'key')).not.toThrow();
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    setItem: (key: string, value: string) => values.set(key, value),
  });
  expect(writeOptionalStorage('local', 'key', 'value')).toBe(true);
  expect(values.get('key')).toBe('value');
});
