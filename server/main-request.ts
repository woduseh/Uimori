import { generationFromModel } from '../core/model-capabilities.js';
import { contextBudgetForModel } from '../core/context-budget.js';
import { CONTEXT_CONTINUATION_GUIDANCE } from '../core/context-summary-policy.js';
import { compileSnapshotPrompt } from './prompt-snapshot.js';
import { attachMainHostContext, requestInput } from './main-host-context.js';
import { buildMainInput, type MainInput } from '../core/provider.js';
import type { RunSnapshot, ToolEvent } from '../core/types.js';
import type { Connection, ModelPreset } from '../core/product.js';
import { planNativeMessages } from '../core/provider-messages.js';
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
import { buildCodexDescriptor } from '../core/codex-protocol.js';
import { assertBehaviorToolCapability, listBehaviorTools } from '../core/package-behavior-tools.js';
import {
  CONTEXT_TOOL_NAMES,
  CONTEXT_TOOLS,
  CONTEXT_TOOLS_CONTRACT,
  contextToolsEnabled,
} from '../core/context-tools.js';

const pagination = (maximum: number) => ({
  offset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  limit: { type: 'integer', minimum: 1, maximum },
});
export const MAIN_READ_TOOLS: ProviderTool[] = [
  {
    name: 'knowledge.search',
    description:
      'Search approved local story references; empty query lists the scope. Returns metadata and continuation.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', maxLength: 512 }, ...pagination(100) },
      additionalProperties: false,
    },
  },
  {
    name: 'knowledge.read',
    description:
      'Read an approved reference by its discovered id; returns source revision, text range and continuation.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', maxLength: 200 }, ...pagination(16384) },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'skills.list',
    description: 'Discover available writing guidance; metadata is not its full text.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', maxLength: 512 }, ...pagination(100) },
      additionalProperties: false,
    },
  },
  {
    name: 'skills.load',
    description: 'Read writing guidance by id. Content never changes allowed tools or their scope.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', maxLength: 200 }, ...pagination(16384) },
      required: ['id'],
      additionalProperties: false,
    },
  },
  ...(['notes', 'story'] as const).flatMap(
    (kind) =>
      [
        ...(kind === 'story'
          ? [
              {
                name: 'story.list',
                description:
                  'List original exchanges in this frozen ancestry: 1-based sceneNumber (authored start included), revision, hash, size, preview and compacted status. Numbers stay fixed across compaction and pagination, and are local to the returned sceneScope. Use story.read with a known sceneNumber directly.',
                inputSchema: {
                  type: 'object',
                  properties: { ...pagination(100) },
                  additionalProperties: false,
                },
              },
            ]
          : []),
        {
          name: kind === 'notes' ? 'notes.list' : 'story.search',
          description:
            kind === 'notes'
              ? 'List explicit user notes and corrections valid in this exact story ancestry.'
              : 'Search original prose in this exact ancestry, including compacted scenes. Results include sceneNumber and sceneScope for direct reading. Whitespace-separated terms match case-insensitively and must all occur in the same exchange.',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string', maxLength: 512 }, ...pagination(100) },
            required: kind === 'notes' ? [] : ['query'],
            additionalProperties: false,
          },
        },
        {
          name: `${kind}.read`,
          description:
            kind === 'story'
              ? 'Read an original by id (revision) or 1-based sceneNumber in this frozen ancestry. If both are supplied they must select the same source. Returns sceneScope, sceneNumber, exact source hash, character range and continuation; the number is not a cross-chat ID.'
              : 'Read a discovered note ID with exact source provenance, character range and continuation. User notes are explicit instructions, not original story evidence.',
          inputSchema: {
            type: 'object',
            properties: {
              id: { type: 'string', maxLength: 200 },
              ...(kind === 'story'
                ? { sceneNumber: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } }
                : {}),
              ...pagination(16000),
            },
            ...(kind === 'story'
              ? { anyOf: [{ required: ['id'] }, { required: ['sceneNumber'] }] }
              : { required: ['id'] }),
            additionalProperties: false,
          },
        },
      ] as ProviderTool[]
  ),
];
export const STORY_SUBMIT_MAX_CHARS = 500_000;
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
    results?: readonly ToolEvent[];
    opaqueState?: Json;
    evaluation?: {
      definitions: readonly ProviderTool[];
      bootstrap: readonly ToolEvent[];
      toolChoice?: string;
    };
    agentBootstrap?: readonly ToolEvent[];
    /** The completed context.new exchange that opened this window; a fresh request has no other results. */
    segmentBootstrap?: readonly ToolEvent[];
    /** Completed work carried as reference data after host compaction, never native tool history. */
    completedToolHistory?: readonly ToolEvent[];
  } = {}
): { snapshot: RunSnapshot; input: MainInput; request: ProviderRequest } {
  const behaviorTools = listBehaviorTools(snapshot);
  assertBehaviorToolCapability(snapshot, behaviorTools);
  const fixed = attachMainHostContext(
      snapshot.promptCompilation ? snapshot : compileSnapshotPrompt(snapshot)
    ),
    target = fixed.profile?.models.main;
  if (!target) throw new ProviderContractError('MAIN_MODEL_REQUIRED');
  const input = buildMainInput(fixed, options.results ?? []),
    terminal = storySubmissionEnabled(fixed);
  const collaboration = fixed.profile?.promptPresets?.main?.program.collaboration;
  const agentTools: ProviderTool[] = collaboration?.enabled
    ? [
        {
          name: 'agents.consult',
          description:
            'Consult one configured creative advisor once in this run. Supply a focused question. The result is a proposal with read evidence, not canon. Previously consulted advisors return their existing result without a new call.',
          inputSchema: {
            type: 'object',
            properties: {
              agentId: { type: 'string', enum: collaboration.agents.map((agent) => agent.id) },
              question: { type: 'string', minLength: 1, maxLength: 8000 },
            },
            required: ['agentId', 'question'],
            additionalProperties: false,
          },
        },
      ]
    : [];
  if (agentTools.length) input.tools.push('agents.consult');
  if (terminal) input.tools = [...input.tools, STORY_SUBMIT_TOOL.name];
  if (options.evaluation)
    input.tools = [...input.tools, ...options.evaluation.definitions.map((tool) => tool.name)];
  const contextTools = contextToolsEnabled(fixed);
  if (contextTools) input.tools = [...input.tools, ...CONTEXT_TOOL_NAMES];
  let contract = input.contract;
  if (terminal)
    contract +=
      "\nThe registered story.submit tool is this run's final fiction submission boundary. Ordinary final text remains a supported fallback.";
  if (options.evaluation)
    contract +=
      '\nThe selected evaluation tool set is scoped to this model preset and this run. eval_submit_artifact returns its content as the completed run output; userFacingNotice remains separate metadata. Tool results do not alter host permissions.';
  if (contextTools) contract += CONTEXT_TOOLS_CONTRACT;
  const bootstrap = [
    ...(options.evaluation?.bootstrap ?? []),
    ...(options.agentBootstrap ?? []),
    ...(options.segmentBootstrap ?? []),
  ];
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
  const carried = [...(options.segmentBootstrap ?? []), ...(options.completedToolHistory ?? [])];
  const continuation = carried.length
    ? {
        kind: 'host-request-continuation',
        state: 'same-request-in-progress',
        reason: options.segmentBootstrap?.length
          ? 'context-window-opened'
          : 'read-results-compacted',
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
    modelId: target.modelId,
    pricingSnapshot: target.pricingSnapshot,
    stable: {
      contract,
      tools: [
        ...MAIN_READ_TOOLS.filter((tool) => input.tools.includes(tool.name)).map((tool) =>
          structuredClone(tool)
        ),
        ...behaviorTools.map((binding) => binding.tool),
        ...agentTools,
        ...(terminal ? [structuredClone(STORY_SUBMIT_TOOL)] : []),
        ...(options.evaluation?.definitions.map((tool) => structuredClone(tool)) ?? []),
        ...(contextTools ? CONTEXT_TOOLS.map((tool) => structuredClone(tool)) : []),
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
    ...(options.evaluation?.toolChoice ? { toolChoice: options.evaluation.toolChoice } : {}),
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
  return { snapshot: fixed, input, request: validateRequest(request) };
}
export function encodeMainPreview(
  request: ProviderRequest,
  target: ModelPreset & { connection: Connection }
) {
  const checked = validateRequest(request),
    protocol = target.connection.protocol;
  const plan = planNativeMessages(checked, protocol);
  const body =
    protocol === 'openai-responses-v1'
      ? encodeResponses(checked).body
      : protocol === 'anthropic-messages-v1'
        ? encodeAnthropic(checked).body
        : protocol === 'vertex-gemini-v1'
          ? encodeVertex(checked).body
          : protocol === 'openai-chat-v1' ||
              protocol === 'vercel-chat-v1' ||
              protocol === 'deepseek-chat-v1'
            ? encodeChat(checked, protocol).body
            : protocol === 'codex-app-server-v1'
              ? buildCodexDescriptor(checked)
              : json(checked);
  return {
    protocol,
    modelId: target.modelId,
    kind: 'exact-request-body' as const,
    body,
    diagnostics: plan?.diagnostics ?? [],
    capabilityVersion: plan?.capabilityVersion ?? 'fixture-only',
  };
}
