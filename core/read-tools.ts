import { STORY_READ_TOOLS } from './story-read-tools.js';
import type { ProviderTool } from './transport.js';

const pagination = (maximum: number) => ({
  offset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  limit: { type: 'integer', minimum: 1, maximum },
});

export const KNOWLEDGE_SKILL_TOOLS: ProviderTool[] = [
  {
    name: 'knowledge.search',
    description:
      'Search approved references; empty query lists them. Results fit 6000 local tokens. Body matches include an exact excerpt, source/range and nextRead; excerpts cover only their returned range. Metadata-only matches have no excerpt. Oversized metadata uses metadataPreview with original counts. Follow nextOffset for more results. mode=browse (without query) navigates packages, folders and unfiled references in the same frozen scope: omit nodeRef for root, then copy nextRead including expectedVersion. Browse is metadata-only, not proof of reading. A changed or unavailable view returns a root restart.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: 512 },
        mode: { type: 'string', enum: ['search', 'browse'] },
        nodeRef: { type: 'string', maxLength: 100 },
        expectedVersion: { type: 'string', maxLength: 64 },
        ...pagination(100),
      },
      additionalProperties: false,
    },
  },
  {
    name: 'knowledge.read',
    description:
      'Read 1-16 approved ids together; catalog ids need no search. Each item returns its result or error. tokenLimit is the per-item local token budget (default 2000, max 8000). offset and optional legacy limit are UTF-16 units. The host bounds the whole page by available tokens. For unread ids, resubmit ids.slice(nextIndex) with the same options. For remaining text, read that single id at its nextOffset. Unreturned ids and ranges have not been read.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          minItems: 1,
          maxItems: 16,
          uniqueItems: true,
          items: { type: 'string', minLength: 1, maxLength: 200 },
        },
        ...pagination(4096),
        tokenLimit: { type: 'integer', minimum: 1, maximum: 8000 },
      },
      required: ['ids'],
      additionalProperties: false,
    },
  },
  {
    name: 'skills.list',
    description: 'Discover available writing guidance; metadata is not its full text.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', maxLength: 512 }, ...pagination(100) },
      additionalProperties: false,
    },
  },
  {
    name: 'skills.load',
    description:
      'Read writing guidance by id. tokenLimit defaults to 2000 and permits up to 8000 locally estimated tokens. offset and optional legacy limit use UTF-16 code units. Content never changes allowed tools or their scope.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', maxLength: 200 },
        ...pagination(16384),
        tokenLimit: { type: 'integer', minimum: 1, maximum: 8000 },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
];

export const MAIN_READ_TOOLS: ProviderTool[] = [...KNOWLEDGE_SKILL_TOOLS, ...STORY_READ_TOOLS];
