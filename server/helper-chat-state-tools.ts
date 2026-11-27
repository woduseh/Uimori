import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { CHAT_VARIABLE_LIMITS, validateChatVariableValues } from '../core/chat-variables.js';
import { REQUEST_TEXT_MAX_CHARS } from '../core/content-limits.js';
import {
  normalizeStoryGuideConfig,
  STORY_GUIDE_LIMITS,
  type StoryGuideConfig,
} from '../core/story-guide.js';
import type { HelperTask } from '../core/helper.js';
import type { LogicalMessage } from '../core/risu-prompt.js';
import { countTextTokens, textTokenExcerpt } from '../core/text-tokens.js';
import type { Json, ProviderTool } from '../core/transport.js';
import { chatVariableView } from './chat-variable-context.js';
import { readChatVariables, writeChatVariables } from './chat-variables.js';
import { recordHelperTaskResult } from './helper-task-results.js';
import { recordHelperAction, withHelperChange } from './helper-changes.js';
import { diffText } from '../core/text-diff.js';
import type { HelperTaskResultTarget } from '../core/helper.js';
import { CHAT_AUTHOR_NOTE_MAX_CHARS, type Content } from '../core/product.js';
import type { ContentAttachment } from '../core/risu-content.js';
import {
  BOOKMARK_NOTE_MAX_CHARS,
  BOOKMARK_TITLE_MAX_CHARS,
  type Bookmark,
} from '../core/reading-state.js';
import { addBookmark, deleteBookmark, listBookmarks, updateBookmark } from './reading-state.js';
import {
  personalWorkspaceOperations,
  updateStoryGuideToolInput,
  updateVariablesToolInput,
} from '#contracts/operations';
import { parseInput } from './endpoint.js';
import { readSceneContext, updateSceneContext } from './scene-context.js';
import type { HelperWorkspace } from './helper-workspace.js';
import { sceneRequestLore } from './request-lore.js';
import { sceneTitle, setSceneTitle } from './scene-titles.js';
import { inspectNextRequest } from './request-preview.js';
import { fields, HttpError, isSha256Hex, number, record, text } from './request-validation.js';
import { AppError, HelperToolError } from './app-errors.js';
import { attachableContent } from './product-store.js';
import type { Store } from './store.js';

const schema = (properties: Record<string, Json>, required: string[] = []): Json => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const offset: Json = {
  type: 'integer',
  minimum: 0,
  description: 'Entry offset. Pass the previous nextOffset.',
};
const textOffset: Json = {
  type: 'integer',
  minimum: 0,
  description:
    'Start position inside the text, in UTF-16 code units. Pass the previous nextOffset.',
};
const textLimit: Json = {
  type: 'integer',
  minimum: 1,
  maximum: 10000,
  description:
    'Maximum text to return, in UTF-16 code units. Omit to read up to about 3000 tokens.',
};
const sha256: Json = { type: 'string', pattern: '^[a-f0-9]{64}$' };

export const HELPER_CHAT_STATE_TOOLS: ProviderTool[] = [
  {
    name: 'chat.preview',
    description:
      "Preview the next main request of a chat without sending it: the model, prompt preset and persona it would use, its estimated input tokens against the model limit, whether the summary is used, the lore it would carry, prompt blocks left out and why, and the assembled prompt messages in order. Use it to find out why the writer ignored a setting or lore entry, what a prompt preset actually produces, or how close the context is to its limit. request is the user's next request; omit it for an empty one. Without message, the messages are listed in pages with role, origin (prompt, history or current), prompt block, length and opening; contains keeps only messages containing that literal text, case-insensitively. With message, that message's text is returned in pages. Native Risu scripts run read-only and start/input callbacks are skipped; caveats names what can still differ from a real request. Each call assembles the request again: pass promptHash back as expectedPromptHash while paging, so a changed chat is reported instead of mixing versions. Nothing is reserved, sent or saved.",
    inputSchema: schema({
      request: {
        type: 'string',
        maxLength: REQUEST_TEXT_MAX_CHARS,
        description: 'The next user request to preview. Omit for an empty request.',
      },
      contains: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description: 'List only messages that contain this literal text, ignoring case.',
      },
      message: {
        type: 'integer',
        minimum: 0,
        description: 'Index of one message to read, from the message list.',
      },
      offset: { ...(offset as object), description: 'Message list offset.' },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        description: 'Maximum messages per list page. Default 20.',
      },
      textOffset,
      textLimit,
      expectedPromptHash: {
        ...(sha256 as object),
        description: 'promptHash from an earlier page of the same preview.',
      },
    }),
  },
  {
    name: 'scene.lore',
    description:
      'Show which lore entries the writer actually received when a saved scene was written: each entry title and library source, how it arrived (pinned, selected by automatic lore selection, retained from earlier scenes, or read through a tool), whether its full text, an excerpt or a summary was delivered, and the automatic selection counts. sourceId defaults to the latest scene. Imported scenes, authored first messages and scenes written before this record existed return lore:null. For the next request use chat.preview.',
    inputSchema: schema({
      sourceId: {
        type: 'string',
        minLength: 1,
        maxLength: 100,
        description: 'Scene id from chat.read. Omit for the latest scene.',
      },
      offset,
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 200,
        description: 'Maximum entries per page. Default 50.',
      },
    }),
  },
  {
    name: 'chat.variables.read',
    description:
      'Read the Risu variables of a chat, the values that {{getvar::name}} and scripts use, such as affection or a quest flag. For each name it returns the value the next request would use, the authored default from the bot, persona, modules or prompt preset, and whether this chat overrides it. It also returns revision and sourceHash, which chat.variables.update needs, and pending while a request of the chat is queued or running. query keeps names that contain that text. Long values are cut to a preview with their full length; pass name to read one value in text pages.',
    inputSchema: schema({
      query: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description: 'Keep variable names that contain this text, ignoring case.',
      },
      name: {
        type: 'string',
        minLength: 1,
        maxLength: 1000,
        description: 'Exact variable name to read in full.',
      },
      offset,
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 200,
        description: 'Maximum variables per page. Default 50.',
      },
      textOffset,
      textLimit,
    }),
  },
  {
    name: 'chat.variables.update',
    description:
      "Change Risu variables of a chat. set gives new values by name; Risu stores every value as text, so write numbers and flags as text too. unset removes this chat's value so the authored default applies again, and a variable without a default disappears. Variables you do not name keep their values. Take expectedRevision and expectedSourceHash from chat.variables.read. The change is refused while a request of the chat is queued or running, and when the story or the variables changed after that read. It affects later requests only; saved scenes are not rewritten.",
    inputSchema: schema(
      {
        expectedRevision: {
          type: 'integer',
          minimum: 0,
          description: 'revision from chat.variables.read.',
        },
        expectedSourceHash: {
          type: ['string', 'null'],
          pattern: '^[a-f0-9]{64}$',
          description: 'sourceHash from chat.variables.read, null for a chat without scenes.',
        },
        set: {
          type: 'object',
          additionalProperties: { type: 'string', maxLength: CHAT_VARIABLE_LIMITS.maxValueChars },
          description: 'Variable names and their new text values.',
        },
        unset: {
          type: 'array',
          maxItems: CHAT_VARIABLE_LIMITS.maxEntries,
          items: { type: 'string', minLength: 1, maxLength: 1000 },
          description: 'Variable names whose chat value is removed.',
        },
      },
      ['expectedRevision', 'expectedSourceHash']
    ),
  },
  {
    name: 'scene.title',
    description:
      'Name a saved scene of the chat, or clear its name with an empty title. The name labels the scene in the scene list and navigator only; it is not sent to the writer. Take expectedTitle from the title that chat.read returns for that scene, or an empty string when it has none; the change is refused when the name changed since that read, unless the scene already has the requested name.',
    inputSchema: schema(
      {
        sourceId: {
          type: 'string',
          minLength: 1,
          maxLength: 100,
          description: 'Scene id from chat.read.',
        },
        title: { type: 'string', maxLength: 200, description: 'New scene name; empty clears it.' },
        expectedTitle: {
          type: 'string',
          maxLength: 200,
          description: 'Current name from chat.read, empty when the scene has none.',
        },
      },
      ['sourceId', 'title', 'expectedTitle']
    ),
  },
  {
    name: 'chat.guide.update',
    description:
      'Change the original-work reference settings of a chat: whether the automatic reference step runs before writing, the work and edition, the reader position and spoiler limit, supplied reference text, whether canon events are followed, and whether the step may search the web. source.writing.chat.storyGuide has the revision for the current chat; context.read with sections ["storyGuide"] returns all settings. changes names only the settings to change; the others keep their values. It affects later requests only.',
    inputSchema: schema(
      {
        expectedRevision: {
          type: 'integer',
          minimum: 0,
          description: 'storyGuide.revision from source.writing.chat or context.read.',
        },
        changes: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            enabled: { type: 'boolean', description: 'Run the automatic reference step.' },
            work: {
              type: 'string',
              maxLength: STORY_GUIDE_LIMITS.work,
              description: 'Original work and edition.',
            },
            position: {
              type: 'string',
              maxLength: STORY_GUIDE_LIMITS.position,
              description: 'Where the reader is in the original work and the spoiler limit.',
            },
            reference: {
              type: 'string',
              maxLength: STORY_GUIDE_LIMITS.reference,
              description: 'Reference text the user supplies about the work.',
            },
            followCanon: { type: 'boolean', description: 'Consider canon events.' },
            webSearch: { type: 'boolean', description: 'Allow the step to search the web.' },
          },
          description: 'Only the settings to change.',
        },
      },
      ['expectedRevision', 'changes']
    ),
  },
  {
    name: 'chat.profile.read',
    description:
      'Read what a chat is assembled from: its owning bot, the persona and modules attached to it, its lore context policy and its Risu author note, with the profileRevision that chat.profile.update needs. The pinned model and prompt preset of the chat are in settings.read.',
    inputSchema: schema({}),
  },
  {
    name: 'chat.profile.update',
    description:
      'Change what a chat is assembled from: the attached persona, the attached modules, the lore context policy or the Risu author note. Give only the fields to change. persona takes a saved persona id, or null to detach it; modules replaces the whole list of attached module ids; the owning bot cannot be changed. loreContext takes the complete policy object as chat.profile.read returns it. authorNote replaces the whole note, and an empty string clears it; the earlier note stays in the change record. Changes apply to later requests; scenes already written keep what they used. Take expectedRevision from chat.profile.read.',
    inputSchema: schema(
      {
        expectedRevision: {
          type: 'integer',
          minimum: 0,
          description: 'profileRevision from chat.profile.read.',
        },
        persona: {
          type: ['string', 'null'],
          maxLength: 100,
          description: 'Saved persona id to attach, or null to detach the persona.',
        },
        modules: {
          type: 'array',
          maxItems: 98,
          items: { type: 'string', minLength: 1, maxLength: 100 },
          description: 'The complete list of saved module ids to attach, in order.',
        },
        loreContext: {
          type: 'object',
          description: 'The complete lore context policy, as chat.profile.read returns it.',
        },
        authorNote: {
          type: 'string',
          maxLength: CHAT_AUTHOR_NOTE_MAX_CHARS,
          description: 'The complete new Risu author note.',
        },
      },
      ['expectedRevision']
    ),
  },
  {
    name: 'scene.context.update',
    description:
      'Hide or show a saved scene for the writer, turn the request that produced it off or on, or replace that request text. A hidden scene stays in the chat but is left out of later requests and of scene numbers; a request that is off is left out while the scene text stays. requestText replaces the request the writer sees for this scene, and null drops that replacement so the request originally sent applies again. The earlier text stays in the change record; read the current text through db.query (agent_messages.request). Refused while the chat has a queued or running request. Take expectedRevision from contextRevision in chat.read.',
    inputSchema: schema(
      {
        sourceId: {
          type: 'string',
          minLength: 1,
          maxLength: 100,
          description: 'Scene id from chat.read.',
        },
        expectedRevision: {
          type: 'integer',
          minimum: 0,
          description: 'contextRevision of the scene from chat.read.',
        },
        sceneEnabled: { type: 'boolean', description: 'false hides the scene from the writer.' },
        requestEnabled: {
          type: 'boolean',
          description: 'false leaves the request of this scene out of later requests.',
        },
        requestText: {
          type: ['string', 'null'],
          maxLength: REQUEST_TEXT_MAX_CHARS,
          description: 'The complete new request text, or null to go back to the original.',
        },
      },
      ['sourceId', 'expectedRevision']
    ),
  },
  {
    name: 'chat.bookmark',
    description:
      'Read, add, rename or delete the bookmarks of a chat: named places in the story with an optional note, shown in the reader. action=read lists them with their ids and revisions. add takes sourceId and title, and optionally note and representation (original by default), and marks the start of that scene. update takes id, expectedRevision, and a new title, note or both; an omitted one stays. delete takes id and expectedRevision. The earlier title and note of an updated or deleted bookmark stay in the change record; no scene text changes.',
    inputSchema: schema(
      {
        action: {
          type: 'string',
          enum: ['read', 'add', 'update', 'delete'],
          description: 'What to do.',
        },
        id: { type: 'string', minLength: 1, maxLength: 100, description: 'Bookmark id.' },
        expectedRevision: {
          type: 'integer',
          minimum: 1,
          description: 'update, delete: revision of the bookmark from action=read.',
        },
        sourceId: {
          type: 'string',
          minLength: 1,
          maxLength: 100,
          description: 'add: scene id from chat.read.',
        },
        representation: {
          type: 'string',
          enum: ['original', 'translation'],
          description: 'add: whether the bookmark opens the original or the translation.',
        },
        title: {
          type: 'string',
          minLength: 1,
          maxLength: BOOKMARK_TITLE_MAX_CHARS,
          description: 'add, update: bookmark name.',
        },
        note: {
          type: 'string',
          maxLength: BOOKMARK_NOTE_MAX_CHARS,
          description: 'add, update: optional note.',
        },
      },
      ['action']
    ),
  },
];

const READ_TOKEN_BUDGET = 12_000;
const MESSAGE_OPENING_CHARS = 160;
const VALUE_PREVIEW_CHARS = 300;

function boundary(value: string, at: number) {
  return at > 0 &&
    /[\uD800-\uDBFF]/u.test(value[at - 1] ?? '') &&
    /[\uDC00-\uDFFF]/u.test(value[at] ?? '')
    ? at - 1
    : at;
}

function textPage<T extends object>(
  value: string,
  args: Record<string, unknown>,
  wrap: (page: object) => T
): T {
  const start = boundary(value, number(args.textOffset ?? 0, 'text offset', 0, value.length));
  const limit =
    args.textLimit === undefined
      ? textTokenExcerpt(value.slice(start), 3000).text.length
      : number(args.textLimit, 'text limit', 1, 10000);
  let end = boundary(value, Math.min(value.length, start + limit));
  if (end === start && start < value.length) end = Math.min(value.length, start + 2);
  const page = () =>
    wrap({
      text: value.slice(start, end),
      range: { start, end, unit: 'utf16-code-unit' },
      totalChars: value.length,
      nextOffset: end < value.length ? end : null,
    });
  while (end - start > 2 && countTextTokens(JSON.stringify(page())) > READ_TOKEN_BUDGET)
    end = boundary(value, start + Math.max(2, Math.floor((end - start) / 2)));
  return page();
}

function listPage<T, R extends object>(
  items: readonly T[],
  start: number,
  limit: number,
  wrap: (page: T[], nextOffset: number | null) => R
): R {
  let count = Math.min(limit, Math.max(0, items.length - start));
  const page = () => {
    const end = start + count;
    return wrap(items.slice(start, end), end < items.length ? end : null);
  };
  while (count > 1 && countTextTokens(JSON.stringify(page())) > READ_TOKEN_BUDGET)
    count = Math.max(1, Math.floor(count / 2));
  return page();
}

const opening = (value: string, chars: number) =>
  value.length <= chars ? value : `${value.slice(0, boundary(value, chars))}…`;

function messageText(message: LogicalMessage): string {
  return message.content
    .map((part) =>
      part.type === 'text' ? part.text : part.type === 'image' ? '[image]' : '[file]'
    )
    .join('');
}

async function readChatPreview(store: Store, chatId: string, args: Record<string, unknown>) {
  fields(args, [
    'request',
    'contains',
    'message',
    'offset',
    'limit',
    'textOffset',
    'textLimit',
    'expectedPromptHash',
  ]);
  const request =
    args.request === undefined ? '' : text(args.request, 'request', REQUEST_TEXT_MAX_CHARS, true);
  const contains =
    args.contains === undefined ? undefined : text(args.contains, 'contains', 200).toLowerCase();
  if (args.expectedPromptHash !== undefined && !isSha256Hex(args.expectedPromptHash))
    throw new HttpError(400, 'Invalid expectedPromptHash');
  if (args.message !== undefined && (contains !== undefined || args.offset !== undefined))
    throw new HttpError(400, 'message reads one message; omit contains and offset');
  if (args.message === undefined && (args.textOffset !== undefined || args.textLimit !== undefined))
    throw new HttpError(400, 'textOffset and textLimit need message');
  const { preview, compilation, loreContext } = await inspectNextRequest(store, chatId, request);
  const messages = compilation?.messages ?? [];
  const promptHash = compilation
    ? createHash('sha256').update(JSON.stringify(messages)).digest('hex')
    : null;
  if (args.expectedPromptHash !== undefined && args.expectedPromptHash !== promptHash)
    throw new HelperToolError(
      409,
      'PREVIEW_CHANGED',
      'The chat or its settings changed since that page. Start again from the first page.'
    );
  const describe = (item: LogicalMessage, index: number, body: string) => ({
    index,
    role: item.role,
    origin: item.provenance.origin,
    blockId: item.provenance.blockId,
    ...(item.provenance.sourceRevision ? { sourceId: item.provenance.sourceRevision } : {}),
    ...(item.completion === 'prefill' ? { prefill: true } : {}),
    chars: body.length,
  });
  if (args.message !== undefined) {
    if (!compilation) throw new HttpError(409, preview.error ?? 'PREVIEW_UNAVAILABLE');
    const index = number(args.message, 'message index', 0, Math.max(0, messages.length - 1));
    const item = messages[index];
    if (!item) throw new HttpError(400, 'The preview has no messages');
    const body = messageText(item);
    return textPage(body, args, (page) => ({
      promptHash,
      ...describe(item, index, body),
      ...page,
    }));
  }
  const listed = messages
    .map((item, index) => ({ item, index, body: messageText(item) }))
    .filter(({ body }) => contains === undefined || body.toLowerCase().includes(contains));
  const start = number(args.offset ?? 0, 'offset', 0);
  const limit = number(args.limit ?? 20, 'limit', 1, 50);
  return listPage(listed, start, limit, (page, nextOffset) => ({
    preview: {
      scope: preview.scope,
      stale: preview.snapshot.stale,
      selected: preview.selected,
      tokens: {
        estimatedInputTokens: preview.tokens.estimatedInputTokens,
        inputTokenLimit: preview.tokens.inputTokenLimit,
        utilization: preview.tokens.utilization,
        status: preview.tokens.status,
      },
      summary: preview.summary,
      error: preview.error,
      caveats: preview.caveats,
    },
    promptHash,
    ...(start === 0
      ? {
          lore: {
            enabled: preview.lore.enabled,
            pinnedEntries: preview.lore.pinnedEntries,
            selectionPending: preview.lore.selectionPending,
            retained: (loreContext?.entries ?? [])
              .slice(0, 50)
              .map((entry) => ({ id: entry.id, title: entry.title, chars: entry.text.length })),
            retainedTotal: loreContext?.entries.length ?? 0,
          },
          excludedBlocks: (compilation?.trace ?? [])
            .filter((block) => !block.included)
            .slice(0, 50)
            .map((block) => ({ blockId: block.blockId, reason: block.reason ?? null })),
          warnings: (compilation?.warnings ?? []).slice(0, 20).map((item) => opening(item, 300)),
        }
      : {}),
    messages: page.map(({ item, index, body }) => {
      const at = contains === undefined ? -1 : body.toLowerCase().indexOf(contains);
      return {
        ...describe(item, index, body),
        opening: opening(body, MESSAGE_OPENING_CHARS),
        ...(at >= 0 ? { matchOffset: at } : {}),
      };
    }),
    total: listed.length,
    totalMessages: messages.length,
    nextOffset,
  }));
}

function readSceneLore(store: Store, chatId: string, args: Record<string, unknown>) {
  fields(args, ['sourceId', 'offset', 'limit']);
  const chat = store.chat(chatId);
  const sourceId =
    args.sourceId === undefined ? chat.headRevision : text(args.sourceId, 'source ID', 100);
  if (!sourceId) return { sourceId: null, attemptId: null, lore: null };
  if (!store.history(chat.headRevision).some((item) => item.revision === sourceId))
    throw new HelperToolError(404, 'SCENE_NOT_IN_CHAT', 'Find the scene id with chat.read.');
  const { attemptId, lore } = sceneRequestLore(store, sourceId);
  if (!lore) return { sourceId, attemptId, lore: null };
  const start = number(args.offset ?? 0, 'offset', 0);
  const limit = number(args.limit ?? 50, 'limit', 1, 200);
  return listPage(lore.entries, start, limit, (entries, nextOffset) => ({
    sourceId,
    attemptId,
    status: lore.status,
    ...(lore.selection ? { selection: lore.selection } : {}),
    entries,
    total: lore.entries.length,
    nextOffset,
  }));
}

function readHelperChatVariables(store: Store, chatId: string, args: Record<string, unknown>) {
  fields(args, ['query', 'name', 'offset', 'limit', 'textOffset', 'textLimit']);
  const view = chatVariableView(store, chatId);
  const guards = {
    revision: view.revision,
    sourceHash: view.sourceHash,
    pending: view.pending,
    ...(view.variableDefaultsError ? { variableDefaultsError: view.variableDefaultsError } : {}),
  };
  const defaults = view.defaults as Record<string, string>;
  const resolved = view.resolved as Record<string, string>;
  const value = (name: string) => resolved[name] ?? view.values[name] ?? defaults[name] ?? '';
  if (args.name !== undefined) {
    if (args.query !== undefined || args.offset !== undefined || args.limit !== undefined)
      throw new HttpError(400, 'name reads one variable; omit query, offset and limit');
    const name = text(args.name, 'variable name', 1000);
    if (!(name in resolved || name in view.values || name in defaults))
      throw new HelperToolError(
        404,
        'CHAT_VARIABLE_NOT_FOUND',
        'List the names with chat.variables.read.'
      );
    return textPage(value(name), args, (page) => ({
      ...guards,
      name,
      overridden: Object.hasOwn(view.values, name),
      ...(Object.hasOwn(defaults, name) ? { defaultLength: defaults[name]!.length } : {}),
      ...page,
    }));
  }
  if (args.textOffset !== undefined || args.textLimit !== undefined)
    throw new HttpError(400, 'textOffset and textLimit need name');
  const query = args.query === undefined ? undefined : text(args.query, 'query', 200).toLowerCase();
  const names = [
    ...new Set([...Object.keys(resolved), ...Object.keys(view.values), ...Object.keys(defaults)]),
  ]
    .filter((name) => query === undefined || name.toLowerCase().includes(query))
    .sort();
  const start = number(args.offset ?? 0, 'offset', 0);
  const limit = number(args.limit ?? 50, 'limit', 1, 200);
  return listPage(names, start, limit, (page, nextOffset) => ({
    ...guards,
    variables: page.map((name) => {
      const current = value(name);
      const fallback = defaults[name];
      return {
        name,
        value: opening(current, VALUE_PREVIEW_CHARS),
        ...(current.length > VALUE_PREVIEW_CHARS ? { valueLength: current.length } : {}),
        overridden: Object.hasOwn(view.values, name),
        ...(fallback === undefined
          ? {}
          : fallback === current
            ? { default: 'same' }
            : { default: opening(fallback, VALUE_PREVIEW_CHARS) }),
      };
    }),
    total: names.length,
    nextOffset,
  }));
}

export async function readHelperChatState(
  store: Store,
  chatId: string,
  name: string,
  value: unknown
): Promise<unknown> {
  const args = record(value);
  if (name === 'chat.preview') return readChatPreview(store, chatId, args);
  if (name === 'scene.lore') return readSceneLore(store, chatId, args);
  if (name === 'chat.variables.read') return readHelperChatVariables(store, chatId, args);
  if (name === 'chat.profile.read') {
    fields(args, []);
    return readChatProfile(store, chatId);
  }
  if (name === 'chat.bookmark' && args.action === 'read') {
    fields(args, ['action']);
    return { chatId, bookmarks: listBookmarks(store, chatId).map(bookmarkView) };
  }
  throw new HelperToolError(400, 'UNKNOWN_CHAT_STATE_TOOL');
}

type ResultTask = Pick<HelperTask, 'id' | 'conversationId'>;

export function applyHelperChatState(
  store: Store,
  workspace: HelperWorkspace,
  task: ResultTask,
  receiptId: string,
  chatId: string,
  name: string,
  value: unknown
): { changed: boolean } & Record<string, unknown> {
  const args = record(value);
  if (name === 'chat.variables.update')
    return updateChatVariables(store, workspace, task, receiptId, chatId, args);
  if (name === 'scene.title') return nameScene(store, workspace, task, receiptId, chatId, args);
  if (name === 'chat.guide.update')
    return updateStoryGuide(store, workspace, task, receiptId, chatId, args);
  if (name === 'chat.profile.update')
    return updateChatProfile(store, workspace, task, receiptId, chatId, args);
  if (name === 'scene.context.update')
    return updateHelperSceneContext(store, workspace, task, receiptId, chatId, args);
  if (name === 'chat.bookmark')
    return changeBookmark(store, workspace, task, receiptId, chatId, args);
  throw new HelperToolError(400, 'UNKNOWN_CHAT_STATE_TOOL');
}

function nameScene(
  store: Store,
  workspace: HelperWorkspace,
  task: ResultTask,
  receiptId: string,
  chatId: string,
  args: Record<string, unknown>
) {
  fields(args, ['sourceId', 'title', 'expectedTitle']);
  const sourceId = text(args.sourceId, 'source ID', 100);
  const chat = store.chat(chatId);
  if (!store.history(chat.headRevision).some((item) => item.revision === sourceId))
    throw new HelperToolError(404, 'SCENE_NOT_IN_CHAT', 'Find the scene id with chat.read.');
  const before = sceneTitle(store, sourceId);
  const saved = withHelperChange(
    store,
    task,
    { domain: 'scene', chatId, sourceId, field: 'title' },
    () => setSceneTitle(store, sourceId, { title: args.title, expectedTitle: args.expectedTitle })
  );
  const changed = saved.title !== before;
  recordHelperTaskResult(workspace, task, {
    receiptId,
    operation: 'scene.title',
    requestedTargets: 1,
    targets: changed
      ? [{ kind: 'scene', id: sourceId, chatId, title: saved.title || chat.title, revision: 1 }]
      : [],
  });
  return { changed, sourceId, title: saved.title };
}

function updateStoryGuide(
  store: Store,
  workspace: HelperWorkspace,
  task: ResultTask,
  receiptId: string,
  chatId: string,
  args: Record<string, unknown>
) {
  const { expectedRevision, changes } = parseInput(updateStoryGuideToolInput, args);
  const current = store.storyGuide.get(chatId);
  let config: StoryGuideConfig;
  try {
    config = normalizeStoryGuideConfig({ ...current.config, ...changes });
  } catch {
    throw new HelperToolError(
      400,
      'STORY_GUIDE_INVALID',
      `enabled, followCanon and webSearch are booleans; work, position and reference are text of at most ${STORY_GUIDE_LIMITS.work}, ${STORY_GUIDE_LIMITS.position} and ${STORY_GUIDE_LIMITS.reference} characters.`
    );
  }
  const saved = store.storyGuide.update(chatId, { expectedRevision, config });
  const changed = saved.revision !== current.revision;
  recordHelperTaskResult(workspace, task, {
    receiptId,
    operation: 'chat.guide.update',
    requestedTargets: 1,
    targets: changed
      ? [
          {
            kind: 'settings',
            id: chatId,
            title: store.chat(chatId).title,
            revision: saved.revision,
            setting: 'chat.storyGuide',
          },
        ]
      : [],
  });
  return { changed, revision: saved.revision, config: saved.config };
}

function updateChatVariables(
  store: Store,
  workspace: HelperWorkspace,
  task: ResultTask,
  receiptId: string,
  chatId: string,
  args: Record<string, unknown>
) {
  const input = parseInput(updateVariablesToolInput, args);
  const { expectedRevision, expectedSourceHash } = input;
  const set = input.set ?? {};
  const unset = input.unset ?? [];
  const both = unset.filter((name) => Object.hasOwn(set, name));
  if (both.length) throw new HttpError(400, `Both set and unset name: ${both.join(', ')}`);
  const current = readChatVariables(store, chatId);
  const next: Record<string, string> = { ...current.values, ...set };
  for (const name of unset) delete next[name];
  try {
    validateChatVariableValues(next);
  } catch {
    throw new HelperToolError(
      400,
      'CHAT_VARIABLE_VALUES_INVALID',
      `At most ${CHAT_VARIABLE_LIMITS.maxEntries} variables, ${CHAT_VARIABLE_LIMITS.maxValueChars} characters per value and ${CHAT_VARIABLE_LIMITS.maxTotalChars} in total.`
    );
  }
  const changed = !isDeepStrictEqual(next, current.values);
  const chat = store.chat(chatId);
  const sourceHash = chat.headRevision ? store.source(chat.headRevision).hash : null;
  let revision = current.revision;
  if (changed)
    revision = writeChatVariables(store, chatId, {
      expectedRevision,
      expectedSourceHash,
      idempotencyKey: `helper:${createHash('sha256').update(receiptId).digest('hex')}`,
      values: next,
    }).revision;
  else if (current.revision !== expectedRevision || sourceHash !== expectedSourceHash)
    throw new AppError(409, 'REVISION_CONFLICT');
  recordHelperTaskResult(workspace, task, {
    receiptId,
    operation: 'chat.variables.update',
    requestedTargets: 1,
    targets: changed
      ? [{ kind: 'settings', id: chatId, title: chat.title, revision, setting: 'chat.variables' }]
      : [],
  });
  return { changed, revision, sourceHash, set: Object.keys(set), unset };
}

function attachmentView(store: Store, ref: ContentAttachment) {
  let title: string | null = null;
  try {
    title = store.product.stored<Content>('content', ref.id).title;
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
  }
  return { id: ref.id, title, revision: ref.revision };
}

function readChatProfile(store: Store, chatId: string) {
  const profile = store.product.profile(chatId);
  const attached = profile.packageAttachments ?? [];
  const persona = attached.find((ref) => ref.role === 'persona');
  const bot = attached.find((ref) => ref.role === 'bot');
  return {
    chatId,
    profileRevision: profile.revision,
    bot: bot ? attachmentView(store, bot) : null,
    persona: persona ? attachmentView(store, persona) : null,
    modules: attached
      .filter((ref) => ref.role === 'module')
      .map((ref) => attachmentView(store, ref)),
    loreContext: profile.loreContext ?? null,
    authorNote: profile.authorNote ?? '',
  };
}

function attachable(
  store: Store,
  value: unknown,
  role: 'persona' | 'module',
  held: readonly ContentAttachment[]
): ContentAttachment {
  const id = text(value, `${role} ID`, 100);
  const content = attachableContent(store.product, { id, role }, held);
  if (content.kind !== role)
    throw new HttpError(400, `NOT_A_${role.toUpperCase()}: ${id} is a ${content.kind}.`);
  return { id: content.id, revision: content.revision, role };
}

function updateChatProfile(
  store: Store,
  workspace: HelperWorkspace,
  task: ResultTask,
  receiptId: string,
  chatId: string,
  args: Record<string, unknown>
) {
  fields(args, ['expectedRevision', 'persona', 'modules', 'loreContext', 'authorNote']);
  const expectedRevision = number(args.expectedRevision, 'profile revision', 0);
  const requested = ['persona', 'modules', 'loreContext', 'authorNote'].filter(
    (key) => args[key] !== undefined
  );
  if (!requested.length) throw new HttpError(400, 'Pass at least one change');
  const prior = store.product.profile(chatId);
  if (prior.revision !== expectedRevision) throw new AppError(409, 'REVISION_CONFLICT');
  const current = prior.packageAttachments ?? [];
  let packageAttachments: ContentAttachment[] | undefined;
  if (args.persona !== undefined || args.modules !== undefined) {
    if (args.modules !== undefined && !Array.isArray(args.modules))
      throw new HttpError(400, 'modules must be a list of module ids');
    packageAttachments = [
      ...current.filter((ref) => ref.role === 'bot'),
      ...(args.persona === undefined
        ? current.filter((ref) => ref.role === 'persona')
        : args.persona === null
          ? []
          : [attachable(store, args.persona, 'persona', current)]),
      ...(args.modules === undefined
        ? current.filter((ref) => ref.role === 'module')
        : (args.modules as unknown[]).map((id) => attachable(store, id, 'module', current))),
    ];
  }
  const keys = (refs: ContentAttachment[] | undefined) =>
    (refs ?? []).map((ref) => `${ref.role}:${ref.id}`);
  const unchanged =
    (packageAttachments === undefined ||
      isDeepStrictEqual(keys(packageAttachments), keys(prior.packageAttachments))) &&
    (args.loreContext === undefined ||
      isDeepStrictEqual(args.loreContext, prior.loreContext ?? null)) &&
    (args.authorNote === undefined || args.authorNote === (prior.authorNote ?? ''));
  if (unchanged) {
    recordHelperTaskResult(workspace, task, {
      receiptId,
      operation: 'chat.profile.update',
      requestedTargets: requested.length,
      targets: [],
    });
    return { changed: false, ...readChatProfile(store, chatId) };
  }
  const saved = store.product.updateProfile(chatId, {
    expectedRevision,
    image: prior.image,
    ...(packageAttachments ? { packageAttachments } : {}),
    ...(args.loreContext !== undefined ? { loreContext: args.loreContext } : {}),
    ...(args.authorNote !== undefined ? { authorNote: args.authorNote } : {}),
  });
  const chat = store.chat(chatId);
  const attachmentsChanged = !isDeepStrictEqual(
    keys(prior.packageAttachments),
    keys(saved.packageAttachments)
  );
  const loreChanged = !isDeepStrictEqual(prior.loreContext ?? null, saved.loreContext ?? null);
  const noteBefore = prior.authorNote ?? '';
  const noteAfter = saved.authorNote ?? '';
  const targets: HelperTaskResultTarget[] = [
    ...(attachmentsChanged ? ['chat.attachments'] : []),
    ...(loreChanged ? ['chat.loreContext'] : []),
  ].map((setting) => ({
    kind: 'settings' as const,
    id: chatId,
    title: chat.title,
    revision: saved.revision,
    setting,
  }));
  if (noteBefore !== noteAfter) {
    recordHelperAction(store, task, {
      domain: 'settings',
      targetId: `chat.authorNote:${chatId}`,
      chatId,
      title: chat.title,
      location: { kind: 'setting', setting: 'chat.authorNote' },
      action: 'update',
      anchor: { domain: 'settings', id: chatId, chatId, setting: 'chat.authorNote' },
      value: { before: noteBefore, after: noteAfter },
      diff: (baseline) => diffText(String(baseline ?? ''), noteAfter, 'prose'),
    });
    targets.push({ kind: 'chat', id: chatId, title: chat.title, revision: saved.revision });
  }
  recordHelperTaskResult(workspace, task, {
    receiptId,
    operation: 'chat.profile.update',
    requestedTargets: requested.length,
    targets,
  });
  return { changed: targets.length > 0, ...readChatProfile(store, chatId) };
}

function updateHelperSceneContext(
  store: Store,
  workspace: HelperWorkspace,
  task: ResultTask,
  receiptId: string,
  chatId: string,
  args: Record<string, unknown>
) {
  fields(args, ['sourceId', 'expectedRevision', 'sceneEnabled', 'requestEnabled', 'requestText']);
  const sourceId = text(args.sourceId, 'source ID', 100);
  const chat = store.chat(chatId);
  if (!store.history(chat.headRevision).some((item) => item.revision === sourceId))
    throw new HelperToolError(404, 'SCENE_NOT_IN_CHAT', 'Find the scene id with chat.read.');
  const before = readSceneContext(store.db, sourceId);
  const { sourceId: _sourceId, ...change } = args;
  const after = updateSceneContext(store, sourceId, change);
  const changed = after.revision !== before.revision;
  const title = sceneTitle(store, sourceId) || chat.title;
  if (changed) {
    const { revision: _before, ...beforeValue } = before;
    const { revision: _after, ...afterValue } = after;
    recordHelperAction(store, task, {
      domain: 'settings',
      targetId: `scene.context:${sourceId}`,
      chatId,
      title,
      location: { kind: 'setting', setting: 'scene.context' },
      action: 'update',
      anchor: { domain: 'scene', chatId, sourceId, field: 'original', paragraph: null },
      value: { before: beforeValue, after: afterValue },
      sourceId,
      diff: (baseline) => {
        const earlier = (baseline as { requestText?: string | null } | undefined)?.requestText;
        return (earlier ?? null) === after.requestText
          ? null
          : diffText(earlier ?? '', after.requestText ?? '', 'prose');
      },
    });
  }
  recordHelperTaskResult(workspace, task, {
    receiptId,
    operation: 'scene.context.update',
    requestedTargets: 1,
    targets: changed
      ? [{ kind: 'scene', id: sourceId, chatId, title, revision: after.revision }]
      : [],
  });
  return {
    changed,
    sourceId,
    contextRevision: after.revision,
    sceneEnabled: after.sceneEnabled,
    requestEnabled: after.requestEnabled,
    requestEdited: after.requestText !== null,
  };
}

function bookmarkView(bookmark: Bookmark) {
  return {
    id: bookmark.id,
    revision: bookmark.revision,
    title: bookmark.title,
    note: bookmark.note,
    sourceId: bookmark.target.sourceId,
    representation: bookmark.target.representation,
    createdAt: bookmark.createdAt,
  };
}

function receiptUuid(receiptId: string) {
  const hex = createHash('sha256').update(`bookmark:${receiptId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function changeBookmark(
  store: Store,
  workspace: HelperWorkspace,
  task: ResultTask,
  receiptId: string,
  chatId: string,
  args: Record<string, unknown>
) {
  const chat = store.chat(chatId);
  const report = (target: HelperTaskResultTarget) =>
    recordHelperTaskResult(workspace, task, {
      receiptId,
      operation: 'chat.bookmark',
      requestedTargets: 1,
      targets: [target],
    });
  if (args.action === 'add') {
    fields(args, ['action', 'sourceId', 'representation', 'title', 'note']);
    const sourceId = text(args.sourceId, 'source ID', 100);
    const saved = addBookmark(
      store,
      chatId,
      parseInput(personalWorkspaceOperations.addBookmark.input, {
        chatId,
        id: receiptUuid(receiptId),
        target: { sourceId, representation: args.representation ?? 'original' },
        title: args.title,
        note: args.note ?? '',
      })
    );
    report({ kind: 'scene', id: sourceId, chatId, title: saved.title, revision: saved.revision });
    return { changed: true, bookmark: bookmarkView(saved) };
  }
  if (args.action !== 'update' && args.action !== 'delete')
    throw new HelperToolError(400, 'INVALID_BOOKMARK_ACTION');
  fields(
    args,
    args.action === 'update'
      ? ['action', 'id', 'expectedRevision', 'title', 'note']
      : ['action', 'id', 'expectedRevision']
  );
  const id = text(args.id, 'bookmark ID', 100);
  const current = listBookmarks(store, chatId).find((bookmark) => bookmark.id === id);
  if (!current)
    throw new HelperToolError(
      404,
      'BOOKMARK_NOT_FOUND',
      'List the bookmarks of this chat with action=read.'
    );
  const keep = (after: { title: string; note: string } | null) =>
    recordHelperAction(store, task, {
      domain: 'settings',
      targetId: `chat.bookmark:${id}`,
      chatId,
      title: current.title,
      location: { kind: 'setting', setting: 'chat.bookmark' },
      action: after ? 'update' : 'delete',
      anchor: { domain: 'settings', id: chatId, chatId, setting: 'chat.bookmark' },
      value: { before: { title: current.title, note: current.note }, after },
      diff: (baseline) => {
        const earlier = baseline as { title: string; note: string } | undefined;
        const text = (value: { title: string; note: string } | null | undefined) =>
          value ? `${value.title}\n\n${value.note}` : '';
        return diffText(text(earlier), text(after), 'prose');
      },
    });
  if (args.action === 'delete') {
    deleteBookmark(
      store,
      parseInput(personalWorkspaceOperations.deleteBookmark.input, {
        id,
        expectedRevision: args.expectedRevision,
      })
    );
    keep(null);
    report({ kind: 'chat', id: chatId, title: chat.title, revision: current.revision });
    return { changed: true, deleted: id };
  }
  const saved = updateBookmark(
    store,
    parseInput(personalWorkspaceOperations.updateBookmark.input, {
      id,
      expectedRevision: args.expectedRevision,
      title: args.title ?? current.title,
      note: args.note ?? current.note,
    })
  );
  keep({ title: saved.title, note: saved.note });
  report({
    kind: 'scene',
    id: current.target.sourceId,
    chatId,
    title: saved.title,
    revision: saved.revision,
  });
  return { changed: true, bookmark: bookmarkView(saved) };
}
