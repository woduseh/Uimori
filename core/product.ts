import type { GeminiSafetySettings } from './gemini-safety.js';
import type { ProviderOptions } from './provider-options.js';
import { DEFAULT_LORE_CONTEXT } from './lore-context.js';
import { parseVertexEndpoint, vertexModelsEndpoint } from './vertex-location.js';
export const PROVIDER_PROTOCOLS = [
  'fixture-sse-v1',
  'vertex-gemini-v1',
  'google-gemini-v1',
  'openai-responses-v1',
  'anthropic-messages-v1',
  'vercel-chat-v1',
  'deepseek-chat-v1',
  'openai-chat-v1',
  'codex-app-server-v1',
] as const;
export type ProviderProtocol = (typeof PROVIDER_PROTOCOLS)[number];
export function isGeminiProtocol(
  protocol: string | undefined
): protocol is 'vertex-gemini-v1' | 'google-gemini-v1' {
  return protocol === 'vertex-gemini-v1' || protocol === 'google-gemini-v1';
}
export const MODEL_FAMILIES = ['openai', 'anthropic', 'google', 'deepseek', 'xai'] as const;
export type ModelFamily = (typeof MODEL_FAMILIES)[number];
export type VertexRequestTier = 'standard' | 'flex';
export type ModelExecutionMode = 'realtime' | 'batch';
export type ModelGeneration = {
  modelFamily?: ModelFamily;
  maxOutputTokens: number;
  temperature: number | null;
  thinkingLevel?: 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH' | 'XHIGH';
  structuredOutput?: boolean;
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  outputEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  thinkingMode?: 'disabled' | 'adaptive';
  verbosity?: 'low' | 'medium' | 'high';
  reasoningMode?: 'standard' | 'pro';
  reasoningContext?: 'auto' | 'all_turns' | 'current_turn';
  topP?: number;
  stopSequences?: string[];
  safetySettings?: GeminiSafetySettings;
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
export type ModelRef = { id: string };
export type Content = ContentRef & {
  coverImage?: { url: string; title: string };
  kind: ContentKind;
  title: string;
  description: string;
  text: string;
  loading: 'pinned' | 'discoverable';
  relatedIds: string[];
  package: import('./risu-content.js').RisuContent;
  hasPackage?: boolean;
};
export type PromptCombinationOwner =
  | { kind: 'preset'; id: string }
  | { kind: 'workspace'; role: PromptRole };
export type SavedPromptCombination = ContentRef & {
  owner: PromptCombinationOwner;
  controls?: import('./risu-prompt.js').PromptControl[];
  title: string;
  role: PromptRole;
  values: Record<string, import('./risu-prompt.js').PromptValue>;
};
export type PromptRole = 'main' | 'translation';
export type PromptPreset = ContentRef & {
  title: string;
  role: PromptRole;
  program: import('./risu-prompt.js').RisuPrompt;
  values?: Record<string, import('./risu-prompt.js').PromptValue>;
};
export type CurrentPrompt = {
  presetId?: string;
  presetRevision?: number;
  title: string;
  program: import('./risu-prompt.js').RisuPrompt;
  values: Record<string, import('./risu-prompt.js').PromptValue>;
  optionValues?: Record<string, import('./risu-prompt.js').PromptValue>;
  defaultValues?: Record<string, import('./risu-prompt.js').PromptValue>;
};
export type ModelWorkspace = {
  helperTaskTimeoutMinutes?: number;
  helperConfirmPaidGeneration?: boolean;
  judgment?: import('./judgment-settings.js').JudgmentSelection;
  judgmentPricing?: import('./judgment-settings.js').JudgmentPriceEntry[];
  summaryLength?: import('./summary-length.js').SummaryLengthSettings;
  mainJudgmentThreshold?: number;
  mainJudgmentEnabled?: boolean;
  titleModel?: ModelRef | null;
  helperModel?: ModelRef | null;
  contextModel?: ModelRef | null;
  scriptModel?: ModelRef | null;
  revision: number;
  routes: Record<TaskModelRole, ModelRef | null>;
  translationPolicy: PromptWorkspace['translationPolicy'];
};
export type PromptWorkspace = {
  helperTaskTimeoutMinutes?: number;
  helperConfirmPaidGeneration?: boolean;
  judgment?: import('./judgment-settings.js').JudgmentSelection;
  judgmentPricing?: import('./judgment-settings.js').JudgmentPriceEntry[];
  summaryLength?: import('./summary-length.js').SummaryLengthSettings;
  mainJudgmentThreshold?: number;
  mainJudgmentEnabled?: boolean;
  titleModel?: ModelRef | null;
  helperModel?: ModelRef | null;
  contextModel?: ModelRef | null;
  scriptModel?: ModelRef | null;
  modelRoutes: Record<TaskModelRole, ModelRef | null>;
  revision: number;
  main: CurrentPrompt;
  translation: CurrentPrompt;
  translationPolicy: import('./translation-settings.js').TranslationPolicy;
};
export type TaskRole = 'main' | 'translation' | 'image';
export type TaskModelRole = Exclude<TaskRole, 'image'>;
export const MODEL_ROLES = [
  'main',
  'translation',
  'image',
  'script',
  'context',
  'helper',
  'title',
  'illustration',
] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];
export type WorkspaceModelRole = Exclude<ModelRole, 'illustration' | 'image'>;
export function workspaceModelRef(
  workspace: PromptWorkspace,
  role: WorkspaceModelRole
): ModelRef | null {
  switch (role) {
    case 'helper':
      return workspace.helperModel ?? null;
    case 'context':
      return workspace.contextModel ?? null;
    case 'script':
      return workspace.scriptModel ?? null;
    case 'title':
      return workspace.titleModel ?? null;
    default:
      return workspace.modelRoutes[role];
  }
}
export type Connection = ContentRef & {
  title: string;
  protocol: ProviderProtocol;
  endpoint: string;
  credentialRef?: string;
  enabled: boolean;
  displayOrder?: number;
  catalog: {
    id: string;
    name: string;
    capabilities: Record<string, boolean | null>;
    priceRevision: string | null;
    limits?: { maxOutputTokens?: number; inputTokenLimit?: number };
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
    tokenizer?: import('./tokenizer-profiles.js').TokenizerProfileId;
    capabilityProtocol?: ProviderProtocol;
    executionMode?: ModelExecutionMode;
    timeoutMs?: number;
    enabled?: boolean;
    displayOrder?: number;
    providerOptions?: ProviderOptions;
    pricing?: import('./pricing-types.js').ModelPricing;
    source?: { kind: 'catalog' | 'manual'; catalogUpdatedAt: string | null };
  };
export type ModelSnapshot = ModelPreset & {
  connection: Connection;
  pricingSnapshot?: import('./pricing-types.js').PricingSnapshot;
};
export type ChatProfile = {
  pinned?: { mainPromptPresetId?: string; mainModel?: ModelRef };
  authorNote?: string;
  optionAdjustments?: string[];
  loreContext?: import('./lore-context.js').LoreContextPolicy;
  chatId: string;
  revision: number;
  routes: Record<TaskModelRole, ModelRef | null>;
  image: boolean;
  imageTranslation?: boolean;
  packageAttachments?: import('./risu-content.js').ContentAttachment[];
};
export type ProfileSnapshot = ChatProfile & {
  summaryLength?: import('./summary-length.js').SummaryLengthSettings;
  variableState?: import('./chat-variables.js').ChatVariableState;
  chatOptions?: import('./chat-options.js').ChatOptionResolution;
  chatOverrides?: import('./chat-overrides.js').ChatOverrideSnapshot;
  contextModel?: ModelSnapshot;
  contextModelUnavailable?: true;
  scriptModel?: ModelSnapshot;
  scriptModelUnavailable?: true;
  prompts?: Partial<Record<PromptRole, ContentRef | null>>;
  promptControls?: Record<string, import('./risu-prompt.js').ChatPromptControls>;
  promptWorkspaceRevision?: number;
  promptOptionOwner?: string;
  collaborationModels?: Record<string, ModelSnapshot>;
  packages?: import('./risu-content.js').RisuContent[];
  models: Partial<Record<TaskRole, ModelSnapshot>>;
  promptPresets?: Partial<Record<PromptRole, PromptPreset>>;
};
export type Asset = {
  packageOwner?: {
    id: string;
    revision: number;
    role: import('./risu-content.js').ContentRole;
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
  role: ModelRole;
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
export type PromptPresetSummary = Pick<PromptPreset, 'id' | 'revision' | 'title' | 'role'>;
export type Library = {
  organization?: import('./library-organization.js').LibraryOrganization;
  contentBodiesOmitted?: boolean;
  assetsOmitted?: boolean;
  promptPresets?: PromptPresetSummary[];
  promptCombinations?: SavedPromptCombination[];
  contents: Content[];
  connections: LibraryConnection[];
  models: ModelPreset[];
  assets: Asset[];
};
export type LibraryConnection = Omit<Connection, 'catalog'> & {
  catalog?: Connection['catalog'];
  catalogCount?: number;
};
export { CHAT_AUTHOR_NOTE_MAX_CHARS } from '#contracts';
export const defaultProfile = (chatId: string): ChatProfile => ({
  chatId,
  revision: 1,
  loreContext: structuredClone(DEFAULT_LORE_CONTEXT),
  packageAttachments: [],
  routes: { main: null, translation: null },
  image: false,
});

export const VERTEX_GEMINI_DEFAULT_TIMEOUT_MS = 300_000;
export const DEFAULT_MODEL_TIMEOUT_MS = 300_000;
export function modelTimeoutMs(model: Pick<ModelPreset, 'timeoutMs'>): number {
  return model.timeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS;
}

export function validateVertexEndpoint(value: string): string {
  const endpoint = parseVertexEndpoint(value);
  if (!endpoint) throw new Error('INVALID_VERTEX_ENDPOINT');
  return vertexModelsEndpoint(endpoint.projectId, endpoint.location);
}

export function validateProviderEndpoint(protocol: ProviderProtocol, value: string): string {
  if (protocol === 'codex-app-server-v1') {
    if (value !== 'codex://local') throw new Error('INVALID_CODEX_ENDPOINT');
    return value;
  }
  if (protocol === 'vertex-gemini-v1') return validateVertexEndpoint(value);
  if (protocol === 'google-gemini-v1') {
    if (!/^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/?$/.test(value))
      throw new Error('INVALID_GEMINI_ENDPOINT');
    return 'https://generativelanguage.googleapis.com/v1beta';
  }
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) throw new Error('INVALID_ENDPOINT');
  if (protocol === 'fixture-sse-v1') {
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname))
      throw new Error('FIXTURE_REQUIRES_LOOPBACK');
    return value;
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('HTTP_ENDPOINT_REQUIRED');
  const normalized = url.href.replace(/\/$/u, '');
  return normalized;
}
export function parseVertexRequestTier(value: string | undefined): VertexRequestTier | undefined {
  if (value === undefined) return undefined;
  if (value !== 'standard' && value !== 'flex') throw new Error('INVALID_VERTEX_REQUEST_TIER');
  return value;
}
