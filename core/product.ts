import type { EvaluationToolOptions } from './evaluation-tool-config.js';
export const PROVIDER_PROTOCOLS = [
  'fixture-sse-v1',
  'vertex-gemini-v1',
  'openai-responses-v1',
  'anthropic-messages-v1',
  'vercel-chat-v1',
  'deepseek-chat-v1',
  'openai-chat-v1',
  'codex-app-server-v1',
] as const;
export type ProviderProtocol = (typeof PROVIDER_PROTOCOLS)[number];
export type VertexRequestTier = 'standard' | 'flex';
export type ModelGeneration = {
  maxOutputTokens: number;
  temperature: number | null;
  thinkingLevel?: 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH';
  structuredOutput?: boolean;
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  outputEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  thinkingMode?: 'disabled' | 'enabled' | 'adaptive';
  thinkingBudgetTokens?: number;
  verbosity?: 'low' | 'medium' | 'high';
  reasoningMode?: 'standard' | 'pro';
  reasoningContext?: 'auto' | 'all_turns' | 'current_turn';
  topP?: number;
  stopSequences?: string[];
  serviceTier?: string;
  cacheMode?: 'disabled' | 'explicit' | 'automatic';
  cacheTtl?: '5m' | '30m' | '1h';
};
export type ContentKind = 'bot' | 'persona' | 'module';
export type ContentRef = { id: string; revision: number };
export type ChatFolder = {
  id: string;
  botId: string;
  title: string;
  defaultPersona: ContentRef | null;
  revision: number;
};
/** Live setting selection. Revision remains an internal edit-conflict token on settings, never a selectable history. */
export type ModelRef = { id: string };
export type Content = ContentRef & {
  coverImage?: { url: string; title: string };
  kind: ContentKind;
  title: string;
  description: string;
  text: string;
  loading: 'pinned' | 'discoverable';
  relatedIds: string[];
  package?: import('./content-package.js').ContentPackage;
  hasPackage?: boolean;
};
export type PromptCombinationOwner =
  | { kind: 'preset'; id: string }
  | { kind: 'workspace'; role: PromptRole };
export type SavedPromptCombination = ContentRef & {
  owner?: PromptCombinationOwner;
  controls?: import('./prompt-program.js').PromptProgram['controls'];
  title: string;
  role: PromptRole;
  values: Record<string, import('./prompt-program.js').PromptValue>;
};
export type PromptRole = 'main' | 'translation';
export type PromptPreset = ContentRef & {
  title: string;
  role: PromptRole;
  program: import('./prompt-program.js').PromptProgram;
  values?: Record<string, import('./prompt-program.js').PromptValue>;
};
/** Editable, application-wide working copies. Applying a preset copies its content. */
export type CurrentPrompt = {
  presetId?: string;
  title: string;
  program: import('./prompt-program.js').PromptProgram;
  values: Record<string, import('./prompt-program.js').PromptValue>;
};
export type ModelWorkspace = {
  titleModel?: ModelRef | null;
  helperModel?: ModelRef | null;
  contextModel?: ModelRef | null;
  revision: number;
  routes: Record<TaskRole, ModelRef | null>;
  translationPolicy: PromptWorkspace['translationPolicy'];
};
export type PromptWorkspace = {
  titleModel?: ModelRef | null;
  helperModel?: ModelRef | null;
  contextModel?: ModelRef | null;
  modelRoutes: Record<TaskRole, ModelRef | null>;
  revision: number;
  main: CurrentPrompt;
  translation: CurrentPrompt;
  translationPolicy: {
    refusalModel: ModelRef | null;
    maxRetries: number;
    maxCalls: number;
  };
};
export type TaskRole = 'main' | 'translation' | 'status' | 'image';
export type Connection = ContentRef & {
  title: string;
  protocol: ProviderProtocol;
  endpoint: string;
  credentialEnv?: string;
  /**
   * Gemini connections only: server environment variable holding a Gemini Developer API key used
   * solely to list Gemini models and limits. Never used for generation requests.
   */
  catalogCredentialEnv?: string;
  enabled: boolean;
  catalog: {
    id: string;
    name: string;
    capabilities: Record<string, boolean | null>;
    priceRevision: string | null;
    /** Limits the provider's list API published for this model; absent when it publishes none. */
    limits?: { maxOutputTokens?: number; inputTokenLimit?: number };
    /** Option values the list API published, in this protocol's native vocabulary. */
    options?: { thinking?: string[]; thinkingModes?: string[] };
    pricing?: {
      rates: import('./pricing-types.js').TokenRates;
      longContext?: { aboveInputTokens: number; rates: import('./pricing-types.js').TokenRates };
      serviceTiers?: Record<
        string,
        {
          rates: import('./pricing-types.js').TokenRates;
          longContext?: {
            aboveInputTokens: number;
            rates: import('./pricing-types.js').TokenRates;
          };
        }
      >;
    };
  }[];
  catalogError: string | null;
  catalogUpdatedAt?: string | null;
};
export type ModelPreset = ContentRef &
  ModelGeneration & {
    title: string;
    connectionId: string;
    modelId: string;
    inputTokenLimit?: number;
    capabilityProtocol?: ProviderProtocol;
    timeoutMs?: number;
    enabled?: boolean;
    evaluationTools?: EvaluationToolOptions;
    /** Opt-in main-role context tools: model-written working summary, window switch and story.list. */
    contextTools?: boolean;
    pricing?: import('./pricing-types.js').ModelPricing;
    source?: { kind: 'catalog' | 'manual'; catalogUpdatedAt: string | null };
  };
export type ModelSnapshot = ModelPreset & {
  connection: Connection;
  pricingSnapshot?: import('./pricing-types.js').PricingSnapshot;
};
export type ChatProfile = {
  /** Read-only notices from adapting saved options to current definitions. Never execution evidence. */
  optionAdjustments?: string[];
  loreContext?: import('./lore-context.js').LoreContextPolicy;
  chatId: string;
  revision: number;
  attachments: ContentRef[];
  /** Read-only current global selection; persisted only in execution snapshots. */
  routes: Record<TaskRole, ModelRef | null>;
  image: boolean;
  /** Automatically place images after a model translation completes. Defaults to true. */
  imageTranslation?: boolean;
  packageAttachments?: import('./content-package.js').PackageAttachment[];
  packageValues?: Record<string, Record<string, import('./prompt-program.js').PromptValue>>;
};
export type ProfileSnapshot = ChatProfile & {
  chatOptions?: import('./chat-options.js').ChatOptionResolution;
  /** Text-only per-link projection; the original packages below remain revision-exact. */
  chatOverrides?: import('./chat-overrides.js').ChatOverrideSnapshot;
  contextModel?: ModelSnapshot;
  /** Historical execution scope only. Current settings and new snapshots omit this field. */
  personaReference?: boolean;
  /** Self-contained execution evidence; never a live library dependency. */
  prompts?: Partial<Record<PromptRole, ContentRef | null>>;
  promptControls?: Record<string, import('./prompt-program.js').ChatPromptControls>;
  promptWorkspaceRevision?: number;
  promptOptionOwner?: string;
  /** Models resolved at reservation, keyed by the main prompt's advisor IDs. */
  collaborationModels?: Record<string, ModelSnapshot>;
  contents: Content[];
  packages?: import('./content-package.js').ContentPackage[];
  models: Partial<Record<TaskRole, ModelSnapshot>>;
  promptPresets?: Partial<Record<PromptRole, PromptPreset>>;
};
export type Branch = {
  id: string;
  chatId: string;
  title: string;
  headRevision: string | null;
  revision: number;
  default: boolean;
};
export type Asset = {
  packageOwner?: {
    id: string;
    revision: number;
    role: import('./content-package.js').PackageRole;
    title: string;
    imageId: string;
  };
  id: string;
  chatId: string;
  revision: number;
  title: string;
  mime: string;
  hash: string;
  description: string;
  actor: string;
  outfit: string;
  location: string;
  allowedUse: 'profile' | 'inline' | 'both';
  url: string;
};
export type Attempt = {
  id: string;
  runId: string | null;
  jobId: string | null;
  storyJobId?: string | null;
  role: TaskRole | 'state' | 'context' | 'helper' | 'title' | 'illustration';
  connectionId: string;
  modelId: string;
  status: string;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  estimatedCost?: import('./pricing-types.js').CostEstimate;
  pricingSnapshot?: import('./pricing-types.js').PricingSnapshot;
  pricingStartedAt?: string;
  rawUsage: unknown;
  priceRevision: string | null;
  error: string | null;
  request: unknown;
  response: unknown;
};
// Summary lists preserve content references and metadata; their text is a placeholder.
// Fetch current content before opening an editor; revisions still protect concurrent saves.
export type Library = {
  organization?: import('./library-organization.js').LibraryOrganization;
  contentBodiesOmitted?: boolean;
  assetsOmitted?: boolean;
  promptPresets?: PromptPreset[];
  promptCombinations?: SavedPromptCombination[];
  contents: Content[];
  connections: Connection[];
  models: ModelPreset[];
  assets: Asset[];
};
export const defaultProfile = (chatId: string): ChatProfile => ({
  chatId,
  revision: 1,
  attachments: [],
  routes: { main: null, translation: null, status: null, image: null },
  image: false,
  imageTranslation: true,
});

export const VERTEX_GEMINI_MODEL_ID = 'gemini-3.8-flash';
export const VERTEX_GEMINI_MAX_OUTPUT_TOKENS = 65_536;
export const VERTEX_GEMINI_DEFAULT_TIMEOUT_MS = 300_000;

/** The first live adapter supports Google's global project endpoint only. */
export function validateVertexEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('INVALID_VERTEX_ENDPOINT');
  }
  if (
    url.origin !== 'https://aiplatform.googleapis.com' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/v1\/projects\/(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]+)\/locations\/global\/publishers\/google\/models\/?$/.test(
      url.pathname
    )
  ) {
    throw new Error('INVALID_VERTEX_ENDPOINT');
  }
  return url.origin + url.pathname.replace(/\/$/, '');
}

/** API roots are connection settings; paths supplied by model output never change them. */
export function validateProviderEndpoint(protocol: ProviderProtocol, value: string): string {
  if (protocol === 'codex-app-server-v1') {
    if (value !== 'codex://local') throw new Error('INVALID_CODEX_ENDPOINT');
    return value;
  }
  if (protocol === 'vertex-gemini-v1') return validateVertexEndpoint(value);
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) throw new Error('INVALID_ENDPOINT');
  if (protocol === 'fixture-sse-v1') {
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname))
      throw new Error('FIXTURE_REQUIRES_LOOPBACK');
    return value;
  }
  const official = {
    'anthropic-messages-v1': 'https://api.anthropic.com/v1',
    'vercel-chat-v1': 'https://ai-gateway.vercel.sh/v1',
    'deepseek-chat-v1': 'https://api.deepseek.com/v1',
  };
  const normalized = url.href.replace(/\/$/u, '');
  if (protocol !== 'openai-chat-v1' && protocol !== 'openai-responses-v1') {
    if (normalized !== official[protocol]) throw new Error('INVALID_PROVIDER_ENDPOINT');
  } else if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))
  )
    throw new Error('HTTPS_OR_LOOPBACK_REQUIRED');
  return normalized;
}
export function parseVertexRequestTier(value: string | undefined): VertexRequestTier | undefined {
  if (value === undefined) return undefined;
  if (value !== 'standard' && value !== 'flex') throw new Error('INVALID_VERTEX_REQUEST_TIER');
  return value;
}
