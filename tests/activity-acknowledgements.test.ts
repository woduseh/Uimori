import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { readAcknowledgements, saveAcknowledgements } from '../web/activity-acknowledgements.js';

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
});
afterEach(() => vi.unstubAllGlobals());

test('independent saves preserve prior confirmations and remain scoped to their chat', () => {
  expect(saveAcknowledgements('a', ['execution-1'])).toBe(true);
  expect(saveAcknowledgements('a', ['execution-2'])).toBe(true);
  expect(saveAcknowledgements('b', ['execution-3'])).toBe(true);
  expect(readAcknowledgements('a')).toEqual(['execution-1', 'execution-2']);
  expect(readAcknowledgements('b')).toEqual(['execution-3']);
});

test('storage failure is explicit and keeps earlier confirmations', () => {
  expect(saveAcknowledgements('a', ['old-execution'])).toBe(true);
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
    throw new Error('Storage full');
  });
  expect(saveAcknowledgements('a', ['new-execution'])).toBe(false);
  expect(readAcknowledgements('a')).toEqual(['old-execution']);
});

test('confirmations do not stop persisting after an arbitrary history count', () => {
  const identities = Array.from({ length: 2001 }, (_, index) => `execution-${index}`);
  expect(saveAcknowledgements('a', identities)).toBe(true);
  expect(readAcknowledgements('a')).toHaveLength(2001);
});
