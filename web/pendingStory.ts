import type { ChatProfile, ContentRef, CreativeControls } from '../core/product.js';
import { api } from './api.js';

export type NewStoryProfileIntent = { attachments: ContentRef[]; creative: CreativeControls | null; models?: Pick<ChatProfile['routes'], 'main' | 'translation'> };
type PendingStoryProfile = NewStoryProfileIntent & { version: 1 | 2; kind: 'new-story-profile' };
const pendingKey = (chatId: string) => `pending-profile:${chatId}`;
const saving = new Map<string, Promise<void>>();

export function savePendingStoryProfile(chatId: string, intent: NewStoryProfileIntent) {
  const pending: PendingStoryProfile = { version: intent.models ? 2 : 1, kind: 'new-story-profile', ...intent };
  sessionStorage.setItem(pendingKey(chatId), JSON.stringify(pending));
}

function readIntent(raw: string): NewStoryProfileIntent {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('보관한 시작 설정을 읽을 수 없어요.');
  const pending = value as Record<string, unknown>;
  const versioned = (pending.version === 1 || pending.version === 2) && pending.kind === 'new-story-profile';
  // Earlier versions stored the whole profile. Keep the chosen content and controls,
  // but never restore those old routes or image settings over a newer profile.
  const legacy = pending.version === undefined && pending.kind === undefined && pending.routes && typeof pending.routes === 'object' && typeof pending.image === 'boolean';
  const attachments = pending.attachments;
  const creative = pending.creative;
  if ((!versioned && !legacy) || !Array.isArray(attachments) || !attachments.every(item => item && typeof item === 'object' && typeof item.id === 'string' && item.id.length > 0 && Number.isSafeInteger(item.revision) && item.revision > 0) || !(creative === null && versioned || creative && typeof creative === 'object' && !Array.isArray(creative))) {
    throw new Error('보관한 시작 설정을 읽을 수 없어요.');
  }
  let models: NewStoryProfileIntent['models'];
  if (pending.version === 2) {
    const value = pending.models;
    const ref = (item: unknown) => item === null || !!item && typeof item === 'object' && !Array.isArray(item) && typeof (item as ContentRef).id === 'string' && (item as ContentRef).id.length > 0 && Number.isSafeInteger((item as ContentRef).revision) && (item as ContentRef).revision > 0;
    if (!value || typeof value !== 'object' || Array.isArray(value) || !ref((value as Record<string, unknown>).main) || !ref((value as Record<string, unknown>).translation)) throw new Error('보관한 시작 모델을 읽을 수 없어요.');
    const selected = value as NonNullable<NewStoryProfileIntent['models']>;
    models = { main: selected.main, translation: selected.translation };
  }
  return { attachments: attachments as ContentRef[], creative: creative as CreativeControls | null, ...(models ? { models } : {}) };
}

export function completePendingStoryProfile(chatId: string): Promise<void> {
  const inProgress = saving.get(chatId);
  if (inProgress) return inProgress;
  const promise = applyPendingStoryProfile(chatId).finally(() => { saving.delete(chatId); });
  saving.set(chatId, promise);
  return promise;
}

async function applyPendingStoryProfile(chatId: string) {
  const key = pendingKey(chatId);
  const raw = sessionStorage.getItem(key);
  if (raw === null) return;
  const intent = readIntent(raw);
  const current = await api<ChatProfile>(`/chats/${chatId}/profile`);
  await api(`/chats/${chatId}/profile`, {
    attachments: intent.attachments,
    creative: intent.creative ?? current.creative,
    // Starting models belong only to the untouched new profile. A retry must not
    // overwrite model choices saved by another tab after story creation.
    routes: current.revision === 1 && intent.models ? { ...current.routes, ...intent.models } : current.routes,
    image: current.image,
    expectedRevision: current.revision,
  }, 'PUT');
  if (sessionStorage.getItem(key) === raw) sessionStorage.removeItem(key);
}
