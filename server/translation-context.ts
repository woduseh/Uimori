import type { Store } from './store.js';
import type { RunSnapshot } from '../core/types.js';
import type { TranslationReference } from '../core/translation-context.js';
import { successfulTranslation, validateTranslationArtifact } from './source-editing.js';
import { sourceHash } from '../core/source-history.js';

/** Only completed, currently valid wording for the exact frozen ancestry/hash is eligible. */
export function translationReferences(store: Store, snapshot: RunSnapshot): TranslationReference[] {
  const references: TranslationReference[] = [];
  for (const item of snapshot.history) {
    try {
      const source = store.source(item.revision);
      if (
        source.chatId !== snapshot.chatId ||
        source.hash !== (item.contentHash ?? sourceHash(item.text))
      )
        continue;
      const job = successfulTranslation(store, source);
      if (!job || job.status !== 'completed' || job.chatId !== snapshot.chatId) continue;
      validateTranslationArtifact(store, job, source);
      references.push({
        id: job.id,
        revision: job.revision ?? 0,
        sourceRevision: source.id,
        sourceHash: source.hash,
        text: String(job.result!.text),
        manual: job.result!.manual === true,
      });
    } catch {
      /* Missing, stale or malformed references cannot expand the scope. */
    }
  }
  return references;
}
