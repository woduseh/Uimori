export type ContentKind = 'bot' | 'persona' | 'lore' | 'canon' | 'skill' | 'glossary';
export type ContentRef = { id: string; revision: number };
export type Content = ContentRef & { kind: ContentKind; title: string; description: string; text: string; loading: 'pinned' | 'discoverable'; relatedIds: string[] };
export type CreativeControls = { mode: 'novel' | 'rp'; language: 'en' | 'ko'; personaReference: boolean; worldFocus: boolean; coNarration: boolean; declarationFinal: boolean; pov: 'auto' | 'first' | 'third'; style: 'auto' | 'calm' | 'vivid'; lengthMode: 'auto' | 'range' | 'custom'; minWords: number; maxWords: number; customWords: number };
export type CreativePreset = ContentRef & { title: string; controls: CreativeControls };
export type TaskRole = 'main' | 'translation' | 'status' | 'image';
export type Connection = ContentRef & { title: string; protocol: 'fixture-sse-v1'; endpoint: string; credentialEnv?: string; enabled: boolean; catalog: { id: string; name: string; capabilities: Record<string, boolean | null>; priceRevision: string | null }[]; catalogError: string | null };
export type ModelPreset = ContentRef & { title: string; connectionId: string; connectionRevision: number; modelId: string; maxOutputTokens: number; temperature: number | null };
export type ChatProfile = { chatId: string; revision: number; attachments: ContentRef[]; creative: CreativeControls; routes: Record<TaskRole, ContentRef | null>; image: boolean };
export type ProfileSnapshot = ChatProfile & { contents: Content[]; models: Partial<Record<TaskRole, ModelPreset & { connection: Connection }>> };
export type Branch = { id: string; chatId: string; title: string; headRevision: string | null; revision: number; default: boolean };
export type Asset = { id: string; chatId: string; revision: number; title: string; mime: string; hash: string; description: string; actor: string; outfit: string; location: string; allowedUse: 'profile' | 'inline' | 'both'; url: string };
export type Attempt = { id: string; runId: string | null; jobId: string | null; role: TaskRole; connectionId: string; modelId: string; status: string; inputTokens: number | null; outputTokens: number | null; costUsd: number | null; rawUsage: unknown; priceRevision: string | null; error: string | null; request: unknown; response: unknown };
export type Library = { contents: Content[]; presets: CreativePreset[]; connections: Connection[]; models: ModelPreset[]; assets: Asset[] };
export const defaultCreative = (): CreativeControls => ({ mode: 'novel', language: 'en', personaReference: true, worldFocus: true, coNarration: false, declarationFinal: false, pov: 'auto', style: 'auto', lengthMode: 'range', minWords: 4500, maxWords: 7500, customWords: 15000 });
export const defaultProfile = (chatId: string): ChatProfile => ({ chatId, revision: 1, attachments: [], creative: defaultCreative(), routes: { main: null, translation: null, status: null, image: null }, image: false });
export function compileCreative(value: CreativeControls) {
  const length = value.lengthMode === 'range' ? { minWords: value.minWords, maxWords: value.maxWords } : value.lengthMode === 'custom' ? { words: value.customWords } : { automatic: true };
  return { mode: value.mode, language: value.language, personaReference: value.personaReference, worldFocus: value.worldFocus, coNarration: value.coNarration, declarationFinal: value.declarationFinal, pov: value.pov, style: value.style, length };
}
