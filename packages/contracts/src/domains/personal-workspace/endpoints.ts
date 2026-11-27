import { defineEndpoint } from '../../endpoint.js';
import type { personalWorkspaceOperations as operations } from './operations.js';

export const personalWorkspaceEndpoints = {
  readUsage: defineEndpoint<typeof operations.readUsage>()({
    operation: 'personal-workspace.readUsage',
    method: 'GET',
    path: '/usage',
  }),
  readBackups: defineEndpoint<typeof operations.readBackups>()({
    operation: 'personal-workspace.readBackups',
    method: 'GET',
    path: '/backups',
  }),
  updateBackupSettings: defineEndpoint<typeof operations.updateBackupSettings>()({
    operation: 'personal-workspace.updateBackupSettings',
    method: 'PUT',
    path: '/backups/settings',
  }),
  startBackup: defineEndpoint<typeof operations.startBackup>()({
    operation: 'personal-workspace.startBackup',
    method: 'POST',
    path: '/backups',
    status: 202,
  }),
  readReadingPositions: defineEndpoint<typeof operations.readReadingPositions>()({
    operation: 'personal-workspace.readReadingPositions',
    method: 'GET',
    path: '/chats/:chatId/reading-position',
  }),
  saveReadingPosition: defineEndpoint<typeof operations.saveReadingPosition>()({
    operation: 'personal-workspace.saveReadingPosition',
    method: 'PUT',
    path: '/chats/:chatId/reading-position',
  }),
  listBookmarks: defineEndpoint<typeof operations.listBookmarks>()({
    operation: 'personal-workspace.listBookmarks',
    method: 'GET',
    path: '/chats/:chatId/bookmarks',
  }),
  addBookmark: defineEndpoint<typeof operations.addBookmark>()({
    operation: 'personal-workspace.addBookmark',
    method: 'POST',
    path: '/chats/:chatId/bookmarks',
  }),
  updateBookmark: defineEndpoint<typeof operations.updateBookmark>()({
    operation: 'personal-workspace.updateBookmark',
    method: 'PATCH',
    path: '/bookmarks/:id',
  }),
  deleteBookmark: defineEndpoint<typeof operations.deleteBookmark>()({
    operation: 'personal-workspace.deleteBookmark',
    method: 'DELETE',
    path: '/bookmarks/:id',
  }),
  readPush: defineEndpoint<typeof operations.readPush>()({
    operation: 'personal-workspace.readPush',
    method: 'GET',
    path: '/push',
  }),
  preparePush: defineEndpoint<typeof operations.preparePush>()({
    operation: 'personal-workspace.preparePush',
    method: 'POST',
    path: '/push/prepare',
  }),
  subscribePush: defineEndpoint<typeof operations.subscribePush>()({
    operation: 'personal-workspace.subscribePush',
    method: 'POST',
    path: '/push/subscription',
  }),
  updatePush: defineEndpoint<typeof operations.updatePush>()({
    operation: 'personal-workspace.updatePush',
    method: 'PUT',
    path: '/push/subscription',
  }),
  unsubscribePush: defineEndpoint<typeof operations.unsubscribePush>()({
    operation: 'personal-workspace.unsubscribePush',
    method: 'DELETE',
    path: '/push/subscription',
  }),
  testPush: defineEndpoint<typeof operations.testPush>()({
    operation: 'personal-workspace.testPush',
    method: 'POST',
    path: '/push/test',
    status: 202,
  }),
  searchManuscripts: defineEndpoint<typeof operations.searchManuscripts>()({
    operation: 'personal-workspace.searchManuscripts',
    method: 'POST',
    path: '/search',
  }),
};
