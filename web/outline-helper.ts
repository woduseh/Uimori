import type { HelperScope } from '../core/helper.js';
import type { OutlineTarget } from '../core/outline.js';

/** A prepared request is not a model invocation. The existing helper owns submission and recovery. */
export type OutlineHelperRequest = {
  key: string;
  scope: Extract<HelperScope, { kind: 'chat' }>;
  target?: OutlineTarget;
  title: string;
  text: string;
  conversationId?: string;
};
export const OUTLINE_REFRESH_EVENT = 'uimori:outline-refresh';
