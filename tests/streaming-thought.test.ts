import { expect, test } from 'vitest';
import { thoughtTail } from '../web/StreamingResponse.js';

test('a thought summary shows without emphasis marks, and a long one keeps its latest words', () => {
  expect(thoughtTail('**자료 확인**\n\n설정을 읽고 있어요.')).toBe(
    '자료 확인\n\n설정을 읽고 있어요.'
  );
  const tail = thoughtTail(`${'앞부분 '.repeat(200)}마지막 문장이에요.`);
  expect(tail.startsWith('…앞부분')).toBe(true);
  expect(tail.endsWith('마지막 문장이에요.')).toBe(true);
  expect(tail.length).toBeLessThanOrEqual(601);
});
