export type Settings = {
  preset: 'calm' | 'vivid';
  mode: 'direct' | 'research';
  translation: boolean;
  status: boolean;
  maxCalls: number;
};
export type Chat = {
  id: string;
  title: string;
  titleRevision?: number;
  lastActivityAt?: string;
  headRevision: string | null;
  settingsRevision: number;
  settings: Settings;
  botId: string;
  folderId?: string | null;
  organizationRevision?: number;
  sortPosition?: number;
};
export type Resource = {
  loreContext?: import('./lore-context.js').LorePlacement;
  id: string;
  chatId: string;
  kind: 'lore' | 'skill';
  revision: number;
  title: string;
  description: string;
  text: string;
  sourceKind?: string;
  loading?: 'pinned' | 'discoverable';
  relatedIds?: string[];
};
export type ModelInput = {
  agentId?: string;
  role: 'main';
  contract: string;
  task: string;
  preset: Settings['preset'];
  facts: string[];
  history: {
    revision: string;
    text: string;
    contentHash?: string;
    sourceSegments?: import('./source-segments.js').SourceSegmentPolicy;
  }[];
  catalog: Omit<Resource, 'text' | 'chatId'>[];
  prefetch: string[];
  tools: string[];
  results: ToolEvent[];
};
export type ToolEvent = {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  denied: boolean;
  errorKind?: 'recoverable';
};
export type Usage = {
  modelCalls: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
};
export type RunSnapshot = {
  contextPlan?: import('./context-plan.js').ContextPlan;
  loreContext?: import('./lore-context.js').LoreContextSnapshot;
  loreContextReset?: boolean;
  forkedLoreReads?: import('./lore-context.js').ForkedLoreReads;
  packageStart?: import('./package-start.js').PackageStartSnapshot;
  behaviorExecution?: import('./behavior-execution.js').BehaviorRunSnapshot;
  executionClock?: { iso: string; unix: number };
  packageStates?: import('./execution-context.js').PackageExecutionState[];
  sourceSegments?: import('./source-segments.js').SourceSegmentPolicy;
  logicalHistory?: import('./prompt-program.js').PromptHistoryMessage[];
  promptCompilation?: import('./prompt-program.js').PromptCompilation;
  chatId: string;
  parentRevision: string | null;
  settingsRevision: number;
  settings: Settings;
  request: string;
  history: {
    revision: string;
    text: string;
    contentHash?: string;
    sourceSegments?: import('./source-segments.js').SourceSegmentPolicy;
  }[];
  resources: Resource[];
  branchId?: string;
  profile?: import('./product.js').ProfileSnapshot;
  candidateOf?: string;
  forkedFrom?: { chatId: string; runId: string; sourceRevision: string };
  story?: import('./story.js').StorySnapshot;
};
export type Run = {
  id: string;
  chatId: string;
  parentRevision: string | null;
  settingsRevision: number;
  snapshot: RunSnapshot;
  request: string;
  status:
    | 'queued'
    | 'running'
    | 'waiting_for_state'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'interrupted'
    | 'refused'
    | 'partial';
  sourceRevision: string | null;
  error: string | null;
  usage: Usage;
  inputs: ModelInput[];
  toolEvents: ToolEvent[];
  partialText?: string;
};
export type Source = {
  editRevision?: number;
  translationRevision?: number;
  id: string;
  chatId: string;
  parentRevision: string | null;
  runId: string;
  text: string;
  hash: string;
  blocks?: { anchor: string; index: number; text: string; start: number; end: number }[];
};
export type ImageTarget =
  | { mode: 'original'; textHash: string }
  | {
      mode: 'translation';
      textHash: string;
      translationJobId: string;
      translationRevision: number;
    };
export type TranslationLayout = {
  textHash: string;
  blocks: { anchor: string; index: number; text: string; start: number; end: number }[];
};
export type Job = {
  id: string;
  chatId: string;
  sourceRevision: string;
  sourceHash: string;
  kind: 'translation' | 'status' | 'image';
  imageTarget?: ImageTarget;
  translationLayout?: TranslationLayout;
  status:
    | 'queued'
    | 'running'
    | 'completed'
    | 'failed'
    | 'stale'
    | 'partial'
    | 'cancelled'
    | 'interrupted';
  attempt: number;
  error: string | null;
  /** Read-time projection of the failing attempt's provider verdict; never stored on the job. */
  rejection?: import('./provider-rejection.js').ProviderRejection;
  result: {
    mock: boolean;
    manual?: boolean;
    imageTarget?: ImageTarget;
    text?: string;
    label?: string;
    sourceRevision: string;
    sourceHash: string;
    blocks?: { anchor: string; text: string }[];
    segments?: { anchors: string[]; text: string }[];
    annotations?: {
      blockAnchor: string;
      assetRef: string;
      assetRevision: number;
      assetHash: string;
      presentationIntent: 'profile' | 'inline';
      caption?: string;
    }[];
  } | null;
  /** Last validated translation of this exact source, retained while a new request runs/fails. */
  previousResult?: {
    jobId: string;
    revision: number;
    result: NonNullable<Job['result']>;
    translationLayout?: TranslationLayout;
  };
  revision?: number;
};
export type ChatDetail = {
  chat: Chat;
  runs: Run[];
  sources: Source[];
  jobs: Job[];
  profile?: import('./product.js').ChatProfile;
  branches?: import('./product.js').Branch[];
  attempts?: import('./product.js').Attempt[];
  assets?: import('./product.js').Asset[];
};

/** Reader summaries never stand in for frozen execution inputs. */
export type ReaderRun = Omit<Run, 'snapshot' | 'inputs' | 'toolEvents'> & {
  snapshot: Pick<RunSnapshot, 'branchId' | 'candidateOf' | 'forkedFrom' | 'loreContextReset'>;
  contextSummary?: {
    status: 'pending' | 'ready' | 'failed';
    inputTokenLimit: number;
    estimatedInputTokens: number | null;
    compactedSources: number;
    summaryCalls: number;
    error: string | null;
  };
  modelTitle?: string;
  /** Read-time projection of the failing attempt's provider verdict; never stored on the run. */
  rejection?: import('./provider-rejection.js').ProviderRejection;
  packageStart?: Pick<import('./package-start.js').PackageStartSnapshot, 'mode' | 'title'>;
  hasPackages?: boolean;
  sourceSegments?: import('./source-segments.js').SourceSegmentPolicy;
};
export type ReaderActivity = {
  sourceHash?: string | null;
  superseded?: boolean;
  executionUncertain?: boolean;
  id: string;
  kind: 'main' | 'translation' | 'image' | 'status' | 'state' | 'memory';
  status: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string;
  finishedAt: string | null;
  branchId: string | null;
  sourceRevision: string | null;
  generation: number;
};
export type ReaderNavigationItem = { id: string; number: number; label: string };

export type ReaderDetail = Omit<ChatDetail, 'runs' | 'attempts'> & {
  runs: ReaderRun[];
  reader: {
    navigation: ReaderNavigationItem[];
    activity?: ReaderActivity[];
    responseActivity?: ReaderActivity[];
    headSourceHash?: string | null;
    activeJobs: number;
    cursor: number;
    order: string[];
    start: number;
    total: number;
    previous: string | null;
    next: string | null;
    latest: string | null;
    projection: true;
  };
};
