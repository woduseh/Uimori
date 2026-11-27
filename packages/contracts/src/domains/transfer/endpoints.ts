import { defineEndpoint } from '../../endpoint.js';
import type { transferOperations as operations } from './operations.js';
import {
  CHAT_BACKUP_MAX_BYTES,
  CHAT_TRANSCRIPT_IMPORT_MAX_BYTES,
  NATIVE_TRANSFER_MAX_BYTES,
} from './transfer-limits.js';

export const transferEndpoints = {
  prepareFile: defineEndpoint<typeof operations.prepareFile>()({
    operation: 'transfer.prepareFile',
    method: 'POST',
    path: '/native-transfers/prepare',
    bodyLimit: NATIVE_TRANSFER_MAX_BYTES,
  }),
  applyFile: defineEndpoint<typeof operations.applyFile>()({
    operation: 'transfer.applyFile',
    method: 'POST',
    path: '/native-transfers/apply',
    bodyLimit: NATIVE_TRANSFER_MAX_BYTES,
    invalidates: ['library'],
  }),
  prepareArchive: defineEndpoint<typeof operations.prepareArchive>()({
    operation: 'transfer.prepareArchive',
    method: 'POST',
    path: '/native-transfers/prepare-archive',
  }),
  applyArchive: defineEndpoint<typeof operations.applyArchive>()({
    operation: 'transfer.applyArchive',
    method: 'POST',
    path: '/native-transfers/apply-archive',
    invalidates: ['library'],
  }),
  prepareChatArchive: defineEndpoint<typeof operations.prepareChatArchive>()({
    operation: 'transfer.prepareChatArchive',
    method: 'POST',
    path: '/chats/prepare-backup-archive',
  }),
  importChatArchive: defineEndpoint<typeof operations.importChatArchive>()({
    operation: 'transfer.importChatArchive',
    method: 'POST',
    path: '/chats/import-backup-archive',
    invalidates: ['library'],
  }),
  importChatBackup: defineEndpoint<typeof operations.importChatBackup>()({
    operation: 'transfer.importChatBackup',
    method: 'POST',
    path: '/chats/import-backup',
    bodyLimit: CHAT_BACKUP_MAX_BYTES + 1024,
    invalidates: ['library'],
  }),
  importTranscript: defineEndpoint<typeof operations.importTranscript>()({
    operation: 'transfer.importTranscript',
    method: 'POST',
    path: '/chats/import-transcript',
    bodyLimit: CHAT_TRANSCRIPT_IMPORT_MAX_BYTES,
  }),
  readManuscript: defineEndpoint<typeof operations.readManuscript>()({
    operation: 'transfer.readManuscript',
    method: 'GET',
    path: '/chats/:id/manuscript',
  }),
  exportManuscript: defineEndpoint<typeof operations.exportManuscript>()({
    operation: 'transfer.exportManuscript',
    method: 'POST',
    path: '/chats/:id/manuscript',
  }),
};
