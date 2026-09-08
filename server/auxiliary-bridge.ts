import { translationChunkChars } from '../core/translation-settings.js';
import type { Store } from './store.js';
import { type AssetEntry } from '../core/auxiliary.js';
import type { AuxiliaryStoreBridge } from './product-auxiliary.js';
import type { Controls } from './controls.js';
import { translationReferences } from './translation-context.js';
import { imageCatalog } from './package-images.js';

export function auxiliaryBridge(
  store: Store,
  controls: Controls,
  signal: AbortSignal
): AuxiliaryStoreBridge {
  const owns = (id: string, generation: number, owner: string) => {
    if (!store.ownsJob(id, generation, owner)) throw new Error('Job ownership changed');
    const job = store.job(id);
    const source = store.source(job.sourceRevision);
    if (source.hash !== job.sourceHash || source.chatId !== job.chatId)
      throw new Error('SOURCE_DEPENDENCY_MISMATCH');
  };
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
      const row = store.db.prepare('SELECT retry_chunk FROM jobs WHERE id=?').get(id) as {
        retry_chunk: string | null;
      };
      return {
        job,
        source,
        snapshot,
        ...(job.kind === 'translation'
          ? { translationReferences: translationReferences(store, snapshot) }
          : {}),
        assets: job.kind === 'image' ? imageCatalog(job.input) : assets,
        translationChunkChars: translationChunkChars(
          job.input && typeof job.input === 'object'
            ? (job.input as { translationChunkChars?: unknown }).translationChunkChars
            : undefined
        ),
        plan: store.product.plan(id) ?? undefined,
        chunks: store.product.chunks(id),
        ...(row.retry_chunk ? { retryChunkIds: [row.retry_chunk] } : {}),
      };
    },
    async claim(id, owner, prepared) {
      const job = store.claimJob(
        id,
        owner,
        { initial: prepared.input, inputs: [], toolEvents: [] },
        prepared.plan
      );
      if (!job) return null;
      await controls.wait(job.kind, signal);
      signal.throwIfAborted();
      controls.fail(job.kind);
      return job.generation;
    },
    beginChunk(id, chunk, generation, owner) {
      owns(id, generation, owner);
      store.product.chunk(id, chunk, 'running');
    },
    completeChunk(id, chunk, generation, owner, result) {
      owns(id, generation, owner);
      store.product.chunk(id, chunk, 'completed', undefined, result);
    },
    failChunk(id, chunk, generation, owner, code, status) {
      if (store.ownsJob(id, generation, owner))
        store.product.chunk(id, chunk, status, undefined, undefined, code);
    },
    finish(id, generation, owner, outcome) {
      store.finishAuxiliary(id, generation, owner, outcome, controls);
    },
  };
}
