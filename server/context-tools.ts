import type { ContextCheckpointRef, ContextPlan } from '../core/context-plan.js';
import {
  CONTEXT_KEEP_RECENT_DEFAULT,
  CONTEXT_KEEP_RECENT_MAX,
  CONTEXT_SUMMARY_MAX_CHARS,
  CONTEXT_TOOL_NAMES,
  contextWindowStatus,
} from '../core/context-tools.js';
import type { ToolAction } from '../core/provider.js';
import { sourceSceneAnchors, sourceSceneScope } from '../core/source-history.js';
import type { RunSnapshot, ToolEvent } from '../core/types.js';
import {
  contextSourceRefs,
  measureMainContext,
  validateContextPlan,
  withContextProjection,
} from './context-planning.js';

/** Publishes a prepared projection as an immutable model checkpoint; the owner decides activation. */
export type ContextPersistence = (
  prepared: RunSnapshot,
  own: ContextCheckpointRef | null
) =>
  | { snapshot: RunSnapshot; activated: boolean }
  | Promise<{ snapshot: RunSnapshot; activated: boolean }>;
export type ContextToolState = {
  workingSummary: string | null;
  checkpoint: ContextCheckpointRef | null;
};
export type ContextToolOptions = {
  state: ContextToolState;
  /** context.new must be the only call of its round so no sibling result is dropped undelivered. */
  alone: boolean;
  pendingResults: number;
  reservedBootstrap: number;
  persist?: ContextPersistence;
};
const MAX_BOOTSTRAP = 8;

/** Re-project the transmit input; originals, logical roles and the frozen model stay untouched. */
export function stageContextProjection(
  fixed: RunSnapshot,
  compacted: ContextPlan['compacted'],
  summary: string | null
): { snapshot: RunSnapshot; estimatedInputTokens: number } {
  const projected = withContextProjection(fixed, compacted, summary);
  const plan = { ...projected.contextPlan! };
  delete plan.checkpoint;
  const measured = measureMainContext({ ...projected, contextPlan: plan });
  if (
    !Number.isFinite(measured.estimatedInputTokens) ||
    measured.estimatedInputTokens > plan.budget.inputTokenLimit
  )
    throw new Error('CONTEXT_FIXED_INPUT_TOO_LARGE');
  const snapshot: RunSnapshot = {
    ...measured.snapshot,
    contextPlan: { ...plan, estimatedInputTokens: measured.estimatedInputTokens },
  };
  validateContextPlan(snapshot);
  return { snapshot, estimatedInputTokens: measured.estimatedInputTokens };
}

/** Size failures are the model's to fix; anything else is a host projection failure. */
const stageFailure = (error: unknown) =>
  error instanceof Error && error.message === 'CONTEXT_FIXED_INPUT_TOO_LARGE'
    ? 'CONTEXT_FIXED_INPUT_TOO_LARGE'
    : 'CONTEXT_PROJECTION_FAILED';
const summaryText = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text && text.length <= CONTEXT_SUMMARY_MAX_CHARS ? text : undefined;
};

/** One context tool call inside the main loop. Denials are host verdicts, never provider output. */
export async function executeContextTool(
  fixed: RunSnapshot,
  action: ToolAction,
  options: ContextToolOptions
): Promise<{ event: ToolEvent; switched?: RunSnapshot }> {
  const denied = (code: string, recoverable = true): { event: ToolEvent } => ({
    event: {
      callId: action.callId,
      name: action.name,
      args: {},
      result: { code },
      denied: true,
      ...(recoverable ? { errorKind: 'recoverable' as const } : {}),
    },
  });
  if (!(CONTEXT_TOOL_NAMES as readonly string[]).includes(action.name))
    return denied('TOOL_NOT_ALLOWED', false);
  const plan = fixed.contextPlan;
  if (!plan) return denied('CONTEXT_TOOLS_UNAVAILABLE', false);
  const args = action.args,
    state = options.state,
    keys = Object.keys(args);
  if (action.name === 'context.read') {
    if (keys.length) return denied('INVALID_ARGUMENTS');
    const anchors = sourceSceneAnchors(fixed);
    const numbers = new Map(anchors.map((anchor) => [anchor.revision, anchor.sceneNumber]));
    const retained = new Set(plan.recentSourceRevisions);
    return {
      event: {
        ...action,
        result: {
          savedSummary: state.workingSummary,
          windowSummary: plan.summary,
          sceneScope: sourceSceneScope(fixed),
          compacted: plan.compacted.map(({ revision, hash }) => ({
            sceneNumber: numbers.get(revision)!,
            revision,
            hash,
          })),
          retained: anchors.filter((anchor) => retained.has(anchor.revision)),
          checkpoint: state.checkpoint,
        },
        denied: false,
      },
    };
  }
  if (!options.persist) return denied('CONTEXT_TOOLS_UNAVAILABLE', false);
  const persist = async (staged: RunSnapshot) => {
    const own = state.checkpoint ?? plan.checkpoint ?? null;
    const saved = await options.persist!(staged, own);
    return { ...saved, checkpoint: saved.snapshot.contextPlan?.checkpoint ?? null };
  };
  if (action.name === 'context.write') {
    if (keys.some((key) => key !== 'summary')) return denied('INVALID_ARGUMENTS');
    const summary = summaryText(args.summary);
    if (!summary)
      return denied(typeof args.summary === 'string' ? 'SUMMARY_INVALID' : 'INVALID_ARGUMENTS');
    let staged: RunSnapshot;
    try {
      staged = stageContextProjection(fixed, plan.compacted, summary).snapshot;
    } catch (error) {
      return denied(stageFailure(error));
    }
    let saved: Awaited<ReturnType<typeof persist>>;
    try {
      saved = await persist(staged);
    } catch {
      return denied('CONTEXT_WRITE_FAILED');
    }
    state.workingSummary = summary;
    state.checkpoint = saved.checkpoint;
    return {
      event: {
        ...action,
        args: { summary },
        result: {
          saved: true,
          summaryChars: summary.length,
          checkpoint: saved.checkpoint,
          activated: saved.activated,
          appliesTo: 'next context window and later turns; the current window is unchanged',
        },
        denied: false,
      },
    };
  }
  // context.new
  if (keys.some((key) => !['keepRecent', 'summary'].includes(key)))
    return denied('INVALID_ARGUMENTS');
  if (!options.alone) return denied('CONTEXT_NEW_MUST_BE_ALONE');
  const keepRecent = args.keepRecent === undefined ? CONTEXT_KEEP_RECENT_DEFAULT : args.keepRecent;
  if (
    !Number.isSafeInteger(keepRecent) ||
    (keepRecent as number) < 0 ||
    (keepRecent as number) > CONTEXT_KEEP_RECENT_MAX
  )
    return denied('INVALID_ARGUMENTS');
  if (args.summary !== undefined && summaryText(args.summary) === undefined)
    return denied('SUMMARY_INVALID');
  const summary = args.summary === undefined ? state.workingSummary : summaryText(args.summary)!;
  const compactedCount = Math.max(
    plan.compacted.length,
    fixed.history.length - (keepRecent as number)
  );
  if (compactedCount > 0 && !summary) return denied('SUMMARY_REQUIRED');
  if (options.reservedBootstrap + 1 > MAX_BOOTSTRAP)
    return denied('CONTEXT_SEGMENT_BOOTSTRAP_LIMIT', false);
  const refs = contextSourceRefs(fixed).slice(0, compactedCount);
  let staged: ReturnType<typeof stageContextProjection>;
  try {
    staged = stageContextProjection(fixed, refs, summary);
  } catch (error) {
    return denied(stageFailure(error));
  }
  let saved: Awaited<ReturnType<typeof persist>>;
  try {
    saved = await persist(staged.snapshot);
  } catch {
    return denied('CONTEXT_WRITE_FAILED');
  }
  state.workingSummary = summary;
  state.checkpoint = saved.checkpoint ?? state.checkpoint;
  const switched = saved.snapshot;
  const retained = new Set(switched.contextPlan?.recentSourceRevisions ?? []);
  return {
    switched,
    event: {
      ...action,
      args: { keepRecent, ...(args.summary !== undefined ? { summary } : {}) },
      result: {
        switched: true,
        compactedExchanges: refs.length,
        sceneScope: sourceSceneScope(switched),
        retained: sourceSceneAnchors(switched).filter((anchor) => retained.has(anchor.revision)),
        droppedToolResults: options.pendingResults,
        checkpoint: saved.checkpoint,
        activated: saved.activated,
        contextWindow: contextWindowStatus(
          staged.estimatedInputTokens,
          plan.budget.inputTokenLimit
        ),
        guidance:
          'Earlier exchanges and tool results have left the input. Read any known [scene N] anchor directly with story.read({sceneNumber:N}); story.list/search still discover every original in this sceneScope.',
      },
      denied: false,
    },
  };
}
