import type { ChatActivityCount } from './chat-activity.js';

/** Saved work outcomes, independent of Web Push subscriptions. */
export type ActivityFeedItem = {
  chatId: string;
  acknowledgementKey: string;
  kind: 'main' | 'translation' | 'image' | 'illustration';
  status: string;
  label: string;
  at: string;
  sourceId: string | null;
  representation: 'original' | 'translation';
  actionable: boolean;
  canAcknowledge: boolean;
};
export type ActivityFeed = { items: ActivityFeedItem[]; running: ChatActivityCount[] };
