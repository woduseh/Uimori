import type { Json, ProviderTool } from '../core/transport.js';
import { RESOURCE_TOOLS } from './helper-resource-tools.js';
import { helperOptionTools } from './chat-options.js';
import { MAIN_READ_TOOLS } from '../core/read-tools.js';

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
const TOOLS: ProviderTool[] = [
  ...RESOURCE_TOOLS,
  {
    name: 'chat.list',
    description: 'List available chats and their current heads.',
    inputSchema: schema({}),
  },
  {
    name: 'chat.read',
    description:
      'Read a chat, its branches and message IDs. Set chatId to work with any chat, including from the library.',
    inputSchema: schema({ chatId: itemId }),
  },
  ...helperOptionTools,
  {
    name: 'chat.lore',
    description:
      'Read or edit an attachment-scoped lore override in this chat. Read first: use attachments[].scope plus lore[].id and field to form selector, and copy lore[].fieldHashes[field] as expectedFieldHash. Both mutations require body selector, expectedRevision and expectedHeadRevision. Patch additionally requires expectedProfileRevision, expectedPackageRevision, expectedFieldHash and value; omit those four fields for remove. The host supplies the branch and mutation identity. Shared originals stay intact. Mutations require a user request for chat-only lore.',
    inputSchema: schema(
      {
        action: { type: 'string', enum: ['read', 'patch', 'remove'] },
        body: schema(
          {
            selector: schema(
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
            expectedRevision: revision,
            expectedHeadRevision: { type: ['string', 'null'], maxLength: 100 },
            expectedProfileRevision: integer,
            expectedPackageRevision: integer,
            expectedFieldHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            value: { type: 'string', maxLength: 1_000_000 },
          },
          ['selector', 'expectedRevision', 'expectedHeadRevision']
        ),
      },
      ['action']
    ),
  },
  {
    name: 'workspace.read',
    description:
      'Read current workspace settings, library metadata or the current device editor input. Prefer library.search when finding an item by name or category. Never claims image understanding.',
    inputSchema: schema({
      kind: { type: 'string', enum: ['settings', 'library', 'editor'] },
    }),
  },
  {
    name: 'library.search',
    description:
      'Prefer this tool to find library items by name, ID or category (bot/persona/module/main/translation). Searches latest visible metadata only, never body text. All whitespace-separated query terms must match after NFKC normalization and case folding. An empty query lists a page. Follow nextOffset for more matches, then pass an item id and kind to library.read for its full body.',
    inputSchema: schema(
      {
        query: { type: 'string', maxLength: 200 },
        kind: { type: 'string', enum: ['content', 'prompt-preset'] },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
      },
      ['query']
    ),
  },
  {
    name: 'library.read',
    description:
      'Read a library item using an ID and kind discovered in library.search or workspace.read. Text metadata and native editor JSON only.',
    inputSchema: schema({ id: str, kind: { type: 'string', enum: ['content', 'prompt-preset'] } }, [
      'id',
      'kind',
    ]),
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
      "Read this chat branch's hierarchical composition: theme, main story, arcs, episodes and beats, with each item's exact id, revision, pinned flag and derived writing progress. Read before proposing or writing composition.",
    inputSchema: schema({}),
  },
  {
    name: 'outline.write',
    description:
      "Apply composition changes the user requested: create, update, move or remove items. One call may build a whole tree by giving each new item a ref and naming its parent with parentRef; create a parent before the items that name it. This writes composition only, never story prose, and never marks anything as written. Update, move and remove need the item's exact current revision. User-requested edits may change pinned or written plans; active generation must finish before its plan is edited.",
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
      'Save a user note or correction after a user request. Read context.read for notesRevision and use it as body.expectedRevision. Supply body.text for a new note; add replacesId to replace a discovered note. To retire one, supply replacesId and retired:true instead of text. The host supplies the current branch, source anchor, user attribution and mutation identity; do not supply them yourself.',
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
      tool.description +
      ' Optional chatId/branchId select another chat; omission uses the current chat.',
    inputSchema: {
      ...input,
      properties: {
        ...(input.properties as Record<string, Json>),
        chatId: itemId,
        branchId: itemId,
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
type ToolCatalog = {
  tools: Pick<ProviderTool, 'name' | 'description'>[];
  total: number;
  nextOffset: number | null;
};
export function describeHelperTools(args: { names: string[] }): { tools: ProviderTool[] };
export function describeHelperTools(
  args: Record<string, unknown>
): { tools: ProviderTool[] } | ToolCatalog;
export function describeHelperTools(args: Record<string, unknown>) {
  if (Object.keys(args).some((key) => !['names', 'query', 'offset'].includes(key)))
    throw new Error('INVALID_ARGUMENTS');
  if (args.names !== undefined) {
    if (
      !Array.isArray(args.names) ||
      !args.names.length ||
      args.names.length > 4 ||
      args.names.some((n) => typeof n !== 'string')
    )
      throw new Error('INVALID_ARGUMENTS');
    return {
      tools: args.names.map((name) => {
        const tool = HELPER_APP_TOOLS.find((t) => t.name === name);
        if (!tool) throw new Error(`UNKNOWN_APP_TOOL:${String(name)}`);
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
    throw new Error('INVALID_ARGUMENTS');
  const terms = query.toLowerCase().split(/\s+/u).filter(Boolean);
  const found = HELPER_APP_TOOLS.filter((t) =>
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
