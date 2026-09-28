import { Worker } from 'node:worker_threads';
import type { FastifyInstance } from 'fastify';
import type {
  ManuscriptSearchQuery,
  ManuscriptSearchResult,
  SearchIndexBatch,
  SearchKind,
} from '../core/manuscript-search.js';
import { HttpError, fields, record, text } from './request-validation.js';
import type { Store } from './store.js';

export class ManuscriptSearch {
  private readonly workers = new Set<Worker>();
  private indexing: Promise<void> | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  constructor(
    private readonly store: Store,
    private readonly writable: () => boolean = () => true
  ) {}
  private work<T>(
    operation: 'index' | 'search',
    query?: ManuscriptSearchQuery,
    signal?: AbortSignal
  ): Promise<T> {
    if (this.closed || signal?.aborted)
      return Promise.reject(new HttpError(503, '검색이 중단됐어요.'));
    if (this.workers.size >= 4)
      return Promise.reject(
        new HttpError(429, '진행 중인 검색이 있어요. 잠시 후 다시 검색해 주세요.')
      );
    return new Promise((resolve, reject) => {
      const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
      const worker = new Worker(
        new URL(`./manuscript-search-worker.${extension}`, import.meta.url),
        {
          workerData: { path: this.store.path, operation, query },
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
        finish(undefined, new HttpError(408, '검색 범위를 좁혀 다시 검색해 주세요.'));
        void worker.terminate();
      };
      const timer = setTimeout(abort, 8000);
      signal?.addEventListener('abort', abort, { once: true });
      worker.once('message', (message: { result?: T; error?: string }) => {
        if (message.error)
          finish(
            undefined,
            new HttpError(
              message.error === 'SEARCH_CURSOR_STALE' ? 409 : 400,
              message.error === 'SEARCH_CURSOR_STALE'
                ? 'SEARCH_CURSOR_STALE'
                : '검색을 완료하지 못했어요. 검색어나 범위를 확인해 주세요.'
            )
          );
        else finish(message.result);
      });
      worker.once('error', () =>
        finish(undefined, new HttpError(503, '검색을 완료하지 못했어요.'))
      );
      worker.once('exit', () => {
        this.workers.delete(worker);
        if (!settled) finish(undefined, new HttpError(503, '검색이 중단됐어요.'));
      });
    });
  }
  async search(value: unknown, signal?: AbortSignal): Promise<ManuscriptSearchResult> {
    const body = record(value);
    fields(body, ['query', 'scope', 'chatId', 'botId', 'kinds', 'cursor', 'limit']);
    const query = text(body.query, 'search query', 500).trim();
    if (!['workspace', 'chat', 'bot'].includes(String(body.scope)))
      throw new HttpError(400, '검색 범위를 확인해 주세요.');
    if (
      !Array.isArray(body.kinds) ||
      !body.kinds.length ||
      body.kinds.length > 3 ||
      body.kinds.some((kind) => !['original', 'translation', 'request'].includes(kind))
    )
      throw new HttpError(400, '검색 대상을 확인해 주세요.');
    const scope = body.scope as ManuscriptSearchQuery['scope'];
    const chatId = scope === 'chat' ? text(body.chatId, 'chat', 120) : undefined;
    const botId = scope === 'bot' ? text(body.botId, 'bot', 120) : undefined;
    if (chatId) this.store.chat(chatId);
    if (botId) this.store.organization.bot(botId);
    const limit = body.limit === undefined ? 20 : Number(body.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50)
      throw new HttpError(400, '검색 페이지 크기를 확인해 주세요.');
    const cursor = body.cursor == null ? null : text(body.cursor, 'cursor', 1500);
    return this.work(
      'search',
      { query, scope, chatId, botId, kinds: body.kinds as SearchKind[], cursor, limit },
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
          'INSERT INTO search_documents(source_id,chat_id,kind,content_hash,text,search_text) VALUES(?,?,?,?,?,?)'
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
            insert.run(
              doc.sourceId,
              doc.chatId,
              doc.kind,
              doc.contentHash,
              doc.text,
              doc.text.normalize('NFC').toLowerCase()
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
      } catch {
        /* Dirty sources remain queryable; retry indexing later. */
      }
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
  app.post('/api/search', async (request, reply) => {
    const controller = new AbortController();
    const abort = () => {
      if (!reply.raw.writableEnded) controller.abort();
    };
    reply.raw.once('close', abort);
    try {
      return await service.search(request.body, controller.signal);
    } finally {
      reply.raw.removeListener('close', abort);
    }
  });
}
