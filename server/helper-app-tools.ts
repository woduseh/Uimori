import { HELPER_PRESENTATION_TOOLS, presentationReadOnly } from './helper-presentation-tools.js';
import type { Json, ProviderTool } from '../core/transport.js';
import { SOURCE_TEXT_MAX_CHARS } from '../core/content-limits.js';
import { RESOURCE_TOOLS, helperResourceOperation } from './helper-resource-tools.js';
import { HELPER_SETTINGS_TOOLS } from './helper-settings-tools.js';
import { HELPER_GUIDE_TOOLS } from './helper-guide-tools.js';
import { HELPER_CODE_TOOLS } from './helper-code-tools.js';
import {
  HELPER_VERTEX_LOCATION_TOOLS,
  isVertexLocationTool,
} from './helper-vertex-location-tools.js';
import { HELPER_TASK_TOOLS } from './helper-task-tools.js';
import { HELPER_DATA_TOOLS } from './helper-data-tools.js';
import { HELPER_SCENE_TOOLS } from './helper-scene-tools.js';
import { HELPER_CHAT_STATE_TOOLS } from './helper-chat-state-tools.js';
import { HELPER_CHAT_ORGANIZATION_TOOLS } from './helper-chat-organization-tools.js';
import { HELPER_CHAT_LIFECYCLE_TOOLS } from './helper-chat-lifecycle-tools.js';
import { HELPER_PROMPT_COMBINATION_TOOLS } from './helper-prompt-combination-tools.js';
import { helperConfirmationTrait } from './helper-confirmation-traits.js';
import { HELPER_STORY_TOOLS } from './helper-story-tools.js';
import { HELPER_IMAGE_TOOLS } from './helper-image-tools.js';
import { HELPER_ILLUSTRATION_TOOLS } from './helper-illustration-workflow.js';
import { helperOptionTools } from './chat-options.js';
import { MAIN_READ_TOOLS } from '../core/read-tools.js';
import { STORY_READ_TOOLS } from '../core/story-read-tools.js';
import { HttpError } from './request-validation.js';
import { countTextTokens } from '../core/text-tokens.js';

const schema = (
  properties: Record<string, Json>,
  required: string[] = [],
  examples?: Json[]
): Json => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
  ...(examples ? { examples } : {}),
});
const str: Json = { type: 'string' },
  integer: Json = { type: 'integer', minimum: 1 },
  revision: Json = { type: 'integer', minimum: 0 },
  itemId: Json = { type: 'string', minLength: 1, maxLength: 100 };
const described = (value: Json, description: string): Json => ({
  ...(value as Record<string, Json>),
  description,
});
const resultOffset: Json = {
  type: 'integer',
  minimum: 0,
  description: 'Entry offset. Pass the previous nextOffset.',
};
const textOffset: Json = {
  type: 'integer',
  minimum: 0,
  description: 'Start position inside a long text, in UTF-16 code units.',
};
const textLimit: Json = {
  type: 'integer',
  minimum: 1,
  maximum: 10000,
  description: 'Maximum text to return, in UTF-16 code units.',
};
const HELPER_READ_WORDING: Record<string, [from: string, to: string]> = {
  'knowledge.search': [
    'approved for this run when the catalog does not already identify the id you need. Known ids go straight to knowledge.read.',
    "of this chat's bot, persona and modules as frozen for this task. For live library text and other chats, data.search is the general search.",
  ],
  'knowledge.read': [
    'Ids come from the catalog in the input or from knowledge.search, so a catalog id needs no search first.',
    'Ids come from knowledge.search.',
  ],
  'skills.list': [
    'Use it when the request may be covered by a guide that the catalog does not already name.',
    'Use it when the request may be covered by a writing guide.',
  ],
  'skills.load': ['from skills.list or the catalog', 'from skills.list'],
};
export const HELPER_WRITING_READ_TOOLS: ProviderTool[] = MAIN_READ_TOOLS.map((tool) => {
  const wording = HELPER_READ_WORDING[tool.name];
  if (!wording) return tool;
  if (!tool.description.includes(wording[0]))
    throw new Error(`HELPER_READ_WORDING_STALE: ${tool.name}`);
  return { ...tool, description: tool.description.replace(wording[0], wording[1]) };
});
const STORY_READ_NAMES = new Set(STORY_READ_TOOLS.map((tool) => tool.name));
const loreSelector = described(
  schema(
    {
      id: { type: 'string', minLength: 1, maxLength: 64 },
      role: { type: 'string', enum: ['bot', 'persona', 'module'] },
      modulePath: {
        type: 'array',
        maxItems: 20,
        items: { type: 'string', minLength: 1, maxLength: 64 },
      },
      loreId: { type: 'string', minLength: 1, maxLength: 64 },
      field: { type: 'string', enum: ['title', 'description', 'text'] },
    },
    ['id', 'role', 'modulePath', 'loreId', 'field']
  ),
  'One lore field of one entry. Build it from a listed item: id, role and modulePath from item.scope, item.id as loreId, and the field to address.'
);
const loreChange = schema(
  {
    selector: loreSelector,
    expectedRevision: revision,
    expectedHeadRevision: { type: ['string', 'null'], maxLength: 100 },
    expectedProfileRevision: integer,
    expectedPackageRevision: integer,
    expectedFieldHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    value: {
      type: 'string',
      maxLength: SOURCE_TEXT_MAX_CHARS,
      description: 'patch: the complete override text for the field.',
    },
  },
  ['selector', 'expectedRevision', 'expectedHeadRevision']
);
const TOOLS: ProviderTool[] = [
  ...HELPER_GUIDE_TOOLS,
  ...RESOURCE_TOOLS,
  ...HELPER_CODE_TOOLS,
  ...HELPER_PRESENTATION_TOOLS,
  ...HELPER_SETTINGS_TOOLS,
  ...HELPER_VERTEX_LOCATION_TOOLS,
  ...HELPER_TASK_TOOLS,
  ...HELPER_SCENE_TOOLS,
  ...HELPER_CHAT_STATE_TOOLS,
  ...HELPER_CHAT_ORGANIZATION_TOOLS,
  ...HELPER_CHAT_LIFECYCLE_TOOLS,
  ...HELPER_PROMPT_COMBINATION_TOOLS,
  ...HELPER_STORY_TOOLS,
  ...HELPER_IMAGE_TOOLS,
  ...HELPER_ILLUSTRATION_TOOLS,
  {
    name: 'helper.ask',
    description:
      'Show the user a short multiple-choice question card when a material ambiguity cannot be resolved from the workspace. Pass one concise question and 2 to 5 distinct options. Do not use this for routine choices you can decide yourself, or for confirmations handled by CONFIRMATION_REQUIRED. After calling helper.ask, end the turn so the user can pick an option in the UI.',
    inputSchema: schema(
      {
        question: {
          type: 'string',
          minLength: 1,
          maxLength: 500,
          description: 'One concise question for the user.',
        },
        options: {
          type: 'array',
          minItems: 2,
          maxItems: 5,
          description: '2 to 5 distinct answer choices.',
          items: schema(
            {
              label: {
                type: 'string',
                minLength: 1,
                maxLength: 120,
                description: 'Short label shown on the option button.',
              },
              description: {
                type: 'string',
                maxLength: 240,
                description: 'Optional brief explanation of this choice.',
              },
            },
            ['label']
          ),
        },
        allowFreeform: {
          type: 'boolean',
          description:
            'Whether the user may also write a custom reply in the composer. Default true.',
        },
      },
      ['question', 'options']
    ),
  },
  {
    name: 'chat.list',
    description:
      'Find saved chats by title, to get the chatId that chat operations take. Returns the id, title, headRevision, titleRevision and last activity of each chat in pages; follow nextOffset. The settings of a chat are in settings.read and its scenes in chat.read.',
    inputSchema: schema({
      query: {
        type: 'string',
        maxLength: 200,
        description: 'Text that the chat title must contain. Omit to list all chats.',
      },
      offset: resultOffset,
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        description: 'Maximum chats per page. Default 20.',
      },
    }),
  },
  {
    name: 'chat.read',
    description:
      'Read the scene index of a chat: its current head and, for each scene, the id (sourceId), visible sceneNumber, original length, whether the scene and its request are enabled, the contextRevision that scene.context.update needs, the editRevision of its original, its translation state (none, current, stale after an original edit, or pending), and the saved name (title, when it has one). Use it to find the sourceId of a scene before reading or editing it. Scene numbers count the enabled scenes from 1, starting with any introduction, and a hidden scene has sceneNumber null. order=newest lists the latest scenes first. includePreview adds the opening of each original, about 60 tokens, and includeRequest the user request that produced each scene (null when the request is turned off), about 200 tokens at most. Follow nextOffset for more scenes. The text of a scene comes from scene.read; source.writing.chat.latestScene already describes the latest one.',
    inputSchema: schema({
      chatId: itemId,
      order: {
        type: 'string',
        enum: ['oldest', 'newest'],
        description: 'oldest (default) is story order; newest starts from the latest scene.',
      },
      includePreview: {
        type: 'boolean',
        description: 'Add a short preview of each original. Default false.',
      },
      includeRequest: {
        type: 'boolean',
        description: 'Add the request text of each scene. Default false.',
      },
      offset: described(resultOffset, 'Scene offset. Pass the previous nextOffset.'),
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        description: 'Maximum scenes per page.',
      },
    }),
  },
  ...helperOptionTools,
  {
    name: 'chat.lore',
    description:
      'Read or change the chat-only lore overrides of a chat: a private version of one lore field (title, description or text) that applies in this chat only and leaves the shared library entry as it is. action=read without selector lists the lore items in pages, optionally only those whose title or text contains query. action=read with selector returns the shared original and the override of that field in text pages. action=patch saves body.value as the override; action=patchMany saves 1-16 overrides together or none; action=remove deletes the override so the shared original applies again. The guards a change needs are already in the list: expectedRevision, expectedHeadRevision and expectedProfileRevision from its top level, and for each item expectedPackageRevision from packageRevision and expectedFieldHash from fieldHashes[field], so read the field itself only when its full text is needed. An item whose original no longer exists is listed with originalMissing and read as original:null, and its override can still be removed. To change the shared entry for every chat, edit the library resource with resource.patch instead.',
    inputSchema: schema(
      {
        action: {
          type: 'string',
          enum: ['read', 'patch', 'patchMany', 'remove'],
          description:
            'read lists items or reads one field; patch saves an override; patchMany saves several; remove deletes one.',
        },
        selector: {
          type: 'object',
          description:
            'read: the one lore field to read, in the same form as body.selector. Omit to list items.',
        },
        query: {
          type: 'string',
          maxLength: 200,
          description: 'read without selector: only items whose title or text contains this.',
        },
        offset: resultOffset,
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: 'read without selector: maximum items per page.',
        },
        textOffset,
        textLimit,
        body: described(
          loreChange,
          'patch and remove: the change, with the selector and the expected* guards, and value for patch.'
        ),
        items: {
          type: 'array',
          minItems: 1,
          maxItems: 16,
          description:
            'patchMany: one change per field, each with the fields of body and a value; all take the same expectedRevision and the host applies them in order.',
          items: { type: 'object', description: 'One change with the fields of body.' },
        },
      },
      ['action']
    ),
  },
  {
    name: 'editor.read',
    description:
      'Read what the user has open in the editor, as captured when this request was sent, including changes that are not saved yet. Use it for the structure and exact typed values of the draft; for ordinary facts in it, data.search with scope=editor is shorter. Without path it returns a compact overview. Follow a returned JSON Pointer path for a field, object or array, and page with fields, offset/limit or textOffset/textLimit. inputOrigin tells whether the content is the saved revision or an unsaved draft. This never saves the draft, and a later saved version is not substituted. To change the resource, patch its saved revision with guards and paths from resource.read: unsaved indexes and text can differ from the saved ones, and the user reconciles the draft with your save in the editor. Images in the editor are not interpreted.',
    inputSchema: schema({
      path: described(
        str,
        'JSON Pointer of the field, object or array to read, from the overview or an earlier result. Omit for the overview.'
      ),
      fields: {
        type: 'array',
        items: str,
        maxItems: 50,
        description: 'Names of the object fields to return at path.',
      },
      offset: resultOffset,
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        description: 'Maximum array or object entries per page.',
      },
      textOffset,
      textLimit,
    }),
  },
  {
    name: 'chat.rename',
    description:
      'Change the title of a chat. expectedRevision is the titleRevision of that chat: source.writing.chat has it for the current chat, and chat.list for any chat.',
    inputSchema: schema(
      {
        title: described(str, 'The new chat title.'),
        expectedRevision: {
          type: 'integer',
          minimum: 0,
          description: 'titleRevision from source.writing.chat or chat.list.',
        },
      },
      ['title', 'expectedRevision']
    ),
  },
  {
    name: 'chat.fork',
    description:
      'Create a new chat that branches off from an earlier scene of the story of this chat. Only the story up to the chosen scene is copied; this helper conversation and any drafts are not. The original chat is left unchanged.',
    inputSchema: schema(
      {
        sourceId: described(
          str,
          'Id of the scene to branch from, from chat.read or the story tools.'
        ),
        title: described(str, 'Title of the new chat. Optional.'),
      },
      ['sourceId']
    ),
  },
  {
    name: 'library.organize',
    description:
      'Organize the library into folders: read the folder tree, create, rename, reorder or remove a folder, or move bots, personas, modules and prompt presets into a folder. action=read returns the folders and the revision. The other actions need body with that revision as expectedRevision and the category: create-folder takes body.title; move takes body.items and body.folderId, where null moves the items to the top of the category; update-folder takes body.folderId with body.title and/or body.beforeFolderId (null for last); delete-folder takes body.folderId and moves its items to the top of the category, deleting no item.',
    inputSchema: schema(
      {
        action: {
          type: 'string',
          enum: ['read', 'create-folder', 'update-folder', 'delete-folder', 'move'],
          description: 'read the folder tree, change a folder, or move items.',
        },
        body: described(
          schema(
            {
              expectedRevision: described(integer, 'Folder revision from action=read.'),
              category: {
                type: 'string',
                enum: ['bot', 'persona', 'module', 'prompts'],
                description: 'Library category the folder or the items belong to.',
              },
              title: {
                type: 'string',
                minLength: 1,
                maxLength: 200,
                description: 'create-folder: name of the new folder. Omit for move.',
              },
              items: {
                type: 'array',
                minItems: 1,
                maxItems: 1000,
                description: 'move: the items to move.',
                items: schema(
                  {
                    kind: {
                      type: 'string',
                      enum: ['content', 'prompt-preset'],
                      description:
                        'content is a bot, persona or module; prompt-preset a prompt preset.',
                    },
                    id: itemId,
                  },
                  ['kind', 'id']
                ),
              },
              folderId: {
                type: ['string', 'null'],
                maxLength: 100,
                description:
                  'move: the destination folder, or null for the top of the category. update-folder and delete-folder: the folder to change.',
              },
              beforeFolderId: {
                type: ['string', 'null'],
                maxLength: 100,
                description: 'update-folder: place the folder before this one, or null for last.',
              },
            },
            ['expectedRevision', 'category']
          ),
          'Required for create-folder and move.'
        ),
      },
      ['action'],
      [
        {
          action: 'move',
          body: {
            expectedRevision: 1,
            category: 'bot',
            items: [{ kind: 'content', id: '<item-id>' }],
            folderId: null,
          },
        },
      ]
    ),
  },
  {
    name: 'context.read',
    description:
      'Read the live context state of a chat: the conversation summary that stands in for its older scenes (summary), its author notes (notes), and its original-work reference settings (storyGuide), together with activeRevision for context.compact and context.edit, notesRevision for notes.write and storyGuide.revision for chat.guide.update. sections picks what to return; the revisions always come back. source.writing.chat already holds these revisions and source.writing.notes the notes as of the task start, so read this only for the summary text or after a change. The summary covers only the first checkpoint.plan.compactedScenes scenes; read newer scenes with chat.read and scene.read before stating the latest situation.',
    inputSchema: schema({
      sections: {
        type: 'array',
        minItems: 1,
        items: { type: 'string', enum: ['summary', 'notes', 'storyGuide'] },
        description: 'Parts to return. Default all three.',
      },
      includeCompacted: {
        type: 'boolean',
        description: 'Add the reference list of the summarized scenes. Default false.',
      },
    }),
  },
  {
    name: 'context.compact',
    description:
      'Summarize the older scenes of the chat into its conversation summary now, using the regular compaction of the app. expectedRevision is the activeRevision that context.read returns.',
    inputSchema: schema(
      {
        expectedRevision: {
          type: 'integer',
          minimum: 0,
          description:
            'activeRevision from context.read. It is the revision of the chat context, not checkpoint.revision.',
        },
      },
      ['expectedRevision']
    ),
  },
  {
    name: 'context.edit',
    description:
      'Replace the text of the active conversation summary of a chat, for example to correct a fact it states wrongly. The summary is what the writer sees in place of the older scenes, so keep names, facts and who did what exact. expectedRevision is the activeRevision that context.read returns.',
    inputSchema: schema(
      {
        expectedRevision: {
          type: 'integer',
          minimum: 0,
          description:
            'activeRevision from context.read. It is the revision of the chat context, not checkpoint.revision.',
        },
        summary: described(str, 'The complete new summary text.'),
      },
      ['expectedRevision', 'summary']
    ),
  },
  {
    name: 'outline.read',
    description:
      'Read the plot outline (composition) of a chat in bounded pages: the tree of themes, main story, arcs, episodes and beats, each with a writing intent. mode=overview (default) lists the items with metadata and short intent previews, and focusId names the item the story is currently in, which ordinary requests receive as orientation (null when none). mode=subtree returns the items under nodeId, limited by depth. mode=detail reads one section of one item: intent (default) is the full writing brief in text pages, related lists the linked plans, and writings lists the scenes written for the item and its subtree as data.read refs. Later pages need the expectedVersion of the first page: copy nextRead unchanged, and after OUTLINE_CHANGED start that read again. Switching mode or section starts a new read with its own version. An overview preview is not the full intent; coverage.wholeField means this one response contains the entire intent, and nextOffset null means the last page. A writings reference shows where text was written, not that the plan was fulfilled.',
    inputSchema: schema({
      mode: {
        type: 'string',
        enum: ['overview', 'subtree', 'detail'],
        description: 'overview (default), subtree of nodeId, or detail of nodeId.',
      },
      nodeId: described(itemId, 'Outline item to read. Required for subtree and detail.'),
      depth: {
        type: 'integer',
        minimum: 0,
        maximum: 4,
        description:
          'subtree only: 0 returns the item alone, 1 adds its direct children. Omit for all descendants.',
      },
      section: {
        type: 'string',
        enum: ['intent', 'related', 'writings'],
        description: 'detail only: which section to read. Default intent.',
      },
      offset: {
        type: 'integer',
        minimum: 0,
        description:
          'Page offset: an item offset for lists, or a UTF-16 position inside intent text.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 10000,
        description:
          'Page size: items for lists (default 20, at most 50), or UTF-16 code units for intent text (at most 10000; omit for about 3000 tokens).',
      },
      expectedVersion: {
        type: 'string',
        maxLength: 64,
        description: 'Version from the first page of this read. Copying nextRead supplies it.',
      },
    }),
  },
  {
    name: 'outline.write',
    description:
      'Create, update, move or remove items of the plot outline of a chat, as one atomic batch. A whole tree can be built in one call: give each new item a ref and name its parent with parentRef, listing a parent before its children. update, move and remove need the current revision of the item as expectedRevision. relatedIds link other plans of the same chat; read the ids before linking them. fixed marks an item the author wants kept when the outline is elaborated; it does not lock the item against edits the user asks for. An item whose text is being generated right now cannot be edited until that finishes. This changes the outline only: it writes no story prose and never marks anything as written. The result is a short receipt of what was applied, with the revision each operation produced, not the whole tree. If a call ends without a clear result, read the outline before trying again, because repeating a create would add the items twice.',
    inputSchema: schema(
      {
        operations: {
          type: 'array',
          minItems: 1,
          maxItems: 200,
          description: 'Operations applied in order; all of them save or none does.',
          items: {
            type: 'object',
            properties: {
              op: {
                type: 'string',
                enum: ['create', 'update', 'move', 'remove'],
                description: 'What to do with the item.',
              },
              ref: described(
                str,
                'create: a temporary name for the new item, so later operations in this call can use it as parentRef.'
              ),
              parentRef: described(str, 'Parent created earlier in this call, by its ref.'),
              parentId: {
                type: ['string', 'null'],
                description: 'Id of an existing parent item, or null for the top level.',
              },
              level: {
                type: 'string',
                enum: ['theme', 'mainStory', 'arc', 'episode', 'beat'],
                description:
                  'create: kind of the new item. update: change the kind; it must stay smaller than its parent and larger than its children.',
              },
              title: described(str, 'Title of the item.'),
              intent: described(str, 'The writing brief of the item: what it should achieve.'),
              position: {
                type: 'integer',
                minimum: 0,
                description: 'Index among the siblings under the parent.',
              },
              id: described(str, 'update, move, remove: id of the existing item.'),
              expectedRevision: {
                type: 'integer',
                minimum: 1,
                description:
                  'update, move, remove: current revision of the item, from outline.read.',
              },
              fixed: {
                type: 'boolean',
                description:
                  'create, update: mark the item as one the author wants kept during elaboration.',
              },
              relatedIds: {
                type: 'array',
                maxItems: 40,
                items: str,
                description: 'Ids of other plans in the same chat that this item relates to.',
              },
            },
            required: ['op'],
            additionalProperties: false,
          },
        },
      },
      ['operations']
    ),
  },
  {
    name: 'notes.write',
    description:
      'Save, replace or retire an author note of a chat: a fact, correction or standing instruction from the user that later writing must respect. Take notesRevision as body.expectedRevision from source.writing.chat for the current chat, from context.read, or from the previous notes.write result. body.text alone adds a note; with replacesId it replaces that note; replacesId with retired:true and no text retires it. The position in the chat, the source anchor and the attribution to the user are filled in by the app.',
    inputSchema: schema(
      {
        body: described(
          schema(
            {
              expectedRevision: described(
                revision,
                'notesRevision from source.writing.chat or context.read.'
              ),
              text: {
                type: 'string',
                minLength: 1,
                maxLength: 32000,
                description: 'Text of the new or replacing note.',
              },
              replacesId: described(itemId, 'Id of the existing note to replace or retire.'),
              retired: {
                type: 'boolean',
                enum: [true],
                description: 'With replacesId and no text: retire that note.',
              },
            },
            ['expectedRevision']
          ),
          'The note change: add, replace or retire.'
        ),
      },
      ['body'],
      [{ body: { expectedRevision: 0, text: 'The harbor closes at sunset.' } }]
    ),
  },
  {
    name: 'artifact.read',
    description:
      'Read a saved artifact at an exact revision: a hypothetical scene that was generated outside the played story, or the request that produced it. An artifact is not a story event that happened, and a reference to one does not mean its text was read. Text comes in pages; follow nextOffset for the rest.',
    inputSchema: schema(
      {
        id: described(str, 'Artifact id.'),
        revision: described(integer, 'Exact artifact revision to read.'),
        field: {
          type: 'string',
          enum: ['text', 'request'],
          description:
            'text (default) is the hypothetical scene; request is the generation request.',
        },
        offset: textOffset,
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 10000,
          description:
            'Maximum text to return, in UTF-16 code units. Omit to read up to about 2000 tokens.',
        },
      },
      ['id', 'revision']
    ),
  },
];
const chatToolNames = new Set([
  'settings.read',
  'settings.update',
  'chat.read',
  'chat.lore',
  'chat.rename',
  'chat.fork',
  'illustration.image.list',
  'illustration.image.read',
  ...HELPER_ILLUSTRATION_TOOLS.map((tool) => tool.name),
  ...HELPER_SCENE_TOOLS.map((tool) => tool.name),
  ...HELPER_CHAT_STATE_TOOLS.map((tool) => tool.name),
  ...HELPER_STORY_TOOLS.map((tool) => tool.name),
  'outline.read',
  'outline.write',
  'context.read',
  'context.edit',
  'context.compact',
  'notes.write',
  ...helperOptionTools.map((tool) => tool.name),
  ...MAIN_READ_TOOLS.map((tool) => tool.name),
]);
const dataToolNames = new Set(HELPER_DATA_TOOLS.map((tool) => tool.name));
const writingReadNames = new Set(MAIN_READ_TOOLS.map((tool) => tool.name));
const readNames = new Set([
  'illustration.profiles.read',
  'illustration.continuity.read',
  'illustration.cuts.list',
  'illustration.scene.read',
  'illustration.cut.read',
  ...HELPER_IMAGE_TOOLS.map((tool) => tool.name),
  ...HELPER_CODE_TOOLS.map((tool) => tool.name),
  'data.exec',
  ...dataToolNames,
  ...writingReadNames,
  'settings.read',
  'usage.read',
  'model.list',
  'model.pricing.read',
  'model.parameters.read',
  'vertex.location.read',
  'task.inspect',
  'task.list',
  'app.tools',
  'guide.read',
  'helper.ask',
  'web.search',
  'editor.read',
  'chat.list',
  'chat.read',
  'context.read',
  'outline.read',
  'options.read',
  'prompt.combination.list',
  'artifact.read',
  'scene.read',
  'scene.search',
  'scene.versions',
  'scene.lore',
  'chat.preview',
  'chat.variables.read',
  'chat.profile.read',
]);
const conditionalNames = new Set([
  'chat.lore',
  'library.organize',
  'chat.bookmark',
  'chat.organize',
]);
const writingNames = new Set([
  ...writingReadNames,
  'chat.fork',
  'context.edit',
  'context.compact',
  'notes.write',
]);
export function helperToolTraits(name: string, args: Record<string, unknown> = {}) {
  const data = dataToolNames.has(name);
  const writingRead = writingReadNames.has(name);
  const readOnly = !!(
    helperResourceOperation(name, args)?.readOnly ||
    readNames.has(name) ||
    presentationReadOnly(name) ||
    (conditionalNames.has(name) && args.action === 'read')
  );
  return {
    readOnly,
    confirmation: helperConfirmationTrait(name),
    effect: (conditionalNames.has(name) && args.action === undefined
      ? 'mixed'
      : readOnly
        ? 'read'
        : 'write') as 'read' | 'write' | 'mixed',
    reviewAllowed:
      data ||
      name === 'app.tools' ||
      name === 'outline.read' ||
      name === 'web.search' ||
      name === 'guide.read' ||
      writingRead,
    direct:
      name === 'helper.ask' ||
      name === 'web.search' ||
      name === 'guide.read' ||
      name === 'image.list' ||
      name === 'image.read' ||
      name === 'data.exec' ||
      HELPER_PRESENTATION_TOOLS.some((tool) => tool.name === name) ||
      data ||
      HELPER_SETTINGS_TOOLS.some((tool) => tool.name === name) ||
      name === 'chat.organize' ||
      name === 'chat.create' ||
      name === 'chat.delete' ||
      isVertexLocationTool(name) ||
      name.startsWith('task.'),
    writingRead,
    writing:
      writingNames.has(name) ||
      (name === 'outline.read' && args.mode === 'detail' && args.section === 'writings'),
  };
}

export const HELPER_APP_TOOLS: ProviderTool[] = [
  ...TOOLS,
  ...HELPER_WRITING_READ_TOOLS,
  ...HELPER_DATA_TOOLS,
].map((tool) => {
  if (!chatToolNames.has(tool.name)) return tool;
  const input = tool.inputSchema as Record<string, Json>;
  return {
    ...tool,
    inputSchema: {
      ...input,
      properties: {
        ...(input.properties as Record<string, Json>),
        chatId: described(itemId, 'Chat to act on. Omit for the current chat.'),
      },
    },
  };
});

export const HELPER_OPERATION_AREAS: readonly (readonly [area: string, purpose: string])[] = [
  ['data', 'search and read text in the library, chats, editor input and this conversation'],
  ['resource', 'saved bots, personas, modules, prompt presets and themes'],
  [
    'code',
    'check the Risu CBS, Lua, trigger and regex code of bots, modules and prompt presets, trace regex scripts and preview first messages',
  ],
  [
    'chat',
    'chat list, new chats, deleting chats, scene index, title, fork, chat-only lore, next request preview, Risu variables, original-work reference settings, attached persona and modules, author note, bookmarks, chat folders and pins of a bot',
  ],
  [
    'scene',
    'saved story scenes, their names and translations, hiding a scene or its request, the lore used to write them, and requests for the next scene or a translation',
  ],
  ['story', 'frozen story history of this task'],
  ['knowledge', 'frozen writing references of this task'],
  ['skills', 'writing guidance'],
  ['outline', 'plot outline and writing plans'],
  ['context', 'conversation summary'],
  ['notes', 'author notes'],
  ['options', 'writing options of a chat'],
  ['prompt', 'saved option presets of the writing and translation prompts'],
  ['editor', 'captured editor input'],
  ['artifact', 'hypothetical scenes'],
  ['db', 'read-only SQL'],
  ['settings', 'models, prompts, automatic translation, chat settings and new chat defaults'],
  ['model', 'saved models: register, delete, generation parameters and pricing'],
  ['vertex', 'Google Vertex AI request locations'],
  ['usage', 'cost and tokens'],
  ['task', 'runs and background jobs'],
  ['image', 'saved content images'],
  ['illustration', 'illustrations, cuts, appearance profiles and references'],
  ['illustration-preset', 'illustration presets and which one is selected'],
  ['preset', 'prompt preset checks'],
  ['library', 'folders'],
  ['theme', 'themes'],
  ['palette', 'color palettes'],
  ['font', 'fonts'],
  ['helper', 'ask the user a short multiple-choice question card'],
  ['guide', "Uimori's user guides: how the app and its features behave"],
];
const operationArea = (name: string) => name.slice(0, name.indexOf('.'));
const areaRank = new Map(HELPER_OPERATION_AREAS.map(([area], index) => [area, index]));
const byArea = (a: ProviderTool, b: ProviderTool) =>
  (areaRank.get(operationArea(a.name)) ?? areaRank.size) -
  (areaRank.get(operationArea(b.name)) ?? areaRank.size);
function operationIndex(tools: readonly ProviderTool[]): string {
  return HELPER_OPERATION_AREAS.flatMap(([area, purpose]) => {
    const names = tools
      .filter((tool) => operationArea(tool.name) === area)
      .map((tool) => tool.name.slice(area.length + 1));
    return names.length ? [`${area} (${purpose}): ${names.join(', ')}`] : [];
  }).join('; ');
}

const REVIEW_APP_TOOLS = HELPER_APP_TOOLS.filter(
  (tool) => helperToolTraits(tool.name).reviewAllowed
);
const APPLY_APP_TOOLS = HELPER_APP_TOOLS.filter((tool) => !STORY_READ_NAMES.has(tool.name));
const availableAppTools = (review: boolean) => (review ? REVIEW_APP_TOOLS : APPLY_APP_TOOLS);

export const HELPER_KNOWN_OPERATION_LIMIT = 6;
export const HELPER_KNOWN_OPERATION_MAX_TOKENS = 5_000;
export function knownHelperOperations(
  names: readonly string[],
  review: boolean,
  maxTokens: number
): ProviderTool[] {
  const allowed = availableAppTools(review);
  const known: ProviderTool[] = [];
  let tokens = 0;
  for (const name of names) {
    if (known.length >= HELPER_KNOWN_OPERATION_LIMIT) break;
    const tool = allowed.find((item) => item.name === name);
    if (!tool || known.includes(tool)) continue;
    const size = countTextTokens(JSON.stringify(tool));
    if (tokens + size > maxTokens) continue;
    known.push(tool);
    tokens += size;
  }
  return known;
}

const gatewayTools = (review: boolean): ProviderTool[] => {
  const allowed = availableAppTools(review);
  return [
    {
      name: 'app.tools',
      description: `Look up Uimori app operations: what each one does and its exact argument schema. Operations run through app.call. Pass names for the schemas of operations you can already name from the list below, for example ${review ? '["outline.read","story.read"]' : '["resource.read","resource.patch"]'}. Pass query, an English purpose such as ${review ? '"read outline intent"' : '"edit lorebook entry"'} or an exact operation name, for ranked candidates with complete schemas (3 by default; limit and offset page them). A ranked candidate is only a lexical match, so read its description before relying on it. Pass neither to page through a compact catalog without schemas. ${
        review
          ? 'During this review only read-only operations are available. '
          : 'A schema you have already seen can be reused without looking it up again. '
      }Operations by area, written as area.operation: ${operationIndex(allowed)}.`,
      inputSchema: schema(
        {
          names: {
            type: 'array',
            minItems: 1,
            items: str,
            description: 'Exact operation names whose descriptions and schemas to return.',
          },
          query: described(
            str,
            'An English purpose or one exact operation name. Not combined with names.'
          ),
          offset: resultOffset,
          limit: {
            type: 'integer',
            minimum: 1,
            description: 'Maximum entries: 3 by default for a query, 20 for the catalog.',
          },
        },
        [],
        [{ names: ['outline.read'] }]
      ),
    },
    {
      name: 'app.call',
      description: review
        ? 'Run one read-only outline, story or reference operation by its exact name, with arguments that follow its schema from app.tools. Saving is not available during a review. Keep the versions and coverage fields that results return, and copy a returned nextRead unchanged to continue a read.'
        : 'Run one Uimori app operation by its exact name, with arguments that follow its schema from app.tools. Read operations return data with continuation fields such as nextOffset, nextIndex or a ready nextRead. Operations that save return a receipt with the new revision, so rereading only to confirm a successful save is unnecessary. A failed call returns an error code and says whether to correct the arguments, refresh and retry, or stop.',
      inputSchema: schema(
        {
          name: described(
            str,
            `Exact operation name, such as ${review ? 'outline.read' : 'resource.read'}.`
          ),
          arguments: {
            type: 'object',
            description: 'Arguments object of that operation. Use {} when it takes none.',
          },
        },
        ['name', 'arguments'],
        [{ name: 'outline.read', arguments: { mode: 'overview', limit: 5 } }]
      ),
    },
  ];
};
export const HELPER_GATEWAY_TOOLS: ProviderTool[] = gatewayTools(false);
const REVIEW_GATEWAY_TOOLS: ProviderTool[] = gatewayTools(true);
export function helperGatewayTools(review: boolean): ProviderTool[] {
  return review ? REVIEW_GATEWAY_TOOLS : HELPER_GATEWAY_TOOLS;
}

const discoveryTerms: Record<string, string> = {
  'resource.read':
    'shared library inspect open view show character card bot persona module lorebook lore entry greeting system prompt preset 기본 외형 프로필 라이브러리',
  'resource.patch':
    'shared library save edit change update modify fix rename character card bot persona module lorebook lore entry greeting system prompt preset 기본 외형 프로필 라이브러리',
  'data.search': 'find grep locate lookup text anywhere across all chats library',
  'code.cbs': 'syntax template macro braces getvar setvar check lint CBS 문법 검사',
  'code.references':
    'where used usage variable toggle unused undefined cross reference 변수 토글 사용처',
  'code.diagnose':
    'lint validate check errors problems bugs broken compatibility unsupported Lua trigger regex lore asset 오류 진단 호환',
  'code.regex': 'regular expression test try replace script stage output display 정규식 테스트',
  'code.preview': 'render first message greeting how it looks display toggle 첫 메시지 미리보기',
  'scene.search': 'find locate typo phrase manuscript prose',
  'scene.read': 'open view show manuscript prose text',
  'scene.patch': 'fix correct typo edit change manuscript prose rewrite',
  'settings.update': 'switch select choose model prompt preset',
  'task.inspect': 'why failed failure error diagnose',
  'image.read': 'view see show open picture',
  'illustration.image.read': 'view see show open picture',
  'illustration.cut.read': 'view see show open picture',
  'chat.read': 'scene list index',
  'chat.preview':
    'prompt request assembled debug why ignored missing check context token limit 프롬프트 미리보기',
  'scene.lore': 'lorebook entries used delivered activated last scene why missing 로어',
  'scene.request': 'write continue next scene send composer run generate story 다음 장면 써줘 요청',
  'scene.translate': 'translate retranslate translation again 번역 재번역',
  'chat.variables.read': 'risu variable state value getvar flag affection 변수',
  'chat.variables.update': 'risu variable state value setvar change fix flag affection 변수',
  'options.fix': 'save keep always from now on writing option permanently 옵션 고정',
  'scene.title': 'name rename label scene chapter title 장면 이름 제목',
  'chat.guide.update': 'original work canon spoiler reference settings story guide 원작 참고',
  'model.parameters.update':
    'temperature max output tokens reasoning effort thinking verbosity top p 온도 파라미터 호환 옵션',
  'illustration.profiles.read': 'local override 채팅 외형 프로필',
  'illustration.profiles.save': 'local override 채팅 외형 프로필',
  'helper.ask': 'ask clarify question choice options multiple choice 선택지 질문 확인',
  'model.register': 'add new model create save provider catalog 모델 추가 등록',
  'model.delete': 'remove model delete unused 모델 삭제',
  'chat.profile.read':
    'persona module attached attachment author note lore context 페르소나 모듈 작가 노트',
  'chat.profile.update':
    'attach detach persona module change switch author note lore context 페르소나 모듈 바꾸기 작가 노트',
  'scene.context.update':
    'hide show disable enable exclude scene request skip 장면 숨기기 끄기 켜기 요청 제외',
  'chat.bookmark': 'bookmark mark place reading position 책갈피 북마크',
  'chat.organize': 'folder organize chats sort move default persona 채팅 폴더 정리 기본 페르소나',
  'chat.create':
    'new chat start begin story conversation with bot persona first message greeting 새 채팅 시작 만들기',
  'chat.delete': 'remove delete erase chat conversation story permanently 채팅 삭제 지우기',
  'prompt.combination.list':
    'option preset combination saved writing options values 옵션 프리셋 조합 목록',
  'prompt.combination.save':
    'save store remember current writing options as option preset combination 옵션 프리셋 저장',
  'prompt.combination.update': 'edit option preset combination values title 옵션 프리셋 이름 수정',
  'prompt.combination.delete': 'remove delete option preset combination 옵션 프리셋 삭제',
  'prompt.combination.apply':
    'apply use choose select option preset combination default values 옵션 프리셋 적용',
  'illustration-preset.select':
    'choose use apply switch illustration preset style 삽화 프리셋 선택',
};
const searchStopWords = new Set(
  'a an the this that these those my me i it its of for to in into on at by and or with from can could would please how did'.split(
    ' '
  )
);
function searchWords(text: string) {
  return text
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word && !searchStopWords.has(word))
    .map((word) =>
      /^[a-z]{3,}s$/u.test(word) && !/(?:ss|us|is)$/u.test(word)
        ? word.endsWith('ies')
          ? `${word.slice(0, -3)}y`
          : word.slice(0, -1)
        : word
    );
}

function* schemaSearchText(schema: Json): Generator<string> {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return;
  if (typeof schema.description === 'string') yield schema.description;
  const properties = schema.properties;
  if (properties && typeof properties === 'object' && !Array.isArray(properties))
    for (const [name, child] of Object.entries(properties)) {
      yield name;
      yield* schemaSearchText(child);
    }
  for (const key of ['items', 'anyOf', 'oneOf', 'allOf']) {
    const child = schema[key];
    if (Array.isArray(child)) {
      for (const variant of child) yield* schemaSearchText(variant);
    } else if (child !== undefined) yield* schemaSearchText(child);
  }
}
const searchIndex = new Map(
  HELPER_APP_TOOLS.map((tool) => {
    const primary = searchWords(`${tool.name} ${discoveryTerms[tool.name] ?? ''}`);
    const words = [
      ...primary,
      ...primary,
      ...primary,
      ...searchWords(`${tool.description} ${[...schemaSearchText(tool.inputSchema)].join(' ')}`),
    ];
    const frequencies = new Map<string, number>();
    for (const word of words) frequencies.set(word, (frequencies.get(word) ?? 0) + 1);
    return [tool.name, { frequencies, length: words.length }] as const;
  })
);

function searchHelperTools(allowed: ProviderTool[], query: string, scope?: 'chat' | 'library') {
  const exact = HELPER_APP_TOOLS.find(
    (tool) => tool.name.toLowerCase() === query.trim().toLowerCase()
  );
  if (exact) return allowed.includes(exact) ? [exact] : [];
  const terms = [...new Set(searchWords(query))];
  if (!terms.length || !allowed.length) return [];
  const documents = allowed.map((tool) => ({ tool, index: searchIndex.get(tool.name)! }));
  const averageLength =
    documents.reduce((sum, doc) => sum + doc.index.length, 0) / documents.length;
  const k1 = 1.2,
    b = 0.3;
  const scores = new Map(allowed.map((tool) => [tool.name, 0]));
  const covered = new Map(allowed.map((tool) => [tool.name, 0]));
  for (const term of terms) {
    const frequencies = documents.map((doc) =>
      [...doc.index.frequencies].reduce(
        (sum, [word, frequency]) => sum + (word.startsWith(term) ? frequency : 0),
        0
      )
    );
    const documentFrequency = frequencies.filter((frequency) => frequency > 0).length;
    const idf = Math.log(
      1 + (documents.length - documentFrequency + 0.5) / (documentFrequency + 0.5)
    );
    for (const [index, doc] of documents.entries()) {
      const frequency = frequencies[index]!;
      if (frequency > 0) covered.set(doc.tool.name, covered.get(doc.tool.name)! + 1);
      const score =
        (idf * frequency * (k1 + 1)) /
        (frequency + k1 * (1 - b + (b * doc.index.length) / averageLength));
      scores.set(doc.tool.name, scores.get(doc.tool.name)! + score);
    }
  }
  const applicability = (tool: ProviderTool) =>
    Number(scope !== undefined && chatToolNames.has(tool.name) === (scope === 'chat'));
  return allowed
    .filter((tool) => scores.get(tool.name)! > 0)
    .sort(
      (a, b) =>
        Number(covered.get(b.name) === terms.length) -
          Number(covered.get(a.name) === terms.length) ||
        scores.get(b.name)! - scores.get(a.name)! ||
        applicability(b) - applicability(a)
    );
}

type ToolCatalog = {
  tools: (Pick<ProviderTool, 'name' | 'description'> & {
    required: string[];
    effect: 'read' | 'write' | 'mixed';
    inputSchema?: Json;
  })[];
  total: number;
  nextOffset: number | null;
};
export function describeHelperTools(
  args: { names: string[] },
  review?: boolean,
  scope?: 'chat' | 'library'
): { tools: ProviderTool[] };
export function describeHelperTools(
  args: Record<string, unknown>,
  review?: boolean,
  scope?: 'chat' | 'library'
): { tools: ProviderTool[] } | ToolCatalog;
export function describeHelperTools(
  args: Record<string, unknown>,
  review = false,
  scope?: 'chat' | 'library'
) {
  const allowed = availableAppTools(review);
  if (typeof args.name === 'string' && args.names === undefined) {
    const { name, ...rest } = args;
    args = { ...rest, names: [name] };
  }
  if (Object.keys(args).some((key) => !['names', 'query', 'offset', 'limit'].includes(key)))
    throw new HttpError(400, 'INVALID_ARGUMENTS');
  if (args.names !== undefined) {
    if (
      !Array.isArray(args.names) ||
      !args.names.length ||
      args.names.some((n) => typeof n !== 'string')
    )
      throw new HttpError(400, 'INVALID_ARGUMENTS');
    return {
      tools: [...new Set(args.names)].map((name) => {
        const tool = allowed.find((t) => t.name === name);
        if (!tool) throw new HttpError(400, `UNKNOWN_APP_TOOL:${String(name)}`);
        return tool;
      }),
    };
  }
  const query = args.query ?? '';
  const offset = args.offset ?? 0;
  const searching = typeof query === 'string' && query.trim().length > 0;
  const limit = args.limit ?? (searching ? 3 : 20);
  if (
    typeof query !== 'string' ||
    query.length > 200 ||
    !Number.isSafeInteger(offset) ||
    Number(offset) < 0 ||
    !Number.isSafeInteger(limit) ||
    Number(limit) < 1
  )
    throw new HttpError(400, 'INVALID_ARGUMENTS');
  const found = searching ? searchHelperTools(allowed, query, scope) : [...allowed].sort(byArea);
  if (!searching && scope === 'library')
    found.sort((a, b) => Number(chatToolNames.has(a.name)) - Number(chatToolNames.has(b.name)));
  const page = found.slice(
    Number(offset),
    Number(offset) + Math.min(Number(limit), allowed.length)
  );
  return {
    tools: page.map((tool) => {
      return {
        name: tool.name,
        description:
          searching || tool.description.length <= 260
            ? tool.description
            : `${tool.description.slice(0, 257)}…`,
        required: (tool.inputSchema as { required?: string[] }).required ?? [],
        effect: helperToolTraits(tool.name).effect,
        ...(searching ? { inputSchema: tool.inputSchema } : {}),
      };
    }),
    total: found.length,
    nextOffset: Number(offset) + page.length < found.length ? Number(offset) + page.length : null,
  };
}
