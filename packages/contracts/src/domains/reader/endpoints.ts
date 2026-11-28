import { defineEndpoint } from '../../endpoint.js';
import { PROMPT_HTTP_BODY_MAX_BYTES } from '../limits.js';
import type { readerOperations as operations } from './operations.js';

export const readerEndpoints = {
  readSceneDetail: defineEndpoint<typeof operations.readSceneDetail>()({
    operation: 'reader.readSceneDetail',
    method: 'GET',
    path: '/attempts/:attemptId/scene-detail',
  }),
  readLastSceneLore: defineEndpoint<typeof operations.readLastSceneLore>()({
    operation: 'reader.readLastSceneLore',
    method: 'GET',
    path: '/chats/:chatId/last-scene-lore',
  }),
  listChatAttempts: defineEndpoint<typeof operations.listChatAttempts>()({
    operation: 'reader.listChatAttempts',
    method: 'GET',
    path: '/chats/:chatId/attempts',
  }),
  readAttempt: defineEndpoint<typeof operations.readAttempt>()({
    operation: 'reader.readAttempt',
    method: 'GET',
    path: '/attempts/:attemptId',
  }),
  listChatJobs: defineEndpoint<typeof operations.listChatJobs>()({
    operation: 'reader.listChatJobs',
    method: 'GET',
    path: '/chats/:chatId/jobs',
  }),
  readJob: defineEndpoint<typeof operations.readJob>()({
    operation: 'reader.readJob',
    method: 'GET',
    path: '/jobs/:jobId',
  }),
  readSceneDeletionImpact: defineEndpoint<typeof operations.readSceneDeletionImpact>()({
    operation: 'reader.readSceneDeletionImpact',
    method: 'GET',
    path: '/chats/:chatId/sources/:sourceId/deletion-impact',
  }),
  deleteScenes: defineEndpoint<typeof operations.deleteScenes>()({
    operation: 'reader.deleteScenes',
    method: 'DELETE',
    path: '/chats/:chatId/sources/:sourceId',
  }),
  reviseSelection: defineEndpoint<typeof operations.reviseSelection>()({
    operation: 'reader.reviseSelection',
    method: 'POST',
    path: '/sources/:sourceId/selection-revision',
    bodyLimit: 32 * 1024 * 1024,
    cache: 'no-store',
  }),
  translateInput: defineEndpoint<typeof operations.translateInput>()({
    operation: 'reader.translateInput',
    method: 'POST',
    path: '/chats/:chatId/input-translation',
    bodyLimit: 16 * 1024 * 1024,
    cache: 'no-store',
  }),
  preflightChatContent: defineEndpoint<typeof operations.preflightChatContent>()({
    operation: 'reader.preflightChatContent',
    method: 'POST',
    path: '/chats/:chatId/codex-content-preflight',
    bodyLimit: 32 * 1024 * 1024,
    cache: 'no-store',
  }),
  preflightSourceContent: defineEndpoint<typeof operations.preflightSourceContent>()({
    operation: 'reader.preflightSourceContent',
    method: 'POST',
    path: '/sources/:sourceId/codex-content-preflight',
    cache: 'no-store',
  }),
  previewPrompt: defineEndpoint<typeof operations.previewPrompt>()({
    operation: 'reader.previewPrompt',
    method: 'POST',
    path: '/chats/:chatId/prompt-preview',
    bodyLimit: PROMPT_HTTP_BODY_MAX_BYTES,
  }),
  previewRequest: defineEndpoint<typeof operations.previewRequest>()({
    operation: 'reader.previewRequest',
    method: 'POST',
    path: '/chats/:chatId/request-preview',
    bodyLimit: PROMPT_HTTP_BODY_MAX_BYTES,
  }),
  readResponseStream: defineEndpoint<typeof operations.readResponseStream>()({
    operation: 'reader.readResponseStream',
    method: 'GET',
    path: '/response-streams/:taskKind/:taskId',
  }),
  requestImages: defineEndpoint<typeof operations.requestImages>()({
    operation: 'reader.requestImages',
    method: 'POST',
    path: '/sources/:sourceId/images',
  }),
};
