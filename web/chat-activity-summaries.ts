import type { ChatActivityCount } from '../core/chat-activity.js';

export type ChatActivitySummary = { count: number; label: string };

const kindLabels: Record<ChatActivityCount['kind'], string> = {
  main: '원문 생성',
  translation: '번역',
  status: '상태 표현',
  image: '이미지',
  illustration: '삽화',
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
      label: [previous?.label, `${kindLabels[row.kind]} ${row.count}개`]
        .filter(Boolean)
        .join(' · '),
    };
  }
  return result;
}
