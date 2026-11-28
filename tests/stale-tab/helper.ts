import { randomUUID } from 'node:crypto';
import { helperEndpoints } from '#contracts';
import { type Answer, deleted, deletedChat, domainCases, read } from './harness.js';

const libraryScope = { kind: 'library', workId: 'workspace' } as const;
const missingConversation: Answer = { status: 404, code: 'HELPER_CONVERSATION_NOT_FOUND' };
const missingProject: Answer = { status: 404, code: 'HELPER_PROJECT_NOT_FOUND' };

const conversationReason =
  'The helper has its own catalogued answer for a deleted conversation, and the web shows its "may have been deleted elsewhere" text for it (the handoff in HelperPanel also opens a fresh conversation on this 404).';
const projectReason =
  'The helper has its own catalogued answer for a deleted project, so the move names the project that went away instead of reporting a generic conflict.';
const ownRevision =
  'The revision is the deleted target own revision, so a stale and a matching revision meet the same 404 HELPER_CONVERSATION_NOT_FOUND and cannot be told apart; pinned over HTTP in tests/helper-navigation.test.ts.';
const ownProjectRevision =
  'The revision is the deleted project own revision, so a stale and a matching revision meet the same 404 HELPER_PROJECT_NOT_FOUND and cannot be told apart; pinned over HTTP in tests/helper-navigation.test.ts.';
const messageTarget =
  'A deleted message always raises the conversation revision, so a tab that still names it meets REVISION_CONFLICT through that revision; a live revision with an unknown message answers an uncoded 404.';

const conversation = () =>
  read<{ id: string; revision: number }>(helperEndpoints.createConversation, {
    scope: libraryScope,
    requestKey: randomUUID(),
  });
const project = () =>
  read<{ id: string; revision: number }>(helperEndpoints.createProject, {
    title: 'Stale tab project',
    requestKey: randomUUID(),
  });
async function removedProject() {
  const gone = await project();
  await read(helperEndpoints.deleteProject, { id: gone.id, expectedRevision: gone.revision });
  return gone.id;
}
async function removedConversation() {
  const gone = await conversation();
  await read(helperEndpoints.deleteConversation, {
    id: gone.id,
    expectedRevision: gone.revision,
    expectedEventSequence: 0,
  });
  return gone.id;
}
const conversationRead = (when: string) => ({
  cases: [
    {
      when,
      arrange: async () => ({ input: { id: await removedConversation() } }),
      answer: missingConversation,
      reason: conversationReason,
    },
  ],
});

export const helperCases = domainCases('helper', {
  renameProject: { exempt: ownProjectRevision },
  deleteProject: { exempt: ownProjectRevision },
  listConversations: {
    cases: [
      {
        when: 'a chat another tab deleted',
        arrange: () => ({ input: { kind: 'chat', chatId: deletedChat().chatId } }),
        answer: deleted,
      },
    ],
  },
  openConversation: {
    cases: [
      {
        when: 'a chat another tab deleted',
        arrange: () => ({ input: { scope: { kind: 'chat', chatId: deletedChat().chatId } } }),
        answer: deleted,
        target: 'scope.chatId',
      },
    ],
    exemptTargets: {
      'scope.workId':
        'A library work id names no stored item; the helper opens a conversation for any id.',
    },
    exemptBranches: {
      'scope.kind=library':
        'A library scope names no stored item that another tab could delete, so the helper opens a conversation for any work id.',
    },
  },
  createConversation: {
    cases: [
      {
        when: 'a chat another tab deleted',
        arrange: () => ({
          input: {
            scope: { kind: 'chat', chatId: deletedChat().chatId },
            requestKey: randomUUID(),
          },
        }),
        answer: deleted,
        target: 'scope.chatId',
      },
      {
        when: 'a project another tab deleted',
        arrange: async () => ({
          input: {
            scope: libraryScope,
            requestKey: randomUUID(),
            projectId: await removedProject(),
          },
        }),
        answer: missingProject,
        reason: projectReason,
        target: 'projectId',
      },
    ],
    exemptTargets: {
      'scope.workId':
        'A library work id names no stored item; the helper creates a conversation for any id.',
    },
  },
  readConversation: conversationRead('a conversation another tab deleted'),
  updateConversation: { exempt: ownRevision },
  moveConversation: {
    cases: [
      {
        when: 'a project another tab deleted',
        arrange: async () => {
          const owner = await conversation();
          const base = { id: owner.id, expectedRevision: owner.revision };
          return {
            input: { ...base, projectId: await removedProject() },
            control: { ...base, projectId: (await project()).id },
          };
        },
        answer: missingProject,
        reason: projectReason,
        target: 'projectId',
      },
    ],
    exemptTargets: { id: ownRevision },
  },
  copyConversation: { exempt: ownRevision },
  markConversationRead: {
    cases: [
      {
        when: 'a conversation another tab deleted',
        arrange: async () => ({ input: { id: await removedConversation(), activityEventSeq: 1 } }),
        answer: missingConversation,
        reason: conversationReason,
      },
    ],
  },
  readConversationDeletion: conversationRead('a conversation another tab deleted'),
  deleteConversation: { exempt: ownRevision },
  readContextSummary: conversationRead('a conversation another tab deleted'),
  editContextSummary: { exempt: ownRevision },
  resetContextSummary: { exempt: ownRevision },
  editMessage: {
    exempt: ownRevision,
    exemptTargets: { id: ownRevision, messageId: messageTarget },
  },
  deleteMessages: {
    exempt: ownRevision,
    exemptTargets: { id: ownRevision, messageId: messageTarget },
  },
});
