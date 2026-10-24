import { formatDate, t } from './i18n.js';

export type RecentDateGroup<T> = { key: string; date?: Date; items: T[] };
const day = 86_400_000;
// Comparing calendar dates rather than elapsed hours keeps yesterday correct across DST.
const calendarDay = (date: Date) =>
  Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / day;

/** Input order and item identity are retained; callers own sorting and pagination. */
export function groupRecentDates<T>(
  items: T[],
  timestamp: (item: T) => string | undefined,
  now = new Date()
): RecentDateGroup<T>[] {
  const groups: RecentDateGroup<T>[] = [];
  for (const item of items) {
    const value = timestamp(item);
    const date = value ? new Date(value) : undefined;
    const valid = date && Number.isFinite(date.getTime());
    const age = valid ? calendarDay(now) - calendarDay(date) : NaN;
    const key = !valid
      ? 'unknown'
      : age === 0
        ? 'today'
        : age === 1
          ? 'yesterday'
          : age > 1 && age < 7
            ? 'week'
            : age >= 7 && age < 30
              ? 'month'
              : age < 0
                ? `date:${calendarDay(date)}`
                : `month:${date.getFullYear()}-${date.getMonth()}`;
    let group = groups.at(-1);
    if (!group || group.key !== key) {
      group = { key, ...(valid ? { date } : {}), items: [] };
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}

export function recentDateGroupLabel(group: Pick<RecentDateGroup<unknown>, 'key' | 'date'>) {
  if (group.key.startsWith('month:'))
    return formatDate(group.date!, { year: 'numeric', month: 'long' });
  if (group.key.startsWith('date:'))
    return formatDate(group.date!, { year: 'numeric', month: 'long', day: 'numeric' });
  return t(`recent.${group.key}`);
}
