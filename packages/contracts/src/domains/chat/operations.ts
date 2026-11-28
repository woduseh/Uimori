import { z } from 'zod/v4';
import { defineOperation } from '../../endpoint.js';
import { storyUiStyles } from '../story-ui-styles.js';
import { revision } from '../revision.js';
import { nonBlank } from '../text.js';
import {
  CHAT_AUTHOR_NOTE_MAX_CHARS,
  MAX_AUTO_REFUSAL_RETRIES,
  MAX_MAIN_MODEL_CALLS,
} from './limits.js';

const id = nonBlank(100);
const chatTarget = { chatId: id };
const botTarget = { botId: id };
const contentRef = z.strictObject({ id, revision: z.int().positive() });
export type ChatContentRef = z.infer<typeof contentRef>;

const personaMode = <P extends z.ZodType>(persona: P) =>
  z.discriminatedUnion('mode', [
    z.strictObject({ mode: z.literal('inherit') }),
    z.strictObject({ mode: z.literal('none') }),
    z.strictObject({ mode: z.literal('persona'), persona }),
  ]);
const personaChoice = z.strictObject({ id });
export type PersonaChoice = z.infer<typeof personaChoice>;
export const botDefaults = z.strictObject({ revision, persona: personaMode(contentRef) });

export const chatFolder = z.strictObject({
  id: z.string(),
  botId: z.string(),
  title: z.string(),
  defaultPersona: contentRef.nullable(),
  revision,
});

const chat = z.looseObject({ id: z.string(), title: z.string() });

const folderTitle = nonBlank(200);
export const createChatFolderInput = z.strictObject({
  ...botTarget,
  title: folderTitle,
  defaultPersona: personaChoice.nullable().optional(),
});
export type CreateChatFolder = z.infer<typeof createChatFolderInput>;
export const updateChatFolderInput = z.strictObject({
  ...botTarget,
  folderId: id,
  expectedRevision: revision,
  title: folderTitle.optional(),
  defaultPersona: personaChoice.nullable().optional(),
});
export type UpdateChatFolder = z.infer<typeof updateChatFolderInput>;
export const deleteChatFolderInput = z.strictObject({
  ...botTarget,
  folderId: id,
  expectedRevision: revision,
});
export type DeleteChatFolder = z.infer<typeof deleteChatFolderInput>;
export const updateBotDefaultsInput = z.strictObject({
  ...botTarget,
  expectedRevision: revision,
  persona: personaMode(personaChoice),
});
export type UpdateBotDefaults = z.infer<typeof updateBotDefaultsInput>;

export const moveChatInput = z.strictObject({
  ...chatTarget,
  expectedRevision: revision,
  folderId: id.nullable(),
  beforeChatId: id.nullable().optional(),
});
export type MoveChat = z.infer<typeof moveChatInput>;
export const pinChatInput = z.strictObject({ ...chatTarget, pinned: z.boolean() });
export type PinChat = z.infer<typeof pinChatInput>;

export const forkChatInput = z.strictObject({
  ...chatTarget,
  fromRevision: id.nullable(),
  title: nonBlank(Number.MAX_SAFE_INTEGER).optional(),
  titleLocale: z.string().max(20).optional(),
  idempotencyKey: id,
});
export type ForkChat = z.infer<typeof forkChatInput>;

const packageAttachment = z.strictObject({
  id,
  revision: z.int().positive(),
  role: z.enum(['bot', 'persona', 'module']),
});
const packageAttachments = z
  .array(packageAttachment)
  .max(100)
  .refine(
    (refs) =>
      new Set(refs.map((ref) => `${ref.id}:${ref.role}`)).size === refs.length &&
      refs.filter((ref) => ref.role === 'bot').length <= 1 &&
      refs.filter((ref) => ref.role === 'persona').length <= 1,
    'Each package is attached once, with at most one bot and one persona'
  );
export const pinnedProfile = z.strictObject({
  mainPromptPresetId: id.optional(),
  mainModel: z.strictObject({ id }).optional(),
});
export const updateChatProfileInput = z.strictObject({
  ...chatTarget,
  expectedRevision: revision,
  image: z.boolean(),
  packageAttachments: packageAttachments.optional(),
  loreContext: z.unknown().optional(),
  pinned: pinnedProfile.optional(),
  authorNote: z.string().max(CHAT_AUTHOR_NOTE_MAX_CHARS).optional(),
});
export type UpdateChatProfile = z.infer<typeof updateChatProfileInput>;
const chatProfile = z.looseObject({ chatId: z.string(), revision, image: z.boolean() });

const storyUiStyleSetting = z.union([
  z.literal('auto'),
  z.enum(storyUiStyles),
  z.templateLiteral(['theme:', z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u)]),
]);
export const chatGenerationDefaults = z.strictObject({
  revision,
  maxCalls: z.int().min(1).max(MAX_MAIN_MODEL_CALLS),
  storyUi: z.boolean(),
  storyUiStyle: storyUiStyleSetting,
  autoRefusalRetryEnabled: z.boolean(),
  autoRefusalMaxRetries: z.int().min(0).max(MAX_AUTO_REFUSAL_RETRIES),
});
const { revision: _revision, ...generationValues } = chatGenerationDefaults.shape;
export const updateChatGenerationDefaultsInput = z.strictObject({
  ...generationValues,
  expectedRevision: revision,
});
export type UpdateChatGenerationDefaults = z.infer<typeof updateChatGenerationDefaultsInput>;

const assetText = (max: number) => z.string().max(max);
const assetDetails = {
  title: nonBlank(200),
  description: assetText(2000),
  actor: assetText(200),
  outfit: assetText(200),
  location: assetText(200),
  allowedUse: z.enum(['profile', 'inline', 'both']),
};
export const uploadChatAssetInput = z.strictObject({
  ...chatTarget,
  ...assetDetails,
  base64: z.string(),
});
export type UploadChatAsset = z.infer<typeof uploadChatAssetInput>;
export type ChatAssetDetails = z.infer<z.ZodObject<typeof assetDetails>>;
export const updateChatAssetInput = z.strictObject({
  ...chatTarget,
  assetId: id,
  expectedRevision: z.int().positive(),
  title: assetDetails.title,
  description: assetDetails.description,
});
export type UpdateChatAsset = z.infer<typeof updateChatAssetInput>;
export const chatAssetTarget = z.strictObject({ ...chatTarget, assetId: id });
export type ChatAssetTarget = z.infer<typeof chatAssetTarget>;
const asset = z.looseObject({ id: z.string(), chatId: z.string(), revision, url: z.string() });

export const chatOperations = {
  readBotDefaults: defineOperation('chat.readBotDefaults', z.strictObject(botTarget), botDefaults),
  updateBotDefaults: defineOperation('chat.updateBotDefaults', updateBotDefaultsInput, botDefaults),
  listFolders: defineOperation('chat.listFolders', z.strictObject(botTarget), z.array(chatFolder)),
  createFolder: defineOperation('chat.createFolder', createChatFolderInput, chatFolder),
  updateFolder: defineOperation('chat.updateFolder', updateChatFolderInput, chatFolder),
  deleteFolder: defineOperation(
    'chat.deleteFolder',
    deleteChatFolderInput,
    z.strictObject({ deleted: z.literal(true), movedChatIds: z.array(z.string()) })
  ),
  pinChat: defineOperation('chat.pinChat', pinChatInput, chat),
  moveChat: defineOperation('chat.moveChat', moveChatInput, chat),
  forkChat: defineOperation('chat.forkChat', forkChatInput, chat),
  deleteChat: defineOperation(
    'chat.deleteChat',
    z.strictObject(chatTarget),
    z.strictObject({ deleted: z.literal(true) })
  ),
  readProfile: defineOperation('chat.readProfile', z.strictObject(chatTarget), chatProfile),
  updateProfile: defineOperation('chat.updateProfile', updateChatProfileInput, chatProfile),
  readGenerationDefaults: defineOperation(
    'chat.readGenerationDefaults',
    z.strictObject({}),
    chatGenerationDefaults
  ),
  updateGenerationDefaults: defineOperation(
    'chat.updateGenerationDefaults',
    updateChatGenerationDefaultsInput,
    chatGenerationDefaults
  ),
  uploadAsset: defineOperation('chat.uploadAsset', uploadChatAssetInput, asset),
  updateAsset: defineOperation('chat.updateAsset', updateChatAssetInput, asset),
  deleteAsset: defineOperation(
    'chat.deleteAsset',
    chatAssetTarget,
    z.strictObject({ deleted: z.literal(true), id: z.string() })
  ),
};
