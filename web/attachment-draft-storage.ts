import { openRecoveryDatabase, type RecoveryBuffer } from './editor-recovery.js';
import type { DraftFile, HelperAttachmentDraft } from './helper-attachment-draft.js';
import type { DraftImage, RequestDraft } from './request-image-draft.js';

type Draft = RequestDraft | HelperAttachmentDraft;
type StoredDraft = { token: string; imageIds: string[] } & (
  | { text: string }
  | { fileIds: string[] }
);

function getRecord<T>(buffers: IDBObjectStore, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const request = buffers.get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withDraftRecords<T>(
  key: string,
  mode: 'readonly' | 'readwrite',
  use: (buffers: IDBObjectStore, previous?: StoredDraft) => T | Promise<T>
): Promise<T> {
  const db = await openRecoveryDatabase();
  const tx = db.transaction('buffers', mode);
  const buffers = tx.objectStore('buffers');
  const committed = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('Attachment draft transaction aborted'));
  });
  const apply = getRecord<RecoveryBuffer<StoredDraft>>(buffers, key).then(async (prior) => {
    try {
      return await use(buffers, prior?.model);
    } catch (error) {
      if (mode === 'readwrite') tx.abort();
      throw error;
    }
  });
  const [result] = await Promise.all([apply, committed]);
  return result;
}

const attachmentKey = (key: string, id: string) => `${key}:attachment:${id}`;
function attachmentIds(draft?: StoredDraft) {
  if (!draft) return [];
  return 'fileIds' in draft ? [...draft.imageIds, ...draft.fileIds] : draft.imageIds;
}

export async function readAttachmentDraft<T extends Draft>(key: string): Promise<T | undefined> {
  const saved = await withDraftRecords(key, 'readonly', async (buffers, previous) => {
    if (!previous) return previous;
    const load = <A extends DraftImage | DraftFile>(ids: string[]) =>
      Promise.all(
        ids.map(async (id) => {
          const attachment = await getRecord<A>(buffers, attachmentKey(key, id));
          if (!attachment) throw new Error('Missing draft attachment');
          return attachment;
        })
      );
    const images = await load<DraftImage>(previous.imageIds);
    return 'fileIds' in previous
      ? { token: previous.token, images, files: await load<DraftFile>(previous.fileIds) }
      : { token: previous.token, images, text: previous.text };
  });
  return saved as T | undefined;
}

export function writeAttachmentDraft(key: string, draft: Draft) {
  return withDraftRecords(key, 'readwrite', (buffers, previous) => {
    const existing = new Set(attachmentIds(previous));
    const attachments = 'files' in draft ? [...draft.images, ...draft.files] : draft.images;
    for (const attachment of attachments)
      if (!existing.delete(attachment.id))
        buffers.put(attachment, attachmentKey(key, attachment.id));
    for (const removed of existing) buffers.delete(attachmentKey(key, removed));
    const header: RecoveryBuffer<StoredDraft> = {
      token: draft.token,
      revision: null,
      model: {
        token: draft.token,
        imageIds: draft.images.map((image) => image.id),
        ...('files' in draft
          ? { fileIds: draft.files.map((file) => file.id) }
          : { text: draft.text }),
      },
      rawFields: {},
    };
    buffers.put(header, key);
  });
}

export function deleteAttachmentDraft(key: string, token: string | null) {
  return withDraftRecords(key, 'readwrite', (buffers, saved) => {
    if (!saved || (token !== null && saved.token !== token)) return false;
    buffers.delete(key);
    for (const id of attachmentIds(saved)) buffers.delete(attachmentKey(key, id));
    return true;
  });
}
