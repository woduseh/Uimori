import { contextBudgetForModel, estimateContextTokens } from '../core/context-budget.js';
import { CONTEXT_WINDOW_RESULT_TOOLS } from '../core/context-tools.js';
import {
  CONTEXT_RETRIEVAL_GUIDANCE,
  CONTEXT_SUMMARY_SEMANTICS,
  contextSummaryPolicy,
} from '../core/context-summary-policy.js';
import { generationFromModel } from '../core/model-capabilities.js';
import {
  executeProvider,
  transportConnection,
  type Json,
  type ProviderRequest,
} from '../core/transport.js';
import type { RunSnapshot, ToolEvent, Usage } from '../core/types.js';
import { encodeMainPreview } from './main-request.js';
import type { MainHooks } from './model-runner.js';

/** Only completed reads may be replaced. Mutation receipts and advisor outputs stay exact. */
export const compactableRead = (event: ToolEvent) =>
  !event.denied && event.name !== 'context.write' && CONTEXT_WINDOW_RESULT_TOOLS.has(event.name);

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Carry only metadata actually returned by a host read, never a claim that its question is solved. */
function returnedReadMetadata(event: ToolEvent): Json | undefined {
  const result = record(event.result);
  if (!result) return undefined;
  const pick = (value: Record<string, unknown>, keys: string[]): Record<string, Json> =>
    Object.fromEntries(
      keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key] as Json])
    );
  if (event.name === 'story.read')
    return pick(result, [
      'sceneNumber',
      'sceneScope',
      'source',
      'keptRanges',
      'excludedRanges',
      'rangeSemantics',
      'totalChars',
      'truncated',
      'nextOffset',
    ]);
  if (event.name === 'story.search' && Array.isArray(result.results))
    return {
      ...pick(result, ['sceneScope', 'total', 'nextOffset']),
      results: result.results.flatMap((item) => {
        const found = record(item);
        return found ? [pick(found, ['sceneNumber', 'source', 'truncated', 'nextOffset'])] : [];
      }),
    };
  if (event.name === 'notes.read')
    return pick(result, [
      'id',
      'kind',
      'atRevision',
      'atHash',
      'author',
      'range',
      'totalChars',
      'nextOffset',
    ]);
  if (event.name === 'knowledge.read' || event.name === 'skills.load')
    return pick(result, ['source', 'range', 'totalLength', 'truncated', 'continuation']);
  return undefined;
}

/** A transient, source-attributed summary for this run, never a canonical checkpoint. */
export async function compactToolReads(
  snapshot: RunSnapshot,
  events: ToolEvent[],
  hooks: MainHooks,
  usage: Usage,
  estimateProjectedInputTokens: (events: ToolEvent[]) => number
): Promise<ToolEvent[]> {
  const reads = events.filter(compactableRead);
  if (!reads.length) throw new Error('CONTEXT_TOOL_RESULTS_TOO_LARGE');
  const target = snapshot.profile?.contextModel;
  if (!target || target.enabled === false) throw new Error('MODEL_REQUIRED:context');
  const last = reads.at(-1)!;
  // Exact retrieval arguments survive model summarization, including earlier segment references.
  const references = Array.from(
    new Map(
      reads
        .flatMap((event) => {
          const result = event.result as { kind?: string; references?: Json[] } | null;
          if (result?.kind === 'host-compacted-reads' && Array.isArray(result.references))
            return result.references;
          const returned = returnedReadMetadata(event);
          return [
            {
              name: event.name,
              args: event.args,
              ...(returned !== undefined ? { returned } : {}),
            } as Json,
          ];
        })
        .map((reference) => [JSON.stringify(reference), reference])
    ).values()
  );
  const project = (summary: string): ToolEvent[] => {
    const compacted: ToolEvent = {
      ...last,
      result: {
        kind: 'host-compacted-reads',
        summary,
        references,
        guidance:
          'This derived summary replaces earlier read results only. References retain the original read arguments and returned source metadata, not a verdict that the request is answered. Completed mutation receipts remain separate and must not be replayed. ' +
          CONTEXT_RETRIEVAL_GUIDANCE,
      } satisfies Record<string, Json>,
    };
    return events.flatMap((event) =>
      event === last ? [compacted] : compactableRead(event) ? [] : [event]
    );
  };
  // Size the exact fresh host projection, including retained metadata and mutation receipts.
  // The caller still measures and admits the completed candidate after generation.
  const fixedInputTokens = estimateProjectedInputTokens(project(''));
  let remaining = JSON.stringify(reads),
    summary = '';
  const budget = contextBudgetForModel(target);
  const { targetSummaryTokens, generation } = contextSummaryPolicy({
    purpose: 'tool-results',
    consumerInputTokenLimit: snapshot.contextPlan!.budget.inputTokenLimit,
    generation: generationFromModel(target),
    fixedInputTokens,
  });
  const requestFor = (part: string): ProviderRequest => ({
    role: 'context',
    modelId: target.modelId,
    pricingSnapshot: target.pricingSnapshot,
    generation,
    contextBudget: budget,
    stable: {
      contract: `Summarize completed read-only tool exchanges as temporary reference data for this ongoing request. Merge previousSummary and the complete supplied part; a part may end mid-JSON. This is not a story checkpoint or a final answer. ${CONTEXT_SUMMARY_SEMANTICS}\n${CONTEXT_RETRIEVAL_GUIDANCE}\nOrganize the summary around retrieved evidence, remaining questions and the next needed action. Preserve what the supplied metadata says was returned, including partial or filtered ranges, without treating the entire source or answer as verified. Exact retrieval metadata is retained separately by the host. Return only a complete concise summary, at most about ${targetSummaryTokens} tokens for old and new information together; the output limit is safety headroom, not the target length.`,
      tools: [],
    },
    input: {
      task: snapshot.request,
      controls: { purpose: 'tool-result-compaction', targetSummaryTokens },
      source: { previousSummary: summary, part },
    },
  });
  while (remaining.length) {
    hooks.signal.throwIfAborted();
    if (usage.modelCalls + 2 > snapshot.settings.maxCalls)
      throw new Error('CONTEXT_TOOL_COMPACTION_CALL_LIMIT');
    let lo = 0,
      hi = remaining.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (
        estimateContextTokens(
          encodeMainPreview(requestFor(remaining.slice(0, mid)), target).body
        ) <=
        budget.inputTokenLimit * 0.8
      )
        lo = mid;
      else hi = mid - 1;
    }
    if (lo > 0 && lo < remaining.length && /[\uD800-\uDBFF]/u.test(remaining[lo - 1])) lo--;
    if (!lo) throw new Error('CONTEXT_TOOL_COMPACTION_FIXED_INPUT_TOO_LARGE');
    const authorize = async () => {
      hooks.signal.throwIfAborted();
      const authorized = await hooks.authorize(structuredClone(target.connection));
      if (
        !authorized.enabled ||
        authorized.id !== target.connectionId ||
        authorized.protocol !== target.connection.protocol ||
        authorized.endpoint !== target.connection.endpoint ||
        authorized.credentialEnv !== target.connection.credentialEnv
      )
        throw new Error('CONNECTION_NOT_AUTHORIZED');
      return authorized;
    };
    const authorized = await authorize();
    let attempt: string | undefined;
    const result = await executeProvider(
      transportConnection(authorized),
      requestFor(remaining.slice(0, lo)),
      {
        approvedOrigins: hooks.approvedOrigins,
        signal: hooks.signal,
        resolveCredential: hooks.resolveCredential,
        executeCodex: hooks.executeCodex,
        timeoutMs: hooks.timeoutMs ?? target.timeoutMs,
        vertexRequestTier: hooks.vertexRequestTier,
        onWire: async (wire) => {
          await authorize();
          attempt = await hooks.onAttemptStart(wire);
          usage.modelCalls++;
          await authorize();
        },
      }
    );
    if (attempt !== undefined) {
      for (const key of ['inputTokens', 'outputTokens', 'costUsd'] as const)
        usage[key] =
          usage[key] === null || result.usage[key] === null ? null : usage[key] + result.usage[key];
      await hooks.onAttemptFinish(attempt, { ...structuredClone(result), opaqueState: null });
    }
    hooks.signal.throwIfAborted();
    if (result.status !== 'completed' || result.error || result.refusal || !result.text.trim())
      throw new Error(
        result.error?.code === 'UNEXPECTED_EOF'
          ? 'CONTEXT_TOOL_COMPACTION_EOF'
          : 'CONTEXT_TOOL_COMPACTION_FAILED'
      );
    if (!attempt) throw new Error('CONTEXT_ATTEMPT_MISSING');
    summary = result.text;
    remaining = remaining.slice(lo);
  }
  return project(summary);
}
