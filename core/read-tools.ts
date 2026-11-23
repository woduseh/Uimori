import { STORY_READ_TOOLS } from './story-read-tools.js';
import type { ProviderTool } from './transport.js';

const resultPage = (maximum: number) => ({
  offset: {
    type: 'integer',
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
    description: 'Result offset. Pass the previous nextOffset to get the next page.',
  },
  limit: { type: 'integer', minimum: 1, maximum, description: 'Maximum results per page.' },
});
const textPage = (maximum: number) => ({
  offset: {
    type: 'integer',
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
    description:
      'Start position in the text, in UTF-16 code units. Pass a returned nextOffset to continue.',
  },
  limit: {
    type: 'integer',
    minimum: 1,
    maximum,
    description:
      'Optional hard cap on the returned text, in UTF-16 code units. Normally omit it and size the read with tokenLimit.',
  },
  tokenLimit: {
    type: 'integer',
    minimum: 1,
    maximum: 8000,
    description: 'Text budget per entry in locally estimated tokens. Default 2000.',
  },
});

export const KNOWLEDGE_SKILL_TOOLS: ProviderTool[] = [
  {
    name: 'knowledge.search',
    description:
      'Find writing references (such as lore entries) approved for this run when the catalog does not already identify the id you need. Known ids go straight to knowledge.read. Three modes: search (default) returns entries that contain every query term, or lists all entries when query is empty; relevant ranks lexical matches for a nonempty query and may return entries with only some of the terms (it is not semantic search); browse walks the package and folder structure without a query. A body match returns a short exact excerpt with its source range and a ready-to-use nextRead call. Title or description matches and browse listings are metadata only, and very long metadata is shortened to metadataPreview with the original counts. An excerpt or listing covers only what it shows, so read the entry before relying on its full text. Each page fits about 6000 tokens; follow nextOffset for more.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          maxLength: 512,
          description:
            'Search terms. Omit or leave empty to list entries in search mode. Required for mode=relevant; not allowed with mode=browse.',
        },
        mode: {
          type: 'string',
          enum: ['search', 'relevant', 'browse'],
          description:
            'search (default) needs every term, relevant ranks partial lexical matches, browse navigates packages and folders.',
        },
        nodeRef: {
          type: 'string',
          maxLength: 100,
          description:
            'browse only: the package or folder to open, copied from a previous browse result. Omit to start at the root.',
        },
        expectedVersion: {
          type: 'string',
          maxLength: 64,
          description:
            'browse only: the version from the previous browse page, required for every later page. Copying nextRead includes it. A changed or unavailable view returns an error that tells you to restart at the root.',
        },
        ...resultPage(100),
      },
      additionalProperties: false,
    },
  },
  {
    name: 'knowledge.read',
    description:
      'Read the text of 1-16 writing references by id. Ids come from the catalog in the input or from knowledge.search, so a catalog id needs no search first. Request independent ids together in one call. Each item returns its own page of text or its own error, and the host may shorten the page to fit the available context. Ids and ranges that were not returned have not been read: when nextIndex is not null, call again with ids.slice(nextIndex) and the same options, and when an item has a nextOffset, read that single id from that offset.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          minItems: 1,
          maxItems: 16,
          uniqueItems: true,
          items: { type: 'string', minLength: 1, maxLength: 200 },
          description: 'Reference ids to read. Use a one-item array for a single reference.',
        },
        ...textPage(4096),
      },
      required: ['ids'],
      additionalProperties: false,
    },
  },
  {
    name: 'skills.list',
    description:
      'List or search the writing guidance available to this run. Use it when the request may be covered by a guide that the catalog does not already name. Results are metadata only, not the guidance text: read a relevant entry with skills.load before applying it. Follow nextOffset for more.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          maxLength: 512,
          description: 'Search terms. Omit to list all guidance.',
        },
        ...resultPage(100),
      },
      additionalProperties: false,
    },
  },
  {
    name: 'skills.load',
    description:
      'Read the text of one writing guidance entry by its id from skills.list or the catalog. Follow nextOffset for the remaining text of a long entry.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', maxLength: 200, description: 'Guidance id to read.' },
        ...textPage(16384),
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
];

export const SKILL_TOOL_NAMES: readonly string[] = ['skills.list', 'skills.load'];

export const MAIN_READ_TOOLS: ProviderTool[] = [...KNOWLEDGE_SKILL_TOOLS, ...STORY_READ_TOOLS];
