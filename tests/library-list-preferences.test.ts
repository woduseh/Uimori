import { afterEach, expect, test, vi } from 'vitest';
import { saveLibraryManualOrder, saveLibrarySort } from '../web/library-list-preferences.js';

afterEach(() => vi.unstubAllGlobals());

function stubLocalStorage(initial: Record<string, string>) {
  const values = new Map(Object.entries(initial));
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  return values;
}

test('saving a library preference keeps the other categories and replaces unreadable values', () => {
  const values = stubLocalStorage({
    'uimori-library-sorts': JSON.stringify({ persona: 'name-desc' }),
    'uimori-library-manual-orders': '{',
  });
  saveLibrarySort('bot', 'manual');
  saveLibraryManualOrder('bot', ['b', 'a']);
  expect(JSON.parse(values.get('uimori-library-sorts') ?? '')).toEqual({
    persona: 'name-desc',
    bot: 'manual',
  });
  expect(JSON.parse(values.get('uimori-library-manual-orders') ?? '')).toEqual({ bot: ['b', 'a'] });

  values.set('uimori-library-sorts', JSON.stringify(['name']));
  saveLibrarySort('module', 'name');
  expect(JSON.parse(values.get('uimori-library-sorts') ?? '')).toEqual({ module: 'name' });
});
