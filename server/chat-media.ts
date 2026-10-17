import type { ChatTranscript } from '../core/chat-transcript.js';
import type { Store } from './store.js';

export function remapTranscriptRequestImages(
  transcript: ChatTranscript,
  resolve: (hash: string) => string
): void {
  for (const entry of transcript.entries)
    if (entry.requestImages)
      entry.requestImages = entry.requestImages.map((image) => ({
        ...image,
        hash: resolve(image.hash),
        input: { ...image.input, hash: resolve(image.input.hash) },
      }));
}

const mediaUrl = /\/api\/(assets|illustration-images|package-image-blobs)\/([A-Za-z0-9_.-]+)/gu;

export function rewriteTranscriptMedia(
  transcript: ChatTranscript,
  resolve: (kind: string, id: string) => string | undefined
): ChatTranscript {
  const rewrite = (text: string) =>
    text.replace(mediaUrl, (original, kind, id) => resolve(kind, id) ?? original);
  return {
    ...transcript,
    entries: transcript.entries.map((entry) => ({
      ...entry,
      text: rewrite(entry.text),
      translation: entry.translation === null ? null : rewrite(entry.translation),
    })),
  };
}

/** A copied message points at immutable media bytes, not another chat's mutable asset row. */
export function independentTranscriptMedia(
  store: Store,
  transcript: ChatTranscript
): ChatTranscript {
  const cache = new Map<string, string | undefined>();
  return rewriteTranscriptMedia(transcript, (kind, id) => {
    if (kind === 'package-image-blobs') return undefined;
    const key = `${kind}/${id}`;
    if (!cache.has(key)) {
      const table = kind === 'assets' ? 'assets' : 'illustration_images';
      const row = store.db.prepare(`SELECT hash FROM ${table} WHERE id=?`).get(id);
      cache.set(
        key,
        typeof row?.hash === 'string' ? `/api/package-image-blobs/${row.hash}` : undefined
      );
    }
    return cache.get(key);
  });
}

export function independentTextMedia(store: Store, text: string): string {
  return text.replace(mediaUrl, (raw, kind, id) => {
    if (kind === 'package-image-blobs') return raw;
    const table = kind === 'assets' ? 'assets' : 'illustration_images';
    const row = store.db.prepare(`SELECT hash FROM ${table} WHERE id=?`).get(id);
    return typeof row?.hash === 'string' ? `/api/package-image-blobs/${row.hash}` : raw;
  });
}
