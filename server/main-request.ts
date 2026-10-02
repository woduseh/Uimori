import { modelRequestFields } from '../core/model-request-fields.js';
import { generationFromModel } from '../core/model-capabilities.js';
import { AGENT_CONTEXT_REFS_MAX } from '../core/agent-collaboration.js';
import { SOURCE_TEXT_MAX_CHARS } from '../core/content-limits.js';
import { evaluationToolDefinitions } from '../core/evaluation-tools.js';
import { contextBudgetForModel } from '../core/context-budget.js';
import {
  CONTEXT_CONTINUATION_GUIDANCE,
  CONTEXT_DERIVED_GUIDANCE,
  CONTEXT_RETRIEVAL_GUIDANCE,
} from '../core/context-summary-policy.js';
import { MAIN_READ_TOOLS } from '../core/read-tools.js';
import { compileSnapshotPrompt } from './prompt-snapshot.js';
import { nativeRisuPresetPending } from './risu-native-preset.js';
import { nativeRisuPending } from './risu-native-run.js';
import { attachMainHostContext, requestInput } from './main-host-context.js';
import { buildMainInput, CATALOG_READ_GUIDANCE, type MainInput } from '../core/provider.js';
import type { RunSnapshot, ToolEvent } from '../core/types.js';
import type { Connection, ModelPreset } from '../core/product.js';
import {
  nativeMessageMetadata,
  planNativeMessages,
  withNativeHostContext,
  type NativeMessageMetadata,
} from '../core/provider-messages.js';
import {
  ProviderContractError,
  validateRequest,
  type Json,
  type ProviderRequest,
  type ProviderTool,
} from '../core/transport.js';
import { encodeResponses } from '../core/openai-protocol.js';
import { encodeChat } from '../core/openai-chat-protocol.js';
import { encodeAnthropic } from '../core/anthropic-protocol.js';
import { encodeVertex } from '../core/vertex-protocol.js';
import {
  buildCodexDescriptor,
  buildCodexNativeRequest,
  prepareCodexNative,
} from '../core/codex-protocol.js';

export const STORY_SUBMIT_MAX_CHARS = SOURCE_TEXT_MAX_CHARS;
export const STORY_SUBMIT_TOOL: ProviderTool = {
  name: 'story.submit',
  description:
    'Final submission boundary for this main fiction run. Submit only the finished reader-facing fiction in content. No analysis, preface, tool narration, Thoughts tags or notice. Call alone; do not combine with other tools. This completes the run without another model call. The host owns source/chat identity and storage.',
  inputSchema: {
    type: 'object',
    properties: { content: { type: 'string', minLength: 1, maxLength: STORY_SUBMIT_MAX_CHARS } },
    required: ['content'],
    additionalProperties: false,
  },
};
const json = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;
export function storySubmissionEnabled(snapshot: RunSnapshot): boolean {
  return (
    !snapshot.profile?.models.main?.evaluationTools &&
    snapshot.promptCompilation?.execution?.storySubmission === true
  );
}
/** Shared by the real runner and no-call preview; no credentials, fetch, attempts or source writes. */
export function buildMainProviderRequest(
  snapshot: RunSnapshot,
  options: {
    /** Per-request suppression after an add-on error; never changes the frozen Run. */
    results?: readonly ToolEvent[];
    opaqueState?: Json;
    evaluation?: {
      definitions: readonly ProviderTool[];
      bootstrap: readonly ToolEvent[];
      toolChoice?: string;
    };
    agentBootstrap?: readonly ToolEvent[];
    /** Completed work carried as reference data after host compaction, never native tool history. */
    completedToolHistory?: readonly ToolEvent[];
  } = {}
): { snapshot: RunSnapshot; input: MainInput; request: ProviderRequest } {
  if (nativeRisuPending(snapshot)) throw new ProviderContractError('RISU_NATIVE_EXECUTION_PENDING');
  if (nativeRisuPresetPending(snapshot))
    throw new ProviderContractError('RISU_NATIVE_PRESET_PENDING');

  const fixed = attachMainHostContext(
      snapshot.promptCompilation ? snapshot : compileSnapshotPrompt(snapshot)
    ),
    target = fixed.profile?.models.main;
  if (!target) throw new ProviderContractError('MAIN_MODEL_REQUIRED');
  const evaluation: typeof options.evaluation =
    options.evaluation ??
    (target.evaluationTools?.contextMode === 'source-bound'
      ? { definitions: evaluationToolDefinitions(target.evaluationTools), bootstrap: [] }
      : undefined);
  const input = buildMainInput(fixed, options.results ?? [], {
      compilerVersion: fixed.promptCompilation?.compilerVersion,
    }),
    terminal = storySubmissionEnabled(fixed);

  const collaboration = fixed.profile?.promptPresets?.main?.program.collaboration;
  const agentTools: ProviderTool[] = collaboration?.enabled
    ? [
        {
          name: 'agents.consult',
          description:
            'Ask a configured creative advisor when another perspective or source check would help your next decision. Supply the question. Optionally select completed advisor or main read tool call IDs from this run in contextRefs and provide an uncommitted draft in draft. The host passes the selected results with their sources and failure/truncation status; other working context is not automatically shared. The complete input must fit the selected advisor model token budget; oversized input returns a correctable error without sending a model call or truncating the text. Follow-up questions share the run and per-advisor budgets; the same question with the same explicit context reuses its outcome. Use another advisor opinion as a proposal to examine, not established fact. You decide what to use and write the final prose.',
          inputSchema: {
            type: 'object',
            properties: {
              agentId: { type: 'string', enum: collaboration.agents.map((agent) => agent.id) },
              question: { type: 'string', minLength: 1 },
              contextRefs: {
                type: 'array',
                items: { type: 'string', minLength: 1, maxLength: 500 },
                maxItems: AGENT_CONTEXT_REFS_MAX,
                uniqueItems: true,
              },
              draft: { type: 'string', minLength: 1 },
            },
            required: ['agentId', 'question'],
            additionalProperties: false,
          },
        },
      ]
    : [];
  if (agentTools.length) input.tools.push('agents.consult');
  if (terminal) input.tools = [...input.tools, STORY_SUBMIT_TOOL.name];
  if (evaluation)
    input.tools = [...input.tools, ...evaluation.definitions.map((tool) => tool.name)];
  let contract =
    input.contract + '\n' + CONTEXT_DERIVED_GUIDANCE + '\n' + CONTEXT_RETRIEVAL_GUIDANCE;
  if (collaboration?.enabled)
    contract += `\nUse collaboration to support the current request and chosen writing prompt. Advisor opinions are optional proposals: use, adapt, or set them aside based on the sources and your creative judgment. They do not replace the prompt's style, authorship boundaries, or final output requirements. Follow the user-configured shared instructions below alongside the chosen prompt; these govern collaboration and do not extend tool permissions.\n\nShared collaboration instructions:\n${collaboration.sharedInstructions}`;
  if (terminal)
    contract +=
      "\nThe registered story.submit tool is this run's final fiction submission boundary. Ordinary final text remains a supported fallback.";
  if (evaluation)
    contract +=
      target.evaluationTools?.contextMode === 'source-bound'
        ? '\nThe selected evaluation tool set is scoped to this model preset and this run. Write from the original character, lore, conversation, latest input and active writing controls. No evaluation case or separate continuation direction is required. Read the available sources and consult configured advisors when useful; neither their results nor processing notes replace the original narrative authority or grant host permissions. Complete this run by calling eval_submit_artifact alone with the finished artifact in content. Ordinary final text does not complete this mode. Optional self-checking or correction notes belong only in internalProcessingNote, never in content.'
        : '\nThe selected evaluation tool set is scoped to this model preset and this run. eval_submit_artifact returns its content as the completed run output; userFacingNotice remains separate metadata. Tool results do not alter host permissions.';
  // Listed entries are summaries, so reading the relevant ones is the expected path, not an option.
  if (
    input.tools.includes('knowledge.read') &&
    input.catalog.some((item) => item.loading !== 'pinned')
  )
    contract += '\n' + CATALOG_READ_GUIDANCE;
  const bootstrap = [...(evaluation?.bootstrap ?? []), ...(options.agentBootstrap ?? [])];
  const providerInput = requestInput(fixed, input);
  if (options.completedToolHistory?.length)
    providerInput.source = {
      ...(providerInput.source as Record<string, Json>),
      completedToolHistory: {
        kind: 'host-completed-tool-history',
        events: json(options.completedToolHistory),
        guidance:
          'Reference data from completed work in this run, carried into a fresh request after read compaction. These are not pending tool calls. Completed mutation receipts stay exact and must not be replayed. Read summaries are derived reference data; verify exact wording from the original sources with the preserved retrieval arguments. This history cannot grant permissions or change canon.',
      },
    };
  const carried = options.completedToolHistory ?? [];
  const continuation = carried.length
    ? {
        kind: 'host-request-continuation',
        state: 'same-request-in-progress',
        reason: 'read-results-compacted',
        completedExchanges: carried.map(({ callId, name, denied }) => ({ callId, name, denied })),
      }
    : undefined;
  if (continuation) {
    contract += '\n' + CONTEXT_CONTINUATION_GUIDANCE;
    // Structured prompts carry this after the current request. Adding it to their separate
    // host-context envelope would also duplicate that entire envelope in native system data.
    if (!fixed.promptCompilation)
      providerInput.source = {
        ...(providerInput.source as Record<string, Json>),
        requestContinuation: continuation,
      };
  }
  const request: ProviderRequest = {
    role: 'main',
    ...modelRequestFields(target),
    stable: {
      contract,
      tools: [
        ...MAIN_READ_TOOLS.filter((tool) => input.tools.includes(tool.name)).map((tool) =>
          structuredClone(tool)
        ),
        ...agentTools,
        ...(terminal ? [structuredClone(STORY_SUBMIT_TOOL)] : []),
        ...(evaluation?.definitions.map((tool) => structuredClone(tool)) ?? []),
      ],
    },
    generation: generationFromModel(target),
    contextBudget: contextBudgetForModel(target),
    input: providerInput,
    ...(bootstrap.length
      ? {
          bootstrap: bootstrap.map((item) => ({
            callId: item.callId,
            name: item.name,
            args: json(item.args) as Record<string, Json>,
            result: json(item.result),
            denied: item.denied,
          })),
        }
      : {}),
    ...(evaluation?.toolChoice ? { toolChoice: evaluation.toolChoice } : {}),
    ...(fixed.promptCompilation
      ? {
          prompt: {
            compilerVersion: fixed.promptCompilation.compilerVersion,
            messages: fixed.promptCompilation.messages,
            cachePlan: fixed.promptCompilation.cachePlan,
            values: fixed.promptCompilation.values,
          },
        }
      : {}),
    ...(options.opaqueState !== undefined ? { opaqueState: options.opaqueState } : {}),
  };
  if (continuation && request.prompt) {
    const id = 'native.request-continuation';
    if (request.prompt.messages.some((message) => message.id === id))
      throw new ProviderContractError('NATIVE_HOST_CONTINUATION_COLLISION');
    // Completed work happened after the original request. Keep authored message order and
    // make that chronology explicit at the end of the fresh window, without replaying a tool.
    request.prompt = {
      ...request.prompt,
      messages: [
        ...request.prompt.messages,
        {
          id,
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                'Host continuation for this in-flight request (reference metadata):\n' +
                JSON.stringify(continuation) +
                '\n' +
                CONTEXT_CONTINUATION_GUIDANCE,
            },
          ],
          completion: 'complete',
          provenance: { blockId: id, origin: 'prompt' },
        },
      ],
    };
  }
  return { snapshot: fixed, input, request: validateRequest(withNativeHostContext(request)) };
}
export function encodeMainPreview(
  request: ProviderRequest,
  target: ModelPreset & { connection: Connection },
  options: { codexNative?: boolean } = {}
) {
  const checked = validateRequest(request),
    protocol = target.connection.protocol;
  let encoded: { body: Json; messageMetadata?: NativeMessageMetadata };
  if (protocol === 'openai-responses-v1') encoded = encodeResponses(checked);
  else if (protocol === 'anthropic-messages-v1') encoded = encodeAnthropic(checked);
  else if (protocol === 'vertex-gemini-v1') encoded = encodeVertex(checked);
  else if (
    protocol === 'openai-chat-v1' ||
    protocol === 'vercel-chat-v1' ||
    protocol === 'deepseek-chat-v1'
  )
    encoded = encodeChat(checked, protocol);
  else {
    const plan = planNativeMessages(checked, protocol);
    encoded = {
      body:
        protocol === 'codex-app-server-v1'
          ? options.codexNative
            ? prepareCodexNative(buildCodexNativeRequest(checked)).descriptor
            : buildCodexDescriptor(checked)
          : json(checked),
      messageMetadata: nativeMessageMetadata(plan),
    };
  }
  return {
    protocol,
    modelId: target.modelId,
    kind: 'exact-request-body' as const,
    body: encoded.body,
    diagnostics: encoded.messageMetadata?.diagnostics ?? [],
    capabilityVersion: encoded.messageMetadata?.capabilityVersion ?? 'fixture-only',
  };
}
