import type { ReaderTarget } from './reader-target.js';

export type PushPreferences = {
  main: boolean;
  failures: boolean;
  translation: boolean;
  illustration: boolean;
  showTitle: boolean;
};
export const DEFAULT_PUSH_PREFERENCES: PushPreferences = {
  main: true,
  failures: true,
  translation: false,
  illustration: false,
  showTitle: false,
};
export type PushDevice = {
  revision: number;
  preferences: PushPreferences;
  lastError: string | null;
};
export type PushInfo = {
  available: boolean;
  reason: string | null;
  publicKey: string | null;
  device: PushDevice | null;
};
export type PushSubscriptionData = { endpoint: string; keys: { p256dh: string; auth: string } };
export type PushEnvelope = {
  version: 1;
  kind:
    | 'main-completed'
    | 'translation-completed'
    | 'illustration-completed'
    | 'task-failed'
    | 'test';
  tag: string;
  chatId: string | null;
  branchId: string | null;
  sourceId: string | null;
  representation: 'original' | 'translation';
  title?: string;
};
export type NotificationIntent = { chatId: string; target?: ReaderTarget };
export function notificationIntent(value: unknown): NotificationIntent | null {
  if (!value || typeof value !== 'object') return null;
  const body = value as Record<string, unknown>;
  const id = (item: unknown): item is string =>
    typeof item === 'string' && item.length > 0 && item.length <= 120;
  if (!id(body.chatId)) return null;
  if (!id(body.sourceId)) return { chatId: body.chatId };
  return {
    chatId: body.chatId,
    target: {
      chatId: body.chatId,
      sourceId: body.sourceId,
      branchId: id(body.branchId) ? body.branchId : `main:${body.chatId}`,
      representation: body.representation === 'translation' ? 'translation' : 'original',
    },
  };
}
