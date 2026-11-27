import { defineEndpoint } from '../../endpoint.js';
import type { chatSettingsOperations as operations } from './operations.js';

export const chatSettingsEndpoints = {
  readOptions: defineEndpoint<typeof operations.readOptions>()({
    operation: 'chat-settings.readOptions',
    method: 'GET',
    path: '/chats/:chatId/options',
  }),
  fixOptions: defineEndpoint<typeof operations.fixOptions>()({
    operation: 'chat-settings.fixOptions',
    method: 'POST',
    path: '/chats/:chatId/options/fixed',
  }),
  stageOptions: defineEndpoint<typeof operations.stageOptions>()({
    operation: 'chat-settings.stageOptions',
    method: 'POST',
    path: '/chats/:chatId/options/oneoff',
  }),
  cancelStagedOptions: defineEndpoint<typeof operations.cancelStagedOptions>()({
    operation: 'chat-settings.cancelStagedOptions',
    method: 'POST',
    path: '/chats/:chatId/options/pending/:pendingId/cancel',
  }),
  readVariables: defineEndpoint<typeof operations.readVariables>()({
    operation: 'chat-settings.readVariables',
    method: 'GET',
    path: '/chats/:chatId/variables',
  }),
  writeVariables: defineEndpoint<typeof operations.writeVariables>()({
    operation: 'chat-settings.writeVariables',
    method: 'PUT',
    path: '/chats/:chatId/variables',
  }),
  readStoryGuide: defineEndpoint<typeof operations.readStoryGuide>()({
    operation: 'chat-settings.readStoryGuide',
    method: 'GET',
    path: '/chats/:chatId/story-guide',
  }),
  updateStoryGuide: defineEndpoint<typeof operations.updateStoryGuide>()({
    operation: 'chat-settings.updateStoryGuide',
    method: 'PUT',
    path: '/chats/:chatId/story-guide',
    bodyLimit: 256 * 1024,
  }),
  readOrphanMemory: defineEndpoint<typeof operations.readOrphanMemory>()({
    operation: 'chat-settings.readOrphanMemory',
    method: 'GET',
    path: '/chats/:chatId/orphan-memory',
  }),
  applyOrphanMemory: defineEndpoint<typeof operations.applyOrphanMemory>()({
    operation: 'chat-settings.applyOrphanMemory',
    method: 'POST',
    path: '/chats/:chatId/orphan-memory',
  }),
};
