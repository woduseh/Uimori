import { afterEach, beforeAll, expect, test } from 'vitest';
import { groupRecentDates } from '../web/recent-date-groups.js';
import { loadLocale, setLocale, UI_LOCALES } from '../web/i18n.js';

beforeAll(() => Promise.all(UI_LOCALES.map(loadLocale)));

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
