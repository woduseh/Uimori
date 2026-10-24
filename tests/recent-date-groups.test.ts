import { afterEach, expect, test } from 'vitest';
import { groupRecentDates, recentDateGroupLabel } from '../web/recent-date-groups.js';
import { setLocale } from '../web/i18n.js';

afterEach(() => setLocale('ko'));

test('recent groups use local calendar dates across midnight and year boundaries', () => {
  const now = new Date(2026, 0, 1, 0, 5);
  const items = [
    { id: 'today', at: new Date(2026, 0, 1, 0, 1).toISOString() },
    { id: 'yesterday', at: new Date(2025, 11, 31, 23, 59).toISOString() },
    { id: 'six-days', at: new Date(2025, 11, 26, 12).toISOString() },
    { id: 'seven-days', at: new Date(2025, 11, 25, 12).toISOString() },
    { id: '29-days', at: new Date(2025, 11, 3, 12).toISOString() },
    { id: '30-days', at: new Date(2025, 11, 2, 12).toISOString() },
    { id: 'older-year', at: new Date(2024, 11, 2, 12).toISOString() },
  ];
  const groups = groupRecentDates(items, (item) => item.at, now);
  expect(groups.map((group) => [group.key, group.items.map((item) => item.id)])).toEqual([
    ['today', ['today']],
    ['yesterday', ['yesterday']],
    ['week', ['six-days']],
    ['month', ['seven-days', '29-days']],
    ['month:2025-11', ['30-days']],
    ['month:2024-11', ['older-year']],
  ]);
  expect(groups.flatMap((group) => group.items)).toEqual(items);
  expect(groups[0].items[0]).toBe(items[0]);
});

test('timezone-bearing instants are grouped by their local date, without inventing absent dates', () => {
  const now = new Date(2026, 9, 25, 0, 5);
  const yesterday = new Date(2026, 9, 24, 23, 59);
  const items = [yesterday.toISOString(), 'not-a-timestamp', undefined, ''];
  const groups = groupRecentDates(items, (item) => item, now);
  expect(groups.map((group) => group.key)).toEqual(['yesterday', 'unknown']);
  expect(groups[0].date?.getTime()).toBe(yesterday.getTime());
  expect(groups[1].date).toBeUndefined();
  expect(groups[1].items).toEqual(['not-a-timestamp', undefined, '']);
});

test('grouping retains activity priority and the already paginated item order', () => {
  const items = [
    { id: 'running-old', at: '2026-10-20T12:00:00' },
    { id: 'completed-today', at: '2026-10-25T12:00:00' },
    { id: 'completed-old', at: '2026-10-20T12:00:00' },
  ];
  const groups = groupRecentDates(items, (item) => item.at, new Date(2026, 9, 25, 13));
  expect(groups.map((group) => group.key)).toEqual(['week', 'today', 'week']);
  expect(groups.flatMap((group) => group.items)).toEqual(items);
});

test('spring and autumn calendar days stay yesterday even when their elapsed length differs', () => {
  for (const [now, before] of [
    [new Date(2026, 2, 9, 0, 5), new Date(2026, 2, 8, 0, 1)],
    [new Date(2026, 10, 2, 0, 5), new Date(2026, 10, 1, 0, 1)],
  ]) {
    expect(groupRecentDates([before.toISOString()], (item) => item, now)[0].key).toBe('yesterday');
  }
});

test('group labels follow the current UI locale and preserve a future calendar date', () => {
  const now = new Date(2026, 9, 25, 12);
  const groups = groupRecentDates(
    ['2026-10-25T12:00:00', '2026-10-26T12:00:00'],
    (item) => item,
    now
  );
  setLocale('ko');
  expect(recentDateGroupLabel(groups[0])).toBe('오늘');
  expect(recentDateGroupLabel(groups[1])).toContain('26');
  setLocale('en');
  expect(recentDateGroupLabel(groups[0])).toBe('Today');
  expect(recentDateGroupLabel(groups[1])).toBe('October 26, 2026');
});
