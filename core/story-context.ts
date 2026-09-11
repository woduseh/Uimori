import {
  matchSourceSpan,
  readStorySource,
  searchStorySources,
  searchTerms,
  sourceHash,
  sourceSceneScope,
} from './source-history.js';
import { visibleAuthorNotes } from './notes.js';
import type { RunSnapshot, ToolEvent } from './types.js';
import type { ToolAction } from './provider.js';
import { sourceReadRange, sourceRequestView } from './source-context.js';
export const STORY_READ_NAMES = [
  'notes.list',
  'notes.read',
  'story.list',
  'story.search',
  'story.read',
];
const LIST_PREVIEW_CHARS = 160;
export const STORY_RESULT_MAX_BYTES = 24000;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
function boundedRead<T>(start: number, desiredEnd: number, build: (end: number) => T): T {
  let result = build(desiredEnd);
  if (bytes(result) <= STORY_RESULT_MAX_BYTES) return result;
  let low = start;
  let high = desiredEnd;
  if (bytes(build(start)) > STORY_RESULT_MAX_BYTES) throw new Error('RESULT_METADATA_TOO_LARGE');
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (bytes(build(middle)) <= STORY_RESULT_MAX_BYTES) low = middle;
    else high = middle - 1;
  }
  if (low === start && desiredEnd > start) throw new Error('RESULT_METADATA_TOO_LARGE');
  return build(low);
}

function boundedSearch(
  total: number,
  offset: number,
  candidates: unknown[],
  sceneScope?: ReturnType<typeof sourceSceneScope>
) {
  const results: unknown[] = [];
  const result = () => ({
    ...(sceneScope ? { sceneScope } : {}),
    results,
    total,
    nextOffset: offset + results.length < total ? offset + results.length : null,
    ...(results.length < candidates.length
      ? { diagnostics: ['RESULT_BYTE_BUDGET_PAGE_LIMIT'] }
      : {}),
  });
  for (const candidate of candidates) {
    results.push(candidate);
    if (bytes(result()) > STORY_RESULT_MAX_BYTES) {
      results.pop();
      break;
    }
  }
  while (results.length && bytes(result()) > STORY_RESULT_MAX_BYTES) results.pop();
  if (candidates.length && !results.length) throw new Error('RESULT_METADATA_TOO_LARGE');
  return result();
}

/** Ordered ancestry index: position, id, size, a short preview and window membership. */
function listStorySources(snapshot: RunSnapshot, offset: number, limit: number) {
  const compacted = new Set(snapshot.contextPlan?.compacted.map((ref) => ref.revision) ?? []);
  const items = snapshot.history.slice(offset, offset + limit).map((item, pageIndex) => {
    const index = offset + pageIndex;
    const view = snapshot.sourceSegments ? sourceRequestView(snapshot, item.revision) : undefined;
    const text = view?.text ?? item.text;
    const preview = text.replace(/\s+/gu, ' ').trim().slice(0, LIST_PREVIEW_CHARS);
    return {
      sceneNumber: index + 1,
      revision: item.revision,
      index,
      hash: view?.sourceHash ?? item.contentHash ?? sourceHash(item.text),
      chars: text.length,
      preview,
      compacted: compacted.has(item.revision),
    };
  });
  return { total: snapshot.history.length, results: items };
}

/** Search only inside a kept source span: a query cannot cross an omitted hidden region. */
function searchHiddenSources(snapshot: RunSnapshot, query: string, offset: number, limit: number) {
  const terms = searchTerms(query);
  if (!terms.length) throw new Error('QUERY_REQUIRED');
  const matches = snapshot.history.flatMap((item) => {
    const view = sourceRequestView(snapshot, item.revision);
    for (const range of view.keptRanges) {
      const match = matchSourceSpan(item.text.slice(range.start, range.end), terms);
      if (match < 0) continue;
      const start = Math.max(range.start, range.start + match - 60),
        end = Math.min(range.end, start + 240),
        quote = item.text.slice(start, end);
      return [
        {
          revision: item.revision,
          text: quote,
          source: { revision: item.revision, hash: view.sourceHash, start, end, quote },
          truncated: start > 0 || end < item.text.length,
          nextOffset: end < item.text.length ? end : null,
        },
      ];
    }
    return [];
  });
  return {
    results: matches.slice(offset, offset + limit),
    total: matches.length,
    nextOffset: offset + limit < matches.length ? offset + limit : null,
  };
}

export function executeStoryRead(
  snapshot: RunSnapshot,
  action: ToolAction,
  _scoped = true
): ToolEvent {
  const denied = (code: string): ToolEvent => ({
    callId: action.callId,
    name: action.name,
    args: {},
    result: { code },
    denied: true,
  });
  if (!STORY_READ_NAMES.includes(action.name)) return denied('TOOL_NOT_ALLOWED');
  const scope = { chatId: snapshot.chatId, history: snapshot.history },
    args = action.args;
  const search = action.name.endsWith('.search') || action.name.endsWith('.list');
  const allowed =
    action.name === 'story.list'
      ? ['offset', 'limit']
      : search
        ? ['query', 'offset', 'limit']
        : action.name === 'story.read'
          ? ['id', 'sceneNumber', 'offset', 'limit']
          : ['id', 'offset', 'limit'];
  if (Object.keys(args).some((key) => !allowed.includes(key))) return denied('INVALID_ARGUMENTS');
  const offset = args.offset === undefined ? 0 : Number(args.offset),
    limit = args.limit === undefined ? (search ? 20 : 4096) : Number(args.limit);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > (search ? 100 : 16000)
  )
    return denied('INVALID_ARGUMENTS');
  try {
    let result: unknown;
    if (action.name === 'story.list') {
      const listed = listStorySources(snapshot, offset, limit);
      result = boundedSearch(listed.total, offset, listed.results, sourceSceneScope(scope));
    } else if (search) {
      const query = args.query === undefined && action.name === 'notes.list' ? '' : args.query;
      if (typeof query !== 'string' || query.length > 512) return denied('INVALID_ARGUMENTS');
      if (action.name === 'story.search') {
        if (!query.trim()) return denied('INVALID_ARGUMENTS');
        const numbers = new Map(scope.history.map((source, index) => [source.revision, index + 1]));
        const found = snapshot.sourceSegments
          ? searchHiddenSources(snapshot, query, offset, limit)
          : searchStorySources(scope, { query, offset, limit });
        result = boundedSearch(
          found.total,
          offset,
          found.results.map(({ source: { quote: _quote, ...source }, ...item }) => ({
            ...item,
            sceneNumber: numbers.get(source.revision)!,
            source,
          })),
          sourceSceneScope(scope)
        );
      } else {
        const found = visibleAuthorNotes(scope, snapshot.story?.notes ?? []).filter((note) =>
          note.text.includes(query)
        );
        result = boundedSearch(
          found.length,
          offset,
          found.slice(offset, offset + limit).map((note) => ({
            id: note.id,
            chatId: note.chatId,
            kind: note.kind,
            atRevision: note.atRevision,
            atHash: note.atHash,
            author: note.declaration.author,
            excerpt: note.text.slice(0, 240),
            totalChars: note.text.length,
          }))
        );
      }
    } else {
      if (action.name === 'story.read') {
        if (
          (args.id !== undefined && (typeof args.id !== 'string' || args.id.length > 200)) ||
          (args.sceneNumber !== undefined &&
            (!Number.isSafeInteger(args.sceneNumber) || (args.sceneNumber as number) < 1)) ||
          (args.id === undefined && args.sceneNumber === undefined)
        )
          return denied('INVALID_ARGUMENTS');
        const numbered =
          args.sceneNumber === undefined
            ? undefined
            : scope.history[(args.sceneNumber as number) - 1];
        if (args.sceneNumber !== undefined && !numbered) return denied('RESOURCE_UNAVAILABLE');
        if (numbered && args.id !== undefined && args.id !== numbered.revision)
          return denied('INVALID_ARGUMENTS');
        const sourceId = numbered?.revision ?? (args.id as string);
        const sceneNumber = scope.history.findIndex((source) => source.revision === sourceId) + 1;
        const page = readStorySource(scope, { revision: sourceId, offset, limit }),
          { quote: _quote, ...source } = page.source;
        const sceneScope = sourceSceneScope(scope);
        result = boundedRead(offset, page.source.end, (end) => {
          const filtered = snapshot.sourceSegments
            ? sourceReadRange(snapshot, sourceId, offset, end)
            : undefined;
          return {
            sceneNumber,
            sceneScope,
            text: filtered?.text ?? page.text.slice(0, end - offset),
            source: { ...source, end },
            ...(filtered
              ? {
                  keptRanges: filtered.ranges,
                  excludedRanges: filtered.excluded.map((item) => item.range),
                  rangeSemantics: 'source coordinates; text concatenates keptRanges',
                }
              : {}),
            totalChars: page.totalChars,
            truncated: end < page.totalChars,
            nextOffset: end < page.totalChars ? end : null,
          };
        });
      } else {
        if (typeof args.id !== 'string' || args.id.length > 200) return denied('INVALID_ARGUMENTS');
        const note = visibleAuthorNotes(scope, snapshot.story?.notes ?? []).find(
          (note) => note.id === args.id
        );
        if (!note || offset > note.text.length) return denied('RESOURCE_UNAVAILABLE');
        result = boundedRead(offset, Math.min(note.text.length, offset + limit), (end) => ({
          id: note.id,
          kind: note.kind,
          atRevision: note.atRevision,
          atHash: note.atHash,
          author: note.declaration.author,
          text: note.text.slice(offset, end),
          range: { start: offset, end },
          totalChars: note.text.length,
          nextOffset: end < note.text.length ? end : null,
        }));
      }
    }
    return { ...action, args: { ...args, offset, limit }, result, denied: false };
  } catch {
    return denied('RESOURCE_UNAVAILABLE');
  }
}
