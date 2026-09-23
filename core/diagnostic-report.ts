/** Sharing contract. Never extend this with arbitrary stored objects or free-form messages. */
export const DIAGNOSTIC_REPORT_VERSION = 1;
// Even eight maximum-length rejection paths per attempt fit within the byte cap.
export const DIAGNOSTIC_LIMITS = { runs: 50, attempts: 100, bytes: 262_144 } as const;
export type DiagnosticScope =
  | { scope: 'system' }
  | { scope: 'chat'; chatId: string; runId?: string };

const statuses = [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'refused',
  'partial',
  'tool_calls',
  'error',
  'mock',
  'stale',
  'ready',
  'skipped',
] as const;
const roles = [
  'main',
  'translation',
  'translation-refusal',
  'status',
  'image',
  'script',
  'context',
  'helper',
  'title',
  'illustration',
] as const;
const toolArgumentStages = ['tool_start_shape', 'tool_json_parse', 'tool_json_shape'] as const;
const protocols = [
  'typesafe-systemone-v1',
  'fixture-sse-v1',
  'vertex-gemini-v1',
  'openai-responses-v1',
  'anthropic-messages-v1',
  'vercel-chat-v1',
  'openai-chat-v1',
  'deepseek-chat-v1',
  'codex-app-server-v1',
] as const;
const errors = new Set([
  'MAIN_RESPONSE_REFUSED',
  'MAIN_REFUSAL_UNCERTAIN',
  'MAIN_JUDGMENT_CALL_BUDGET',
  'JEV_CREDENTIAL_REQUIRED',
  'JEV_EXECUTION_FAILED',
  'JEV_TIMEOUT',
  'JEV_RESPONSE_INVALID',
  'JEV_INPUT_BUDGET',
  'CANCELLED',
  'TIMEOUT',
  'CONNECTION_NOT_AUTHORIZED',
  'MODEL_CALL_BUDGET_EXHAUSTED',
  'INPUT_CONTEXT_LIMIT_EXCEEDED',
  'CONTEXT_COMPACTION_FAILED',
  'CONTEXT_COMPACTION_PARTIAL',
  'INVALID_CONTEXT_INPUT',
  'INVALID_CONTEXT_BUDGET',
  'UNEXPECTED_EOF',
  'NETWORK_ERROR',
  'CODEX_START_FAILED',
  'CODEX_CLOSED',
  'CODEX_PROTOCOL_ERROR',
  'CODEX_REQUEST_FAILED',
  'CODEX_TIMEOUT',
  'CODEX_CANCELLED',
  'INVALID_TOOL_ARGUMENTS',
  'ANTHROPIC_TOOL_INPUT_CHANGED',
  'ANTHROPIC_UNKNOWN_TOOL',
  'ANTHROPIC_TOOL_TERMINAL_MISMATCH',
]);
function member<T extends string>(value: unknown, values: readonly T[]): T | 'unknown' {
  return typeof value === 'string' && values.includes(value as T) ? (value as T) : 'unknown';
}
export const diagnosticStatus = (value: unknown) => member(value, statuses);
export const diagnosticRole = (value: unknown) => member(value, roles);
export const diagnosticProtocol = (value: unknown) => member(value, protocols);
export const diagnosticToolArgumentStage = (value: unknown) =>
  typeof value === 'string' &&
  toolArgumentStages.includes(value as (typeof toolArgumentStages)[number])
    ? (value as (typeof toolArgumentStages)[number])
    : null;
export const diagnosticToolName = (value: unknown) =>
  typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/u.test(value) ? value : null;
export function diagnosticError(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' && (errors.has(value) || /^HTTP_[45]\d{2}$/u.test(value)))
    return value;
  if (
    value === 'Provider outcome uncertain; not replayed' ||
    value === 'Provider outcome uncertain; explicit retry required'
  )
    return 'PROVIDER_OUTCOME_UNCERTAIN';
  return 'UNKNOWN_ERROR';
}
export function diagnosticNumber(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
    ? value
    : null;
}
const diagnosticFieldParts = new Set([
  'model',
  'messages',
  'role',
  'content',
  'input',
  'instructions',
  'contents',
  'parts',
  'text',
  'systemInstruction',
  'generationConfig',
  'responseMimeType',
  'responseSchema',
  'response_format',
  'json_schema',
  'schema',
  'tools',
  'tool_choice',
  'parameters',
  'temperature',
  'top_p',
  'topP',
  'topK',
  'max_tokens',
  'max_output_tokens',
  'max_completion_tokens',
  'maxOutputTokens',
  'thinkingConfig',
  'thinkingBudget',
  'thinkingLevel',
  'thinking',
  'type',
  'budget_tokens',
  'reasoning',
  'reasoning_effort',
  'effort',
  'mode',
  'context',
  'output_config',
  'verbosity',
  'stop_sequences',
  'stopSequences',
  'stop',
  'service_tier',
  'cache_control',
  'cachedContent',
  'prompt_cache_options',
  'prompt_cache_breakpoint',
  'prompt_cache_retention',
  'ttl',
]);
export function diagnosticField(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length > 128 ||
    !/^[a-zA-Z_]+(?:\[\d{1,4}\])?(?:\.[a-zA-Z_]+(?:\[\d{1,4}\])?)*$/u.test(value)
  )
    return null;
  return value
    .replace(/\[\d+\]/gu, '')
    .split('.')
    .every((part) => diagnosticFieldParts.has(part))
    ? value
    : null;
}
export type DiagnosticReport = {
  format: 'uimori-diagnostic-report';
  version: typeof DIAGNOSTIC_REPORT_VERSION;
  generatedAt: string;
  environment: {
    buildId: string | null;
    schemaVersion: number;
    supportedSchemaVersion: number;
    node: string;
    platform: string;
    architecture: string;
    testMode: boolean;
    /** Whether this app is holding new writes, so a shared report shows an update in progress. */
    maintenance: { status: 'open' | 'closed'; epoch: number };
  };
  scope: 'system' | 'chat' | 'run';
  coverage: {
    runs: { included: number; truncated: boolean };
    attempts: { included: number; truncated: boolean };
    order: 'newest-first';
    omitted: string[];
    limits: typeof DIAGNOSTIC_LIMITS;
  };
  runs: {
    ref: string;
    status: ReturnType<typeof diagnosticStatus>;
    errorCode: string | null;
    inputCount: number | null;
    toolCount: number | null;
    deniedToolCount: number | null;
    sourceCommitted: boolean;
    hasPartialOutput: boolean;
    modelCalls: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    costUsd: number | null;
    elapsedToLastUpdateMs: number | null;
  }[];
  attempts: {
    ref: string;
    runRef: string | null;
    connectionRef: string;
    modelRef: string;
    role: ReturnType<typeof diagnosticRole>;
    status: ReturnType<typeof diagnosticStatus>;
    protocol: ReturnType<typeof diagnosticProtocol>;
    errorCode: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    costUsd: number | null;
    sequence: number;
    preparedOffsetMs: number | null;
    durationMs: null;
    httpStatus: number | null;
    rejectedFields: string[];
    toolArgumentFailure: {
      toolName: string | null;
      stage: (typeof toolArgumentStages)[number];
      blockIndex: number | null;
      argumentChars: number | null;
      hasJsonDelta: boolean;
      parseOffset: number | null;
    } | null;
  }[];
};
