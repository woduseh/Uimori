import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { allEndpoints } from '#contracts';
import { DEFAULT_PUSH_PREFERENCES } from '../../core/push.js';
import { addBookmark } from '../../server/reading-state.js';
import { deleteScenes, sceneDeletionImpact } from '../../server/scene-deletion.js';
import { completedSource } from '../fixtures/illustration.js';
import {
  bot,
  conflict,
  deleted,
  deletedChat,
  domainCases,
  purged,
  read,
  scene,
  singletonExemption,
  store,
} from './harness.js';

const targetChatIdExemption =
  'resolveReaderTarget ignores target.chatId and always binds the route :chatId, which the chatId case probes.';
const readingSceneReason =
  'A scene another tab removed from a live chat answers the catalogued READING_SCENE_NOT_FOUND after checking the chat and revision.';

function chatWithRemovedScene(title: string) {
  const { chat, source: kept } = scene(title);
  const gone = completedSource(store(), chat.id, 'Second scene later removed.');
  deleteScenes(store(), chat.id, gone.id, {
    ...sceneDeletionImpact(store(), chat.id, gone.id).request,
    scope: 'only',
    idempotencyKey: randomUUID(),
  });
  return { chatId: chat.id, keptId: kept.id, goneId: gone.id };
}

async function removedBookmark() {
  const { chat, source } = scene('Stale tab bookmark');
  const mark = addBookmark(store(), chat.id, {
    id: randomUUID(),
    target: { sourceId: source.id, representation: 'original' },
    title: 'Mark',
    note: '',
    quote: '',
  });
  await read(allEndpoints['personal-workspace'].deleteBookmark, {
    id: mark.id,
    expectedRevision: mark.revision,
  });
  return mark;
}
function pushSubscription() {
  const key = createECDH('prime256v1');
  key.generateKeys();
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
    keys: {
      p256dh: key.getPublicKey().toString('base64url'),
      auth: randomBytes(16).toString('base64url'),
    },
  };
}
async function removedPushDevice() {
  const endpoints = allEndpoints['personal-workspace'];
  const clientId = randomUUID();
  await read(endpoints.preparePush, { clientId });
  await read(endpoints.subscribePush, {
    clientId,
    expectedRevision: 0,
    subscription: pushSubscription(),
    preferences: DEFAULT_PUSH_PREFERENCES,
  });
  await read(endpoints.unsubscribePush, { clientId, expectedRevision: 1 });
  return clientId;
}

export const personalWorkspaceCases = domainCases('personal-workspace', {
  updateBackupSettings: { exempt: singletonExemption },
  readReadingPositions: {
    cases: [
      {
        when: 'a chat another tab deleted',
        arrange: () => ({ input: { chatId: deletedChat().chatId, clientId: randomUUID() } }),
        answer: deleted,
      },
    ],
  },
  saveReadingPosition: {
    cases: [
      {
        when: 'a chat another tab deleted',
        arrange: () => {
          const gone = deletedChat();
          const live = scene('Stale tab reading');
          const position = { clientId: randomUUID(), expectedRevision: 0 };
          const target = (sourceId: string) => ({ sourceId, representation: 'original' });
          return {
            input: { ...position, chatId: gone.chatId, target: target(gone.sourceId) },
            control: { ...position, chatId: live.chat.id, target: target(live.source.id) },
          };
        },
        answer: conflict,
        target: 'chatId',
      },
      {
        when: 'a scene another tab deleted from a live chat',
        arrange: () => {
          const { chatId, keptId, goneId } = chatWithRemovedScene('Stale tab reading scene');
          const position = { chatId, clientId: randomUUID(), expectedRevision: 0 };
          const target = (sourceId: string) => ({ sourceId, representation: 'original' });
          return {
            input: { ...position, target: target(goneId) },
            control: { ...position, target: target(keptId) },
          };
        },
        answer: { status: 404, code: 'READING_SCENE_NOT_FOUND' },
        reason: readingSceneReason,
        target: 'target.sourceId',
      },
    ],
    exemptTargets: { 'target.chatId': targetChatIdExemption },
  },
  listBookmarks: {
    cases: [
      {
        when: 'a chat another tab deleted',
        arrange: () => ({ input: { chatId: deletedChat().chatId } }),
        answer: deleted,
      },
    ],
  },
  addBookmark: {
    cases: [
      {
        when: 'a chat another tab deleted',
        arrange: () => {
          const gone = deletedChat();
          return {
            input: {
              chatId: gone.chatId,
              id: randomUUID(),
              target: { sourceId: gone.sourceId, representation: 'original' },
              title: 'Mark',
            },
          };
        },
        answer: conflict,
        target: 'chatId',
      },
      {
        when: 'a scene another tab deleted from a live chat',
        arrange: () => {
          const { chatId, keptId, goneId } = chatWithRemovedScene('Stale tab bookmark scene');
          const mark = (sourceId: string) => ({
            chatId,
            id: randomUUID(),
            target: { sourceId, representation: 'original' },
            title: 'Mark',
          });
          return { input: mark(goneId), control: mark(keptId) };
        },
        answer: { status: 404, code: 'READING_SCENE_NOT_FOUND' },
        reason: readingSceneReason,
        target: 'target.sourceId',
      },
    ],
    exemptTargets: {
      id: 'id is the client-generated identifier and idempotency key for the new bookmark, not an existing stored resource.',
      'target.chatId': targetChatIdExemption,
    },
  },
  updateBookmark: {
    cases: [
      {
        when: 'a bookmark another tab deleted',
        arrange: async () => {
          const mark = await removedBookmark();
          return {
            input: { id: mark.id, expectedRevision: mark.revision, title: 'Edited', note: 'Kept' },
          };
        },
        answer: conflict,
        targetRevision: true,
      },
    ],
  },
  deleteBookmark: {
    cases: [
      {
        when: 'a bookmark another tab deleted',
        arrange: async () => {
          const mark = await removedBookmark();
          return { input: { id: mark.id, expectedRevision: mark.revision } };
        },
        answer: conflict,
        targetRevision: true,
      },
    ],
  },
  subscribePush: {
    cases: [
      {
        when: 'a device another tab unsubscribed',
        arrange: async () => ({
          input: {
            clientId: await removedPushDevice(),
            expectedRevision: 1,
            subscription: pushSubscription(),
            preferences: DEFAULT_PUSH_PREFERENCES,
          },
        }),
        answer: conflict,
        targetRevision: true,
      },
    ],
  },
  updatePush: {
    cases: [
      {
        when: 'a device another tab unsubscribed',
        arrange: async () => ({
          input: {
            clientId: await removedPushDevice(),
            expectedRevision: 1,
            preferences: DEFAULT_PUSH_PREFERENCES,
          },
        }),
        answer: conflict,
        targetRevision: true,
      },
    ],
  },
  unsubscribePush: {
    exempt:
      'Removing a device another tab already removed reaches the state the request asks for and holds nothing of the user’s, so it answers the current push state instead of a conflict.',
  },
  testPush: {
    cases: [
      {
        when: 'a device another tab unsubscribed',
        arrange: async () => ({ input: { clientId: await removedPushDevice() } }),
        answer: conflict,
      },
    ],
  },
  searchManuscripts: {
    cases: [
      {
        when: 'a chat another tab deleted',
        arrange: () => ({
          input: {
            query: 'lantern',
            kinds: ['original'],
            scope: 'chat',
            chatId: deletedChat().chatId,
          },
        }),
        answer: deleted,
        target: 'chatId',
      },
      {
        when: 'a bot another tab purged',
        arrange: () => {
          const gone = bot();
          purged('content', gone);
          return {
            input: {
              query: 'lantern',
              kinds: ['original'],
              scope: 'bot',
              botId: gone.id,
            },
          };
        },
        answer: deleted,
        target: 'botId',
      },
    ],
  },
});
