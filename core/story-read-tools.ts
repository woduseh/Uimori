import type { ProviderTool } from './transport.js';

const pagination = (maximum: number) => ({
  offset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  limit: { type: 'integer', minimum: 1, maximum },
});

/** Shared model-facing schemas for frozen story ancestry reads. */
export const STORY_READ_TOOLS: ProviderTool[] = [
  {
    name: 'story.search',
    description:
      'Browse or search original exchanges in this frozen ancestry, including compacted scenes. Omit query or use an empty string to list scenes in order with previews; otherwise all whitespace-separated terms must occur in the same exchange. Results include stable 1-based sceneNumber values and sceneScope for direct reading.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: 512 },
        ...pagination(100),
      },
      additionalProperties: false,
    },
  },
  {
    name: 'story.read',
    description:
      'Read an original by its 1-based sceneNumber in this frozen ancestry. Returns sceneScope, exact source revision/hash, character range and continuation; sceneNumber is local to the returned sceneScope and is not a cross-chat ID.',
    inputSchema: {
      type: 'object',
      properties: {
        sceneNumber: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        ...pagination(16000),
      },
      required: ['sceneNumber'],
      additionalProperties: false,
    },
  },
];
