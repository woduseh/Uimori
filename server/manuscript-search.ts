import { authoredOpeningSql } from './authored-opening.js';
import { Worker } from 'node:worker_threads';
import type { FastifyInstance } from 'fastify';
import type {
  ManuscriptSearchQuery,
  ManuscriptSearchResult,
  SearchIndexBatch,
} from '../core/manuscript-search.js';
import { AppError } from './app-errors.js';
import { personalWorkspaceEndpoints } from '#contracts';
import { type ManuscriptSearchInput, personalWorkspaceOperations } from '#contracts/operations';
import { registerEndpoint } from './endpoint.js';
import { foldSearchText } from './search-schema.js';
import type { Store } from './store.js';

export class ManuscriptSearch {
  private readonly workers = new Set<Worker>();
  private indexing: Promise<void> | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private readonly store: Store;
  private readonly writable: () => boolean;
  constructor(store: Store, writable: () => boolean = () => true) {
    this.store = store;
    this.writable = writable;
  }
  private work<T>(
    operation: 'index' | 'search',
    query?: ManuscriptSearchQuery,
    signal?: AbortSignal
  ): Promise<T> {
    if (this.closed || signal?.aborted)
      return Promise.reject(new AppError(503, 'SEARCH_INTERRUPTED'));
    if (this.workers.size >= 4) return Promise.reject(new AppError(429, 'SEARCH_BUSY'));
    return new Promise((resolve, reject) => {
      const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
      const worker = new Worker(
        new URL(`./manuscript-search-worker.${extension}`, import.meta.url),
        {
          workerData: {
            path: this.store.path,
            operation,
            query,
            openingSql: authoredOpeningSql('r.snapshot'),
          },
          execArgv: [],
          resourceLimits: { maxOldGenerationSizeMb: 256 },
        }
      );
      this.workers.add(worker);
      let settled = false;
      const finish = (value?: T, error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve(value!);
      };
      const abort = () => {
        finish(undefined, new AppError(408, 'SEARCH_TIMEOUT'));
        void worker.terminate();
      };
      const timer = setTimeout(abort, 8000);
      signal?.addEventListener('abort', abort, { once: true });
      worker.once('message', (message: { result?: T; error?: string }) => {
        if (message.error)
          finish(
            undefined,
            message.error === 'SEARCH_CURSOR_STALE'
              ? new AppError(409, 'SEARCH_CURSOR_STALE')
              : new AppError(400, 'SEARCH_FAILED')
          );
        else finish(message.result);
      });
      worker.once('error', () => finish(undefined, new AppError(503, 'SEARCH_FAILED')));
      worker.once('exit', () => {
        this.workers.delete(worker);
        if (!settled) finish(undefined, new AppError(503, 'SEARCH_INTERRUPTED'));
      });
    });
  }
  async search(
    input: ManuscriptSearchInput,
    signal?: AbortSignal
  ): Promise<ManuscriptSearchResult> {
    const { scope, kinds, limit = 20 } = input;
    const chatId = scope === 'chat' ? input.chatId : undefined;
    const botId = scope === 'bot' ? input.botId : undefined;
    if (chatId) this.store.chat(chatId);
    if (botId) this.store.organization.bot(botId);
    return this.work(
      'search',
      {
        query: input.query.trim(),
        scope,
        chatId,
        botId,
        kinds,
        cursor: input.cursor ?? null,
        limit,
      },
      signal
    );
  }
  async refreshBatch(): Promise<void> {
    if (this.indexing) return this.indexing;
    if (
      this.closed ||
      !this.writable() ||
      !this.store.db.prepare('SELECT 1 FROM search_dirty_sources LIMIT 1').get()
    )
      return;
    this.indexing = (async () => {
      const batch = await this.work<SearchIndexBatch>('index');
      if (this.closed || !this.writable()) return;
      this.store.transaction(() => {
        const insert = this.store.db.prepare(
          "INSERT INTO search_documents(source_id,chat_id,kind,content_hash,text,search_text) VALUES(?,?,?,?,?,'')"
        );
        const indexTrigrams = this.store.db.prepare(
          'INSERT INTO search_trigrams(rowid,text) VALUES(?,?)'
        );
        for (const item of batch) {
          const pending = this.store.db
            .prepare('SELECT revision FROM search_dirty_sources WHERE source_id=?')
            .get(item.sourceId);
          if (!pending || Number(pending.revision) !== item.revision) continue;
          this.store.db
            .prepare('DELETE FROM search_documents WHERE source_id=?')
            .run(item.sourceId);
          for (const doc of item.documents)
            indexTrigrams.run(
              insert.run(doc.sourceId, doc.chatId, doc.kind, doc.contentHash, doc.text)
                .lastInsertRowid,
              foldSearchText(doc.text)
            );
          this.store.db
            .prepare('DELETE FROM search_dirty_sources WHERE source_id=?')
            .run(item.sourceId);
        }
      });
    })().finally(() => {
      this.indexing = null;
    });
    return this.indexing;
  }
  listen() {
    const tick = async () => {
      try {
        await this.refreshBatch();
      } catch {}
      if (!this.closed) {
        this.timer = setTimeout(() => void tick(), 1000);
        this.timer.unref();
      }
    };
    void tick();
  }
  async close() {
    this.closed = true;
    clearTimeout(this.timer);
    await Promise.allSettled([...this.workers].map((worker) => worker.terminate()));
    await this.indexing?.catch(() => {});
  }
}
export function manuscriptSearchRoutes(app: FastifyInstance, service: ManuscriptSearch) {
  registerEndpoint(
    app,
    personalWorkspaceEndpoints.searchManuscripts,
    personalWorkspaceOperations.searchManuscripts,
    async (input, _request, reply) => {
      const controller = new AbortController();
      const abort = () => {
        if (!reply.raw.writableEnded) controller.abort();
      };
      reply.raw.once('close', abort);
      try {
        return await service.search(input, controller.signal);
      } finally {
        reply.raw.removeListener('close', abort);
      }
    }
  );
}
