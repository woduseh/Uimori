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
import { deleteRecoveryIfToken, readRecovery, writeRecovery } from './editor-recovery.js';
import { message } from './i18n.js';
import { requestDraftKey, type DraftImage } from './request-image-draft.js';

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
type Snapshot = { draft: HelperAttachmentDraft; ready: boolean; busy: boolean; error: string };
type Entry = {
  generation: number;
  snapshot: Snapshot;
  listeners: Set<() => void>;
  loading?: Promise<void>;
  write?: Promise<void>;
};
const entries = new Map<string, Entry>();
const emptyDraft = (): HelperAttachmentDraft => ({
  token: crypto.randomUUID(),
  images: [],
  files: [],
});
const logicalKey = (id: string) => `helper-attachments:${id}`;
const acceptedKey = (id: string) => `uimori:helper-attachments-accepted:${id}`;
const tokenKey = (id: string) => `uimori:helper-attachments-token:${id}`;
function entry(id: string): Entry {
  let found = entries.get(id);
  if (!found) {
    found = {
      generation: 0,
      snapshot: { draft: emptyDraft(), ready: false, busy: false, error: '' },
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
  return JSON.parse(sessionStorage.getItem(acceptedKey(id)) ?? '[]') as string[];
}

/** A conversation has one live owner across sidecar/full workspace remounts. */
export async function loadHelperAttachments(id: string): Promise<void> {
  const owner = entry(id);
  if (owner.snapshot.ready) return;
  const generation = owner.generation;
  owner.loading ??= (async () => {
    try {
      const key = await requestDraftKey(logicalKey(id));
      const saved = await readRecovery<HelperAttachmentDraft>(key);
      if (owner.generation !== generation) return;
      const draft = saved?.model;
      const latestToken = sessionStorage.getItem(tokenKey(id));
      if (draft && acceptedTokens(id).includes(draft.token)) {
        await deleteRecoveryIfToken(key, draft.token);
        const empty = emptyDraft();
        publish(owner, {
          draft:
            latestToken && latestToken !== draft.token ? { ...empty, token: latestToken } : empty,
          ready: true,
          error: '',
        });
      } else if (draft && latestToken && latestToken !== draft.token) {
        // Text identity was published before a failed Blob write. Retain its newer owner
        // across reload so an old request acknowledgement cannot clear the new input.
        await persist(id, { ...draft, token: latestToken });
        publish(owner, { ready: true, error: message('helperAttachments.recoveredOlder') });
      } else
        publish(owner, {
          draft:
            draft ??
            (latestToken ? { ...owner.snapshot.draft, token: latestToken } : owner.snapshot.draft),
          ready: true,
          error: '',
        });
    } catch {
      publish(owner, { error: message('helperAttachments.restoreFailed') });
    } finally {
      owner.loading = undefined;
    }
  })();
  return owner.loading;
}
function persist(id: string, draft: HelperAttachmentDraft): Promise<void> {
  const owner = entry(id);
  let remembered = true;
  try {
    sessionStorage.setItem(tokenKey(id), draft.token);
  } catch {
    remembered = false;
  }
  publish(owner, { draft, error: remembered ? '' : message('helperAttachments.saveFailed') });
  const write = (owner.write ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      await writeRecovery(await requestDraftKey(logicalKey(id)), {
        token: draft.token,
        revision: null,
        model: draft,
        rawFields: {},
      });
    });
  owner.write = write;
  void write.catch(() => publish(owner, { error: message('helperAttachments.saveFailed') }));
  return write;
}

/** Text changes also advance attachment identity, including identical text retyped later. */
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
): string {
  const count = draft.images.length + draft.files.length;
  if (!count) return '';
  if (!model) return message('helperAttachments.modelRequired');
  if (draft.images.length && imageInputSupported(model.protocol, model.modelId) === false)
    return message('helperAttachments.imagesUnsupported');
  const unsupported = draft.files.find(
    (file) => !fileInputSupported(model.protocol, model.modelId, file)
  );
  if (unsupported) return message('helperAttachments.unsupportedModel', { name: unsupported.name });
  const limits = providerFileLimits(model.protocol);
  const fileLimit = Math.min(limits.maxFileBytes, REQUEST_FILE_MAX_BYTES);
  const large = draft.files.find((file) => file.blob.size > fileLimit);
  if (large)
    return message('helperAttachments.tooLarge', {
      name: large.name,
      mb: Math.floor(fileLimit / 1_000_000),
    });
  const totalLimit = Math.min(limits.maxTotalBytes, REQUEST_FILES_MAX_BYTES);
  if (draft.files.reduce((sum, file) => sum + file.blob.size, 0) > totalLimit)
    return message('helperAttachments.totalTooLarge', { mb: Math.floor(totalLimit / 1_000_000) });
  return '';
}

/** Immutable upload references are stored in the outbox and reused on uncertain admission. */
export async function freezeHelperAttachments(
  id: string,
  model: AttachmentModel | null
): Promise<FrozenHelperAttachments> {
  await loadHelperAttachments(id);
  const owner = entry(id);
  if (!owner.snapshot.ready || owner.snapshot.busy)
    throw new Error(message('helperAttachments.notReady'));
  const draft = owner.snapshot.draft;
  const invalid = helperAttachmentError(draft, model);
  if (invalid) throw new Error(invalid);
  await owner.write;
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

/** A late acknowledgement clears only the exact frozen draft, including its saved blobs. */
export async function acceptHelperAttachments(id: string, token: string): Promise<boolean> {
  const owner = entry(id);
  const accepted = [...new Set([...acceptedTokens(id), token])];
  sessionStorage.setItem(acceptedKey(id), JSON.stringify(accepted));
  await owner.write?.catch(() => {});
  const matched = owner.snapshot.draft.token === token;
  if (matched) {
    const draft = emptyDraft();
    sessionStorage.setItem(tokenKey(id), draft.token);
    publish(owner, { draft, error: '' });
  }
  await deleteRecoveryIfToken(await requestDraftKey(logicalKey(id)), token);
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
  await writeRecovery(await requestDraftKey(logicalKey(id)));
  publish(owner, { draft: emptyDraft(), ready: true, error: '' });
  sessionStorage.removeItem(acceptedKey(id));
  sessionStorage.removeItem(tokenKey(id));
}

export async function addHelperAttachmentFiles(
  id: string,
  files: File[],
  model: AttachmentModel | null
): Promise<void> {
  const owner = entry(id);
  if (!id || !owner.snapshot.ready || owner.snapshot.busy || !files.length) return;
  publish(owner, { busy: true, error: '' });
  const generation = owner.generation;
  try {
    const images: DraftImage[] = [],
      additions: DraftFile[] = [];
    for (const file of files) {
      const name = file.name || 'attachment';
      if (!file.size || name.length > 300) throw new Error(message('helperAttachments.openFailed'));
      if (['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
        if (file.size > IMAGE_INPUT_MAX_BYTES)
          throw new Error(message('helperAttachments.imageTooLarge'));
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
        if (!kind) throw new Error(message('helperAttachments.unsupportedType', { name }));
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
      throw new Error(
        message('helperAttachments.tooMany', {
          images: REQUEST_IMAGE_MAX_COUNT,
          files: REQUEST_FILE_MAX_COUNT,
        })
      );
    const invalid = helperAttachmentError(draft, model);
    if (invalid) throw new Error(invalid);
    await persist(id, draft).catch(() => {
      throw new Error(message('helperAttachments.saveFailed'));
    });
  } catch (cause) {
    publish(owner, {
      error: cause instanceof Error ? cause.message : message('helperAttachments.openFailed'),
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
  return {
    ...snapshot,
    accept,
    error: snapshot.error || helperAttachmentError(snapshot.draft, model),
    hasAttachments: !!(snapshot.draft.images.length || snapshot.draft.files.length),
    addFiles: (files: File[]) => addHelperAttachmentFiles(id, files, model),
    remove,
    retry: () => loadHelperAttachments(id),
    touch,
    clearError: () => publish(owner, { error: '' }),
    freeze: () => freezeHelperAttachments(id, model),
  };
}
