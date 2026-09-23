export type Settings = {
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
  risuSource?: import('./risu-context-source.js').RisuContextSource;
  nativeRisuPosition?: import('./risu-native.js').NativeRisuLorePosition;
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
  consultationContext?: import('./agent-collaboration.js').AgentConsultationContext;
  role: 'main';
  contract: string;
  task: string;
  facts: string[];
  history: {
    revision: string;
    text: string;
    contentHash?: string;
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
  /** Compact Lua-authored message edits retained after execution inputs are released. */
  messageChanges?: import('./message-changes.js').MessageChanges;
  /** A completed message can store just display metadata instead of execution input. */
  settled?: boolean;
  displayModelTitle?: string;
  /** Frozen at reservation; only an explicit true enables response judgment. */
  mainJudgmentEnabled?: boolean;
  mainJudgmentThreshold?: number;
  /** Bounded input receipt for the host judgment of the unmodified model response. */
  mainJudgment?: {
    version: 'main-refusal-jev-v2';
    candidateHash: string;
    response: string;
    threshold: number;
  };
  nativeRisuPresetProgram?: import('./risu-native-preset.js').NativeRisuPresetExecution;
  nativeRisuExecution?: import('./risu-native-execution.js').NativeRisuExecution;
  nativeRisuAuthored?: import('./risu-native-execution.js').NativeRisuAuthored;
  /** Independent writing artifact: read-only tools and no host source/state commit. */
  executionPurpose?: 'artifact';
  /** Frozen author-side composition for the unit this run writes; planning, never story fact. */
  outline?: import('./outline.js').OutlineSnapshot;
  contextPlan?: import('./context-plan.js').ContextPlan;
  contextBase?: import('./context-plan.js').ContextBase;
  loreContext?: import('./lore-context.js').LoreContextSnapshot;
  loreContextReset?: boolean;
  forkedLoreReads?: import('./lore-context.js').ForkedLoreReads;
  packageStart?: import('./package-start.js').PackageStartSnapshot;
  executionClock?: { iso: string; unix: number };
  logicalHistory?: import('./risu-prompt.js').PromptHistoryMessage[];
  nativeRisuHistoryRevision?: string;
  /** Optional, permission-bound conversation read set; never filled from today's branch on replay. */
  promptCompilation?: import('./risu-prompt.js').PromptCompilation;
  /** Frozen model choice for the packages in model mode; a replay projects it, never reselects. */
  loreSelection?: import('./lore-selection.js').LoreSelectionReceipt;
  chatId: string;
  parentRevision: string | null;
  settingsRevision: number;
  settings: Settings;
  request: string;
  history: {
    revision: string;
    text: string;
    contentHash?: string;
  }[];
  resources: Resource[];
  branchId?: string;
  profile?: import('./product.js').ProfileSnapshot;
  candidateOf?: string;
  /** Rejudge the preserved response without invoking the writer or input hooks. */
  judgmentRecovery?: true;
  /** Translation-job metadata captured at admission, never used to construct a writing request. */
  translationGuide?: import('./translation-guide.js').BotTranslationGuide | null;
  forkedFrom?: {
    chatId: string;
    runId: string;
    sourceRevision: string | null;
    requestOrder?: number;
  };
  /** The source was read from a chat transcript file as authored history; no model was called. */
  transcriptImport?: { index: number; storage?: 'source-only-v1' };
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
  canRejudge?: boolean;
  /** Stable admission order of the first request in this retry chain. */
  requestOrder?: number;
  retryOf?: string | null;
  supersededBy?: string | null;
  estimatedCost?: {
    usd: number | null;
    subtotalUsd: number;
    unknownCount: number;
    attemptCount: number;
  };
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
  executionMode?: import('./product.js').ModelExecutionMode;
  /** Read-time projection of the failing attempt's provider verdict; never stored on the run. */
  rejection?: import('./provider-rejection.js').ProviderRejection;
  packageStart?: Pick<import('./package-start.js').PackageStartSnapshot, 'mode' | 'title'>;
  hasPackages?: boolean;
};
export type ReaderActivity = {
  sourceHash?: string | null;
  superseded?: boolean;
  executionUncertain?: boolean;
  id: string;
  kind:
    | 'main'
    | 'translation'
    | 'image'
    | 'status'
    | 'state'
    | 'context'
    | 'illustration'
    | 'extension';
  status: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string;
  finishedAt: string | null;
  branchId: string | null;
  sourceRevision: string | null;
  generation: number;
};
export type ReaderNavigationItem = { id: string; number: number; label: string; opening?: true };

/** Branches placed by where their source chains diverge; `branches` itself stores no parent. */
export type BranchTreeNode = {
  id: string;
  /** Indentation level: how many fork points this branch sits below. */
  depth: number;
  /** Last source shared with the sibling it diverged from, null while a branch has no scene. */
  forkSourceId: string | null;
  /** 1-based position of the fork source within this branch. */
  forkIndex: number | null;
  /** Scenes this branch does not share with the sibling it diverged from. */
  ownScenes: number;
  totalScenes: number;
};
export type ReaderDetail = Omit<ChatDetail, 'runs' | 'attempts'> & {
  /** Current page, active runs and latest visible source-less responses; full task history is fetched separately. */
  runs: ReaderRun[];
  /** Scene illustrations for the returned sources; older pages keep their cached entries. */
  illustrations?: import('./illustration.js').Illustration[];
  reader: {
    navigation: ReaderNavigationItem[];
    /** Source-less turns belonging to this page, plus active work. */
    pendingRunIds?: string[];
    /** Candidate creation order is independent of the visible Run page. */
    candidateBranches?: string[];
    latestBranchRuns?: Record<string, string>;
    /** Display order is the walk itself; the list is already sorted. */
    branchTree?: BranchTreeNode[];
    activity?: ReaderActivity[];
    responseActivity?: ReaderActivity[];
    presentationRevisions: Record<string, string>;
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
