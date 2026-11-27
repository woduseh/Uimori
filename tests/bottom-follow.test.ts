import { expect, test } from 'vitest';
import { followAfterScroll } from '../web/useBottomFollow.js';

const viewport = 500;
const bottomOf = (height: number) => ({ top: height - viewport, height });

test('scrolling up stops following at once, even while still near the bottom', () => {
  const last = bottomOf(2000);
  expect(followAfterScroll(true, last, { top: 1490, height: 2000, clientHeight: viewport })).toBe(
    false
  );
  expect(followAfterScroll(true, last, { top: 400, height: 2000, clientHeight: viewport })).toBe(
    false
  );
});

test('returning within 80px of the bottom resumes following', () => {
  const last = { top: 400, height: 2000 };
  expect(followAfterScroll(false, last, { top: 1421, height: 2000, clientHeight: viewport })).toBe(
    true
  );
  expect(followAfterScroll(false, last, { top: 1420, height: 2000, clientHeight: viewport })).toBe(
    false
  );
});

test('content shrinking under the reader is not a scroll up', () => {
  expect(
    followAfterScroll(true, bottomOf(2000), { top: 1100, height: 1600, clientHeight: viewport })
  ).toBe(true);
});

test('a scroll far from the bottom keeps the previous decision', () => {
  const last = { top: 400, height: 2000 };
  expect(followAfterScroll(false, last, { top: 700, height: 2000, clientHeight: viewport })).toBe(
    false
  );
  expect(followAfterScroll(true, last, { top: 700, height: 2000, clientHeight: viewport })).toBe(
    true
  );
});

test('a scroller that is not laid out yields no decision', () => {
  expect(
    followAfterScroll(
      false,
      { top: 400, height: 2000 },
      {
        top: 0,
        height: 0,
        clientHeight: 0,
      }
    )
  ).toBeNull();
});
