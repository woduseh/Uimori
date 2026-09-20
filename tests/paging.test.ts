import { describe, expect, it } from 'vitest';
import { HOST_LIST_PAGE_DEFAULT, HOST_LIST_PAGE_MAX, pageSlice } from '../core/paging.js';

describe('pageSlice', () => {
  const items = ['a', 'b', 'c', 'd', 'e'];

  it('returns the whole list and no next page when the limit covers it', () => {
    expect(pageSlice(items, 0, 5)).toEqual({ items, nextOffset: null, total: 5 });
    expect(pageSlice(items, 0, HOST_LIST_PAGE_MAX)).toEqual({ items, nextOffset: null, total: 5 });
  });

  it('reports the next offset for a partial page and null for the last one', () => {
    expect(pageSlice(items, 0, 2)).toEqual({ items: ['a', 'b'], nextOffset: 2, total: 5 });
    expect(pageSlice(items, 2, 2)).toEqual({ items: ['c', 'd'], nextOffset: 4, total: 5 });
    expect(pageSlice(items, 4, 2)).toEqual({ items: ['e'], nextOffset: null, total: 5 });
  });

  it('ends the walk at the exact boundary rather than offering an empty page', () => {
    expect(pageSlice(items, 0, 5).nextOffset).toBeNull();
    expect(pageSlice(items, 3, 2).nextOffset).toBeNull();
  });

  it('yields an empty last page for an empty list and for an offset at or past the end', () => {
    expect(pageSlice([], 0, 20)).toEqual({ items: [], nextOffset: null, total: 0 });
    expect(pageSlice(items, 5, 20)).toEqual({ items: [], nextOffset: null, total: 5 });
    expect(pageSlice(items, 9, 20)).toEqual({ items: [], nextOffset: null, total: 5 });
    expect(pageSlice(items, Number.MAX_SAFE_INTEGER, 20)).toEqual({
      items: [],
      nextOffset: null,
      total: 5,
    });
  });

  it('repeats the offset for a zero limit, which is why callers require at least 1', () => {
    expect(pageSlice(items, 0, 0)).toEqual({ items: [], nextOffset: 0, total: 5 });
    expect(pageSlice(items, 5, 0)).toEqual({ items: [], nextOffset: null, total: 5 });
  });

  it('copies the page instead of exposing the source list', () => {
    const source = ['a', 'b'];
    const page = pageSlice(source, 0, 2);
    page.items.push('c');
    expect(source).toEqual(['a', 'b']);
  });
});

describe('shared page bounds', () => {
  it('keeps the defaults inside their maxima', () => {
    expect(HOST_LIST_PAGE_DEFAULT).toBeLessThanOrEqual(HOST_LIST_PAGE_MAX);
  });
});
