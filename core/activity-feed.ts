import type { ChatActivityCount } from './chat-activity.js';

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
export type HelperRecentTask = {
  id: string;
  conversationId: string;
  chatId: string | null;
  workId: string | null;
  title: string;
  modelTitle: string | null;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  updatedAt: string;
  committedEffects: number;
};
export type ActivityFeed = {
  items: ActivityFeedItem[];
  running: ChatActivityCount[];
  helpers?: HelperRecentTask[];
};
