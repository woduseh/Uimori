import type { ProviderProgress } from './provider-progress.js';

import { RESPONSE_TASK_KINDS, type ResponseTaskKind } from '#contracts';

export { RESPONSE_TASK_KINDS, type ResponseTaskKind };
export type ResponseTaskIdentity = { taskKind: ResponseTaskKind; taskId: string };
export type ResponseStreamStatus =
  | 'running'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'refused'
  | 'cancelled'
  | 'interrupted';
export type ResponseProgress = ProviderProgress & { attemptId: string; segment: number };
export type ResponseChunk = ResponseProgress & { seq: number };
export type ResponseStreamPage = {
  taskKind: ResponseTaskKind;
  taskId: string;
  status: ResponseStreamStatus;
  cursor: number;
  hasMore: boolean;
  chunks: ResponseChunk[];
  thought?: string;
};
