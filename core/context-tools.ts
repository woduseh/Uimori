import type { Json, ProviderTool } from './transport.js';
import type { RunSnapshot } from './types.js';
import { STORY_READ_NAMES } from './story-context.js';
import { CONTEXT_RETRIEVAL_GUIDANCE, CONTEXT_SUMMARY_SEMANTICS } from './context-summary-policy.js';

/** Opt-in main-role tools: a model-written working summary and a model-requested window switch. */
export const CONTEXT_TOOL_NAMES = ['context.read', 'context.write', 'context.new'] as const;
export type ContextToolName = (typeof CONTEXT_TOOL_NAMES)[number];
export const CONTEXT_NOTICE_RATIO = 0.7;
export const CONTEXT_URGENT_RATIO = 0.8;
/** Mirrors the host compaction trigger; documented to the model, enforced by the compaction path. */
export const CONTEXT_AUTOMATIC_RATIO = 0.85;
export const CONTEXT_SUMMARY_MAX_CHARS = 200_000;
export const CONTEXT_KEEP_RECENT_DEFAULT = 2;
export const CONTEXT_KEEP_RECENT_MAX = 8;
const summarySchema: Json = {
  type: 'string',
  minLength: 1,
  maxLength: CONTEXT_SUMMARY_MAX_CHARS,
};
export const CONTEXT_TOOLS: ProviderTool[] = [
  {
    name: 'context.read',
    description:
      'Show saved/window summaries, compacted and retained source anchors (sceneNumber, revision, hash) in their frozen sceneScope, and current contextWindow usage. Read a known scene directly with story.read({sceneNumber}).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'context.write',
    description:
      'Save or replace working memory for later windows and turns: decisions, reasons, active constraints, unresolved threads and next steps. Attach compact [scene 12] anchors to important claims with known sources, without expanding anchors with source UUIDs/hashes or writing per-scene recaps. Keep exact story identifiers, codes, attribution and user corrections. It is durable before returning; the current window is unchanged and explicit user notes take precedence.',
    inputSchema: {
      type: 'object',
      properties: { summary: summarySchema },
      required: ['summary'],
      additionalProperties: false,
    },
  },
  {
    name: 'context.new',
    description:
      'Open a new context window in this run. Exchanges older than keepRecent (default 2) and earlier tool results leave the input; your summary replaces them and every original remains retrievable by story.read({sceneNumber}). A saved or supplied summary is required when anything is compacted; preserve known compact scene anchors on important claims. Call alone after saving needed working memory.',
    inputSchema: {
      type: 'object',
      properties: {
        keepRecent: { type: 'integer', minimum: 0, maximum: CONTEXT_KEEP_RECENT_MAX },
        summary: summarySchema,
      },
      additionalProperties: false,
    },
  },
];
export const CONTEXT_TOOLS_CONTRACT =
  '\nContext window tools are registered for this run. Tool results carry projected contextWindow usage including the returned data. context.write saves a working summary for later windows and turns without changing the current window. context.new, called alone, opens a new window: exchanges before the kept recent ones and all earlier tool results leave the transmitted input, your summary stands in for them, and the host keeps every original. story.list, story.search, story.read, notes.list and notes.read work in every window; recover exact decisions and wording from originals instead of guessing. Act before usedRatio reaches 0.85. If completed reads fill the window, the host summarizes those reads before the next model call while preserving mutation receipts; story history is compacted before the next writing turn. Summaries are derived reference data: explicit user notes and the current request take precedence.\nWorking-memory rules for context.write and context.new: ' +
  CONTEXT_SUMMARY_SEMANTICS +
  '\n' +
  CONTEXT_RETRIEVAL_GUIDANCE;

/** Frozen per run from the main preset; evaluation presets and independent artifacts keep their own loops. */
export function contextToolsEnabled(snapshot: RunSnapshot): boolean {
  const main = snapshot.profile?.models.main;
  return (
    main?.contextTools === true &&
    !main.evaluationTools &&
    snapshot.executionPurpose !== 'artifact' &&
    !!snapshot.contextPlan
  );
}
export type ContextWindowStatus = {
  inputTokenLimit: number;
  estimatedInputTokens: number;
  usedRatio: number;
  level: 'ok' | 'notice' | 'urgent';
  notice?: string;
};
export function contextWindowStatus(
  estimatedInputTokens: number,
  inputTokenLimit: number
): ContextWindowStatus {
  const usedRatio = Math.round((estimatedInputTokens / inputTokenLimit) * 1000) / 1000;
  const level =
    usedRatio >= CONTEXT_URGENT_RATIO
      ? 'urgent'
      : usedRatio >= CONTEXT_NOTICE_RATIO
        ? 'notice'
        : 'ok';
  return {
    inputTokenLimit,
    estimatedInputTokens,
    usedRatio,
    level,
    ...(level === 'urgent'
      ? {
          notice:
            'Input is near the limit. Save what you still need with context.write and call context.new now. At 85% the host summarizes accumulated reads before the next model call; originals and mutation receipts remain preserved.',
        }
      : level === 'notice'
        ? {
            notice:
              'Input is filling up. Before it reaches 85%, save a working summary with context.write and call context.new. Compacted originals stay retrievable through story.list, story.search and story.read.',
          }
        : {}),
  };
}
/** Results of these host reads report contextWindow usage; action and advisor results stay untouched. */
export const CONTEXT_WINDOW_RESULT_TOOLS: ReadonlySet<string> = new Set([
  ...STORY_READ_NAMES,
  'knowledge.search',
  'knowledge.read',
  'skills.list',
  'skills.load',
  'context.read',
  'context.write',
]);
/** Static per-window reference data. Live estimates never enter the prompt: they would change what is measured. */
export function contextWindowReference(snapshot: RunSnapshot): Json | undefined {
  if (!contextToolsEnabled(snapshot)) return undefined;
  const plan = snapshot.contextPlan!;
  return {
    inputTokenLimit: plan.budget.inputTokenLimit,
    compactedExchanges: plan.compacted.length,
    retainedExchanges: plan.recentSourceRevisions.length,
    summaryChars: plan.summary?.length ?? 0,
    tools:
      'context.read, context.write, context.new, story.list, story.search, story.read, notes.list, notes.read',
  };
}
