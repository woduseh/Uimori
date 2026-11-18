import { STORY_READ_DEFAULT_TOKENS, STORY_READ_MAX_TOKENS } from './source-history.js';
import type { ProviderTool } from './transport.js';

/** Shared model-facing schemas for frozen story ancestry reads. */
export const STORY_READ_TOOLS: ProviderTool[] = [
  {
    name: 'story.search',
    description:
      "Browse or search the original exchanges of this story's frozen history, including scenes that were compacted out of the visible context. Use it to locate an earlier scene before quoting it or relying on its details. Omit query (or pass an empty string) to list scenes in order with short previews; with a query, every whitespace-separated term must occur in the same exchange. Each result has a stable 1-based sceneNumber and a sceneScope for story.read. A preview or excerpt is not the whole scene.",
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          maxLength: 512,
          description: 'Search terms, all required in one exchange. Omit to list scenes in order.',
        },
        offset: {
          type: 'integer',
          minimum: 0,
          maximum: Number.MAX_SAFE_INTEGER,
          description: 'Result offset. Pass the previous nextOffset to get the next page.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'Maximum scenes or matches per page.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'story.read',
    description:
      'Read the original text of one scene by its 1-based sceneNumber from story.search. Returns the sceneScope, the exact source revision and hash, the UTF-16 range that was returned and a nextOffset when text remains. A sceneNumber is local to the returned sceneScope; it is not an id that works across chats.',
    inputSchema: {
      type: 'object',
      properties: {
        sceneNumber: {
          type: 'integer',
          minimum: 1,
          maximum: Number.MAX_SAFE_INTEGER,
          description: 'Scene number as returned by story.search.',
        },
        offset: {
          type: 'integer',
          minimum: 0,
          maximum: Number.MAX_SAFE_INTEGER,
          description:
            'Start position in the scene text, in UTF-16 code units. Pass nextOffset to continue.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 16000,
          description:
            'Optional hard cap on the returned text, in UTF-16 code units. Normally omit it and size the read with maxTokens.',
        },
        maxTokens: {
          type: 'integer',
          minimum: 1,
          maximum: STORY_READ_MAX_TOKENS,
          default: STORY_READ_DEFAULT_TOKENS,
          description: 'Text budget in locally estimated tokens.',
        },
      },
      required: ['sceneNumber'],
      additionalProperties: false,
    },
  },
];
