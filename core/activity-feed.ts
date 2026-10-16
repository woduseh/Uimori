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
/** Helper jobs have their own scope; a library helper does not have a chatId. */
export type HelperRecentTask = {
  id: string;
  conversationId: string;
  chatId: string | null;
  workId: string | null;
  title: string;
  modelTitle: string | null;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  updatedAt: string;
  /** Receipt-backed operations, including no-op transactions. */
  committedEffects: number;
};
export type ActivityFeed = {
  items: ActivityFeedItem[];
  running: ChatActivityCount[];
  helpers?: HelperRecentTask[];
};
