import type { EvaluationToolOptions } from './evaluation-tool-config.js';
export const PROVIDER_PROTOCOLS = ['fixture-sse-v1', 'vertex-gemini-v1', 'openai-responses-v1', 'anthropic-messages-v1', 'vercel-chat-v1', 'openai-chat-v1', 'codex-app-server-v1'] as const;
export type ProviderProtocol = typeof PROVIDER_PROTOCOLS[number];
export type VertexRequestTier = 'standard' | 'flex';
export type ModelGeneration = { maxOutputTokens: number; temperature: number | null; thinkingLevel?: 'LOW' | 'MEDIUM' | 'HIGH'; structuredOutput?: boolean; reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'; thinkingMode?: 'disabled' | 'enabled' | 'adaptive'; thinkingBudgetTokens?: number };
export type ContentKind = 'bot' | 'persona' | 'module' | 'lore' | 'canon' | 'skill' | 'glossary';
export type ContentRef = { id: string; revision: number };
export type Content = ContentRef & { kind: ContentKind; title: string; description: string; text: string; loading: 'pinned' | 'discoverable'; relatedIds: string[]; package?: import('./content-package.js').ContentPackage; hasPackage?: boolean };
export type SavedPromptCombination = ContentRef & { title: string; prompt: ContentRef; values: Record<string, import('./prompt-program.js').PromptValue> };
export type CreativeControls = { mode: 'novel' | 'rp'; language: 'en' | 'ko'; personaReference: boolean; worldFocus: boolean; coNarration: boolean; declarationFinal: boolean; pov: 'auto' | 'first' | 'third'; style: 'auto' | 'calm' | 'vivid'; lengthMode: 'auto' | 'range' | 'custom'; minWords: number; maxWords: number; customWords: number };
export type CreativePreset = ContentRef & { title: string; controls: CreativeControls };
export type PromptRole = 'main' | 'translation';
export type PromptPreset = ContentRef & { title: string; role: PromptRole; program: import('./prompt-program.js').PromptProgram };
export type TaskRole = 'main' | 'translation' | 'status' | 'image';
export type Connection = ContentRef & { title: string; protocol: ProviderProtocol; endpoint: string; credentialEnv?: string; requestTier?: VertexRequestTier; enabled: boolean; catalog: { id: string; name: string; capabilities: Record<string, boolean | null>; priceRevision: string | null }[]; catalogError: string | null; catalogUpdatedAt?: string | null };
export type ModelPreset = ContentRef & ModelGeneration & { title: string; connectionId: string; connectionRevision: number; modelId: string; timeoutMs?: number; enabled?: boolean; evaluationTools?: EvaluationToolOptions; userOverrides?: { tools: boolean | null; structuredOutput: boolean | null; note: string }; source?: { kind: 'catalog' | 'manual'; connectionRevision: number; catalogUpdatedAt: string | null } };
export type ChatProfile = { hiddenStory?: import('./hidden-story-package.js').HiddenStorySelection; chatId: string; revision: number; attachments: ContentRef[]; creative: CreativeControls; routes: Record<TaskRole, ContentRef | null>; image: boolean; prompts?: Partial<Record<PromptRole,ContentRef | null>>; promptControls?: Record<string,import('./prompt-program.js').ChatPromptControls>; packageAttachments?: import('./content-package.js').PackageAttachment[]; packageValues?: Record<string,Record<string,import('./prompt-program.js').PromptValue>> };
export type ProfileSnapshot = ChatProfile & { contents: Content[]; packages?: import('./content-package.js').ContentPackage[]; models: Partial<Record<TaskRole, ModelPreset & { connection: Connection }>>; promptPresets?: Partial<Record<PromptRole,PromptPreset>> };
export type Branch = { id: string; chatId: string; title: string; headRevision: string | null; revision: number; default: boolean };
export type Asset = { id: string; chatId: string; revision: number; title: string; mime: string; hash: string; description: string; actor: string; outfit: string; location: string; allowedUse: 'profile' | 'inline' | 'both'; url: string };
export type Attempt = { id: string; runId: string | null; jobId: string | null; storyJobId?: string | null; role: TaskRole | 'state' | 'memory'; connectionId: string; modelId: string; status: string; inputTokens: number | null; outputTokens: number | null; costUsd: number | null; rawUsage: unknown; priceRevision: string | null; error: string | null; request: unknown; response: unknown };
// Summary lists preserve content references and metadata; their text is a placeholder.
// Fetch the immutable revision before opening a content editor.
export type Library = { contentBodiesOmitted?: boolean; assetsOmitted?: boolean; promptPresets?: PromptPreset[]; promptCombinations?: SavedPromptCombination[]; contents: Content[]; presets: CreativePreset[]; connections: Connection[]; models: ModelPreset[]; assets: Asset[] };
export const defaultCreative = (): CreativeControls => ({ mode: 'novel', language: 'en', personaReference: true, worldFocus: true, coNarration: false, declarationFinal: false, pov: 'auto', style: 'auto', lengthMode: 'range', minWords: 4500, maxWords: 7500, customWords: 15000 });
export const defaultProfile = (chatId: string): ChatProfile => ({ chatId, revision: 1, attachments: [], creative: defaultCreative(), routes: { main: null, translation: null, status: null, image: null }, image: false });
export function compileCreative(value: CreativeControls) {
  const length = value.lengthMode === 'range' ? { minWords: value.minWords, maxWords: value.maxWords } : value.lengthMode === 'custom' ? { words: value.customWords } : { automatic: true };
  return { mode: value.mode, language: value.language, personaReference: value.personaReference, worldFocus: value.worldFocus, coNarration: value.coNarration, declarationFinal: value.declarationFinal, pov: value.pov, style: value.style, length };
}

export const VERTEX_GEMINI_MODEL_ID = 'gemini-3.8-flash';
export const VERTEX_GEMINI_MAX_OUTPUT_TOKENS = 65_536;
export const VERTEX_GEMINI_DEFAULT_THINKING_LEVEL = 'MEDIUM' as const;
export const VERTEX_GEMINI_DEFAULT_TIMEOUT_MS = 300_000;

/** The first live adapter supports Google's global project endpoint only. */
export function validateVertexEndpoint(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('INVALID_VERTEX_ENDPOINT'); }
  if (url.origin !== 'https://aiplatform.googleapis.com' || url.username || url.password || url.search || url.hash ||
    !/^\/v1\/projects\/(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]+)\/locations\/global\/publishers\/google\/models\/?$/.test(url.pathname)) {
    throw new Error('INVALID_VERTEX_ENDPOINT');
  }
  return url.origin + url.pathname.replace(/\/$/, '');
}

/** API roots are connection settings; paths supplied by model output never change them. */
export function validateProviderEndpoint(protocol: ProviderProtocol, value: string): string {
  if (protocol === 'codex-app-server-v1') { if (value !== 'codex://local') throw new Error('INVALID_CODEX_ENDPOINT'); return value; }
  if (protocol === 'vertex-gemini-v1') return validateVertexEndpoint(value);
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) throw new Error('INVALID_ENDPOINT');
  if (protocol === 'fixture-sse-v1') {
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('FIXTURE_REQUIRES_LOOPBACK');
    return value;
  }
  const official = { 'anthropic-messages-v1': 'https://api.anthropic.com/v1', 'vercel-chat-v1': 'https://ai-gateway.vercel.sh/v1' };
  const normalized = url.href.replace(/\/$/u, '');
  if (protocol !== 'openai-chat-v1' && protocol !== 'openai-responses-v1') {
    if (normalized !== official[protocol]) throw new Error('INVALID_PROVIDER_ENDPOINT');
  } else if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('HTTPS_OR_LOOPBACK_REQUIRED');
  return normalized;
}
export function parseVertexRequestTier(value: string | undefined): VertexRequestTier | undefined {
  if (value === undefined) return undefined;
  if (value !== 'standard' && value !== 'flex') throw new Error('INVALID_VERTEX_REQUEST_TIER');
  return value;
}
