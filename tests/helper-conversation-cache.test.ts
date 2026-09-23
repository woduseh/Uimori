import { expect, test } from 'vitest';
import { evictHelperViews } from '../web/helper-conversation-cache.js';

test('helper cache keeps current and four recent views without copying or truncating the current manuscript', () => {
  const current = {
    messages: Array.from({ length: 150 }, (_, id) => ({ id, text: 'synthetic prose' })),
  };
  const cache = new Map([['current', current]]);
  const evicted: string[] = [];
  for (let index = 0; index < 20; index++) {
    cache.set(String(index), { messages: [] });
    evicted.push(...evictHelperViews(cache, 'current'));
  }
  expect([...cache.keys()]).toEqual(['current', '16', '17', '18', '19']);
  expect(cache.get('current')).toBe(current);
  expect(current.messages).toHaveLength(150);
  expect(evicted).toHaveLength(16);
  const revisited = cache.get('16')!;
  cache.delete('16');
  cache.set('16', revisited);
  cache.set('next', { messages: [] });
  expect(evictHelperViews(cache, 'current')).toEqual(['17']);
  expect(cache.get('16')).toBe(revisited);
});
