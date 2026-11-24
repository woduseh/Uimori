export type Settings = {
  maxCalls: number;
  autoTranslate?: boolean;
  storyUi?: boolean;
  storyUiStyle?: import('./story-ui-style.js').StoryUiStyleSetting;
  autoRefusalRetryEnabled?: boolean;
  autoRefusalMaxRetries?: number;
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
  pinnedAt?: string;
};
export type Resource = {
  loreFolder?: { id: string; name: string };
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
  readBudget?: {
    tokens: number;
    tokenizer: import('./tokenizer-profiles.js').TokenizerProfileId;
    ranges?: (number | null)[];
  };
};
export type ToolEventTiming = {
  elapsedMs?: number;
  finishedAt?: string;
  originalResultChars?: number | null;
  diagnosticArgs?: Record<string, unknown>;
};
export type Usage = {
  modelCalls: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
};
export type RunPhaseSpan =
  | 'risuPrepare'
  | 'contextPlan'
  | 'compaction'
  | 'loreSelect'
  | 'storyGuide'
  | 'advisorPrep'
  | 'promptCompile'
  | 'preflightTokenize'
  | 'mainModel'
  | 'refusalJudge'
  | 'risuOutput'
  | 'txCommit';
export type RunSnapshot = {
  storyUiAction?: import('./story-ui.js').StoryUiAction;
  storyUiThemeChoices?: {
    themes: {
      id: `theme:${string}`;
      title: string;
      description: string;
      baseStyle: import('./story-ui-style.js').StoryUiStyle;
    }[];
    botThemeId?: `theme:${string}`;
  };
  imageCatalog?: import('./auxiliary.js').AssetEntry[];
  requestImages?: import('./request-images.js').RequestImage[];
  storyGuide?: import('./story-guide.js').StoryGuideSnapshot;
  storyGuideReceipt?: Pick<import('./story-guide.js').StoryGuideSnapshot, 'brief' | 'error'>;
  replacement?: { sourceRevision: string; sourceHash: string };
  messageChanges?: import('./message-changes.js').MessageChanges;
  settled?: boolean;
  capturedSources?: string[];
  invalidatedBySceneDeletion?: true;
  displayModelTitle?: string;
  mainJudgmentEnabled?: boolean;
  mainJudgmentThreshold?: number;
  mainJudgmentPending?: true;
  mainJudgment?: {
    version: 'main-refusal-jev-v3';
    candidateHash: string;
    response: string;
    threshold: number;
  };
  nativeRisuPresetProgram?: import('./risu-native-preset.js').NativeRisuPresetExecution;
  nativeRisuExecution?: import('./risu-native-execution.js').NativeRisuExecution;
  nativeRisuAuthored?: import('./risu-native-execution.js').NativeRisuAuthored;
  executionPurpose?: 'artifact';
  outline?: import('./outline.js').OutlineSnapshot;
  contextPlan?: import('./context-plan.js').ContextPlan;
  contextBase?: import('./context-plan.js').ContextBase;
  loreContext?: import('./lore-context.js').LoreContextSnapshot;
  loreContextReset?: boolean;
  packageStart?: import('./package-start.js').PackageStartSnapshot;
  executionClock?: { iso: string; unix: number };
  logicalHistory?: import('./risu-prompt.js').PromptHistoryMessage[];
  nativeRisuHistoryRevision?: string;
  promptCompilation?: import('./risu-prompt.js').PromptCompilation;
  loreSelection?: import('./lore-selection.js').LoreSelectionReceipt;
  phaseSpans?: Partial<Record<RunPhaseSpan, number>>;
  chatId: string;
  parentRevision: string | null;
  settingsRevision: number;
  settings: Settings;
  request: string;
  history: {
    revision: string;
    text: string;
    contentHash?: string;
    sceneContext?: import('./scene-context.js').SceneContext;
  }[];
  resources: Resource[];
  profile?: import('./product.js').ProfileSnapshot;
  judgmentRecovery?: true;
  translationGuide?: import('./translation-guide.js').BotTranslationGuide | null;
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
export type RunReceipt = Omit<Run, 'snapshot' | 'inputs' | 'toolEvents'>;
export type Source = {
  sceneContext?: import('./scene-context.js').SceneContext;
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
  rejection?: import('./provider-rejection.js').ProviderRejection;
  result: {
    mock: boolean;
    manual?: boolean;
    judgmentPending?: true;
    imageTarget?: ImageTarget;
    text?: string;
    label?: string;
    sourceRevision: string;
    sourceHash: string;
    blocks?: { anchor: string; text: string }[];
    annotations?: {
      blockAnchor: string;
      assetRef: string;
      assetRevision: number;
      assetHash: string;
      presentationIntent: 'profile' | 'inline';
      caption?: string;
    }[];
  } | null;
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
  attempts?: import('./product.js').Attempt[];
  assets?: import('./product.js').Asset[];
};

export type RunPhase = 'context' | 'lore' | 'story-guide' | 'writing';
export type ReaderRun = Omit<Run, 'snapshot' | 'inputs' | 'toolEvents'> & {
  createdAt: string;
  updatedAt: string;
  phase?: RunPhase;
  sceneUsage?: import('./scene-usage.js').SceneUsageReceipt;
  canRejudge?: boolean;
  requestOrder?: number;
  retryOf?: string | null;
  supersededBy?: string | null;
  readerDismissed?: boolean;
  estimatedCost?: {
    usd: number | null;
    subtotalUsd: number;
    unknownCount: number;
    attemptCount: number;
  };
  snapshot: Pick<RunSnapshot, 'loreContextReset' | 'requestImages' | 'replacement'>;
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
  rejection?: import('./provider-rejection.js').ProviderRejection;
  packageStart?: Pick<
    import('./package-start.js').PackageStartSnapshot,
    'mode' | 'title' | 'startId' | 'packageId' | 'packageRevision'
  >;
  hasPackages?: boolean;
};
export type ReaderActivity = {
  sourceHash?: string | null;
  superseded?: boolean;
  executionUncertain?: boolean;
  id: string;
  kind: 'main' | 'translation' | 'image' | 'status' | 'illustration';
  status: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string;
  finishedAt: string | null;
  sourceRevision: string | null;
  generation: number;
};
export type ReaderNavigationItem = {
  id: string;
  number: number;
  label: string;
  title?: string;
  requestLabel?: string;
  opening?: true;
};

export type ReaderDetail = Omit<ChatDetail, 'runs' | 'attempts'> & {
  runs: ReaderRun[];
  illustrations?: import('./illustration.js').Illustration[];
  reader: {
    navigation: ReaderNavigationItem[];
    navigationUnchanged?: boolean;
    pendingRunIds?: string[];
    activity?: ReaderActivity[];
    responseActivity?: ReaderActivity[];
    presentationRevisions: Record<string, string>;
    headSourceHash?: string | null;
    canChangePackageStart?: boolean;
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
