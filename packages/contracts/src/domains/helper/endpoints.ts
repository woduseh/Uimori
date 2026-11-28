import { defineEndpoint } from '../../endpoint.js';
import type { helperOperations as operations } from './operations.js';

const HELPER_TEXT_BODY_MAX_BYTES = 16 * 1024 * 1024;

export const helperEndpoints = {
  listProjects: defineEndpoint<typeof operations.listProjects>()({
    operation: 'helper.listProjects',
    method: 'GET',
    path: '/helper/projects',
    cache: 'no-store',
  }),
  createProject: defineEndpoint<typeof operations.createProject>()({
    operation: 'helper.createProject',
    method: 'POST',
    path: '/helper/projects',
    cache: 'no-store',
  }),
  renameProject: defineEndpoint<typeof operations.renameProject>()({
    operation: 'helper.renameProject',
    method: 'PATCH',
    path: '/helper/projects/:id',
    cache: 'no-store',
  }),
  deleteProject: defineEndpoint<typeof operations.deleteProject>()({
    operation: 'helper.deleteProject',
    method: 'DELETE',
    path: '/helper/projects/:id',
    cache: 'no-store',
  }),
  listConversations: defineEndpoint<typeof operations.listConversations>()({
    operation: 'helper.listConversations',
    method: 'GET',
    path: '/helper/conversations',
    cache: 'no-store',
  }),
  openConversation: defineEndpoint<typeof operations.openConversation>()({
    operation: 'helper.openConversation',
    method: 'POST',
    path: '/helper/conversations',
    cache: 'no-store',
  }),
  createConversation: defineEndpoint<typeof operations.createConversation>()({
    operation: 'helper.createConversation',
    method: 'POST',
    path: '/helper/conversations/new',
    cache: 'no-store',
  }),
  readConversation: defineEndpoint<typeof operations.readConversation>()({
    operation: 'helper.readConversation',
    method: 'GET',
    path: '/helper/conversations/:id',
    cache: 'no-store',
  }),
  updateConversation: defineEndpoint<typeof operations.updateConversation>()({
    operation: 'helper.updateConversation',
    method: 'PATCH',
    path: '/helper/conversations/:id',
    cache: 'no-store',
  }),
  moveConversation: defineEndpoint<typeof operations.moveConversation>()({
    operation: 'helper.moveConversation',
    method: 'PATCH',
    path: '/helper/conversations/:id/project',
    cache: 'no-store',
  }),
  copyConversation: defineEndpoint<typeof operations.copyConversation>()({
    operation: 'helper.copyConversation',
    method: 'POST',
    path: '/helper/conversations/:id/copy',
    cache: 'no-store',
  }),
  markConversationRead: defineEndpoint<typeof operations.markConversationRead>()({
    operation: 'helper.markConversationRead',
    method: 'POST',
    path: '/helper/conversations/:id/read',
    cache: 'no-store',
  }),
  readConversationDeletion: defineEndpoint<typeof operations.readConversationDeletion>()({
    operation: 'helper.readConversationDeletion',
    method: 'GET',
    path: '/helper/conversations/:id/deletion',
    cache: 'no-store',
  }),
  deleteConversation: defineEndpoint<typeof operations.deleteConversation>()({
    operation: 'helper.deleteConversation',
    method: 'DELETE',
    path: '/helper/conversations/:id',
    cache: 'no-store',
  }),
  readContextSummary: defineEndpoint<typeof operations.readContextSummary>()({
    operation: 'helper.readContextSummary',
    method: 'GET',
    path: '/helper/conversations/:id/context',
    cache: 'no-store',
  }),
  editContextSummary: defineEndpoint<typeof operations.editContextSummary>()({
    operation: 'helper.editContextSummary',
    method: 'PUT',
    path: '/helper/conversations/:id/context/summary',
    bodyLimit: HELPER_TEXT_BODY_MAX_BYTES,
    cache: 'no-store',
  }),
  resetContextSummary: defineEndpoint<typeof operations.resetContextSummary>()({
    operation: 'helper.resetContextSummary',
    method: 'DELETE',
    path: '/helper/conversations/:id/context/summary',
    cache: 'no-store',
  }),
  editMessage: defineEndpoint<typeof operations.editMessage>()({
    operation: 'helper.editMessage',
    method: 'PATCH',
    path: '/helper/conversations/:id/messages/:messageId',
    bodyLimit: HELPER_TEXT_BODY_MAX_BYTES,
    cache: 'no-store',
  }),
  deleteMessages: defineEndpoint<typeof operations.deleteMessages>()({
    operation: 'helper.deleteMessages',
    method: 'DELETE',
    path: '/helper/conversations/:id/messages/:messageId',
    cache: 'no-store',
  }),
};
