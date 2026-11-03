import { api, ApiError, definiteRejection } from './api.js';
import { legacyMessage } from './i18n.js';

/** Persist one clone intent until admission is known; a second deliberate clone gets a fresh key. */
export async function cloneWithReceipt<T>(
  storageKey: string,
  input: {
    kind: 'content' | 'prompt-preset';
    sourceId: string;
    expectedSourceRevision: number;
    title: string;
  }
): Promise<T> {
  const raw = sessionStorage.getItem(storageKey);
  const command = raw
    ? (JSON.parse(raw) as typeof input & { idempotencyKey: string })
    : { ...input, idempotencyKey: crypto.randomUUID() };
  if (
    command.kind !== input.kind ||
    command.sourceId !== input.sourceId ||
    typeof command.idempotencyKey !== 'string' ||
    !command.idempotencyKey
  )
    throw new Error(legacyMessage('shared.resourceCloneRecordInvalid'));
  if (!raw) sessionStorage.setItem(storageKey, JSON.stringify(command));
  try {
    const result = await api<T>('/resources/clone', command);
    sessionStorage.removeItem(storageKey);
    return result;
  } catch (error) {
    if (definiteRejection(error) && !(error instanceof ApiError && error.status === 429))
      sessionStorage.removeItem(storageKey);
    throw error;
  }
}
