import { copyRecoveryPrefix } from './editor-recovery.js';
import {
  deleteAttachmentDraft,
  readAttachmentDraft,
  writeAttachmentDraft,
} from './attachment-draft-storage.js';

export type DraftImage = { id: string; name: string; blob: Blob; width: number; height: number };
export type RequestDraft = { token: string; text: string; images: DraftImage[] };

let tabOwnership: Promise<string> | undefined;

function claimTab(tab: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    void navigator.locks
      .request(`uimori:request-draft:${tab}`, { ifAvailable: true }, (lock) => {
        resolve(!!lock);
        // The browser releases this lock when this document is destroyed, including reload.
        return lock ? new Promise<void>(() => {}) : undefined;
      })
      .catch(reject);
  });
}

async function ownTab() {
  let tab = sessionStorage.getItem('uimori:request-draft-tab');
  if (!tab) {
    tab = crypto.randomUUID();
    sessionStorage.setItem('uimori:request-draft-tab', tab);
  }
  // Without Web Locks, ordinary new tabs remain separate; cloned-tab isolation is unavailable.
  if (!navigator.locks || (await claimTab(tab))) return tab;
  const inherited = tab;
  do {
    tab = crypto.randomUUID();
  } while (!(await claimTab(tab)));
  await copyRecoveryPrefix(`request:${inherited}:`, `request:${tab}:`);
  sessionStorage.setItem('uimori:request-draft-tab', tab);
  return tab;
}

/** A page holds one UUID; reload reclaims it, while a concurrently open clone gets a copy. */
export async function requestDraftKey(key: string) {
  tabOwnership ??= ownTab();
  return `request:${await tabOwnership}:${key}`;
}

type DraftState = { token: string; accepted: string[] };
function stateKey(key: string) {
  return `request-state:${key}`;
}
function readState(key: string): DraftState | undefined {
  const value = sessionStorage.getItem(stateKey(key));
  return value ? (JSON.parse(value) as DraftState) : undefined;
}

/** Publish the text and generation synchronously, even if IndexedDB later fails. */
export function rememberRequestDraft(key: string, model: RequestDraft) {
  const state = readState(key);
  sessionStorage.setItem(
    stateKey(key),
    JSON.stringify({ token: model.token, accepted: state?.accepted ?? [] })
  );
  sessionStorage.setItem(key, model.text);
}

export async function readRequestDraft(
  key: string
): Promise<{ saved?: RequestDraft; conflict?: RequestDraft }> {
  const storageKey = await requestDraftKey(key);
  let saved = await readAttachmentDraft<RequestDraft>(storageKey);
  const state = readState(key);
  if (saved && state?.accepted.includes(saved.token)) {
    // A known accepted request must never reappear when cleanup failed before reload.
    try {
      if (await deleteAttachmentDraft(storageKey, saved.token)) return {};
      saved = await readAttachmentDraft<RequestDraft>(storageKey);
    } catch {
      return {};
    }
  }
  if (!saved) return {};
  if (
    state &&
    (state.token !== saved.token || saved.text !== (sessionStorage.getItem(key) ?? ''))
  ) {
    return saved.images.length ? { conflict: saved } : {};
  }
  return { saved };
}

export async function writeRequestDraft(key: string, model: RequestDraft) {
  rememberRequestDraft(key, model);
  const storageKey = await requestDraftKey(key);
  return writeAttachmentDraft(storageKey, model);
}

export async function clearRequestDraft(key: string, token: string) {
  const state = readState(key);
  const accepted = [...new Set([...(state?.accepted ?? []), token])];
  if (state?.token === token) {
    sessionStorage.removeItem(key);
    sessionStorage.setItem(stateKey(key), JSON.stringify({ token: '', accepted }));
  } else
    sessionStorage.setItem(stateKey(key), JSON.stringify({ token: state?.token ?? '', accepted }));
  // Keep the tombstone until a successful deletion. A newer saved tuple is never deleted.
  await deleteAttachmentDraft(await requestDraftKey(key), token);
  const latest = readState(key);
  if (latest)
    sessionStorage.setItem(
      stateKey(key),
      JSON.stringify({
        token: latest.token,
        accepted: latest.accepted.filter((item) => item !== token),
      })
    );
}
