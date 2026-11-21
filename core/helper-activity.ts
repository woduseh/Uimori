import type { HelperStatus } from './helper.js';

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
  callId?: string;
  target?: HelperActivityTarget;
};

export type HelperActivity = {
  taskId: string;
  status: HelperStatus;
  events: HelperActivityEvent[];
  hasEarlier: boolean;
};

export type HelperActivityTargetRef = { kind: string; id: string } | { count: number };
export type HelperActivityTarget = { kind: string; title?: string } | { count: number };

export function helperActivityTarget(
  args: Record<string, unknown>
): HelperActivityTargetRef | undefined {
  if (Array.isArray(args.items)) return { count: args.items.length };
  if (typeof args.sourceId === 'string') return { kind: 'scene', id: args.sourceId };
  if (typeof args.kind === 'string' && typeof args.id === 'string')
    return { kind: args.kind, id: args.id };
  return undefined;
}
