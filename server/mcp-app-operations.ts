import { readHelperOptions } from './chat-options.js';
import { readHelperChatOrganization } from './helper-chat-organization-tools.js';
import { readHelperChatState } from './helper-chat-state-tools.js';
import { readHelperChatContext } from './helper-context.js';
import { invokeSceneRegexSearch } from './helper-data-tools.js';
import {
  listIllustrationCuts,
  readIllustrationScene,
  inspectIllustrationCut,
  readIllustrationCutImage,
} from './helper-illustration-cuts.js';
import { readIllustrationProfiles } from './helper-illustration-profiles.js';
import {
  listIllustrationHelperImages,
  readHelperImage,
  readIllustrationHelperImage,
} from './helper-image-tools.js';
import { readHelperChatLore } from './helper-lore-read.js';
import { invokePresentationTool } from './helper-presentation-tools.js';
import { readHelperPromptCombinations } from './helper-prompt-combination-tools.js';
import type { HelperReadFit } from './helper-read-fit.js';
import { invokeResourceTool } from './helper-resource-tools.js';
import { invokeHelperSceneTool } from './helper-scene-tools.js';
import { invokeHelperSettingsTool } from './helper-settings-tools.js';
import {
  listHelperChats,
  organizeHelperLibrary,
  readHelperArtifact,
  readHelperChatIndex,
} from './helper-store-operations.js';
import { readVertexLocations } from './helper-vertex-location-tools.js';
import { HelperWorkspace } from './helper-workspace.js';
import { readIllustrationContinuity } from './illustration-continuity.js';
import { readHelperOutline } from './outline-read.js';
import { chatTitle, number } from './request-validation.js';
import type { Store } from './store.js';

export type McpOperationContext = {
  store: Store;
  signal: AbortSignal;
  chatId: string | undefined;
  fit: HelperReadFit;
};
type Args = Record<string, unknown>;
type Image = { result: unknown; resolved: { mime: string; base64: string } };
export type McpAppOperation = {
  readOnly: boolean;
  chat: 'required' | 'optional' | 'none';
  actions?: readonly string[];
  fields?: readonly string[];
  image?: (args: Args) => boolean;
  run: (args: Args, context: McpOperationContext) => unknown;
};

const chatOf = (context: McpOperationContext) => context.chatId!;
const read = (run: McpAppOperation['run'], chat: McpAppOperation['chat'] = 'none') => ({
  readOnly: true,
  chat,
  run,
});
const chatRead = (run: (store: Store, chatId: string, args: Args, fit: HelperReadFit) => unknown) =>
  read((args, context) => run(context.store, chatOf(context), args, context.fit), 'required');
const settings = (name: string) =>
  read((args, { store, chatId }) => invokeHelperSettingsTool(store, name, args, chatId));
const resource = (name: string, readOnly = true): McpAppOperation => ({
  readOnly,
  chat: 'none',
  run: (args, { store, fit }) => invokeResourceTool(store, name, args, fit),
});
const sceneRead = (name: string) =>
  chatRead((store, chatId, args, fit) => invokeHelperSceneTool(store, chatId, name, args, fit));
const chatState = (name: string): McpAppOperation =>
  chatRead((store, chatId, args, fit) => readHelperChatState(store, chatId, name, args, fit));

export const MCP_APP_OPERATIONS: Record<string, McpAppOperation> = {
  'settings.read': read(
    (args, { store, chatId }) => invokeHelperSettingsTool(store, 'settings.read', args, chatId),
    'optional'
  ),
  'model.list': settings('model.list'),
  'model.pricing.read': settings('model.pricing.read'),
  'model.parameters.read': settings('model.parameters.read'),
  'usage.read': settings('usage.read'),
  'vertex.location.read': read((args, { store }) => readVertexLocations(store, args)),
  'illustration-preset.list': resource('illustration-preset.list'),
  'illustration-preset.guide': resource('illustration-preset.guide'),
  'theme.list': resource('theme.list'),
  'theme.guide': resource('theme.guide'),
  'resource.save': resource('resource.save', false),
  'image.update-metadata': resource('image.update-metadata', false),
  'font.list': read((args, { store }) => invokePresentationTool(store, 'font.list', args)),
  'palette.list': read((args, { store }) => invokePresentationTool(store, 'palette.list', args)),
  'prompt.combination.list': read((args, { store }) => readHelperPromptCombinations(store, args)),
  'chat.list': read((args, { store }) => listHelperChats(store, args)),
  'chat.read': chatRead((store, chatId, args) => readHelperChatIndex(store, chatId, args)),
  'chat.rename': {
    readOnly: false,
    chat: 'required',
    run: (args, context) =>
      context.store.renameChat(
        chatOf(context),
        chatTitle(args.title),
        number(args.expectedRevision, 'title revision', 0)
      ),
  },
  'scene.read': sceneRead('scene.read'),
  'scene.versions': sceneRead('scene.versions'),
  'scene.search': read(
    (args, { store, chatId, signal, fit }) =>
      args.regex === true
        ? invokeSceneRegexSearch(store, chatId!, args, signal)
        : invokeHelperSceneTool(store, chatId!, 'scene.search', args, fit),
    'required'
  ),
  'chat.profile.read': chatState('chat.profile.read'),
  'chat.bookmark': { ...chatState('chat.bookmark'), actions: ['read'], fields: ['action'] },
  'chat.lore': {
    ...chatRead((store, chatId, args, fit) => readHelperChatLore(store, chatId, args, fit)),
    actions: ['read'],
    fields: ['action', 'selector', 'query', 'offset', 'limit', 'textOffset', 'textLimit'],
  },
  'chat.organize': {
    ...read((args, { store }) => readHelperChatOrganization(store, args)),
    actions: ['read'],
    fields: ['action', 'botId'],
  },
  'library.organize': {
    readOnly: false,
    chat: 'none',
    actions: ['read', 'create-folder', 'update-folder', 'move'],
    run: (args, { store }) => organizeHelperLibrary(store, args),
  },
  'outline.read': chatRead((store, chatId, args, fit) =>
    readHelperOutline(store, chatId, args, undefined, fit)
  ),
  'options.read': chatRead((store, chatId, args) => readHelperOptions(store, chatId, args)),
  'context.read': chatRead((store, chatId, args) => readHelperChatContext(store, chatId, args)),
  'artifact.read': read((args, { store, fit }) =>
    readHelperArtifact(new HelperWorkspace(store), args, fit)
  ),
  'illustration.profiles.read': chatRead((store, chatId, args) =>
    readIllustrationProfiles(store, chatId, args)
  ),
  'illustration.cuts.list': chatRead((store, chatId, args) =>
    listIllustrationCuts(store, chatId, args)
  ),
  'illustration.scene.read': chatRead((store, chatId, args) =>
    readIllustrationScene(store, chatId, args)
  ),
  'illustration.continuity.read': chatRead((store, chatId, args) =>
    readIllustrationContinuity(store, chatId, args)
  ),
  'illustration.image.list': chatRead((store, chatId, args) =>
    listIllustrationHelperImages(store, chatId, args)
  ),
  'illustration.cut.read': {
    ...read(
      (args, { store, chatId, signal }) =>
        args.includeImage === false
          ? inspectIllustrationCut(store, chatId!, args)
          : readIllustrationCutImage(store, chatId!, args, signal),
      'required'
    ),
    image: (args) => args.includeImage !== false,
  },
  'illustration.image.read': {
    ...read(
      (args, { store, chatId, signal }) =>
        readIllustrationHelperImage(store, chatId!, args, signal),
      'required'
    ),
    image: () => true,
  },
  'image.read': {
    ...read((args, { store, signal }) => readHelperImage(store, args, signal)),
    image: () => true,
  },
};

export const imageContent = (read: unknown) => {
  const { result, resolved } = read as Image;
  return {
    result,
    image: { type: 'image' as const, data: resolved.base64, mimeType: resolved.mime },
  };
};
