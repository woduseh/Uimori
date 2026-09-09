import { useEffect, useState } from 'react';
import type { ChatActivityCount } from '../core/chat-activity.js';
import { api } from './api.js';

export type ChatActivitySummary = { count: number; label: string };
const kindLabels: Record<ChatActivityCount['kind'], string> = {
  main: '원문 생성',
  translation: '번역',
  status: '상태 표현',
  image: '이미지',
  state: '상태 갱신',
  context: '문맥 압축',
};

export function useChatActivities(): Record<string, ChatActivitySummary> {
  const [activities, setActivities] = useState<Record<string, ChatActivitySummary>>({});
  useEffect(() => {
    let stopped = false;
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      if (stopped || pending || document.hidden) return;
      clearTimeout(timer);
      pending = true;
      try {
        const rows = await api<ChatActivityCount[]>('/chat-activities');
        if (stopped) return;
        const next: Record<string, ChatActivitySummary> = {};
        for (const row of rows) {
          const previous = next[row.chatId];
          next[row.chatId] = {
            count: (previous?.count ?? 0) + row.count,
            label: [previous?.label, `${kindLabels[row.kind]} ${row.count}개`]
              .filter(Boolean)
              .join(' · '),
          };
        }
        setActivities(next);
      } catch {
        // A failed read must not leave a settled task spinning indefinitely.
        if (!stopped) setActivities({});
      } finally {
        pending = false;
        if (!stopped) timer = setTimeout(() => void refresh(), 2000);
      }
    };
    const visible = () => void refresh();
    void refresh();
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('focus', visible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('focus', visible);
    };
  }, []);
  return activities;
}
