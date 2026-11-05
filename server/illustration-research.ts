import type { IllustrationJobInput } from '../core/illustration.js';
import type { Content } from '../core/product.js';
import type { Json, ProviderTool } from '../core/transport.js';
import type { RunSnapshot } from '../core/types.js';
import { readHelperModel } from './helper-resource-editing.js';
import { fields, number, text } from './request-validation.js';

const paging = {
  offset: { type: 'integer', minimum: 0 },
  limit: { type: 'integer', minimum: 1, maximum: 50 },
};
const schema = (properties: Record<string, Json>, required: string[]): Json => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
export const ILLUSTRATION_RESEARCH_TOOLS: ProviderTool[] = [
  {
    name: 'illustration.sources.search',
    description:
      'Search frozen attached bot, persona and module native descriptions/lore and prior illustration captions/prompts. Literal case-insensitive search returns paths and excerpts; empty query lists text fields. Use illustration.sources.read for full passages.',
    inputSchema: schema({ query: { type: 'string' }, ...paging }, ['query']),
  },
  {
    name: 'illustration.sources.read',
    description:
      'Read a frozen attached resource or prior illustration by catalog ID. An omitted path lists fields. Exact JSON pointer paths select passages, paged with textOffset/textLimit or offset/limit. Reads reservation-pinned data only.',
    inputSchema: schema(
      {
        id: { type: 'string' },
        path: { type: 'string' },
        ...paging,
        textOffset: { type: 'integer', minimum: 0 },
        textLimit: { type: 'integer', minimum: 1, maximum: 10000 },
      },
      ['id']
    ),
  },
];

/** Native resource reader shared with helper, operating exclusively on reservation evidence. */
export function illustrationResearch(snapshot: RunSnapshot, input: IllustrationJobInput) {
  const attachments = input.research?.attachments ?? snapshot.profile?.packageAttachments ?? [];
  const documents = (input.research?.packages ?? snapshot.profile?.packages ?? [])
    .filter((item) =>
      attachments.some((ref) => ref.id === item.id && ref.revision === item.revision)
    )
    .map((item, index) => ({
      id: `resource:${index}`,
      revision: item.revision,
      title: item.title,
      role: attachments.find((ref) => ref.id === item.id && ref.revision === item.revision)!.role,
      model: {
        kind: 'bot',
        title: item.title,
        description: item.description,
        text: item.body ?? '',
        loading: 'pinned',
        relatedIds: [],
        package: item,
      } as Omit<Content, 'id' | 'revision'>,
    }));
  const prior = (input.research?.prior ?? []).map((item) => ({
    id: `illustration:${item.id}`,
    revision: null,
    title: item.caption,
    role: 'prior-illustration',
    model: item,
  }));
  const catalog = [...documents, ...prior].map(({ id, revision, title, role }) => ({
    id,
    revision,
    title,
    role,
  }));
  const execute = (name: string, args: Record<string, Json>): Json => {
    if (name === 'illustration.sources.read') {
      fields(args, ['id', 'path', 'offset', 'limit', 'textOffset', 'textLimit']);
      const id = text(args.id, 'source ID', 200);
      const document = [...documents, ...prior].find((entry) => entry.id === id);
      if (!document) throw new Error('Unknown frozen illustration source');
      return readHelperModel(
        document.role === 'prior-illustration' ? 'prompt-workspace' : 'content',
        id,
        document.revision,
        document.title,
        document.model as Parameters<typeof readHelperModel>[4],
        args,
        'frozen-illustration-source'
      ) as Json;
    }
    if (name !== 'illustration.sources.search')
      throw new Error('Read-only illustration tool required');
    fields(args, ['query', 'offset', 'limit']);
    const query = text(args.query, 'query', 10000, true).toLocaleLowerCase();
    const offset = args.offset === undefined ? 0 : number(args.offset, 'offset', 0);
    const limit = args.limit === undefined ? 20 : number(args.limit, 'limit', 1, 50);
    const matches: Json[] = [];
    const walk = (id: string, value: unknown, path: string) => {
      if (typeof value === 'string') {
        const index = value.toLocaleLowerCase().indexOf(query);
        if (index < 0) return;
        const start = Math.max(0, index - 100);
        matches.push({
          id,
          path,
          length: value.length,
          textOffset: start,
          excerpt: value.slice(start, start + 400),
        });
      } else if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value))
          walk(id, child, `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`);
      }
    };
    for (const document of documents) {
      walk(document.id, document.model.package.nativeRisu, '/package/nativeRisu');
      // Legacy packages can carry description/body outside their native card.
      walk(document.id, document.model.text, '/text');
      walk(document.id, document.model.description, '/description');
    }
    for (const document of prior) walk(document.id, document.model, '');
    return {
      matches: matches.slice(offset, offset + limit),
      total: matches.length,
      nextOffset: offset + limit < matches.length ? offset + limit : null,
    };
  };
  return { catalog, execute };
}
