import { randomUUID } from 'node:crypto';
import type { Content } from '../../core/product.js';
import { deleteChat } from '../../server/chat-deletion.js';
import { deleteScenes, sceneDeletionImpact } from '../../server/scene-deletion.js';
import { createFixtureChat, fixtureBotInput } from '../fixtures/chat.js';
import { nativeContent } from '../fixtures/native-content.js';
import {
  bot,
  conflict,
  deleted,
  deletedChat,
  domainCases,
  purged,
  removed,
  scene,
  singletonExemption,
  store,
} from './harness.js';

const pixel = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64');
const assetDetails = {
  title: 'Stale tab image',
  description: '',
  actor: '',
  outfit: '',
  location: '',
  allowedUse: 'both' as const,
};
const invalidLore = { enabled: 'sometimes' };

function libraryPackage(kind: 'persona' | 'module') {
  const title = `Stale tab ${kind}`;
  return store().product.content({
    ...fixtureBotInput(title),
    kind,
    package: nativeContent({ name: title, description: title }, {}, kind),
  }) as Content;
}
function removedPersona() {
  const persona = libraryPackage('persona');
  removed('content', persona);
  return persona.id;
}
function purgedBot() {
  const gone = bot();
  purged('content', gone);
  return gone.id;
}
function folder(botId: string, title = 'Stale tab folder') {
  return store().organization.createFolder({ botId, title });
}
function removedFolder() {
  const owner = bot().id;
  const gone = folder(owner, 'Gone');
  store().organization.deleteFolder({
    botId: owner,
    folderId: gone.id,
    expectedRevision: gone.revision,
  });
  return { botId: owner, gone, kept: folder(owner, 'Kept') };
}
function folderOfPurgedBot() {
  const gone = bot();
  const orphan = folder(gone.id, 'Left behind');
  purged('content', gone);
  const owner = bot().id;
  return {
    gone: { botId: gone.id, folderId: orphan.id },
    kept: { botId: owner, folderId: folder(owner, 'Kept').id },
  };
}
function asset(chatId: string) {
  return store().product.createAsset(chatId, { ...assetDetails, mime: 'image/png', base64: pixel });
}
function removedAsset() {
  const { chat } = scene('Stale tab images');
  const gone = asset(chat.id);
  store().product.writableAsset(chat.id, gone.id);
  store().db.prepare("INSERT INTO library_hidden(kind,id) VALUES('asset',?)").run(gone.id);
  return { chatId: chat.id, gone, kept: asset(chat.id) };
}
function assetOfDeletedChat() {
  const { chat } = scene('Stale tab image chat');
  const image = asset(chat.id);
  deleteChat(store(), chat.id);
  return { chatId: chat.id, assetId: image.id };
}
function chatWithDeletedScene() {
  const { chat, source } = scene('Stale tab copy');
  deleteScenes(store(), chat.id, source.id, {
    ...sceneDeletionImpact(store(), chat.id, source.id).request,
    scope: 'only',
    idempotencyKey: randomUUID(),
  });
  return { chatId: chat.id, fromRevision: source.id };
}
function profileOf(chatId: string) {
  return store().product.profile(chatId);
}

export const chatCases = domainCases('chat', {
  readBotDefaults: {
    cases: [
      {
        when: 'a bot another tab purged',
        arrange: () => ({ input: { botId: purgedBot() } }),
        answer: deleted,
      },
    ],
  },
  updateBotDefaults: {
    cases: [
      {
        when: 'a bot another tab purged, with a deleted persona',
        arrange: () => {
          const persona = { mode: 'persona', persona: { id: removedPersona() } };
          return {
            input: { botId: purgedBot(), expectedRevision: 1, persona },
            control: { botId: bot().id, expectedRevision: 1, persona: { mode: 'none' } },
          };
        },
        answer: conflict,
      },
      {
        when: 'a persona another tab deleted',
        arrange: () => ({
          input: {
            botId: bot().id,
            expectedRevision: 1,
            persona: { mode: 'persona', persona: { id: removedPersona() } },
          },
        }),
        answer: deleted,
        targetRevision: true,
      },
    ],
  },
  listFolders: {
    cases: [
      {
        when: 'a bot another tab purged',
        arrange: () => ({ input: { botId: purgedBot() } }),
        answer: deleted,
      },
    ],
  },
  createFolder: {
    cases: [
      {
        when: 'a bot another tab purged, with a deleted persona',
        arrange: () => ({
          input: { botId: purgedBot(), title: 'New', defaultPersona: { id: removedPersona() } },
          control: { botId: bot().id, title: 'New' },
        }),
        answer: conflict,
      },
      {
        when: 'a persona another tab deleted',
        arrange: () => ({
          input: { botId: bot().id, title: 'New', defaultPersona: { id: removedPersona() } },
        }),
        answer: deleted,
      },
    ],
  },
  updateFolder: {
    cases: [
      {
        when: 'a folder another tab deleted, with a deleted persona',
        arrange: () => {
          const { botId, gone, kept } = removedFolder();
          const rename = { botId, expectedRevision: 1, title: 'Renamed' };
          return {
            input: { ...rename, folderId: gone.id, defaultPersona: { id: removedPersona() } },
            control: { ...rename, folderId: kept.id },
          };
        },
        answer: conflict,
      },
      {
        when: 'a bot another tab purged',
        arrange: () => {
          const { gone, kept } = folderOfPurgedBot();
          const rename = { expectedRevision: 1, title: 'Renamed' };
          return { input: { ...gone, ...rename }, control: { ...kept, ...rename } };
        },
        answer: conflict,
      },
      {
        when: 'a persona another tab deleted',
        arrange: () => {
          const owner = bot().id;
          const target = folder(owner);
          return {
            input: {
              botId: owner,
              folderId: target.id,
              expectedRevision: target.revision,
              defaultPersona: { id: removedPersona() },
            },
          };
        },
        answer: deleted,
        targetRevision: true,
      },
    ],
  },
  deleteFolder: {
    cases: [
      {
        when: 'a folder another tab deleted',
        arrange: () => {
          const { botId, gone, kept } = removedFolder();
          return {
            input: { botId, folderId: gone.id, expectedRevision: 1 },
            control: { botId, folderId: kept.id, expectedRevision: 1 },
          };
        },
        answer: conflict,
      },
      {
        when: 'a bot another tab purged',
        arrange: () => {
          const { gone, kept } = folderOfPurgedBot();
          return {
            input: { ...gone, expectedRevision: 1 },
            control: { ...kept, expectedRevision: 1 },
          };
        },
        answer: conflict,
      },
    ],
  },
  pinChat: {
    cases: [
      {
        when: 'a chat another tab deleted',
        arrange: () => ({ input: { chatId: deletedChat().chatId, pinned: true } }),
        answer: conflict,
      },
    ],
  },
  moveChat: {
    cases: [
      {
        when: 'a chat another tab deleted',
        arrange: () => ({
          input: { chatId: deletedChat().chatId, expectedRevision: 1, folderId: null },
          control: { chatId: scene('Stale tab move').chat.id, expectedRevision: 1, folderId: null },
        }),
        answer: conflict,
      },
      {
        when: 'a destination folder another tab deleted',
        arrange: () => {
          const { botId, gone, kept } = removedFolder();
          const moving = { chatId: createFixtureChat(store(), 'Moving', { botId }).id };
          const move = { ...moving, expectedRevision: 1 };
          return {
            input: { ...move, folderId: gone.id },
            control: { ...move, folderId: kept.id },
          };
        },
        answer: conflict,
        targetRevision: true,
      },
      {
        when: 'an order anchor another tab deleted',
        arrange: () => {
          const botId = bot().id;
          const chat = (title: string) => createFixtureChat(store(), title, { botId }).id;
          const [moving, anchor, gone] = [chat('Moving'), chat('Anchor'), chat('Gone')];
          deleteChat(store(), gone);
          const move = { chatId: moving, expectedRevision: 1, folderId: null };
          return {
            input: { ...move, beforeChatId: gone },
            control: { ...move, beforeChatId: anchor },
          };
        },
        answer: conflict,
        targetRevision: true,
      },
    ],
  },
  forkChat: {
    cases: [
      {
        when: 'a chat another tab deleted',
        arrange: () => ({
          input: { chatId: deletedChat().chatId, fromRevision: null, idempotencyKey: randomUUID() },
        }),
        answer: conflict,
        targetRevision: true,
      },
      {
        when: 'a scene another tab deleted',
        arrange: () => ({ input: { ...chatWithDeletedScene(), idempotencyKey: randomUUID() } }),
        answer: conflict,
        targetRevision: true,
      },
    ],
  },
  deleteChat: {
    cases: [
      {
        when: 'a chat another tab deleted',
        arrange: () => ({ input: { chatId: deletedChat().chatId } }),
        answer: conflict,
      },
    ],
  },
  readProfile: {
    cases: [
      {
        when: 'a chat another tab deleted',
        arrange: () => ({ input: { chatId: deletedChat().chatId } }),
        answer: deleted,
      },
    ],
  },
  updateProfile: {
    cases: [
      {
        when: 'a chat another tab deleted, with an invalid lore policy',
        arrange: () => ({
          input: {
            chatId: deletedChat().chatId,
            expectedRevision: 1,
            image: false,
            loreContext: invalidLore,
          },
        }),
        answer: conflict,
        targetRevision: true,
      },
      {
        when: 'a stale profile revision with an invalid lore policy',
        arrange: () => {
          const { chat } = scene('Stale tab profile');
          const profile = profileOf(chat.id);
          return {
            input: {
              chatId: chat.id,
              expectedRevision: profile.revision + 1,
              image: profile.image,
              loreContext: invalidLore,
            },
          };
        },
        answer: conflict,
        targetRevision: true,
      },
      {
        when: 'a module another tab deleted',
        arrange: () => {
          const { chat } = scene('Stale tab module');
          const profile = profileOf(chat.id);
          const module = libraryPackage('module');
          removed('content', module);
          return {
            input: {
              chatId: chat.id,
              expectedRevision: profile.revision,
              image: profile.image,
              packageAttachments: [
                ...(profile.packageAttachments ?? []),
                { id: module.id, revision: module.revision, role: 'module' },
              ],
            },
          };
        },
        answer: deleted,
        targetRevision: true,
      },
    ],
  },
  updateGenerationDefaults: { exempt: singletonExemption },
  uploadAsset: {
    cases: [
      {
        when: 'a chat another tab deleted, with bytes that are not an image',
        arrange: () => ({
          input: {
            chatId: deletedChat().chatId,
            ...assetDetails,
            base64: Buffer.from('not an image').toString('base64'),
          },
        }),
        answer: conflict,
      },
    ],
  },
  updateAsset: {
    cases: [
      {
        when: 'an image another tab deleted',
        arrange: () => {
          const { chatId, gone, kept } = removedAsset();
          const edit = { chatId, expectedRevision: 1, title: 'Renamed', description: '' };
          return {
            input: { ...edit, assetId: gone.id },
            control: { ...edit, assetId: kept.id },
          };
        },
        answer: conflict,
      },
      {
        when: 'a chat another tab deleted',
        arrange: () => {
          const { chat } = scene('Stale tab image chat');
          const edit = { expectedRevision: 1, title: 'Renamed', description: '' };
          return {
            input: { ...edit, ...assetOfDeletedChat() },
            control: { ...edit, chatId: chat.id, assetId: asset(chat.id).id },
          };
        },
        answer: conflict,
      },
    ],
  },
  deleteAsset: {
    cases: [
      {
        when: 'an image another tab deleted',
        arrange: () => {
          const { chatId, gone } = removedAsset();
          return { input: { chatId, assetId: gone.id } };
        },
        answer: conflict,
      },
      {
        when: 'a chat another tab deleted',
        arrange: () => ({ input: assetOfDeletedChat() }),
        answer: conflict,
      },
    ],
  },
});
