import { supportedLocale, type UiLocale } from '../core/ui-locale.js';
import { workspaceModelRef, type Connection, type ModelPreset } from '../core/product.js';
import {
  executeProvider,
  ProviderContractError,
  type ProviderExecutionOptions,
  type ProviderResult,
  transportConnection,
} from '../core/transport.js';
import { titleRequest } from './title-request.js';
import { promptWorkspace } from './prompt-workspace.js';
import type { Store } from './store.js';
import { textTokenExcerpt } from '../core/text-tokens.js';

// Titles need only a small preview, independent of the stored manuscript's length.
export const TITLE_EXCERPT_TOKENS = { request: 1000, source: 3000 } as const;

type Options = Pick<
  ProviderExecutionOptions,
  'resolveCredential' | 'executeCodex' | 'vertexRequestTier'
> & {
  signal: AbortSignal;
  track: (work: Promise<void>) => void;
  publish: (chatId: string) => void;
};

type TitleSource = {
  id: string;
  chatId: string;
  request: string;
  sourceRevision: string;
};

/** Optional one-shot helper. Its journal survives restarts; failures never replay. */
export class ChatTitleService {
  private active = new Map<string, AbortController>();
  constructor(
    private readonly store: Store,
    private readonly options: Options
  ) {}
  private has(chatId: string, ...kinds: string[]) {
    return kinds.some(
      (kind) =>
        !!this.store.db
          .prepare('SELECT 1 FROM events WHERE chat_id=? AND kind=? LIMIT 1')
          .get(chatId, `chat.title.${kind}`)
    );
  }
  enroll(chatId: string, locale: UiLocale = 'ko') {
    if (workspaceModelRef(promptWorkspace(this.store), 'title') && !this.has(chatId, 'eligible'))
      this.store.event(chatId, 'chat.title.eligible', locale);
  }
  cancel(chatId: string) {
    this.active.get(chatId)?.abort();
  }
  afterSource(runId: string, defer = false) {
    try {
      const run = this.store.db
        .prepare(`SELECT id,chat_id AS chatId,request,source_revision AS sourceRevision,
          json_extract(snapshot,'$.packageStart.mode') AS startMode
          FROM runs WHERE id=? AND status='completed' AND source_revision IS NOT NULL`)
        .get(runId) as (TitleSource & { startMode: string | null }) | undefined;
      if (!run || run.startMode === 'authored') return;
      const chatId = run.chatId;
      // Older enrollment events stored the chat ID and used Korean titles.
      const enrollment = this.store.db
        .prepare(
          "SELECT entity_id FROM events WHERE chat_id=? AND kind='chat.title.eligible' ORDER BY seq LIMIT 1"
        )
        .get(chatId);
      if (!enrollment || this.has(chatId, 'started', 'manual', 'generated', 'failed')) return;
      const deferred = this.store.db
        .prepare(
          "SELECT entity_id FROM events WHERE chat_id=? AND kind='chat.title.deferred' ORDER BY seq LIMIT 1"
        )
        .get(chatId)?.entity_id;
      if (deferred && deferred !== runId) return;
      if (defer) {
        if (!deferred) this.store.event(chatId, 'chat.title.deferred', runId);
        return;
      }
      this.store.event(chatId, 'chat.title.started', runId);
      const controller = new AbortController();
      this.active.set(chatId, controller);
      this.options.track(
        this.generate(run, controller, supportedLocale(enrollment.entity_id)).finally(() => {
          if (this.active.get(chatId) === controller) this.active.delete(chatId);
        })
      );
    } catch {
      // A title must never turn a successful source into a failed main execution.
    }
  }
  resumeDeferred() {
    const rows = this.store.db
      .prepare(`
      SELECT entity_id FROM events AS deferred
      WHERE kind='chat.title.deferred' AND NOT EXISTS (
        SELECT 1 FROM events AS done WHERE done.chat_id=deferred.chat_id
        AND done.kind IN ('chat.title.started','chat.title.manual','chat.title.generated','chat.title.failed')
      ) ORDER BY seq
    `)
      .all();
    for (const row of rows) this.afterSource(String(row.entity_id));
  }
  private async generate(run: TitleSource, controller: AbortController, locale: UiLocale) {
    const runId = run.id,
      chatId = run.chatId;
    let attempt: string | undefined;
    let result: ProviderResult | undefined;
    try {
      const ref = workspaceModelRef(promptWorkspace(this.store), 'title');
      if (!ref) throw new ProviderContractError('TITLE_MODEL_UNSET');
      this.store.product.assertAvailable('model', ref.id);
      const model = structuredClone(this.store.product.get<ModelPreset>('model', ref.id));
      const connection = structuredClone(
        this.store.product.get<Connection>('connection', model.connectionId)
      );
      const source = this.store.source(run.sourceRevision);
      const revision = this.store.chat(chatId).titleRevision;
      const signal = AbortSignal.any([
        controller.signal,
        this.options.signal,
        AbortSignal.timeout(25_000),
      ]);
      const authorize = () => {
        if (signal.aborted) throw new ProviderContractError('TITLE_CANCELLED');
        if (
          this.has(chatId, 'manual') ||
          this.store.chat(chatId).titleRevision !== revision ||
          this.store.source(source.id).hash !== source.hash
        )
          throw new ProviderContractError('TITLE_INPUT_CHANGED');
        const current = this.store.product.get<ModelPreset>('model', model.id);
        this.store.product.assertAvailable('model', model.id);
        if (current.enabled === false) throw new ProviderContractError('TITLE_MODEL_DISABLED');
        this.store.product.authorize(connection);
      };
      authorize();
      const languages: Record<UiLocale, string> = {
        ko: 'Korean',
        en: 'English',
        ja: 'Japanese',
        zh: 'Simplified Chinese',
      };
      const request = titleRequest(model, connection, {
        contract: `Give this story a title in ${languages[locale]}, as it might appear on a novel cover, a game title screen, or an episode opening. Find a striking image, phrase, tension, or promise in the scene and let its genre and mood shape the wording. Choose whatever length gives the title its rhythm. Use the request and manuscript as source material. Return the title alone on one line.`,
        task: JSON.stringify({
          request: textTokenExcerpt(run.request, TITLE_EXCERPT_TOKENS.request, {
            marker: '\n[Remaining request text omitted]',
          }).text,
          source: textTokenExcerpt(source.text, TITLE_EXCERPT_TOKENS.source, {
            marker: '\n[Remaining source text omitted]',
          }).text,
        }),
      });
      result = await executeProvider(transportConnection(connection), request, {
        ...this.options,
        signal,
        timeoutMs: 25_000,
        beforeTurn: authorize,
        onWire: (wire) => {
          authorize();
          if (attempt) throw new ProviderContractError('TITLE_DUPLICATE_SEND');
          attempt = this.store.product.startAttempt(chatId, runId, null, wire);
        },
      });
      if (attempt) this.store.product.finishAttempt(attempt, result);
      const title = result.text.trim().replace(/\s+/gu, ' ');
      if (result.status !== 'completed' || !title || result.toolCalls.length)
        throw new ProviderContractError('TITLE_INVALID_RESULT');
      this.store.transaction(() => {
        authorize();
        this.store.db.prepare('UPDATE chats SET title=? WHERE id=?').run(title, chatId);
        this.store.event(chatId, 'chat.title.generated', runId);
      });
      this.options.publish(chatId);
    } catch (error) {
      try {
        if (attempt && !result)
          this.store.product.finishAttempt(attempt, {
            status: 'error',
            text: '',
            toolCalls: [],
            refusal: null,
            error: {
              code: error instanceof ProviderContractError ? error.code : 'TITLE_GENERATION_FAILED',
            },
            usage: {
              inputTokens: null,
              outputTokens: null,
              costUsd: null,
              raw: null,
              priceRevision: null,
            },
            opaqueState: null,
          });
        this.store.event(chatId, 'chat.title.failed', runId);
      } catch {
        /* Deleting a chat also removes its helper state. */
      }
    }
  }
}
