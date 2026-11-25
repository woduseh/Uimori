import type { RequestLore } from './request-lore.js';
import type { ContextBudget } from './context-budget.js';
import type { TokenizerProfileId } from './tokenizer-profiles.js';

export type ContextReceipt = {
  version: 1;
  model: { modelId: string; title: string; presetId?: string };
  prompt: { id: string; revision: number; title: string } | null;
  persona: { id: string; revision: number; title: string | null; name: string | null } | null;
  summary: {
    status: 'included' | 'absent' | 'unverified';
    coveredSources: number;
  } | null;
  storyGuide?: { status: 'included' | 'unverified' };
};

export type SceneUsageDetail = {
  cache: {
    readTokens: number | null;
    writeTokens: number | null;
    write5mTokens?: number | null;
    write1hTokens?: number | null;
  } | null;
  lore: RequestLore | null;
};

export const MAIN_CONTEXT_PARTS = [
  'prompt',
  'botDescription',
  'persona',
  'lore',
  'authorNote',
  'storyGuide',
  'summary',
  'history',
  'request',
  'tools',
  'toolResults',
  'other',
] as const;
export type MainContextPart = (typeof MAIN_CONTEXT_PARTS)[number];
export type MainContextParts = Partial<Record<MainContextPart, number>>;

export type RequestContext = {
  estimatedInputTokens: number;
  inputTokenLimit: number;
  parts?: MainContextParts;
  estimator?: ContextBudget['estimator'];
  tokenizer?: TokenizerProfileId;
  tokenizerFallback?: boolean;
};

export type SceneUsageReceipt = {
  attemptId?: string;
  inputTokens: number | null;
  outputTokens: number | null;
  inputScope?: 'request' | 'turn';
  context: RequestContext | null;
  receipt?: ContextReceipt | null;
};

export type LastSceneLoreDetail = {
  sourceRevision: string | null;
  attemptId: string | null;
  lore: RequestLore | null;
};
