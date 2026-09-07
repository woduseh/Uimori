import type { ReaderActivity } from './types.js';

/** Sidebar metadata only; execution bodies and historical failures are excluded. */
export type ChatActivityCount = {
  chatId: string;
  kind: ReaderActivity['kind'];
  count: number;
};
