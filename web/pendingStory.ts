import type { ChatProfile, ContentRef } from '../core/product.js';
import { api } from './api.js';
import { validatePackageAttachment } from '../core/content-package.js';
import { validatePackageStartRef, type PackageStartRef } from '../core/package-start.js';
import { validateChatPromptControls } from '../core/prompt-program.js';
export type NewStoryProfileIntent = {
  attachments: ContentRef[];
  packageAttachments?: ChatProfile['packageAttachments'];
  packageValues?: ChatProfile['packageValues'];
  packageStart?: PackageStartRef & {
    idempotencyKey: string;
    expectedSettingsRevision?: number;
    expectedProfileRevision?: number;
  };
};
type PendingStoryProfile = NewStoryProfileIntent & { version: 2; kind: 'new-story-profile' };
const pendingKey = (chatId: string) => `pending-profile:${chatId}`;
const saving = new Map<string, Promise<void>>();

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
  const attachments = pending.attachments;
  if (
    !versioned ||
    !Array.isArray(attachments) ||
    !attachments.every(
      (item) =>
        item &&
        typeof item === 'object' &&
        typeof item.id === 'string' &&
        item.id.length > 0 &&
        Number.isSafeInteger(item.revision) &&
        item.revision > 0
    )
  ) {
    throw new Error('보관한 시작 설정을 읽을 수 없어요.');
  }
  const packageAttachments =
    pending.packageAttachments === undefined
      ? undefined
      : Array.isArray(pending.packageAttachments)
        ? pending.packageAttachments.map(validatePackageAttachment)
        : null;
  if (packageAttachments === null) throw new Error('보관한 시작 패키지를 읽을 수 없어요.');
  let packageValues: ChatProfile['packageValues'];
  if (pending.packageValues !== undefined) {
    if (
      !pending.packageValues ||
      typeof pending.packageValues !== 'object' ||
      Array.isArray(pending.packageValues)
    )
      throw new Error('보관한 시작 선택값을 읽을 수 없어요.');
    packageValues = Object.fromEntries(
      Object.entries(pending.packageValues).map(([key, values]) => [
        key,
        validateChatPromptControls({ values, combinations: [] }).values,
      ])
    );
  }
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
    attachments: attachments as ContentRef[],
    ...(packageAttachments ? { packageAttachments } : {}),
    ...(packageValues ? { packageValues } : {}),
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
  const saved = await api<ChatProfile>(
    `/chats/${chatId}/profile`,
    {
      attachments: intent.attachments,
      image: current.image,
      ...(intent.packageAttachments ? { packageAttachments: intent.packageAttachments } : {}),
      ...(intent.packageValues ? { packageValues: intent.packageValues } : {}),
      expectedRevision: current.revision,
    },
    'PUT'
  );
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
