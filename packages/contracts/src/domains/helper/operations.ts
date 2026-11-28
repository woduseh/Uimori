import { z } from 'zod/v4';
import { defineOperation } from '../../endpoint.js';
import { REQUEST_TEXT_MAX_CHARS, SOURCE_TEXT_MAX_CHARS } from '../limits.js';
import { revision } from '../revision.js';
import { nonBlank } from '../text.js';
import { HELPER_PERSONA_MAX_CHARS } from './limits.js';

const id = nonBlank(100);
const requestKey = nonBlank(100);
const conversationTarget = { id };
const eventSequence = z.int().nonnegative();
const taskStatus = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted']);

export const helperScope = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('chat'), chatId: id }),
  z.strictObject({ kind: z.literal('library'), workId: id }),
]);

const storedScope = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('chat'), chatId: z.string() }),
  z.strictObject({ kind: z.literal('library'), workId: z.string() }),
]);

export const helperProject = z.strictObject({ id: z.string(), title: z.string(), revision });
export const helperConversation = z.strictObject({
  id: z.string(),
  scope: storedScope,
  title: z.string(),
  revision,
  historyRevision: z.int().nonnegative().optional(),
  persona: z.string(),
  limits: z.strictObject({ totalCalls: z.int(), helperCalls: z.int() }),
  createdAt: z.string(),
  updatedAt: z.string(),
  projectId: z.string().nullable().optional(),
});
export const helperConversationSummary = helperConversation.extend({
  projectId: z.string().nullable(),
  chatTitle: z.string().optional(),
  activity: z.strictObject({ running: z.int(), queued: z.int() }),
  latestEventSeq: eventSequence,
  latestActivityEventSeq: eventSequence,
  readActivityEventSeq: eventSequence,
  lastTaskStatus: taskStatus.optional(),
  lastActivityAt: z.string(),
  unused: z.literal(true).optional(),
});
export const helperConversationDeletion = z.strictObject({
  request: z.strictObject({ expectedRevision: revision, expectedEventSequence: eventSequence }),
  activeTasks: z.int(),
  unsettledAttempts: z.int(),
  workerActive: z.boolean(),
  canDelete: z.boolean(),
  description: z.string(),
});
export const helperContextSummaryView = z.strictObject({
  checkpointRevision: revision,
  summary: z.string().nullable(),
  origin: z.enum(['automatic', 'manual', 'edit', 'model']).nullable(),
  createdAt: z.string().nullable(),
  compactedMessages: z.int(),
  totalMessages: z.int(),
  summaryTokens: z.int().nullable(),
  budgetTokens: z.int().nullable(),
  editable: z.boolean(),
  blockedReason: z.enum(['HELPER_COMPACTION_BUSY', 'MODEL_REQUIRED:helper']).nullable(),
});
export const helperMessageMutation = z.strictObject({
  conversation: helperConversation,
  updatedMessage: z.strictObject({ id: z.string(), text: z.string() }).optional(),
  deletedMessageIds: z.array(z.string()).optional(),
});
const deleted = z.strictObject({ deleted: z.literal(true) });

export const createHelperProjectInput = z.strictObject({ title: nonBlank(200), requestKey });
export const renameHelperProjectInput = z.strictObject({
  id,
  expectedRevision: revision,
  title: nonBlank(200),
});
export const deleteHelperProjectInput = z.strictObject({ id, expectedRevision: revision });

export const listHelperConversationsInput = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.enum(['library', 'all']) }),
  z.strictObject({ kind: z.literal('chat'), chatId: id }),
]);
export const openHelperConversationInput = z.strictObject({ scope: helperScope });
export const createHelperConversationInput = z.strictObject({
  scope: helperScope,
  requestKey,
  title: nonBlank(200).optional(),
  projectId: id.nullable().optional(),
});
export const moveHelperConversationInput = z.strictObject({
  ...conversationTarget,
  expectedRevision: revision,
  projectId: id.nullable(),
});
export const copyHelperConversationInput = z.strictObject({
  ...conversationTarget,
  requestKey,
  expectedRevision: revision,
  expectedEventSequence: eventSequence,
});
export const updateHelperConversationInput = z.strictObject({
  ...conversationTarget,
  expectedRevision: revision,
  title: nonBlank(200).optional(),
  persona: z.string().max(HELPER_PERSONA_MAX_CHARS).optional(),
});
export const markHelperConversationReadInput = z.strictObject({
  ...conversationTarget,
  activityEventSeq: eventSequence,
});
export const deleteHelperConversationInput = z.strictObject({
  ...conversationTarget,
  expectedRevision: revision,
  expectedEventSequence: eventSequence,
});

export const editHelperContextSummaryInput = z.strictObject({
  ...conversationTarget,
  expectedRevision: revision,
  summary: z.string().max(SOURCE_TEXT_MAX_CHARS),
});
export const resetHelperContextSummaryInput = z.strictObject({
  ...conversationTarget,
  expectedRevision: revision,
});

export const editHelperMessageInput = z.strictObject({
  ...conversationTarget,
  messageId: id,
  expectedRevision: revision,
  text: z.string().max(REQUEST_TEXT_MAX_CHARS),
});
export const deleteHelperMessagesInput = z.strictObject({
  ...conversationTarget,
  messageId: id,
  expectedRevision: revision,
  scope: z.enum(['pair', 'following']),
});

export const helperOperations = {
  listProjects: defineOperation('helper.listProjects', z.strictObject({}), z.array(helperProject)),
  createProject: defineOperation('helper.createProject', createHelperProjectInput, helperProject),
  renameProject: defineOperation('helper.renameProject', renameHelperProjectInput, helperProject),
  deleteProject: defineOperation('helper.deleteProject', deleteHelperProjectInput, deleted),
  listConversations: defineOperation(
    'helper.listConversations',
    listHelperConversationsInput,
    z.array(helperConversationSummary)
  ),
  openConversation: defineOperation(
    'helper.openConversation',
    openHelperConversationInput,
    helperConversation
  ),
  createConversation: defineOperation(
    'helper.createConversation',
    createHelperConversationInput,
    helperConversation
  ),
  readConversation: defineOperation(
    'helper.readConversation',
    z.strictObject(conversationTarget),
    helperConversation
  ),
  updateConversation: defineOperation(
    'helper.updateConversation',
    updateHelperConversationInput,
    helperConversation
  ),
  moveConversation: defineOperation(
    'helper.moveConversation',
    moveHelperConversationInput,
    helperConversation
  ),
  copyConversation: defineOperation(
    'helper.copyConversation',
    copyHelperConversationInput,
    helperConversation
  ),
  markConversationRead: defineOperation(
    'helper.markConversationRead',
    markHelperConversationReadInput,
    z.strictObject({ readActivityEventSeq: eventSequence })
  ),
  readConversationDeletion: defineOperation(
    'helper.readConversationDeletion',
    z.strictObject(conversationTarget),
    helperConversationDeletion
  ),
  deleteConversation: defineOperation(
    'helper.deleteConversation',
    deleteHelperConversationInput,
    deleted
  ),
  readContextSummary: defineOperation(
    'helper.readContextSummary',
    z.strictObject(conversationTarget),
    helperContextSummaryView
  ),
  editContextSummary: defineOperation(
    'helper.editContextSummary',
    editHelperContextSummaryInput,
    helperContextSummaryView
  ),
  resetContextSummary: defineOperation(
    'helper.resetContextSummary',
    resetHelperContextSummaryInput,
    helperContextSummaryView
  ),
  editMessage: defineOperation('helper.editMessage', editHelperMessageInput, helperMessageMutation),
  deleteMessages: defineOperation(
    'helper.deleteMessages',
    deleteHelperMessagesInput,
    helperMessageMutation
  ),
};
