export const TRACE_CALL_KINDS = [
  'writing',
  'refusal-judgment',
  'lore-selection',
  'content-precheck',
  'story-guide',
  'advisor',
  'summary',
  'script',
  'chat-title',
  'scene-translation',
  'translation-judgment',
  'image-placement',
  'image-judgment',
  'illustration',
  'illustration-judgment',
  'input-translation',
  'judgment',
  'helper',
  'helper-artifact',
  'legacy-status',
  'connection-test',
  'other',
] as const;
export type TraceCallKind = (typeof TRACE_CALL_KINDS)[number];

export type TraceCallOwner = 'run' | 'job' | 'illustration' | 'helper' | 'chat';

export type TraceToolCall = {
  name: string;
  resultChars: number | null;
  elapsedMs: number | null;
  failed: boolean;
};

export type TraceCall = {
  id: string;
  kind: TraceCallKind;
  owner: TraceCallOwner;
  sceneRunId: string | null;
  purpose?: string;
  modelId: string;
  status: string;
  startedAt: string | null;
  elapsedMs: number | null;
  firstByteMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  reasoningTokens: number | null;
  internalModelCalls: number | null;
  costUsd: number | null;
  estimatedUsd: number | null;
  estimatedSubtotalUsd: number;
  tools: TraceToolCall[];
};

export type ChatTraceCall = TraceCall & {
  runId: string | null;
  jobId: string | null;
  role: string;
  connectionId: string;
  priceRevision: string | null;
  error: string | null;
};

export type SceneTokens = {
  inputTokens: number | null;
  outputTokens: number | null;
  inputPartial: boolean;
  outputPartial: boolean;
};
export type TraceCostTotal = {
  usd: number | null;
  subtotalUsd: number;
  unknownCount: number;
  attemptCount: number;
};

const judgmentKinds: Record<string, TraceCallKind> = {
  'main-refusal': 'refusal-judgment',
  'translation-refusal': 'translation-judgment',
  'lore-selection': 'lore-selection',
  'codex-content-preflight': 'content-precheck',
  'image-selection': 'image-judgment',
  'illustration-content': 'illustration-judgment',
  'illustration-placement': 'illustration-judgment',
};

const usageKinds: Record<string, TraceCallKind> = {
  writing: 'writing',
  'story-guide': 'story-guide',
  advisor: 'advisor',
  summary: 'summary',
  script: 'script',
  title: 'chat-title',
  translation: 'scene-translation',
  'input-translation': 'input-translation',
  helper: 'helper',
  'helper-artifact': 'helper-artifact',
  status: 'legacy-status',
  'connection-test': 'connection-test',
};

const modelRoles: Record<string, TraceCallKind> = {
  main: 'writing',
  translation: 'scene-translation',
  context: 'summary',
  title: 'chat-title',
  image: 'image-placement',
  illustration: 'illustration',
  script: 'script',
  helper: 'helper',
  status: 'legacy-status',
};

export function traceCallKind(stored: {
  usageKind: string | null;
  role: string;
  judgmentKind: string | null;
  diagnosticPurpose: string | null;
}): TraceCallKind {
  const judgment =
    stored.judgmentKind ??
    (stored.diagnosticPurpose === 'codex-content-preflight' ? stored.diagnosticPurpose : null);
  if (judgment && judgmentKinds[judgment]) return judgmentKinds[judgment];
  if (stored.usageKind === 'judgment') return 'judgment';
  if (stored.usageKind === 'image')
    return stored.role === 'illustration' ? 'illustration' : 'image-placement';
  const known = stored.usageKind ? usageKinds[stored.usageKind] : undefined;
  return known ?? modelRoles[stored.role] ?? 'other';
}

export function traceCallCost(
  call: Pick<TraceCall, 'costUsd' | 'estimatedUsd' | 'estimatedSubtotalUsd'>
) {
  const usd = call.costUsd ?? call.estimatedUsd;
  return { usd, known: usd ?? call.estimatedSubtotalUsd };
}

export function sumTraceCosts(
  calls: readonly Pick<TraceCall, 'costUsd' | 'estimatedUsd' | 'estimatedSubtotalUsd'>[]
): TraceCostTotal {
  let subtotalUsd = 0;
  let unknownCount = 0;
  for (const call of calls) {
    const cost = traceCallCost(call);
    subtotalUsd += cost.known;
    if (cost.usd === null) unknownCount++;
  }
  return {
    usd: unknownCount ? null : subtotalUsd,
    subtotalUsd,
    unknownCount,
    attemptCount: calls.length,
  };
}

export type TraceCostGroup = 'writing' | 'translation' | 'image' | 'title' | 'other';

export function traceCostGroup(call: Pick<TraceCall, 'kind' | 'owner'>): TraceCostGroup {
  if (call.kind === 'chat-title') return 'title';
  if (call.owner === 'run') return 'writing';
  if (call.kind === 'scene-translation' || call.kind === 'translation-judgment')
    return 'translation';
  if (
    call.kind === 'image-placement' ||
    call.kind === 'image-judgment' ||
    call.kind === 'illustration' ||
    call.kind === 'illustration-judgment'
  )
    return 'image';
  return 'other';
}
