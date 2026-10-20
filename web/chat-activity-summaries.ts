import { t, formatNumber } from './i18n.js';
import type { ChatActivityCount } from '../core/chat-activity.js';

export type ChatActivitySummary = { count: number; label: string };

const kindLabels: Record<ChatActivityCount['kind'], string> = {
  main: 'helpers.m305',
  translation: 'helpers.m217',
  status: 'helpers.m306',
  image: 'helpers.m218',
  illustration: 'helpers.m220',
};

/** The inbox already queries running jobs; reuse its snapshot for the bot tree and rail. */
export function chatActivitySummaries(
  rows: ChatActivityCount[]
): Record<string, ChatActivitySummary> {
  const result: Record<string, ChatActivitySummary> = {};
  for (const row of rows) {
    const previous = result[row.chatId];
    result[row.chatId] = {
      count: (previous?.count ?? 0) + row.count,
      label: [
        previous?.label,
        t('helpers.m307', { v0: t(kindLabels[row.kind]), v1: formatNumber(row.count) }),
      ]
        .filter(Boolean)
        .join(' · '),
    };
  }
  return result;
}
