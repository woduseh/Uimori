import { defineEndpoint } from '../../endpoint.js';
import type { chatOperations as operations } from './operations.js';

const CHAT_ASSET_BODY_MAX_BYTES = 90 * 1024 * 1024;

export const chatEndpoints = {
  readBotDefaults: defineEndpoint<typeof operations.readBotDefaults>()({
    operation: 'chat.readBotDefaults',
    method: 'GET',
    path: '/bots/:botId/defaults',
  }),
  updateBotDefaults: defineEndpoint<typeof operations.updateBotDefaults>()({
    operation: 'chat.updateBotDefaults',
    method: 'PATCH',
    path: '/bots/:botId/defaults',
  }),
  listFolders: defineEndpoint<typeof operations.listFolders>()({
    operation: 'chat.listFolders',
    method: 'GET',
    path: '/bots/:botId/folders',
  }),
  createFolder: defineEndpoint<typeof operations.createFolder>()({
    operation: 'chat.createFolder',
    method: 'POST',
    path: '/bots/:botId/folders',
  }),
  updateFolder: defineEndpoint<typeof operations.updateFolder>()({
    operation: 'chat.updateFolder',
    method: 'PATCH',
    path: '/bots/:botId/folders/:folderId',
  }),
  deleteFolder: defineEndpoint<typeof operations.deleteFolder>()({
    operation: 'chat.deleteFolder',
    method: 'DELETE',
    path: '/bots/:botId/folders/:folderId',
  }),
  pinChat: defineEndpoint<typeof operations.pinChat>()({
    operation: 'chat.pinChat',
    method: 'PUT',
    path: '/chats/:chatId/pin',
  }),
  moveChat: defineEndpoint<typeof operations.moveChat>()({
    operation: 'chat.moveChat',
    method: 'PATCH',
    path: '/chats/:chatId/organization',
  }),
  forkChat: defineEndpoint<typeof operations.forkChat>()({
    operation: 'chat.forkChat',
    method: 'POST',
    path: '/chats/:chatId/fork',
  }),
  deleteChat: defineEndpoint<typeof operations.deleteChat>()({
    operation: 'chat.deleteChat',
    method: 'DELETE',
    path: '/chats/:chatId',
  }),
  readProfile: defineEndpoint<typeof operations.readProfile>()({
    operation: 'chat.readProfile',
    method: 'GET',
    path: '/chats/:chatId/profile',
  }),
  updateProfile: defineEndpoint<typeof operations.updateProfile>()({
    operation: 'chat.updateProfile',
    method: 'PUT',
    path: '/chats/:chatId/profile',
  }),
  readGenerationDefaults: defineEndpoint<typeof operations.readGenerationDefaults>()({
    operation: 'chat.readGenerationDefaults',
    method: 'GET',
    path: '/chat-generation-defaults',
  }),
  updateGenerationDefaults: defineEndpoint<typeof operations.updateGenerationDefaults>()({
    operation: 'chat.updateGenerationDefaults',
    method: 'PUT',
    path: '/chat-generation-defaults',
  }),
  uploadAsset: defineEndpoint<typeof operations.uploadAsset>()({
    operation: 'chat.uploadAsset',
    method: 'POST',
    path: '/chats/:chatId/assets',
    bodyLimit: CHAT_ASSET_BODY_MAX_BYTES,
  }),
  updateAsset: defineEndpoint<typeof operations.updateAsset>()({
    operation: 'chat.updateAsset',
    method: 'PATCH',
    path: '/chats/:chatId/assets/:assetId',
  }),
  deleteAsset: defineEndpoint<typeof operations.deleteAsset>()({
    operation: 'chat.deleteAsset',
    method: 'DELETE',
    path: '/chats/:chatId/assets/:assetId',
  }),
};
