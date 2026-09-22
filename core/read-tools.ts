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
      'Search approved local story references; empty query lists the scope. Returns metadata and pagination.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', maxLength: 512 }, ...pagination(100) },
      additionalProperties: false,
    },
  },
  {
    name: 'knowledge.read',
    description:
      'Read one to 16 approved references by known ids. Search is not required for catalog ids. Every call uses ids, including a single-item read; each item returns an independent result or error.',
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
