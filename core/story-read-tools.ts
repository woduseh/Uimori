import type { ProviderTool } from './transport.js';

const pagination = (maximum: number) => ({
  offset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  limit: { type: 'integer', minimum: 1, maximum },
});

/** Shared model-facing schemas for executeStoryRead's frozen ancestry and author-note reads. */
export const STORY_READ_TOOLS: ProviderTool[] = [
  {
    name: 'notes.list',
    description:
      'List explicit user notes and corrections valid in this exact story ancestry. Omit query or use an empty string to list all notes; a query filters note text.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', maxLength: 512 }, ...pagination(100) },
      additionalProperties: false,
    },
  },
  {
    name: 'notes.read',
    description:
      'Read a discovered note ID with exact source provenance, character range and continuation. User notes are explicit instructions, not original story evidence.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', maxLength: 200 }, ...pagination(16000) },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'story.list',
    description:
      'List original exchanges in this frozen ancestry: 1-based sceneNumber (authored start included), revision, hash, size, preview and compacted status. Numbers stay fixed across compaction and pagination, and are local to the returned sceneScope. Use story.read with a known sceneNumber directly.',
    inputSchema: {
      type: 'object',
      properties: { ...pagination(100) },
      additionalProperties: false,
    },
  },
  {
    name: 'story.search',
    description:
      'Search original prose in this exact ancestry, including compacted scenes. Supply a nonblank query; use story.list to browse without a search term. Results include sceneNumber and sceneScope for direct reading. Whitespace-separated terms match case-insensitively and must all occur in the same exchange.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 512, pattern: '\\S' },
        ...pagination(100),
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'story.read',
    description:
      'Read an original by id (revision) or 1-based sceneNumber in this frozen ancestry. If both are supplied they must select the same source. Returns sceneScope, sceneNumber, exact source hash, character range and continuation; the number is not a cross-chat ID.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', maxLength: 200 },
        sceneNumber: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        ...pagination(16000),
      },
      anyOf: [{ required: ['id'] }, { required: ['sceneNumber'] }],
      additionalProperties: false,
    },
  },
];
