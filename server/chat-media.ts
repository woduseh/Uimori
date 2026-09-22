import type { ChatTranscript } from '../core/chat-transcript.js';
import type { Store } from './store.js';
import { encodedImage } from './image-storage.js';

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

/** Include bytes referenced by authored Markdown/HTML even when they are not part of the bot. */
export function transcriptImages(store: Store, transcripts: readonly ChatTranscript[]) {
  const hashes = new Set<string>();
  for (const transcript of transcripts)
    for (const entry of transcript.entries)
      for (const text of [entry.text, entry.translation ?? ''])
        for (const match of text.matchAll(/\/api\/package-image-blobs\/([a-f0-9]{64})/gu))
          hashes.add(match[1]);
  return [...hashes].map((hash) => encodedImage(store.db, hash));
}
