import type { HelperStatus } from './helper.js';

/** Small public records. Tool arguments, results and reserved model inputs stay private. */
export type HelperActivityEvent = {
  seq: number;
  kind: string;
  attemptId?: string;
  purpose?: string;
  name?: string;
  status?: string;
  denied?: boolean;
  error?: string;
  text?: string;
  textTruncated?: boolean;
  applied?: boolean;
};

export type HelperActivity = {
  taskId: string;
  status: HelperStatus;
  events: HelperActivityEvent[];
  hasEarlier: boolean;
};
