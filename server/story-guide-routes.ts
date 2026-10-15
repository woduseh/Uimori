import type { FastifyInstance } from 'fastify';
import { REQUEST_TEXT_MAX_CHARS } from '../core/content-limits.js';
import type { StoryGuideDetail } from '../core/story-guide.js';
import type { RunSnapshot } from '../core/types.js';
import { ChatOptionsStore } from './chat-options.js';
import { contextSourceRefs } from './context-planning.js';
import { freezeReservationSnapshot } from './reservation-snapshot.js';
import { prepareNativeRisuReadOnly } from './risu-native-readonly.js';
import { fields, HttpError, record, text } from './request-validation.js';
import { prepareStoryGuide, type StoryGuideHooks } from './story-guide-runtime.js';
import type { Store } from './store.js';

const TIMEOUT_MS = 120_000;
type Options = Pick<StoryGuideHooks, 'resolveCredential' | 'executeCodex' | 'vertexRequestTier'> & {
  signal: AbortSignal;
  track: (work: Promise<void>) => void;
  publish: (chatId: string) => void;
};

/** Inspect current sources without reserving a writer or executing card callbacks. */
function guideSnapshot(store: Store, chatId: string, request: string): RunSnapshot {
  const chat = store.chat(chatId);
  const profile = store.product.snapshot(chatId, 'inspect', chat.headRevision);
  if (!profile.models.main) throw new HttpError(409, 'MODEL_REQUIRED:main');
  new ChatOptionsStore(store).freeze(profile);
  const { revision, config } = store.storyGuide.get(chatId);
  const iso = new Date().toISOString();
  return freezeReservationSnapshot(
    store,
    {
      chatId,
      parentRevision: chat.headRevision,
      settingsRevision: chat.settingsRevision,
      settings: structuredClone(chat.settings),
      request,
      history: store.history(chat.headRevision),
      resources: store.product.resources(chatId, profile),
      profile,
      storyGuide: { revision, config },
      executionClock: { iso, unix: Math.floor(Date.parse(iso) / 1000) },
    },
    { purpose: 'story-guide' }
  );
}

export function storyGuideRoutes(app: FastifyInstance, store: Store, options: Options) {
  const analysisRevision = (chatId: string): number =>
    Number(
      store.db
        .prepare(
          `SELECT COALESCE(MAX(seq),0) AS revision FROM events WHERE chat_id=? AND (
            kind GLOB 'source.*' OR kind IN (
              'context.updated','context.notes.updated','story-guide.updated','profile.updated',
              'prompt-workspace.updated','options.updated','chat.lore.override','chat.variables.changed'
            )
          )`
        )
        .get(chatId)!.revision
    );
  const detail = (chatId: string): StoryGuideDetail => {
    const state = store.storyGuide.get(chatId);
    const last = store.db
      .prepare(
        "SELECT status,COALESCE(json_extract(snapshot,'$.storyGuideReceipt'),json_extract(snapshot,'$.storyGuide')) AS guide FROM runs WHERE chat_id=? ORDER BY rowid DESC LIMIT 1"
      )
      .get(chatId);
    const guide = last?.guide
      ? (JSON.parse(String(last.guide)) as RunSnapshot['storyGuideReceipt'])
      : undefined;
    const lastWithBrief = store.db
      .prepare(
        `SELECT COALESCE(json_extract(snapshot,'$.storyGuideReceipt.brief'),json_extract(snapshot,'$.storyGuide.brief')) AS brief
          FROM runs WHERE chat_id=? AND (
            json_type(snapshot,'$.storyGuideReceipt.brief')='object' OR
            json_type(snapshot,'$.storyGuide.brief')='object'
          ) ORDER BY rowid DESC LIMIT 1`
      )
      .get(chatId);
    return {
      ...state,
      analysisRevision: analysisRevision(chatId),
      // A settings edit during generation may reject cache publication, while the
      // run still owns its advice. A newer run without a guide must not hide it.
      ...(lastWithBrief
        ? { brief: JSON.parse(String(lastWithBrief.brief)) as StoryGuideDetail['brief'] }
        : {}),
      ...(guide
        ? {
            latestRun: {
              status: String(last!.status),
              used: !!guide.brief,
              ...(guide.error ? { error: guide.error } : {}),
            },
          }
        : {}),
    };
  };
  app.get<{ Params: { id: string } }>('/api/chats/:id/story-guide', async (request) =>
    detail(request.params.id)
  );
  app.put<{ Params: { id: string } }>(
    '/api/chats/:id/story-guide',
    { bodyLimit: 256 * 1024 },
    async (request) => {
      store.storyGuide.update(request.params.id, request.body);
      options.publish(request.params.id);
      return detail(request.params.id);
    }
  );
  for (const action of ['ask', 'refresh'] as const)
    app.post<{ Params: { id: string } }>(
      `/api/chats/:id/story-guide/${action}`,
      { bodyLimit: 16 * 1024 * 1024 },
      async (request, reply): Promise<{ text: string }> => {
        const body = record(request.body);
        fields(body, action === 'ask' ? ['question', 'request'] : ['request']);
        const question =
          action === 'ask'
            ? text(body.question, 'guide question', REQUEST_TEXT_MAX_CHARS)
            : undefined;
        const draft =
          body.request === undefined
            ? ''
            : text(body.request, 'guide request', REQUEST_TEXT_MAX_CHARS, true);
        const chatId = request.params.id;
        const frozen = guideSnapshot(store, chatId, draft);
        const sourceRefs = contextSourceRefs(frozen);
        const inputRevision = analysisRevision(chatId);
        const disconnected = new AbortController();
        const onClose = () => {
          if (!reply.raw.writableEnded) disconnected.abort();
        };
        reply.raw.on('close', onClose);
        const timeout = AbortSignal.timeout(TIMEOUT_MS);
        const signal = AbortSignal.any([options.signal, disconnected.signal, timeout]);
        const check = () => {
          if (timeout.aborted) throw new HttpError(504, 'STORY_GUIDE_TIMEOUT');
          if (signal.aborted) throw new HttpError(408, 'STORY_GUIDE_CANCELLED');
          if (
            store.chat(chatId).headRevision !== frozen.parentRevision ||
            analysisRevision(chatId) !== inputRevision
          )
            throw new HttpError(409, 'STORY_GUIDE_STALE');
        };
        const work = (async () => {
          check();
          // Native projection participates in the checkpoint key. Adopt a summary only
          // after that projection, without scheduling a new summary or writing a checkpoint.
          const snapshot = store.context.prepareRun(
            await prepareNativeRisuReadOnly(frozen, 'auxiliary')
          );
          const previous = store.context.previous(snapshot);
          if (previous && snapshot.contextPlan)
            snapshot.contextPlan = {
              ...snapshot.contextPlan,
              status: 'ready',
              compacted: previous.compacted,
              summary: previous.summary,
              recentSourceRevisions: snapshot.history
                .slice(previous.compacted.length)
                .map((source) => source.revision),
            };
          check();
          const result = await prepareStoryGuide(
            snapshot,
            {
              ...options,
              signal,
              timeoutMs: TIMEOUT_MS,
              authorize: (connection) => {
                check();
                return store.product.authorize(connection);
              },
              onAttemptStart: (wire) => {
                check();
                return store.product.startAttempt(chatId, null, null, wire, {
                  kind: 'story-guide',
                  retainContent: false,
                });
              },
              onAttemptFinish: (id, result) => store.product.finishAttempt(id, result),
            },
            { force: true, question }
          );
          check();
          if (
            sourceRefs.some((source) => store.sourceMetadata(source.revision).hash !== source.hash)
          )
            throw new HttpError(409, 'STORY_GUIDE_STALE');
          if (!result.brief) throw new HttpError(502, result.error ?? 'STORY_GUIDE_FAILED');
          return { text: result.brief.text };
        })();
        options.track(
          work.then(
            () => {},
            () => {}
          )
        );
        try {
          reply.header('Cache-Control', 'no-store');
          return await work;
        } catch (error) {
          check();
          throw error;
        } finally {
          reply.raw.off('close', onClose);
        }
      }
    );
}
