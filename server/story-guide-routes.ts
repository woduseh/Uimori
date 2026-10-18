import type { FastifyInstance } from 'fastify';
import type { StoryGuideDetail } from '../core/story-guide.js';
import type { RunSnapshot } from '../core/types.js';
import type { Store } from './store.js';

export function storyGuideRoutes(
  app: FastifyInstance,
  store: Store,
  options: { publish: (chatId: string) => void }
) {
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
}
