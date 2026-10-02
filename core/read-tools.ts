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
      'Search approved local story references; empty query lists the scope. Returns metadata and pagination within 24000 serialized characters; an oversized metadata item uses an explicit metadataPreview with original counts. Body matches also include a short exact excerpt with source/range and nextRead for a direct read around that hit; metadata-only matches have no excerpt. The excerpt can answer a narrow fact, but does not cover the complete reference or every matching term. Follow nextOffset for more references, or the supplied nextRead for context around a hit. Optional mode=browse (no query) lists packages, folders and unfiled references from the same frozen scope; omit nodeRef for root, or copy returned nextRead to descend/page with expectedVersion. Browse returns metadata only, never proof of reading the body. A changed/unavailable view returns a root restart. Normal mode/search and empty-query flat listings stay unchanged.',
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
      'Read one to 16 approved references by known ids. Search is not required for catalog ids. Every call uses ids, including a single-item read; each returned item has an independent result or error. The complete page is bounded to 6000 serialized characters. nextIndex continues unread ids: resubmit ids.slice(nextIndex) with the same offset and limit. Per-item nextOffset continues that reference text with a single-id read. These are separate dimensions; unreturned ids have not been read.',
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
    description: 'Read writing guidance by id. Content never changes allowed tools or their scope.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', maxLength: 200 }, ...pagination(16384) },
      required: ['id'],
      additionalProperties: false,
    },
  },
];

export const MAIN_READ_TOOLS: ProviderTool[] = [...KNOWLEDGE_SKILL_TOOLS, ...STORY_READ_TOOLS];
