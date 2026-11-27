import { tryParseJson } from './json.js';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { ProviderProtocol } from '../core/product.js';
import { IMAGE_INPUT_MAX_BYTES } from '../core/image-limits.js';
import { imageInputSupported } from '../core/provider-image-reference.js';
import { REQUEST_IMAGE_MAX_COUNT, type RequestImageUpload } from '../core/request-images.js';
import {
  classifyRequestFile,
  fileInputSupported,
  providerFileLimits,
  REQUEST_FILE_MAX_COUNT,
  REQUEST_FILE_MAX_BYTES,
  REQUEST_FILES_MAX_BYTES,
  requestFileAccept,
  type RequestFile,
  type RequestFileUpload,
} from '../core/request-files.js';
import { apiBinary } from './api.js';
import {
  deleteAttachmentDraft,
  readAttachmentDraft,
  writeAttachmentDraft,
} from './attachment-draft-storage.js';
import { UiError, uiMessage, type UiMessage } from './ui-message.js';
import { toUiMessage } from './api-errors.js';
import { requestDraftKey, type DraftImage } from './request-image-draft.js';
import { writeOptionalStorage } from './optional-storage.js';
import { storageKeys } from './storage-keys.js';

export type DraftFile = {
  id: string;
  name: string;
  blob: Blob;
  mime: string;
  kind: RequestFile['kind'];
};
export type HelperAttachmentDraft = { token: string; images: DraftImage[]; files: DraftFile[] };
export type AttachmentModel = { protocol: ProviderProtocol; modelId: string };
export type FrozenHelperAttachments = {
  draftToken: string;
  images?: RequestImageUpload[];
  files?: RequestFileUpload[];
};
type Snapshot = {
  draft: HelperAttachmentDraft;
  ready: boolean;
  busy: boolean;
  error: UiMessage | null;
};
type Entry = {
  generation: number;
  snapshot: Snapshot;
  listeners: Set<() => void>;
  loading?: Promise<void>;
  write?: Promise<void>;
  adding?: Promise<void>;
};
const entries = new Map<string, Entry>();
const emptyDraft = (): HelperAttachmentDraft => ({
  token: crypto.randomUUID(),
  images: [],
  files: [],
});
const logicalKey = (id: string) => `helper-attachments:${id}`;
const acceptedKey = storageKeys.helperAttachmentsAccepted;
const tokenKey = storageKeys.helperAttachmentsToken;
function entry(id: string): Entry {
  let found = entries.get(id);
  if (!found) {
    found = {
      generation: 0,
      snapshot: { draft: emptyDraft(), ready: false, busy: false, error: null },
      listeners: new Set(),
    };
    entries.set(id, found);
  }
  return found;
}
function publish(owner: Entry, update: Partial<Snapshot>) {
  owner.snapshot = { ...owner.snapshot, ...update };
  for (const listener of owner.listeners) listener();
}
function acceptedTokens(id: string): string[] {
  const accepted = tryParseJson(sessionStorage.getItem(acceptedKey(id)), []);
  return Array.isArray(accepted) ? accepted : [];
}

export async function loadHelperAttachments(id: string): Promise<void> {
  const owner = entry(id);
  if (owner.snapshot.ready) return;
  const generation = owner.generation;
  owner.loading ??= (async () => {
    try {
      const key = await requestDraftKey(logicalKey(id));
      const draft = await readAttachmentDraft<HelperAttachmentDraft>(key);
      if (owner.generation !== generation) return;
      const latestToken = sessionStorage.getItem(tokenKey(id));
      if (draft && acceptedTokens(id).includes(draft.token)) {
        await deleteAttachmentDraft(key, draft.token);
        const empty = emptyDraft();
        publish(owner, {
          draft:
            latestToken && latestToken !== draft.token ? { ...empty, token: latestToken } : empty,
          ready: true,
          error: null,
        });
      } else if (draft && latestToken && latestToken !== draft.token) {
        await persist(id, { ...draft, token: latestToken });
        publish(owner, { ready: true, error: uiMessage('helperAttachments.recoveredOlder') });
      } else
        publish(owner, {
          draft:
            draft ??
            (latestToken ? { ...owner.snapshot.draft, token: latestToken } : owner.snapshot.draft),
          ready: true,
          error: null,
        });
    } catch {
      publish(owner, { error: uiMessage('helperAttachments.restoreFailed') });
    } finally {
      owner.loading = undefined;
    }
  })();
  return owner.loading;
}
function persist(id: string, draft: HelperAttachmentDraft): Promise<void> {
  const owner = entry(id);
  const remembered = writeOptionalStorage('session', tokenKey(id), draft.token);
  publish(owner, { draft, error: remembered ? null : uiMessage('helperAttachments.saveFailed') });
  const write = (owner.write ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      await writeAttachmentDraft(await requestDraftKey(logicalKey(id)), draft);
    });
  owner.write = write;
  void write.catch(() => publish(owner, { error: uiMessage('helperAttachments.saveFailed') }));
  return write;
}

export function touchHelperAttachments(id: string) {
  const owner = entry(id);
  if (!owner.snapshot.ready) return;
  void persist(id, { ...owner.snapshot.draft, token: crypto.randomUUID() });
}
export function helperAttachmentDraftMatches(id: string, token: string): boolean {
  return entry(id).snapshot.draft.token === token;
}
export function helperAttachmentError(
  draft: HelperAttachmentDraft,
  model: AttachmentModel | null
): UiMessage | null {
  const count = draft.images.length + draft.files.length;
  if (!count) return null;
  if (!model) return uiMessage('helperAttachments.modelRequired');
  if (draft.images.length && imageInputSupported(model.protocol, model.modelId) === false)
    return uiMessage('helperAttachments.imagesUnsupported');
  const unsupported = draft.files.find(
    (file) => !fileInputSupported(model.protocol, model.modelId, file)
  );
  if (unsupported)
    return uiMessage('helperAttachments.unsupportedModel', { name: unsupported.name });
  const limits = providerFileLimits(model.protocol);
  const fileLimit = Math.min(limits.maxFileBytes, REQUEST_FILE_MAX_BYTES);
  const large = draft.files.find((file) => file.blob.size > fileLimit);
  if (large)
    return uiMessage('helperAttachments.tooLarge', {
      name: large.name,
      mb: Math.floor(fileLimit / 1_000_000),
    });
  const totalLimit = Math.min(limits.maxTotalBytes, REQUEST_FILES_MAX_BYTES);
  if (draft.files.reduce((sum, file) => sum + file.blob.size, 0) > totalLimit)
    return uiMessage('helperAttachments.totalTooLarge', { mb: Math.floor(totalLimit / 1_000_000) });
  return null;
}

export async function freezeHelperAttachments(
  id: string,
  model: AttachmentModel | null
): Promise<FrozenHelperAttachments> {
  await loadHelperAttachments(id);
  const owner = entry(id);
  if (!owner.snapshot.ready || owner.snapshot.busy)
    throw new UiError(uiMessage('helperAttachments.notReady'));
  const draft = owner.snapshot.draft;
  const invalid = helperAttachmentError(draft, model);
  if (invalid) throw new UiError(invalid);
  try {
    await owner.write;
  } catch (cause) {
    if (draft.images.length || draft.files.length)
      throw new UiError(uiMessage('helperAttachments.saveFailed'), { cause });
  }
  const frozen: FrozenHelperAttachments = { draftToken: draft.token };
  for (const [kind, attachments] of [
    ['images', draft.images],
    ['files', draft.files],
  ] as const) {
    if (!attachments.length) continue;
    const refs: RequestFileUpload[] = [];
    for (const file of attachments) {
      const uploaded = await apiBinary<{ uploadId: string; sha256: string }>('/uploads', file.blob);
      refs.push({ uploadId: uploaded.uploadId, sha256: uploaded.sha256, name: file.name });
    }
    frozen[kind] = refs;
  }
  return frozen;
}

export async function acceptHelperAttachments(id: string, token: string): Promise<boolean> {
  const owner = entry(id);
  const accepted = [...new Set([...acceptedTokens(id), token])];
  sessionStorage.setItem(acceptedKey(id), JSON.stringify(accepted));
  await owner.write?.catch(() => {});
  const matched = owner.snapshot.draft.token === token;
  if (matched) {
    const draft = emptyDraft();
    sessionStorage.setItem(tokenKey(id), draft.token);
    publish(owner, { draft, error: null });
  }
  await deleteAttachmentDraft(await requestDraftKey(logicalKey(id)), token);
  sessionStorage.setItem(
    acceptedKey(id),
    JSON.stringify(acceptedTokens(id).filter((value) => value !== token))
  );
  return matched;
}

export async function deleteHelperAttachmentRecovery(id: string): Promise<void> {
  const owner = entry(id);
  owner.generation++;
  await owner.write?.catch(() => {});
  await deleteAttachmentDraft(await requestDraftKey(logicalKey(id)), null);
  publish(owner, { draft: emptyDraft(), ready: true, error: null });
  sessionStorage.removeItem(acceptedKey(id));
  sessionStorage.removeItem(tokenKey(id));
}

export function addHelperAttachmentFiles(
  id: string,
  files: File[],
  model: AttachmentModel | null
): Promise<void> {
  const owner = entry(id);
  if (!id || !files.length) return Promise.resolve();
  const generation = owner.generation;
  const append = () => appendHelperAttachmentFiles(owner, id, files, model, generation);
  const added: Promise<void> = owner.adding ? owner.adding.then(append) : append();
  owner.adding = added;
  void added.then(() => {
    if (owner.adding === added) owner.adding = undefined;
  });
  return added;
}

async function appendHelperAttachmentFiles(
  owner: Entry,
  id: string,
  files: File[],
  model: AttachmentModel | null,
  generation: number
): Promise<void> {
  if (!owner.snapshot.ready || owner.generation !== generation) return;
  publish(owner, { busy: true, error: null });
  try {
    const images: DraftImage[] = [],
      additions: DraftFile[] = [];
    for (const file of files) {
      const name = file.name || 'attachment';
      if (!file.size || name.length > 300)
        throw new UiError(uiMessage('helperAttachments.openFailed'));
      if (['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
        if (file.size > IMAGE_INPUT_MAX_BYTES)
          throw new UiError(uiMessage('helperAttachments.imageTooLarge'));
        const bitmap = await createImageBitmap(file);
        images.push({
          id: crypto.randomUUID(),
          name,
          blob: file,
          width: bitmap.width,
          height: bitmap.height,
        });
        bitmap.close();
      } else {
        const kind = classifyRequestFile(name, file.type);
        if (!kind) throw new UiError(uiMessage('helperAttachments.unsupportedType', { name }));
        additions.push({ id: crypto.randomUUID(), name, blob: file, ...kind });
      }
    }
    const previous = owner.snapshot.draft;
    if (owner.generation !== generation) return;
    const draft = {
      token: crypto.randomUUID(),
      images: [...previous.images, ...images],
      files: [...previous.files, ...additions],
    };
    if (
      draft.images.length > REQUEST_IMAGE_MAX_COUNT ||
      draft.files.length > REQUEST_FILE_MAX_COUNT
    )
      throw new UiError(
        uiMessage('helperAttachments.tooMany', {
          images: REQUEST_IMAGE_MAX_COUNT,
          files: REQUEST_FILE_MAX_COUNT,
        })
      );
    const invalid = helperAttachmentError(draft, model);
    if (invalid) throw new UiError(invalid);
    await persist(id, draft).catch(() => {
      throw new UiError(uiMessage('helperAttachments.saveFailed'));
    });
  } catch (cause) {
    publish(owner, {
      error: toUiMessage(cause, 'helperAttachments.openFailed'),
    });
  } finally {
    publish(owner, { busy: false });
  }
}

export function useHelperAttachmentDraft(id: string, model: AttachmentModel | null) {
  const owner = entry(id);
  const subscribe = useCallback(
    (listener: () => void) => {
      owner.listeners.add(listener);
      return () => {
        owner.listeners.delete(listener);
      };
    },
    [owner]
  );
  const snapshot = useSyncExternalStore(subscribe, () => owner.snapshot);
  useEffect(() => {
    if (id) void loadHelperAttachments(id);
  }, [id]);
  const touch = useCallback(() => touchHelperAttachments(id), [id]);
  const accept = model
    ? [
        ...(imageInputSupported(model.protocol, model.modelId) !== false
          ? ['image/png', 'image/jpeg', 'image/webp']
          : []),
        requestFileAccept(model.protocol, model.modelId),
      ]
        .filter(Boolean)
        .join(',')
    : undefined;
  const remove = (fileId: string) => {
    if (!snapshot.ready || owner.snapshot.busy) return;
    const draft = owner.snapshot.draft;
    void persist(id, {
      token: crypto.randomUUID(),
      images: draft.images.filter((item) => item.id !== fileId),
      files: draft.files.filter((item) => item.id !== fileId),
    });
  };
  const invalid = helperAttachmentError(snapshot.draft, model);
  return {
    ...snapshot,
    accept,
    error: snapshot.error ?? invalid,
    hasAttachments: !!(snapshot.draft.images.length || snapshot.draft.files.length),
    addFiles: (files: File[]) => addHelperAttachmentFiles(id, files, model),
    remove,
    retry: () => loadHelperAttachments(id),
    touch,
    clearError: () => publish(owner, { error: null }),
    freeze: () => freezeHelperAttachments(id, model),
  };
}
