import { translationPolicy, type TranslationPolicy } from '../core/translation-settings.js';
import type { Store } from './store.js';
import { type AssetEntry } from '../core/auxiliary.js';
import type { AuxiliaryStoreBridge } from './product-auxiliary.js';
import type { Controls } from './controls.js';
import { translationReferences } from './translation-context.js';
import { imageCatalog, imageTargetSource } from './package-images.js';

export function auxiliaryBridge(
  store: Store,
  controls: Controls,
  signal: AbortSignal
): AuxiliaryStoreBridge {
  return {
    load(id) {
      const job = store.job(id);
      const source = store.sourceAtHash(job.sourceRevision, job.sourceHash);
      const snapshot = store.product.resolveJobPrompt(store.run(source.runId).snapshot, job.input);
      const assets: AssetEntry[] = store.product.assets(job.chatId).map((a) => ({
        ref: a.id,
        revision: a.revision,
        hash: a.hash,
        url: a.url,
        alt: a.title,
        caption: a.description,
        actorId: a.actor,
        clothing: a.outfit,
        location: a.location,
        uses: a.allowedUse === 'both' ? ['profile', 'inline'] : [a.allowedUse],
      }));
      return {
        job,
        source,
        snapshot,
        ...(job.kind === 'image' ? { imageSource: imageTargetSource(store, job, true) } : {}),
        ...(job.kind === 'translation'
          ? { translationReferences: translationReferences(store, snapshot) }
          : {}),
        assets: job.kind === 'image' ? imageCatalog(job.input) : assets,
        ...(job.kind === 'translation' &&
        job.input &&
        typeof job.input === 'object' &&
        'translationPolicy' in job.input
          ? {
              translationPolicy: translationPolicy(
                job.input.translationPolicy as TranslationPolicy
              ),
            }
          : {}),
      };
    },
    async claim(id, owner, prepared) {
      const job = store.claimJob(id, owner, {
        initial: prepared.input,
        inputs: [],
        toolEvents: [],
      });
      if (!job) return null;
      await controls.wait(job.kind, signal);
      signal.throwIfAborted();
      controls.fail(job.kind);
      return job.generation;
    },
    finish(id, generation, owner, outcome) {
      store.finishAuxiliary(id, generation, owner, outcome, controls);
    },
  };
}
