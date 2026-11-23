import { expect, test } from 'vitest';
import { placeBeside, uniqueTextRange } from '../web/reader-selection.js';

test('a selection matches only when it occurs verbatim exactly once', () => {
  const stored = '바람이 불었다.\n\n미라는 **멈췄다**.\n\n둘째로 바람이 불었다.';
  expect(uniqueTextRange(stored, '미라는')).toEqual({ start: 10, end: 13 });
  expect(uniqueTextRange(stored, '  미라는\n')).toEqual({ start: 10, end: 13 });
  expect(uniqueTextRange(stored, '바람이 불었다.')).toBeNull();
  expect(uniqueTextRange(stored, '미라는 멈췄다.')).toBeNull();
  expect(uniqueTextRange(stored, '없는 문장')).toBeNull();
  expect(uniqueTextRange(stored, '   ')).toBeNull();
  expect(uniqueTextRange('aaa', 'aa')).toBeNull();
});

test('only line-ending differences are reconciled, and offsets point into the stored text', () => {
  const stored = '첫 줄\r\n둘째 줄\r\n셋째 줄';
  const range = uniqueTextRange(stored, '둘째 줄\n셋째');
  expect(range).toEqual({ start: 5, end: 13 });
  expect(stored.slice(range!.start, range!.end)).toBe('둘째 줄\r\n셋째');
  expect(uniqueTextRange('“따옴표”', '"따옴표"')).toBeNull();
  expect(uniqueTextRange('A😀B', '😀')).toEqual({ start: 1, end: 3 });
});

test('a selection occupying the whole viewport retains an accessible toolbar position', () => {
  const rects = [
    { top: 0, bottom: 20, left: 30, width: 250 },
    { top: 760, bottom: 800, left: 30, width: 250 },
  ] as DOMRect[];
  const range = { getClientRects: () => rects } as unknown as Range;
  const area = { top: 0, bottom: 800, left: 0, right: 900, width: 900, height: 800 } as DOMRect;
  expect(placeBeside(range, area, { width: 300, height: 40 }, 'above')).toEqual({
    top: 8,
    left: 8,
  });
  expect(placeBeside(range, area, { width: 300, height: 40 }, 'below')).toEqual({
    top: 752,
    left: 8,
  });
  expect(
    placeBeside(range, { ...area, height: 45, bottom: 45 }, { width: 300, height: 40 }, 'above')
  ).toBeNull();
});
