import type { ReaderActivity } from './types.js';

export type ChatActivityCount = {
  chatId: string;
  kind: ReaderActivity['kind'];
  count: number;
};
