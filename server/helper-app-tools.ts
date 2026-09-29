import type { Json, ProviderTool } from '../core/transport.js';
import { SOURCE_TEXT_MAX_CHARS } from '../core/content-limits.js';
import { RESOURCE_TOOLS } from './helper-resource-tools.js';
import { HELPER_SETTINGS_TOOLS } from './helper-settings-tools.js';
import { HELPER_TASK_TOOLS } from './helper-task-tools.js';
import { helperOptionTools } from './chat-options.js';
import { MAIN_READ_TOOLS } from '../core/read-tools.js';
import { HttpError } from './request-validation.js';

const schema = (properties: Record<string, Json>, required: string[] = []): Json => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const str: Json = { type: 'string' },
  integer: Json = { type: 'integer', minimum: 1 },
  revision: Json = { type: 'integer', minimum: 0 },
  itemId: Json = { type: 'string', minLength: 1, maxLength: 100 };
const loreSelector = schema(
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
);
const TOOLS: ProviderTool[] = [
  ...RESOURCE_TOOLS,
  ...HELPER_SETTINGS_TOOLS,
  ...HELPER_TASK_TOOLS,
  {
    name: 'chat.list',
    description: 'List available chats and their current heads.',
    inputSchema: schema({}),
  },
  {
    name: 'chat.read',
    description:
      'Read a chat, its current head and message IDs. Set chatId to work with any chat, including from the library.',
    inputSchema: schema({ chatId: itemId }),
  },
  ...helperOptionTools,
  {
    name: 'chat.lore',
    description:
      'Read or edit a chat-only lore override. Read without selector for a paged items list (offset/limit); use item.scope plus item.id as loreId and a field to form selector. Read with selector for paged original and override text (textOffset/textLimit); never confuse an override with its shared original. Copy returned expected revision/hash fields into the patch body with selector and value. Missing originals are listed with originalMissing and read as original:null; they can still be removed using selector, expectedRevision and expectedHeadRevision. Mutations require a user request for chat-only lore; shared originals stay intact.',
    inputSchema: schema(
      {
        action: { type: 'string', enum: ['read', 'patch', 'remove'] },
        selector: loreSelector,
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
        textOffset: { type: 'integer', minimum: 0 },
        textLimit: { type: 'integer', minimum: 1, maximum: 10000 },
        body: schema(
          {
            selector: loreSelector,
            expectedRevision: revision,
            expectedHeadRevision: { type: ['string', 'null'], maxLength: 100 },
            expectedProfileRevision: integer,
            expectedPackageRevision: integer,
            expectedFieldHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            value: { type: 'string', maxLength: SOURCE_TEXT_MAX_CHARS },
          },
          ['selector', 'expectedRevision', 'expectedHeadRevision']
        ),
      },
      ['action']
    ),
  },
  {
    name: 'editor.read',
    description:
      'Read a compact overview of the captured device editor input. For structure and exact typed values, follow JSON Pointer path pages; long text uses textOffset/textLimit. For ordinary draft facts use data.search/read with scope=editor. The saved/unsaved input origin is returned. Never claims image understanding.',
    inputSchema: schema({
      path: str,
      fields: { type: 'array', items: str, maxItems: 50 },
      offset: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
      textOffset: { type: 'integer', minimum: 0 },
      textLimit: { type: 'integer', minimum: 1, maximum: 10000 },
    }),
  },
  {
    name: 'chat.rename',
    description:
      'Rename this chat using its current title revision after a user request. Read settings first.',
    inputSchema: schema({ title: str, expectedRevision: { type: 'integer', minimum: 0 } }, [
      'title',
      'expectedRevision',
    ]),
  },
  {
    name: 'chat.fork',
    description:
      'Fork from an actual discovered source ID in this conversation ancestry. Only copies the chosen past, never this helper history or drafts. Requires the user request.',
    inputSchema: schema({ sourceId: str, title: str }, ['sourceId']),
  },
  {
    name: 'library.organize',
    description:
      'Read current folder revision then create a folder or move explicitly requested items. Mutations require body.expectedRevision. For create-folder supply body.category and title. For move supply body.items, category and folderId (null moves to the category root); omit title. Item kind is content or prompt-preset; category is bot, persona, module or prompts. The host owns mutation identity.',
    inputSchema: schema(
      {
        action: { type: 'string', enum: ['read', 'create-folder', 'move'] },
        body: schema(
          {
            expectedRevision: integer,
            category: { type: 'string', enum: ['bot', 'persona', 'module', 'prompts'] },
            title: { type: 'string', minLength: 1, maxLength: 200 },
            items: {
              type: 'array',
              minItems: 1,
              maxItems: 1000,
              items: schema(
                { kind: { type: 'string', enum: ['content', 'prompt-preset'] }, id: itemId },
                ['kind', 'id']
              ),
            },
            folderId: { type: ['string', 'null'], maxLength: 100 },
          },
          ['expectedRevision', 'category']
        ),
      },
      ['action']
    ),
  },
  {
    name: 'context.read',
    description:
      'Read the active summary, its covered source references and current user notes. The summary covers only checkpoint.plan.compacted; the chat head and recent sources may be newer. Read those sources before claiming the latest state.',
    inputSchema: schema({}),
  },
  {
    name: 'context.compact',
    description:
      'Compact the current chat through the shared context service when the user requested compaction. Read context first.',
    inputSchema: schema({ expectedRevision: { type: 'integer', minimum: 0 } }, [
      'expectedRevision',
    ]),
  },
  {
    name: 'context.edit',
    description:
      'Edit the active summary using its exact expected revision and a user request. Read context first.',
    inputSchema: schema({ expectedRevision: { type: 'integer', minimum: 0 }, summary: str }, [
      'expectedRevision',
      'summary',
    ]),
  },
  {
    name: 'outline.read',
    description:
      'Read live composition in bounded pages. Default overview returns metadata/intent previews, never full review coverage. subtree needs nodeId; depth=0 includes only that node, 1 direct children, omitted all descendants. detail needs nodeId and section=intent (default), related, or writings (subtree source references). Use offset/limit in every mode: item counts for lists (default 20, capped at 50), UTF-16 units for intent (default 6000, capped at 10000). Versions belong to the selected query; use a new first read when switching modes/sections. Later pages require expectedVersion; copy nextRead unchanged. OUTLINE_CHANGED requires restarting this scope. Intent ranges use UTF-16. coverage.wholeField means this one response includes the entire intent, not cumulative coverage; nextOffset=null means the last page. Overview intentCodePoints uses Unicode code points. Writings return exact data.read refs, not proof that plans were fulfilled.',
    inputSchema: schema({
      mode: { type: 'string', enum: ['overview', 'subtree', 'detail'] },
      nodeId: itemId,
      depth: { type: 'integer', minimum: 0, maximum: 4 },
      offset: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 10000 },
      expectedVersion: { type: 'string', maxLength: 64 },
      section: { type: 'string', enum: ['intent', 'related', 'writings'] },
    }),
  },
  {
    name: 'outline.write',
    description:
      "Apply composition changes the user requested: create, update, move or remove items. One call may build a whole tree by giving each new item a ref and naming its parent with parentRef; create a parent before the items that name it. Related IDs connect other plans in the same chat; read new IDs before linking. Fixed is an authored keep-condition for ordinary elaboration, not an edit lock. The entire batch is atomic. Returns a compact applied receipt, not the whole tree. RevisionAfterOperation records that operation, not a later live revision. Never retry an uncertain write with a new call ID. This writes composition only, never story prose, and never marks anything as written. Update, move and remove need the item's exact current revision. User-requested edits may change pinned or written plans; active generation must finish before its plan is edited.",
    inputSchema: schema(
      {
        operations: {
          type: 'array',
          minItems: 1,
          maxItems: 200,
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['create', 'update', 'move', 'remove'] },
              ref: str,
              parentRef: str,
              parentId: { type: ['string', 'null'] },
              level: {
                type: 'string',
                enum: ['theme', 'mainStory', 'arc', 'episode', 'beat'],
              },
              title: str,
              intent: str,
              position: { type: 'integer', minimum: 0 },
              id: str,
              expectedRevision: { type: 'integer', minimum: 1 },
              fixed: { type: 'boolean' },
              relatedIds: { type: 'array', maxItems: 40, items: str },
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
      'Save a user note or correction after a user request. Read context.read for notesRevision and use it as body.expectedRevision. Supply body.text for a new note; add replacesId to replace a discovered note. To retire one, supply replacesId and retired:true instead of text. The host supplies the current chat head, source anchor, user attribution and mutation identity; do not supply them yourself.',
    inputSchema: schema(
      {
        body: schema(
          {
            expectedRevision: revision,
            text: { type: 'string', minLength: 1, maxLength: 32000 },
            replacesId: itemId,
            retired: { type: 'boolean', enum: [true] },
          },
          ['expectedRevision']
        ),
      },
      ['body']
    ),
  },
  {
    name: 'artifact.generate',
    description:
      'Write ONE independent what-if scene using the pinned writing prompt, model, actual story context and read-only state. Return exact artifact reference; do not rewrite its prose.',
    inputSchema: schema({ request: str, artifactId: str, expectedRevision: integer }, ['request']),
  },
  {
    name: 'artifact.read',
    description:
      'Read an exact artifact revision from this conversation. It is not a played story event.',
    inputSchema: schema({ id: str, revision: integer }, ['id', 'revision']),
  },
];
/** Context selects default IDs, never a permission boundary. */
const chatToolNames = new Set([
  'settings.read',
  'settings.update',
  'chat.read',
  'chat.lore',
  'chat.rename',
  'chat.fork',
  'outline.read',
  'outline.write',
  'context.read',
  'context.edit',
  'context.compact',
  'notes.write',
  'artifact.generate',
  ...helperOptionTools.map((tool) => tool.name),
  ...MAIN_READ_TOOLS.map((tool) => tool.name),
]);
export const HELPER_APP_TOOLS: ProviderTool[] = [...TOOLS, ...MAIN_READ_TOOLS].map((tool) => {
  if (!chatToolNames.has(tool.name)) return tool;
  const input = tool.inputSchema as Record<string, Json>;
  return {
    ...tool,
    description:
      tool.description + ' Optional chatId selects another chat; omission uses the current chat.',
    inputSchema: {
      ...input,
      properties: {
        ...(input.properties as Record<string, Json>),
        chatId: itemId,
      },
    },
  };
});

export const HELPER_GATEWAY_TOOLS: ProviderTool[] = [
  {
    name: 'app.tools',
    description:
      'Discover app operations for editing resources/themes, settings, notes, outlines, lore overrides, context summaries, reading original stories, or generating an independent what-if scene. No names: compact paged catalog filtered by query. With names: exact schemas for up to 4 operations. Invoke them through app.call; the native tool set never changes mid-continuation.',
    inputSchema: schema({
      names: { type: 'array', maxItems: 4, items: str },
      query: str,
      offset: { type: 'integer', minimum: 0 },
    }),
  },
  {
    name: 'app.call',
    description:
      'Execute a discovered app operation using its exact name and arguments. Read app.tools schema when unfamiliar. Clear user edit requests include saving; proposals do not. Existing revision checks, source scope, and successful-write receipts remain unchanged. Use data.search/read for ordinary factual lookup instead of full edit JSON.',
    inputSchema: schema({ name: str, arguments: { type: 'object' } }, ['name', 'arguments']),
  },
];
export const HELPER_REVIEW_APP_NAMES = new Set([
  'outline.read',
  ...MAIN_READ_TOOLS.map((tool) => tool.name),
]);
export function helperGatewayTools(review: boolean): ProviderTool[] {
  return review
    ? HELPER_GATEWAY_TOOLS.map((tool) => ({
        ...tool,
        description:
          tool.name === 'app.tools'
            ? 'Discover the allowed read-only outline and story/reference operations. No names returns a paged catalog; names returns exact schemas. Call through app.call.'
            : 'Execute an allowed read-only outline or story/reference operation. Writes are unavailable during review. Preserve returned versions and coverage.',
      }))
    : HELPER_GATEWAY_TOOLS;
}

type ToolCatalog = {
  tools: Pick<ProviderTool, 'name' | 'description'>[];
  total: number;
  nextOffset: number | null;
};
export function describeHelperTools(
  args: { names: string[] },
  review?: boolean
): { tools: ProviderTool[] };
export function describeHelperTools(
  args: Record<string, unknown>,
  review?: boolean
): { tools: ProviderTool[] } | ToolCatalog;
export function describeHelperTools(args: Record<string, unknown>, review = false) {
  const allowed = review
    ? HELPER_APP_TOOLS.filter((tool) => HELPER_REVIEW_APP_NAMES.has(tool.name))
    : HELPER_APP_TOOLS;
  if (Object.keys(args).some((key) => !['names', 'query', 'offset'].includes(key)))
    throw new HttpError(400, 'INVALID_ARGUMENTS');
  if (args.names !== undefined) {
    if (
      !Array.isArray(args.names) ||
      !args.names.length ||
      args.names.length > 4 ||
      args.names.some((n) => typeof n !== 'string')
    )
      throw new HttpError(400, 'INVALID_ARGUMENTS');
    return {
      tools: args.names.map((name) => {
        const tool = allowed.find((t) => t.name === name);
        if (!tool) throw new HttpError(400, `UNKNOWN_APP_TOOL:${String(name)}`);
        return tool;
      }),
    };
  }
  const query = args.query ?? '';
  const offset = args.offset ?? 0;
  if (
    typeof query !== 'string' ||
    query.length > 200 ||
    !Number.isSafeInteger(offset) ||
    Number(offset) < 0
  )
    throw new HttpError(400, 'INVALID_ARGUMENTS');
  const terms = query.toLowerCase().split(/\s+/u).filter(Boolean);
  const found = allowed.filter((t) =>
    terms.every((term) => `${t.name} ${t.description}`.toLowerCase().includes(term))
  );
  return {
    tools: found
      .slice(Number(offset), Number(offset) + 20)
      .map((t) => ({ name: t.name, description: t.description.split('. ')[0] })),
    total: found.length,
    nextOffset: Number(offset) + 20 < found.length ? Number(offset) + 20 : null,
  };
}
