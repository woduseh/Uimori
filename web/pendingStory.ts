import type { ChatProfile } from '../core/product.js';
import { api } from './api.js';
import { validateContentAttachment } from '../core/risu-content.js';
import { validatePackageStartRef, type PackageStartRef } from '../core/package-start.js';
import { message as uiMessage } from './i18n.js';
export type NewStoryProfileIntent = {
  packageAttachments?: ChatProfile['packageAttachments'];
  profileBaseRevision?: number;
  packageStart?: PackageStartRef & {
    idempotencyKey: string;
    expectedSettingsRevision?: number;
    expectedProfileRevision?: number;
  };
};
type PendingStoryProfile = NewStoryProfileIntent & { version: 2; kind: 'new-story-profile' };
const pendingKey = (chatId: string) => `pending-profile:${chatId}`;
const saving = new Map<string, Promise<void>>();

export class PendingStoryProfileConflict extends Error {
  constructor(readonly savedIntent: string) {
    super(uiMessage('main.pendingProfileConflict'));
  }
}

/** Discard only the exact conflicted intent the user reviewed. */
export function acceptSavedStoryProfile(chatId: string, savedIntent: string) {
  const key = pendingKey(chatId);
  if (sessionStorage.getItem(key) !== savedIntent)
    throw new Error(uiMessage('main.pendingProfileChanged'));
  sessionStorage.removeItem(key);
}

export function savePendingStoryProfile(chatId: string, intent: NewStoryProfileIntent) {
  const pending: PendingStoryProfile = { version: 2, kind: 'new-story-profile', ...intent };
  sessionStorage.setItem(pendingKey(chatId), JSON.stringify(pending));
}

function readIntent(raw: string): NewStoryProfileIntent {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('보관한 시작 설정을 읽을 수 없어요.');
  const pending = value as Record<string, unknown>;
  const versioned = pending.version === 2 && pending.kind === 'new-story-profile';
  if (
    !versioned ||
    Object.keys(pending).some(
      (key) =>
        !['version', 'kind', 'packageAttachments', 'packageStart', 'profileBaseRevision'].includes(
          key
        )
    )
  ) {
    throw new Error('보관한 시작 설정을 읽을 수 없어요.');
  }
  const packageAttachments =
    pending.packageAttachments === undefined
      ? undefined
      : Array.isArray(pending.packageAttachments)
        ? pending.packageAttachments.map(validateContentAttachment)
        : null;
  if (packageAttachments === null) throw new Error('보관한 시작 패키지를 읽을 수 없어요.');
  const profileBaseRevision = pending.profileBaseRevision;
  if (
    profileBaseRevision !== undefined &&
    (!Number.isSafeInteger(profileBaseRevision) || Number(profileBaseRevision) < 1)
  )
    throw new Error('보관한 시작 설정을 읽을 수 없어요.');
  let packageStart: NewStoryProfileIntent['packageStart'];
  if (pending.packageStart !== undefined) {
    const opening = pending.packageStart as Record<string, unknown>;
    if (
      !opening ||
      typeof opening !== 'object' ||
      Array.isArray(opening) ||
      typeof opening.idempotencyKey !== 'string' ||
      !opening.idempotencyKey ||
      opening.idempotencyKey.length > 120 ||
      !Number.isSafeInteger(opening.expectedSettingsRevision) ||
      Number(opening.expectedSettingsRevision) < 1 ||
      (opening.expectedProfileRevision !== undefined &&
        (!Number.isSafeInteger(opening.expectedProfileRevision) ||
          Number(opening.expectedProfileRevision) < 1))
    )
      throw new Error('보관한 시작 요청을 읽을 수 없어요.');
    packageStart = {
      ...validatePackageStartRef({
        packageId: opening.packageId,
        packageRevision: opening.packageRevision,
        startId: opening.startId,
      }),
      idempotencyKey: opening.idempotencyKey,
      expectedSettingsRevision: Number(opening.expectedSettingsRevision),
      ...(opening.expectedProfileRevision === undefined
        ? {}
        : { expectedProfileRevision: Number(opening.expectedProfileRevision) }),
    };
  }
  return {
    ...(packageAttachments ? { packageAttachments } : {}),
    ...(profileBaseRevision === undefined
      ? {}
      : { profileBaseRevision: Number(profileBaseRevision) }),
    ...(packageStart ? { packageStart } : {}),
  };
}

export function completePendingStoryProfile(chatId: string): Promise<void> {
  const inProgress = saving.get(chatId);
  if (inProgress) return inProgress;
  const promise = applyPendingStoryProfile(chatId).finally(() => {
    saving.delete(chatId);
  });
  saving.set(chatId, promise);
  return promise;
}

async function applyPendingStoryProfile(chatId: string) {
  const key = pendingKey(chatId);
  let raw = sessionStorage.getItem(key);
  if (raw === null) return;
  const intent = readIntent(raw);
  if (intent.packageStart?.expectedProfileRevision !== undefined) {
    await api(`/chats/${chatId}/package-start`, intent.packageStart);
    if (sessionStorage.getItem(key) === raw) sessionStorage.removeItem(key);
    return;
  }
  const current = await api<ChatProfile>(`/chats/${chatId}/profile`);
  if (sessionStorage.getItem(key) !== raw) throw new Error(uiMessage('main.pendingProfileChanged'));
  // New chats start at revision 1. Older pending records did not store their base:
  // only revision 1 is safe to write; later matching attachments can be observed as saved.
  const base = intent.profileBaseRevision ?? 1;
  const sameAttachments =
    intent.packageAttachments === undefined ||
    JSON.stringify((current.packageAttachments ?? []).map(({ id, role }) => [id, role])) ===
      JSON.stringify(intent.packageAttachments.map(({ id, role }) => [id, role]));
  let saved: ChatProfile;
  if (current.revision !== base) {
    if (current.revision < base || !sameAttachments) throw new PendingStoryProfileConflict(raw);
    saved = current;
  } else {
    if (intent.profileBaseRevision === undefined) {
      intent.profileBaseRevision = base;
      savePendingStoryProfile(chatId, intent);
      raw = sessionStorage.getItem(key);
      if (raw === null) throw new Error(uiMessage('main.pendingProfileChanged'));
    }
    saved = await api<ChatProfile>(
      `/chats/${chatId}/profile`,
      {
        image: current.image,
        ...(intent.packageAttachments ? { packageAttachments: intent.packageAttachments } : {}),
        expectedRevision: base,
      },
      'PUT'
    );
    if (sessionStorage.getItem(key) !== raw)
      throw new Error(uiMessage('main.pendingProfileChanged'));
  }
  if (intent.packageStart) {
    // Record the accepted profile revision before starting. A lost start response retries
    // the identical command, without another profile write or another initial action.
    intent.packageStart.expectedProfileRevision = saved.revision;
    savePendingStoryProfile(chatId, intent);
    raw = sessionStorage.getItem(key);
    await api(`/chats/${chatId}/package-start`, intent.packageStart);
  }
  if (sessionStorage.getItem(key) === raw) sessionStorage.removeItem(key);
}
