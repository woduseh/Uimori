import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActivityFeed, ActivityFeedItem } from '../core/activity-feed.js';
import { activityChangedEvent, api } from './api.js';
import { readAcknowledgements, saveAcknowledgements } from './activity-acknowledgements.js';

function groupByChat(items: ActivityFeedItem[]) {
  const result = new Map<string, ActivityFeedItem[]>();
  for (const item of items) result.set(item.chatId, [...(result.get(item.chatId) ?? []), item]);
  return result;
}
export const activityReceiptEvent = 'uimori-activity-receipt';
export const activityViewedEvent = 'uimori-activity-result-visible';

type Viewed = { chatId: string; sourceId: string; representation: 'original' | 'translation' };
export function useActivityFeed() {
  const [feed, setFeed] = useState<ActivityFeed>({ items: [], running: [] });
  const [error, setError] = useState('');
  const latest = useRef(feed);
  latest.current = feed;
  const seq = useRef(0);
  const pendingViews = useRef(new Set<string>());
  const inFlight = useRef(new Set<string>());
  const refresh = useCallback(async () => {
    const order = ++seq.current;
    try {
      const next = await api<ActivityFeed>('/activity-feed');
      if (order !== seq.current) return;
      const localReceipts = new Map<string, Set<string>>();
      const local = next.items.filter((item) => {
        if (!localReceipts.has(item.chatId))
          localReceipts.set(item.chatId, new Set(readAcknowledgements(item.chatId)));
        return localReceipts.get(item.chatId)!.has(item.acknowledgementKey);
      });
      const localKeys = new Set(local.map((item) => item.acknowledgementKey));
      setFeed({
        ...next,
        items: next.items.filter((item) => !localKeys.has(item.acknowledgementKey)),
      });
      setError('');
      // Older browser receipts are safely mirrored to the server before use elsewhere.
      if (local.length) {
        const grouped = groupByChat(local);
        for (const [chatId, entries] of grouped)
          for (let i = 0; i < entries.length; i += 100)
            void api(`/chats/${encodeURIComponent(chatId)}/activity-acknowledgements`, {
              keys: entries.slice(i, i + 100).map((item) => item.acknowledgementKey),
            }).catch(() => {});
      }
    } catch (reason) {
      if (order === seq.current)
        setError(reason instanceof Error ? reason.message : '활동을 불러오지 못했어요.');
    }
  }, []);
  const acknowledge = useCallback(async (items: ActivityFeedItem[]) => {
    const eligible = items.filter(
      (item) => item.canAcknowledge && !inFlight.current.has(item.acknowledgementKey)
    );
    if (!eligible.length) return;
    for (const item of eligible) inFlight.current.add(item.acknowledgementKey);
    const grouped = groupByChat(eligible);
    try {
      for (const [chatId, entries] of grouped) {
        for (let i = 0; i < entries.length; i += 100) {
          const keys = entries.slice(i, i + 100).map((item) => item.acknowledgementKey);
          await api(`/chats/${encodeURIComponent(chatId)}/activity-acknowledgements`, { keys });
          saveAcknowledgements(chatId, keys);
          window.dispatchEvent(new CustomEvent(activityReceiptEvent, { detail: { chatId, keys } }));
        }
      }
      setFeed((current) => ({
        ...current,
        items: current.items.filter(
          (item) =>
            !eligible.some(
              (seen) =>
                seen.chatId === item.chatId && seen.acknowledgementKey === item.acknowledgementKey
            )
        ),
      }));
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '확인 상태를 저장하지 못했어요.');
    } finally {
      for (const item of eligible) inFlight.current.delete(item.acknowledgementKey);
    }
  }, []);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const poll = async () => {
      if (stopped) return;
      if (!document.hidden) await refresh();
      if (!stopped)
        timer = setTimeout(() => void poll(), latest.current.running.length ? 2500 : 10000);
    };
    const active = () => {
      if (!document.hidden) void refresh();
    };
    void poll();
    document.addEventListener('visibilitychange', active);
    window.addEventListener('focus', active);
    window.addEventListener(activityChangedEvent, active);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', active);
      window.removeEventListener('focus', active);
      window.removeEventListener(activityChangedEvent, active);
    };
  }, [refresh]);
  useEffect(() => {
    const visible = (event: Event) => {
      const target = (event as CustomEvent<Viewed>).detail;
      if (!target) return;
      const matches = latest.current.items.filter(
        (item) =>
          pendingViews.current.has(item.acknowledgementKey) &&
          item.chatId === target.chatId &&
          item.sourceId === target.sourceId &&
          item.representation === target.representation &&
          item.status === 'completed'
      );
      if (matches.length) void acknowledge(matches);
    };
    const receipt = (event: Event) => {
      const detail = (event as CustomEvent<{ chatId: string; keys: string[] }>).detail;
      if (!detail) return;
      setFeed((current) => ({
        ...current,
        items: current.items.filter(
          (item) => item.chatId !== detail.chatId || !detail.keys.includes(item.acknowledgementKey)
        ),
      }));
    };
    window.addEventListener(activityViewedEvent, visible);
    window.addEventListener(activityReceiptEvent, receipt);
    return () => {
      window.removeEventListener(activityViewedEvent, visible);
      window.removeEventListener(activityReceiptEvent, receipt);
    };
  }, [acknowledge]);
  const inspect = (item: ActivityFeedItem) => {
    if (item.status !== 'completed' || !item.sourceId) return;
    pendingViews.current.add(item.acknowledgementKey);
  };
  return { feed, error, acknowledge, refresh, inspect };
}
