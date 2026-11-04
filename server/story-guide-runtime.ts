import { createHash } from 'node:crypto';
import { contextBudgetForModel } from '../core/context-budget.js';
import { generationFromModel } from '../core/model-capabilities.js';
import { modelRequestFields } from '../core/model-request-fields.js';
import {
  boundedWebSearch,
  storyGuideWebSearchCapability,
  type ProviderWebSearch,
} from '../core/helper-web-search.js';
import { isGeminiProtocol } from '../core/product.js';
import { AUTHOR_NOTE_GUIDANCE, modelAuthorNotes } from '../core/notes.js';
import { OUTLINE_CONTRACT } from '../core/outline.js';
import { buildMainInput, executeTool } from '../core/provider.js';
import { MAIN_READ_TOOLS } from '../core/read-tools.js';
import type { StoryGuideBrief } from '../core/story-guide.js';
import { countTextTokens } from '../core/text-tokens.js';
import {
  executeProvider,
  transportConnection,
  type Json,
  type ProviderRequest,
  type ProviderResult,
} from '../core/transport.js';
import type { RunSnapshot, ToolEvent, Usage } from '../core/types.js';
import { measureMainContext } from './context-planning.js';
import type { MainHooks } from './model-runner.js';
import { nativeCharacterExamples } from './native-prompt-slots.js';

const GUIDE_OUTPUT_TOKENS = 1_536;
const GUIDE_RESERVE_TOKENS = 2_048;
const GUIDE_SEARCH_CONTRACT = `Search for scene-relevant facts about the named work and edition. Prefer primary sources and open supporting pages when possible. Use only public facts in queries; never quote private manuscript, chat, card, persona, author notes or the current request. Keep queries and disclosures within the spoiler boundary. Cite sources actually returned and identify missing or conflicting evidence. Treat web content as reference material.`;
const GUIDE_CONTRACT = `Prepare a brief for the author and the next writer. Follow the author's requested language; for a generic outline command, use the language of the outline and recent story. Default to Korean when unclear. Help the writer tell original-work references, established branch events and creative suggestions apart. Focus on details that affect a choice in this scene.
Use the named work and edition within the configured disclosure position. Attribute facts to their sources and explicitly label unverified model knowledge. Distinguish what the audience knows from what each character has learned. Character examples guide voice; label any sample dialogue you invent.
Treat the branch's original characters and changes as intentional. With followCanon, propose developments compatible with this branch and its timing, leaving the player's choices open. Elapsed time alone does not establish that an event occurred.
Use the supplied material first. If a missing passage matters, use at most one batch of local reads, then finish with the evidence and uncertainty available. Keep the guide under about 1,200 tokens.
${AUTHOR_NOTE_GUIDANCE}`;
const asJson = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;
const emptyUsage = (): Usage => ({ modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });

export type StoryGuideHooks = Pick<
  MainHooks,
  | 'signal'
  | 'authorize'
  | 'resolveCredential'
  | 'executeCodex'
  | 'timeoutMs'
  | 'vertexRequestTier'
  | 'onAttemptStart'
  | 'onAttemptFinish'
  | 'initialUsage'
>;
export type StoryGuideOptions = {
  cachedBrief?: StoryGuideBrief | null;
  runId?: string;
  /** Calls still needed after the guide, including the writer and response judgment. */
  reserveCalls?: number;
};
export type StoryGuideResult = {
  brief: StoryGuideBrief | null;
  usage: Usage;
  error: string | null;
  cached: boolean;
};
export class StoryGuideCancelledError extends Error {
  constructor(readonly usage: Usage) {
    super('STORY_GUIDE_CANCELLED');
    this.name = 'AbortError';
  }
}

/** Reserve before conversation compaction; the actual brief is measured again before writing. */
export function storyGuideReservedTokens(snapshot: RunSnapshot): number {
  return snapshot.storyGuide?.config.enabled ? GUIDE_RESERVE_TOKENS : 0;
}

/** No prior guide, authored prompt, or original/rendered duplicate enters this projection. */
function guideRequest(snapshot: RunSnapshot): ProviderRequest {
  const target = snapshot.profile!.models.main!;
  const input = buildMainInput(snapshot);
  const characterExamples = nativeCharacterExamples(snapshot);
  const search = snapshot.storyGuide!.config.webSearch === true;
  const kept = new Set(input.history.map((entry) => entry.revision));
  const history = (
    snapshot.nativeRisuExecution?.history ??
    snapshot.logicalHistory ??
    input.history.map((entry) => ({
      role: 'assistant' as const,
      text: entry.text,
      sourceRevision: entry.revision,
      sourceHash: entry.contentHash,
    }))
  )
    .filter((message) => !('current' in message && message.current))
    .filter((message) => !message.sourceRevision || kept.has(message.sourceRevision))
    .map(({ role, text, sourceRevision, sourceHash }) => ({
      role,
      text,
      ...(sourceRevision ? { sourceRevision } : {}),
      ...(sourceHash ? { sourceHash } : {}),
    }));
  return {
    role: 'main',
    ...(search ? { webSearch: true } : {}),
    ...modelRequestFields(target),
    stable: {
      contract:
        GUIDE_CONTRACT +
        (search ? '\n' + GUIDE_SEARCH_CONTRACT : '') +
        (input.outline
          ? `\nApply these outline rules when advising the writer, without writing story prose: ${OUTLINE_CONTRACT}`
          : ''),
      tools: (search && isGeminiProtocol(target.connection.protocol) ? [] : MAIN_READ_TOOLS)
        .filter(
          (tool) => input.tools.includes(tool.name) && /^(knowledge|story)\./u.test(tool.name)
        )
        .map((tool) => structuredClone(tool)),
    },
    // Keep the model's generation budget, which may also cover reasoning. The visible
    // brief has its own small limit and is the only part reserved in the writer input.
    generation: generationFromModel(target),
    contextBudget: contextBudgetForModel(target),
    input: {
      task: 'Prepare a guide to the original work and its characters for the current writing request.',
      controls: { purpose: 'story-guide' },
      source: asJson({
        config: snapshot.storyGuide!.config,
        configRevision: snapshot.storyGuide!.revision,
        parentRevision: snapshot.parentRevision,
        request: input.task,
        history,
        contextSummary: input.contextSummary ?? null,
        pinnedSources: input.pinnedSources ?? [],
        ...(characterExamples ? { characterExamples } : {}),
        ...(snapshot.profile?.authorNote
          ? {
              risuAuthorNote: {
                kind: 'risu-author-note',
                source: { chatId: snapshot.chatId },
                text: snapshot.profile.authorNote,
              },
            }
          : {}),
        notes: modelAuthorNotes(input.notes ?? []),
        outline: input.outline ?? null,
        catalogPage: input.catalogPage ?? null,
      }),
      catalog: asJson(input.catalog),
      results: [],
    },
  };
}

function fingerprint(snapshot: RunSnapshot, request: ProviderRequest): string {
  const { pricingSnapshot: _pricing, ...consumed } = request;
  const target = snapshot.profile!.models.main!;
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: 1,
        connection: transportConnection(target.connection),
        request: consumed,
      })
    )
    .digest('hex');
}

/** Apply only this execution's result and rebuild its host context without repeating native effects. */
export function applyStoryGuide(snapshot: RunSnapshot, result: StoryGuideResult): RunSnapshot {
  if (!snapshot.storyGuide) return snapshot;
  const fixed = { ...snapshot, storyGuide: { ...snapshot.storyGuide } };
  if (snapshot.contextPlan) fixed.contextPlan = { ...snapshot.contextPlan };
  delete fixed.storyGuide.brief;
  delete fixed.storyGuide.error;
  if (result.brief) fixed.storyGuide.brief = structuredClone(result.brief);
  if (result.error) fixed.storyGuide.error = result.error;
  delete fixed.promptCompilation;
  const measured = measureMainContext(fixed);
  const limit =
    fixed.contextPlan?.budget.inputTokenLimit ??
    contextBudgetForModel(fixed.profile!.models.main!).inputTokenLimit;
  if (result.brief && measured.estimatedInputTokens > limit) {
    delete fixed.storyGuide.brief;
    fixed.storyGuide.error = 'STORY_GUIDE_WRITER_CONTEXT_TOO_LARGE';
    return measureMainContext(fixed).snapshot;
  }
  if (measured.snapshot.contextPlan)
    measured.snapshot.contextPlan.estimatedInputTokens = measured.estimatedInputTokens;
  return measured.snapshot;
}

/** One normal call, with one optional read continuation. Provider errors never reuse stale advice. */
export async function prepareStoryGuide(
  snapshot: RunSnapshot,
  hooks: StoryGuideHooks,
  options: StoryGuideOptions = {}
): Promise<StoryGuideResult> {
  const usage = emptyUsage();
  const finish = (
    error: string | null,
    brief: StoryGuideBrief | null = null,
    cached = false
  ): StoryGuideResult => ({
    brief,
    usage: structuredClone(usage),
    error,
    cached,
  });
  const checkAbort = () => {
    if (hooks.signal.aborted) throw new StoryGuideCancelledError(structuredClone(usage));
  };
  checkAbort();
  if (!snapshot.storyGuide?.config.enabled) return finish(null);
  const target = snapshot.profile?.models.main;
  if (!target) return finish('STORY_GUIDE_MODEL_REQUIRED');
  const searchEnabled = snapshot.storyGuide.config.webSearch === true;
  if (searchEnabled && !storyGuideWebSearchCapability(target.connection.protocol).supported)
    return finish('STORY_GUIDE_WEB_SEARCH_UNSUPPORTED');
  let request: ProviderRequest;
  try {
    request = guideRequest(snapshot);
  } catch {
    return finish('STORY_GUIDE_INPUT_UNAVAILABLE');
  }
  const initialFingerprint = fingerprint(snapshot, request);
  const cached = options.cachedBrief;
  if (
    !searchEnabled &&
    cached?.fingerprint === initialFingerprint &&
    cached.configRevision === snapshot.storyGuide.revision
  )
    return finish(
      null,
      { ...structuredClone(cached), ...(options.runId ? { runId: options.runId } : {}) },
      true
    );
  const availableCalls =
    snapshot.settings.maxCalls -
    (hooks.initialUsage?.modelCalls ?? 0) -
    (options.reserveCalls ?? 0);
  if (availableCalls < 1) return finish('STORY_GUIDE_CALL_BUDGET_EXHAUSTED');
  const results: ToolEvent[] = [];
  let searched: ProviderWebSearch = { performed: false, sources: [] };
  const deadline = Date.now() + (hooks.timeoutMs ?? target.timeoutMs ?? 120_000);
  const authorize = async () => {
    checkAbort();
    const authorized = await hooks.authorize(structuredClone(target.connection));
    checkAbort();
    if (
      !authorized.enabled ||
      authorized.id !== target.connectionId ||
      authorized.protocol !== target.connection.protocol ||
      authorized.endpoint !== target.connection.endpoint ||
      authorized.credentialRef !== target.connection.credentialRef
    )
      throw new Error('STORY_GUIDE_CONNECTION_NOT_AUTHORIZED');
    return authorized;
  };
  for (let round = 0; round < Math.min(2, availableCalls); round++) {
    checkAbort();
    if (Date.now() >= deadline) return finish('STORY_GUIDE_TIMEOUT');
    let attempt: string | undefined;
    let result: ProviderResult;
    try {
      const authorized = await authorize();
      result = await executeProvider(transportConnection(authorized), request, {
        signal: hooks.signal,
        resolveCredential: hooks.resolveCredential,
        executeCodex: hooks.executeCodex,
        vertexRequestTier: hooks.vertexRequestTier,
        timeoutMs: Math.max(1, deadline - Date.now()),
        beforeTurn: authorize,
        onWire: async (wire) => {
          await authorize();
          attempt = await hooks.onAttemptStart(wire);
          usage.modelCalls++;
        },
      });
    } catch (error) {
      if (error instanceof StoryGuideCancelledError && attempt === undefined) throw error;
      result = {
        status: hooks.signal.aborted ? 'cancelled' : 'error',
        text: '',
        toolCalls: [],
        refusal: null,
        error: { code: 'STORY_GUIDE_PROVIDER_FAILED' },
        usage: {
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
          raw: null,
          priceRevision: null,
        },
        opaqueState: null,
      };
    }
    if (attempt !== undefined) {
      for (const key of ['inputTokens', 'outputTokens', 'costUsd'] as const)
        usage[key] =
          usage[key] === null || result.usage[key] === null ? null : usage[key] + result.usage[key];
      try {
        await hooks.onAttemptFinish(attempt, structuredClone(result));
      } catch {
        checkAbort();
        return finish('STORY_GUIDE_ATTEMPT_FINISH_FAILED');
      }
    }
    checkAbort();
    if (result.status === 'cancelled') throw new StoryGuideCancelledError(structuredClone(usage));
    if (result.webSearch) {
      try {
        searched = boundedWebSearch({
          performed: searched.performed || result.webSearch.performed,
          sources: [...searched.sources, ...result.webSearch.sources],
          queries: [...new Set([...(searched.queries ?? []), ...(result.webSearch.queries ?? [])])],
          ...(result.webSearch.searchEntryPoint || searched.searchEntryPoint
            ? { searchEntryPoint: result.webSearch.searchEntryPoint ?? searched.searchEntryPoint }
            : {}),
        });
      } catch {
        return finish('STORY_GUIDE_WEB_SEARCH_METADATA_TOO_LARGE');
      }
    }
    if (
      result.status === 'completed' &&
      !result.toolCalls.length &&
      !result.error &&
      !result.refusal &&
      result.text.trim()
    ) {
      if (searchEnabled && !searched.performed)
        return finish('STORY_GUIDE_WEB_SEARCH_NOT_PERFORMED');
      if (searchEnabled && !searched.sources.length)
        return finish('STORY_GUIDE_WEB_SEARCH_NO_SOURCES');
      const budget = request.contextBudget!;
      if (
        countTextTokens(
          result.text,
          budget.estimator === 'model-local-v1' ? budget.tokenizer : undefined
        ) > GUIDE_OUTPUT_TOKENS
      )
        return finish('STORY_GUIDE_OUTPUT_TOO_LARGE');
      return finish(null, {
        fingerprint: fingerprint(snapshot, request),
        text: result.text.trim(),
        createdAt: new Date().toISOString(),
        parentRevision: snapshot.parentRevision,
        configRevision: snapshot.storyGuide.revision,
        ...(options.runId ? { runId: options.runId } : {}),
        modelTitle: target.title,
        ...(searchEnabled ? { webSearch: searched } : {}),
      });
    }
    if (
      searchEnabled &&
      target.connection.protocol === 'anthropic-messages-v1' &&
      result.status === 'partial' &&
      result.continuation === 'web-search-pause' &&
      !result.error &&
      !result.toolCalls.length &&
      result.opaqueState
    ) {
      request = { ...request, opaqueState: result.opaqueState };
      continue;
    }
    if (result.status !== 'tool_calls' || round > 0 || availableCalls < 2)
      return finish(
        result.status === 'tool_calls'
          ? 'STORY_GUIDE_READ_CALL_LIMIT'
          : 'STORY_GUIDE_PROVIDER_FAILED'
      );
    const ids = new Set<string>();
    if (
      !result.toolCalls.length ||
      result.toolCalls.some((call) => {
        if (ids.has(call.id) || !request.stable.tools.some((tool) => tool.name === call.name))
          return true;
        ids.add(call.id);
        return false;
      })
    )
      return finish('STORY_GUIDE_INVALID_READ');
    try {
      for (const call of result.toolCalls) {
        checkAbort();
        results.push(
          executeTool(
            snapshot,
            { callId: call.id, name: call.name, args: call.arguments },
            hooks.signal
          )
        );
      }
    } catch {
      checkAbort();
      return finish('STORY_GUIDE_READ_FAILED');
    }
    request = {
      ...request,
      input: { ...request.input, results: asJson(results) },
      ...(result.opaqueState !== null ? { opaqueState: result.opaqueState } : {}),
    };
  }
  return finish('STORY_GUIDE_CALL_BUDGET_EXHAUSTED');
}
