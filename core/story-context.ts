import {
  readStorySource,
  searchStorySources,
  sourceHash,
  sourceSceneScope,
} from './source-history.js';
import type { RunSnapshot, ToolEvent } from './types.js';
import type { ToolAction } from './provider.js';

export const STORY_READ_NAMES = ['story.search', 'story.read'];
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
  sceneScope: ReturnType<typeof sourceSceneScope>
) {
  const results: unknown[] = [];
  const result = () => ({
    sceneScope,
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

/** Ordered ancestry index: position, revision/hash, size, preview and window membership. */
function listStorySources(snapshot: RunSnapshot, offset: number, limit: number) {
  const compacted = new Set(snapshot.contextPlan?.compacted.map((ref) => ref.revision) ?? []);
  const results = snapshot.history.slice(offset, offset + limit).map((item, pageIndex) => {
    const index = offset + pageIndex;
    const text = item.text;
    return {
      sceneNumber: index + 1,
      revision: item.revision,
      hash: item.contentHash ?? sourceHash(item.text),
      chars: text.length,
      preview: text.replace(/\s+/gu, ' ').trim().slice(0, LIST_PREVIEW_CHARS),
      compacted: compacted.has(item.revision),
    };
  });
  return { total: snapshot.history.length, results };
}

export function executeStoryRead(snapshot: RunSnapshot, action: ToolAction): ToolEvent {
  const denied = (code: string): ToolEvent => ({
    callId: action.callId,
    name: action.name,
    args: {},
    result: { code },
    denied: true,
  });
  if (!STORY_READ_NAMES.includes(action.name)) return denied('TOOL_NOT_ALLOWED');

  const scope = { chatId: snapshot.chatId, history: snapshot.history };
  const args = action.args;
  const search = action.name === 'story.search';
  const allowed = search ? ['query', 'offset', 'limit'] : ['sceneNumber', 'offset', 'limit'];
  if (Object.keys(args).some((key) => !allowed.includes(key))) return denied('INVALID_ARGUMENTS');

  const offset = args.offset === undefined ? 0 : Number(args.offset);
  const limit = args.limit === undefined ? (search ? 20 : 4096) : Number(args.limit);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > (search ? 100 : 16000)
  )
    return denied('INVALID_ARGUMENTS');

  try {
    if (search) {
      if (args.query !== undefined && (typeof args.query !== 'string' || args.query.length > 512))
        return denied('INVALID_ARGUMENTS');
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) {
        const listed = listStorySources(snapshot, offset, limit);
        return {
          ...action,
          args: { query: '', offset, limit },
          result: boundedSearch(listed.total, offset, listed.results, sourceSceneScope(scope)),
          denied: false,
        };
      }

      const numbers = new Map(scope.history.map((source, index) => [source.revision, index + 1]));
      const found = searchStorySources(scope, { query, offset, limit });
      return {
        ...action,
        args: { query, offset, limit },
        result: boundedSearch(
          found.total,
          offset,
          found.results.map(({ source: { quote: _quote, ...source }, ...item }) => ({
            ...item,
            sceneNumber: numbers.get(source.revision)!,
            source,
          })),
          sourceSceneScope(scope)
        ),
        denied: false,
      };
    }

    if (!Number.isSafeInteger(args.sceneNumber) || (args.sceneNumber as number) < 1)
      return denied('INVALID_ARGUMENTS');
    const numbered = scope.history[(args.sceneNumber as number) - 1];
    if (!numbered) return denied('RESOURCE_UNAVAILABLE');

    const page = readStorySource(scope, { revision: numbered.revision, offset, limit });
    const { quote: _quote, ...source } = page.source;
    const sceneScope = sourceSceneScope(scope);
    const result = boundedRead(offset, page.source.end, (end) => ({
      sceneNumber: args.sceneNumber,
      sceneScope,
      text: page.text.slice(0, end - offset),
      source: { ...source, end },
      totalChars: page.totalChars,
      nextOffset: end < page.totalChars ? end : null,
    }));
    return {
      ...action,
      args: { sceneNumber: args.sceneNumber, offset, limit },
      result,
      denied: false,
    };
  } catch {
    return denied('RESOURCE_UNAVAILABLE');
  }
}
