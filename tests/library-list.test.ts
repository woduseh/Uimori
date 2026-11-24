import { expect, test } from 'vitest';
import type { LibraryFolder } from '../core/library-organization.js';
import {
  librarySections,
  neighbourTarget,
  reorderManually,
  sortLibraryItems,
} from '../web/library-list.js';

const item = (id: string, title = id) => ({ id, title });
const folder = (id: string, sortPosition: number): LibraryFolder => ({
  id,
  category: 'bot',
  title: id,
  sortPosition,
  coverImageHash: null,
});

test('sections follow folder order, keep empty folders and put loose items last', () => {
  const items = [item('a'), item('b'), item('c'), item('d')];
  const placement: Record<string, string | null> = { a: 'f2', b: null, c: 'f1', d: 'gone' };
  const sections = librarySections(
    items,
    [folder('f1', 1), folder('f2', 2), folder('f3', 3)],
    (entry) => placement[entry.id]
  );
  expect(
    sections.map((section) => [section.folder?.id ?? null, section.items.map(({ id }) => id)])
  ).toEqual([
    ['f1', ['c']],
    ['f2', ['a']],
    ['f3', []],
    [null, ['b', 'd']],
  ]);
  expect(librarySections([item('a')], [folder('f1', 1)], () => 'f1').at(-1)?.folder?.id).toBe('f1');
});

test('manual order places unordered items by name and moves within the shown list', () => {
  const items = [item('x', 'Charlie'), item('y', 'Alpha'), item('z', 'Bravo')];
  expect(sortLibraryItems(items, 'manual', ['z'], 'en').map(({ id }) => id)).toEqual([
    'z',
    'y',
    'x',
  ]);
  expect(sortLibraryItems(items, 'name-desc', [], 'en').map(({ id }) => id)).toEqual([
    'x',
    'z',
    'y',
  ]);
  expect(reorderManually(items, ['z'], 'en', 'x', 'z')).toEqual(['x', 'z', 'y']);
  expect(reorderManually(items, [], 'en', 'y', null)).toEqual(['z', 'x', 'y']);
  const shown = [item('p'), item('q'), item('r')];
  expect(neighbourTarget(shown, 'q', -1)).toBe('p');
  expect(neighbourTarget(shown, 'p', 1)).toBe('r');
  expect(neighbourTarget(shown, 'q', 1)).toBeNull();
  expect(neighbourTarget(shown, 'r', 1)).toBeUndefined();
  expect(neighbourTarget(shown, 'p', -1)).toBeUndefined();
});
