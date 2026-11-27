import { randomUUID } from 'node:crypto';
import { deleteChat } from '../../server/chat-deletion.js';
import { deleteScenes, sceneDeletionImpact } from '../../server/scene-deletion.js';
import { conflict, deleted, deletedChat, domainCases, scene, store } from './harness.js';

const staleRequest = {
  expectedHeadRevision: null,
  expectedSettingsRevision: 1,
  expectedSourceHash: 'stale',
  expectedHistoryHash: 'stale',
  expectedVariablesRevision: 0,
};

function goneScene() {
  const { chat, source } = scene('Stale tab scene');
  deleteScenes(store(), chat.id, source.id, {
    ...sceneDeletionImpact(store(), chat.id, source.id).request,
    scope: 'only',
    idempotencyKey: randomUUID(),
  });
  return { chatId: chat.id, sourceId: source.id, runId: source.runId };
}

function goneJob() {
  const { chat, source } = scene('Stale tab job');
  const id = randomUUID();
  const now = new Date().toISOString();
  store()
    .db.prepare(
      `INSERT INTO jobs(id,chat_id,source_revision,source_hash,kind,status,input,created_at,updated_at)
      VALUES(?,?,?,?,'translation','completed',?,?,?)`
    )
    .run(id, chat.id, source.id, source.hash, '{}', now, now);
  deleteChat(store(), chat.id);
  return id;
}

function goneStream() {
  const { chat } = scene('Stale tab stream');
  const id = randomUUID();
  const now = new Date().toISOString();
  store()
    .db.prepare(
      `INSERT INTO response_stream_tasks(task_kind,task_id,chat_id,owner,status,created_at,updated_at)
      VALUES('translation',?,?,'stale-tab','running',?,?)`
    )
    .run(id, chat.id, now, now);
  deleteChat(store(), chat.id);
  return id;
}

const attemptExemption =
  'Attempt rows stay for usage accounting: deleting a scene or chat detaches the row and keeps a summary, so a tab holding an attempt id reads that summary and never a missing record.';

const chatGone = (extra: Record<string, unknown> = {}) => ({
  when: 'a chat another tab deleted',
  arrange: () => ({ input: { chatId: deletedChat().chatId, ...extra } }),
  answer: deleted,
});
const sourceGone = (extra: Record<string, unknown>) => ({
  when: 'a scene another tab deleted',
  arrange: () => ({ input: { sourceId: deletedChat().sourceId, ...extra } }),
  answer: deleted,
});

export const readerCases = domainCases('reader', {
  readSceneDetail: { exempt: attemptExemption },
  readLastSceneLore: { cases: [chatGone()] },
  listChatAttempts: { cases: [chatGone()] },
  readAttempt: { exempt: attemptExemption },
  listChatJobs: { cases: [chatGone()] },
  readJob: {
    cases: [
      {
        when: 'a job of a chat another tab deleted',
        arrange: () => ({ input: { jobId: goneJob() } }),
        answer: deleted,
      },
    ],
  },
  readSceneDeletionImpact: {
    cases: [
      {
        when: 'a chat another tab deleted',
        arrange: () => {
          const gone = deletedChat();
          return { input: { chatId: gone.chatId, sourceId: gone.sourceId } };
        },
        answer: deleted,
      },
      {
        when: 'a scene another tab deleted',
        arrange: () => {
          const { chatId, sourceId } = goneScene();
          return { input: { chatId, sourceId } };
        },
        answer: deleted,
      },
    ],
  },
  deleteScenes: {
    cases: [
      {
        when: 'a chat another tab deleted',
        arrange: () => {
          const gone = deletedChat();
          return {
            input: {
              chatId: gone.chatId,
              sourceId: gone.sourceId,
              scope: 'only',
              ...staleRequest,
              idempotencyKey: randomUUID(),
            },
          };
        },
        answer: conflict,
        targetRevision: true,
      },
      {
        when: 'a scene another tab deleted',
        arrange: () => {
          const { chatId, sourceId } = goneScene();
          return {
            input: {
              chatId,
              sourceId,
              scope: 'only',
              ...staleRequest,
              idempotencyKey: randomUUID(),
            },
          };
        },
        answer: conflict,
        targetRevision: true,
      },
    ],
  },
  reviseSelection: {
    cases: [
      {
        when: 'a scene another tab deleted and a translation draft that does not match its hash',
        arrange: () => ({
          input: {
            sourceId: deletedChat().sourceId,
            target: 'translation',
            draft: 'A lantern.',
            start: 0,
            end: 2,
            instruction: 'Make it shorter.',
            expectedSourceHash: 'stale',
            expectedRevision: 0,
            expectedTextHash: 'stale',
          },
        }),
        answer: conflict,
        targetRevision: true,
      },
      {
        when: 'a scene another tab deleted and a selection the range check refuses',
        arrange: () => ({
          input: {
            sourceId: deletedChat().sourceId,
            target: 'source',
            draft: 'A lantern.',
            start: 3,
            end: 3,
            instruction: 'Make it shorter.',
            expectedSourceHash: 'stale',
            expectedRevision: 0,
          },
        }),
        answer: conflict,
        targetRevision: true,
      },
    ],
  },
  translateInput: { cases: [chatGone({ text: 'Hello.', targetLanguage: 'ko' })] },
  preflightChatContent: {
    cases: [
      chatGone({ role: 'translation', text: 'Hello.' }),
      {
        when: 'a run another tab deleted with its scene',
        arrange: () => {
          const { chatId, runId } = goneScene();
          return { input: { chatId, role: 'main', text: 'Hello.', retryRunId: runId } };
        },
        answer: deleted,
      },
    ],
  },
  preflightSourceContent: { cases: [sourceGone({})] },
  previewPrompt: { cases: [chatGone({ role: 'main', request: 'Continue.' })] },
  previewRequest: { cases: [chatGone({ request: 'Continue.' })] },
  readResponseStream: {
    cases: [
      {
        when: 'a stream of a chat another tab deleted',
        arrange: () => ({
          input: { taskKind: 'translation', taskId: goneStream(), after: 0 },
        }),
        answer: deleted,
      },
    ],
  },
  requestImages: {
    cases: [
      {
        when: 'a scene another tab deleted',
        arrange: () => ({
          input: {
            sourceId: deletedChat().sourceId,
            target: 'original',
            expectedSourceHash: 'stale',
            expectedRevision: 0,
          },
        }),
        answer: conflict,
        targetRevision: true,
      },
    ],
  },
});
