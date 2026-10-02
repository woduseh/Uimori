import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  readAcknowledgements,
  saveAcknowledgements,
  migrateAcknowledgements,
} from '../web/activity-acknowledgements.js';

function storage() {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    key: (index: number) => [...data.keys()][index] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}
beforeEach(() => {
  vi.stubGlobal('localStorage', storage());
  vi.stubGlobal('sessionStorage', storage());
});
afterEach(() => vi.unstubAllGlobals());

test('independent saves preserve prior confirmations and remain scoped to their chat', () => {
  expect(saveAcknowledgements('a', ['execution-1'])).toBe(true);
  expect(saveAcknowledgements('a', ['execution-2'])).toBe(true);
  expect(saveAcknowledgements('b', ['execution-3'])).toBe(true);
  expect(readAcknowledgements('a')).toEqual(['execution-1', 'execution-2']);
  expect(readAcknowledgements('b')).toEqual(['execution-3']);
});

test('legacy session acknowledgements migrate before the tab session ends', () => {
  sessionStorage.setItem('activity-acknowledged:a', JSON.stringify(['old-execution', 3]));
  expect(migrateAcknowledgements('a')).toBe(true);
  expect(sessionStorage.getItem('activity-acknowledged:a')).toBeNull();
  vi.stubGlobal('sessionStorage', storage());
  expect(readAcknowledgements('a')).toEqual(['old-execution']);
});

test('storage failure is explicit and does not discard the legacy confirmation', () => {
  sessionStorage.setItem('activity-acknowledged:a', JSON.stringify(['old-execution']));
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
    throw new Error('Storage full');
  });
  expect(migrateAcknowledgements('a')).toBe(false);
  expect(readAcknowledgements('a')).toEqual(['old-execution']);
  expect(saveAcknowledgements('a', ['new-execution'])).toBe(false);
});

test('confirmations do not stop persisting after an arbitrary history count', () => {
  const identities = Array.from({ length: 2001 }, (_, index) => `execution-${index}`);
  expect(saveAcknowledgements('a', identities)).toBe(true);
  expect(readAcknowledgements('a')).toHaveLength(2001);
});
