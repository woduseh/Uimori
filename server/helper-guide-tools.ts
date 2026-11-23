import type { Json, ProviderTool } from '../core/transport.js';
import { listAppGuides, readAppGuide, searchAppGuides } from './app-guides.js';
import { fields, HttpError, number, text } from './request-validation.js';

export const HELPER_GUIDE_TOOLS: ProviderTool[] = [
  {
    name: 'guide.read',
    description:
      "Read Uimori's own user guides: what each feature does, where it is in the interface and what the app does by itself without a tool. Use it before telling the user that Uimori lacks a feature, cannot do something or behaves in a certain way, and when asked how something in the app works. Without arguments it lists the guides. query finds the lines that contain every word of the query across all guides, with the guide and section of each; guides are mostly written in Korean, so search with the user's Korean terms as well as English names. name returns one guide in pages; follow nextOffset. The guides describe the app, not the user's stories or settings.",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Guide name from the list, such as READING.' },
        query: {
          type: 'string',
          description: 'Words that must all appear in a line. Not combined with name.',
        },
        offset: { type: 'integer', minimum: 0, description: 'With name: character offset.' },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 20000,
          description: 'With name: characters to return, 8000 by default.',
        },
      },
      additionalProperties: false,
    } as Json,
  },
];

export function invokeHelperGuideTool(args: Record<string, unknown>): unknown {
  fields(args, ['name', 'query', 'offset', 'limit']);
  if (args.name !== undefined && args.query !== undefined)
    throw new HttpError(400, 'INVALID_ARGUMENTS: pass name or query, not both');
  if (args.query !== undefined) return searchAppGuides(text(args.query, 'guide query', 200));
  if (args.name === undefined) return { guides: listAppGuides() };
  return readAppGuide(
    text(args.name, 'guide name', 100),
    args.offset === undefined ? undefined : number(args.offset, 'guide offset', 0),
    args.limit === undefined ? undefined : number(args.limit, 'guide limit', 1, 20_000)
  );
}
