import type { FastifyInstance } from 'fastify';
import { chatSettingsEndpoints } from '#contracts';
import { chatSettingsOperations } from '#contracts/operations';
import type { StoryGuideDetail } from '../core/story-guide.js';
import type { RunSnapshot } from '../core/types.js';
import { registerEndpoint } from './endpoint.js';
import type { Store } from './store.js';

export function storyGuideRoutes(
  app: FastifyInstance,
  store: Store,
  options: { publish: (chatId: string) => void }
) {
  const detail = (chatId: string): StoryGuideDetail => {
    const state = store.storyGuide.get(chatId);
    const writerIncludesGuide = `a.job_id IS NULL AND a.usage_kind='writing' AND
      json_extract(a.request,'$.requestReceipt.storyGuide.status')='included'`;
    const last = store.db
      .prepare(
        `SELECT r.status,COALESCE(json_extract(r.snapshot,'$.storyGuideReceipt'),
          json_extract(r.snapshot,'$.storyGuide')) AS guide,
          EXISTS (SELECT 1 FROM attempts a WHERE a.run_id=r.id AND ${writerIncludesGuide}) AS used
          FROM runs r WHERE r.chat_id=? ORDER BY r.rowid DESC LIMIT 1`
      )
      .get(chatId);
    const guide = last?.guide
      ? (JSON.parse(String(last.guide)) as RunSnapshot['storyGuideReceipt'])
      : undefined;
    const lastWithBrief = store.db
      .prepare(
        `SELECT COALESCE(json_extract(r.snapshot,'$.storyGuideReceipt.brief'),json_extract(r.snapshot,'$.storyGuide.brief')) AS brief
          FROM attempts a JOIN runs r ON r.id=a.run_id WHERE r.chat_id=? AND (
            json_type(r.snapshot,'$.storyGuideReceipt.brief')='object' OR
            json_type(r.snapshot,'$.storyGuide.brief')='object'
          ) AND ${writerIncludesGuide} ORDER BY r.rowid DESC LIMIT 1`
      )
      .get(chatId);
    return {
      ...state,
      brief: lastWithBrief
        ? (JSON.parse(String(lastWithBrief.brief)) as StoryGuideDetail['brief'])
        : null,
      ...(guide
        ? {
            latestRun: {
              status: String(last!.status),
              used: !!guide.brief && last!.used === 1,
              ...(guide.error ? { error: guide.error } : {}),
            },
          }
        : {}),
    };
  };
  registerEndpoint(
    app,
    chatSettingsEndpoints.readStoryGuide,
    chatSettingsOperations.readStoryGuide,
    ({ chatId }) => detail(chatId)
  );
  registerEndpoint(
    app,
    chatSettingsEndpoints.updateStoryGuide,
    chatSettingsOperations.updateStoryGuide,
    ({ chatId, ...update }) => {
      store.storyGuide.update(chatId, update);
      options.publish(chatId);
      return detail(chatId);
    }
  );
}
