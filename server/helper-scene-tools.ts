import { createHash } from 'node:crypto';
import type { Json, ProviderTool } from '../core/transport.js';
import { SOURCE_TEXT_MAX_CHARS } from '../core/content-limits.js';
import { displayTranslationJob } from '../core/translation-display.js';
import { latestTranslation, sourceVersions } from './source-editing.js';
import { HttpError, choice, fields, number, record, text } from './request-validation.js';
import type { Store } from './store.js';

const schema = (properties: Record<string, Json>, required: string[] = []): Json => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const revision: Json = { type: 'integer', minimum: 0 };
const hash: Json = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const sourceId: Json = { type: 'string', minLength: 1, maxLength: 100 };
const target: Json = { type: 'string', enum: ['original', 'translation'] };
const guards = { expectedRevision: revision, expectedSourceHash: hash };
const paging = {
  offset: revision,
  limit: { type: 'integer', minimum: 1, maximum: 10000 } as Json,
  ...guards,
  expectedTextHash: hash,
};
const mutationRequired = [
  'sourceId',
  'target',
  'expectedRevision',
  'expectedSourceHash',
  'expectedTextHash',
];
export const HELPER_SCENE_TOOLS: ProviderTool[] = [
  {
    name: 'scene.read',
    description:
      'Read the latest editable stored original or displayed completed translation in this chat ancestry, not rendered HTML. Discover sourceId through chat.read/story tools. Pages use UTF-16 offsets (default limit 6000, max 10000); copy nextRead unchanged for sequential pages. For a nonzero offset or random access, pass all three guards (expectedRevision, expectedSourceHash, expectedTextHash) from the same scene.read result. Read every relevant page before full replacement. editTarget contains current save guards, while displayedTranslation identifies the visible previous success during regeneration. Missing translation is an error. Stale pages require restarting.',
    inputSchema: schema({ sourceId, target, ...paging }, ['sourceId', 'target']),
  },
  {
    name: 'scene.search',
    description:
      'Search the live editable original or displayed translation by exact case-sensitive literal patterns (including overlapping matches). Return match positions, bounded context, total counts per pattern, and editTarget guards for scene.patch; no full-scene read required. Results are ordered by pattern then text offset; offset paginates matches, not characters. Copy nextSearch unchanged for later pages; stale versions require restarting. No regex.',
    inputSchema: schema(
      {
        sourceId,
        target,
        patterns: {
          type: 'array',
          minItems: 1,
          maxItems: 8,
          items: { type: 'string', minLength: 1, maxLength: 256 },
        },
        context: { type: 'integer', minimum: 0, maximum: 120 },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
        ...guards,
        expectedTextHash: hash,
      },
      ['sourceId', 'target', 'patterns']
    ),
  },
  {
    name: 'scene.patch',
    description:
      'Save one existing original or translation only after the user requests saving. Copy editTarget from scene.read/search. Supply either complete text or changes of literal oldText/newText. Each oldText must occur exactly expectedCount times (default 1); replace all occurrences atomically only if their ranges do not overlap, including matches within the same change. No regex or unchecked replace-all. Source edits invalidate translations and preserve only original plus two recent edits. Translation edits require an existing usable translation. Conflicts require rereading; never overwrite unseen concurrent work.',
    inputSchema: schema(
      {
        sourceId,
        target,
        ...guards,
        expectedTextHash: hash,
        text: { type: 'string', minLength: 1, maxLength: SOURCE_TEXT_MAX_CHARS },
        changes: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          items: schema(
            {
              oldText: { type: 'string', minLength: 1, maxLength: SOURCE_TEXT_MAX_CHARS },
              newText: { type: 'string', maxLength: SOURCE_TEXT_MAX_CHARS },
              expectedCount: { type: 'integer', minimum: 1, maximum: 100000 },
            },
            ['oldText', 'newText']
          ),
        },
      },
      mutationRequired
    ),
  },
  {
    name: 'scene.versions',
    description:
      'List retained ORIGINAL version metadata (initial original and up to two recent edits), never a full archive. Select versionRevision to read bounded text pages; copy nextRead unchanged. For random access, copy the source revision/hash from editTarget and expectedTextHash from the selected version page textHash (not editTarget.expectedTextHash for the current original). Translation history is not supported. editTarget guards the current original for restore.',
    inputSchema: schema({ sourceId, versionRevision: revision, ...paging }, ['sourceId']),
  },
  {
    name: 'scene.restore',
    description:
      'Restore one retained ORIGINAL version after the user asks. Use current editTarget guards from scene.versions/read and versionRevision from the retained list. Saves as a new edit through ordinary source editing and retention; no historical rows are deleted beyond ordinary retention. Translation restore is not supported.',
    inputSchema: schema(
      {
        sourceId,
        target: { type: 'string', enum: ['original'] },
        versionRevision: revision,
        ...guards,
        expectedTextHash: hash,
      },
      ['sourceId', 'versionRevision', 'expectedRevision', 'expectedSourceHash']
    ),
  },
];

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function scopedSource(store: Store, chatId: string, id: string) {
  const chat = store.chat(chatId);
  // Fork ancestry can contain another chat's originals: those are readable through story
  // tools, but direct editing must never mutate the fork's shared parent.
  if (!store.history(chat.headRevision).some((item) => item.revision === id))
    throw new HttpError(404, 'Scene is not in the current chat ancestry');
  const source = store.source(id);
  if (source.chatId !== chatId) throw new HttpError(409, 'Scene belongs to another chat');
  return source;
}
function snapshot(store: Store, chatId: string, args: Record<string, unknown>, original = false) {
  const id = text(args.sourceId, 'source ID', 100);
  const selected = original
    ? 'original'
    : choice(args.target, ['original', 'translation'], 'scene target');
  const source = scopedSource(store, chatId, id);
  const latest = selected === 'translation' ? latestTranslation(store, id) : null;
  const displayed = latest ? displayTranslationJob(source, latest) : undefined;
  if (selected === 'translation' && typeof displayed?.result?.text !== 'string')
    throw new HttpError(409, 'Scene has no usable completed translation');
  const content = selected === 'original' ? source.text : displayed!.result!.text!;
  return {
    source,
    latest,
    displayed,
    target: selected,
    content,
    editTarget: {
      chatId,
      sourceId: id,
      target: selected,
      expectedRevision:
        selected === 'original' ? (source.editRevision ?? 0) : (latest!.revision ?? 0),
      expectedSourceHash: source.hash,
      expectedTextHash: digest(content),
    },
  };
}
function checkGuards(
  args: Record<string, unknown>,
  expected: { expectedRevision: number; expectedSourceHash: string },
  required: boolean
) {
  if (!required && args.expectedRevision === undefined && args.expectedSourceHash === undefined)
    return;
  const rev = number(args.expectedRevision, 'scene revision', 0);
  const sourceHash = text(args.expectedSourceHash, 'source hash', 64);
  if (rev !== expected.expectedRevision || sourceHash !== expected.expectedSourceHash)
    throw new HttpError(409, 'Scene changed; read the current scene again');
}
function splitsPair(content: string, index: number) {
  return (
    index > 0 &&
    index < content.length &&
    /[\uD800-\uDBFF]/u.test(content[index - 1]!) &&
    /[\uDC00-\uDFFF]/u.test(content[index]!)
  );
}

function page(
  content: string,
  args: Record<string, unknown>,
  editTarget: ReturnType<typeof snapshot>['editTarget'],
  readArgs: Record<string, unknown>,
  chatId: string,
  name: string
) {
  const offset =
    args.offset === undefined ? 0 : number(args.offset, 'text offset', 0, SOURCE_TEXT_MAX_CHARS);
  const limit = args.limit === undefined ? 6000 : number(args.limit, 'text limit', 1, 10000);
  if (
    offset > 0 &&
    (args.expectedRevision === undefined ||
      args.expectedSourceHash === undefined ||
      args.expectedTextHash === undefined)
  )
    throw new HttpError(
      400,
      'SCENE_PAGE_GUARDS_REQUIRED: Nonzero offset requires expectedRevision, expectedSourceHash and expectedTextHash from the same text page (use editTarget.expectedRevision, editTarget.expectedSourceHash and page.textHash). Copy nextRead or restart at offset=0.'
    );
  checkGuards(args, editTarget, offset > 0);
  const textHash = digest(content);
  if ((offset > 0 || args.expectedTextHash !== undefined) && args.expectedTextHash !== textHash)
    throw new HttpError(409, 'Scene text changed; restart paging');
  if (offset > content.length) throw new HttpError(400, 'Text offset exceeds scene length');
  if (splitsPair(content, offset))
    throw new HttpError(400, 'Text offset splits a Unicode character');
  let end = Math.min(offset + limit, content.length);
  if (splitsPair(content, end)) end = end === offset + 1 ? end + 1 : end - 1;
  // Reserve room for guards and provenance; control characters can expand sixfold in JSON.
  while (JSON.stringify(content.slice(offset, end)).length > 18000) {
    end = offset + Math.floor((end - offset) / 2);
    if (splitsPair(content, end)) end--;
  }
  const nextOffset = end < content.length ? end : null;
  return {
    text: content.slice(offset, end),
    offset,
    totalLength: content.length,
    textHash,
    nextOffset,
    nextRead:
      nextOffset === null
        ? null
        : {
            name: 'app.call',
            arguments: {
              name,
              arguments: {
                ...readArgs,
                ...editTarget,
                chatId,
                offset: nextOffset,
                limit,
                expectedTextHash: textHash,
              },
            },
          },
  };
}
function sceneSearch(current: ReturnType<typeof snapshot>, args: Record<string, unknown>) {
  const raw = args.patterns;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 8)
    throw new HttpError(400, 'Invalid search patterns');
  const patterns = raw.map((value) => text(value, 'search pattern', 256));
  const context = args.context === undefined ? 80 : number(args.context, 'search context', 0, 120);
  const offset = args.offset === undefined ? 0 : number(args.offset, 'match offset', 0);
  const limit = args.limit === undefined ? 10 : number(args.limit, 'match limit', 1, 20);
  if (
    offset > 0 &&
    (args.expectedRevision === undefined ||
      args.expectedSourceHash === undefined ||
      args.expectedTextHash === undefined)
  )
    throw new HttpError(
      400,
      'SCENE_SEARCH_GUARDS_REQUIRED: Copy nextSearch or search again from offset=0'
    );
  checkGuards(args, current.editTarget, offset > 0);
  if (
    args.expectedTextHash !== undefined &&
    args.expectedTextHash !== current.editTarget.expectedTextHash
  )
    throw new HttpError(409, 'Scene text changed; restart search');
  const content = current.content;
  const matches: {
    patternIndex: number;
    start: number;
    end: number;
    match: string;
    before: string;
    after: string;
  }[] = [];
  const counts: { pattern: string; count: number }[] = [];
  let totalMatches = 0;
  for (const [patternIndex, pattern] of patterns.entries()) {
    let count = 0;
    for (
      let start = content.indexOf(pattern);
      start !== -1;
      start = content.indexOf(pattern, start + 1)
    ) {
      if (totalMatches >= offset && matches.length < limit) {
        const end = start + pattern.length;
        let beforeStart = Math.max(0, start - context);
        let afterEnd = Math.min(content.length, end + context);
        if (splitsPair(content, beforeStart)) beforeStart--;
        if (splitsPair(content, afterEnd)) afterEnd++;
        matches.push({
          patternIndex,
          start,
          end,
          match: content.slice(start, end),
          before: content.slice(beforeStart, start),
          after: content.slice(end, afterEnd),
        });
      }
      count++;
      totalMatches++;
    }
    counts.push({ pattern, count });
  }
  const nextOffset = offset + matches.length < totalMatches ? offset + matches.length : null;
  return {
    editTarget: current.editTarget,
    totalLength: content.length,
    counts,
    totalMatches,
    offset,
    matches,
    nextOffset,
    nextSearch:
      nextOffset === null
        ? null
        : {
            name: 'app.call',
            arguments: {
              name: 'scene.search',
              arguments: {
                ...current.editTarget,
                patterns,
                context,
                offset: nextOffset,
                limit,
              },
            },
          },
  };
}

function replacement(content: string, args: Record<string, unknown>) {
  if ((args.text === undefined) === (args.changes === undefined))
    throw new HttpError(400, 'Supply either complete text or literal changes');
  if (args.text !== undefined) return text(args.text, 'scene text', SOURCE_TEXT_MAX_CHARS);
  if (!Array.isArray(args.changes) || args.changes.length < 1 || args.changes.length > 100)
    throw new HttpError(400, 'Invalid scene changes');
  const changes = args.changes
    .flatMap((value) => {
      const change = record(value);
      fields(change, ['oldText', 'newText', 'expectedCount']);
      const oldText = text(change.oldText, 'old text', SOURCE_TEXT_MAX_CHARS, true);
      if (oldText.length === 0) throw new HttpError(400, 'Invalid old text');
      const newText = text(change.newText, 'new text', SOURCE_TEXT_MAX_CHARS, true);
      const expectedCount =
        change.expectedCount === undefined
          ? 1
          : number(change.expectedCount, 'expected count', 1, 100000);
      const matches: { start: number; end: number; newText: string }[] = [];
      for (
        let start = content.indexOf(oldText);
        start !== -1;
        start = content.indexOf(oldText, start + 1)
      ) {
        matches.push({ start, end: start + oldText.length, newText });
        if (matches.length > expectedCount) break;
      }
      if (matches.length !== expectedCount)
        throw new HttpError(409, 'Scene replacement count mismatch');
      return matches;
    })
    .sort((a, b) => a.start - b.start);
  if (changes.some((item, index) => index > 0 && item.start < changes[index - 1]!.end))
    throw new HttpError(409, 'Scene changes overlap');
  let result = content;
  for (const change of changes.toReversed())
    result = result.slice(0, change.start) + change.newText + result.slice(change.end);
  return text(result, 'scene text', SOURCE_TEXT_MAX_CHARS);
}

export function invokeHelperSceneTool(
  store: Store,
  chatId: string,
  name: string,
  args: Record<string, unknown>
): unknown {
  return store.transaction(() => {
    const original = name === 'scene.versions' || name === 'scene.restore';
    const common = ['sourceId', 'expectedRevision', 'expectedSourceHash'];
    if (name === 'scene.read')
      fields(args, [...common, 'target', 'offset', 'limit', 'expectedTextHash']);
    else if (name === 'scene.search')
      fields(args, [
        ...common,
        'target',
        'patterns',
        'context',
        'offset',
        'limit',
        'expectedTextHash',
      ]);
    else if (name === 'scene.patch')
      fields(args, [...common, 'target', 'text', 'changes', 'expectedTextHash']);
    else if (name === 'scene.versions')
      fields(args, [...common, 'versionRevision', 'offset', 'limit', 'expectedTextHash']);
    else if (name === 'scene.restore') {
      fields(args, [...common, 'target', 'versionRevision', 'expectedTextHash']);
      if (args.target !== undefined) choice(args.target, ['original'], 'restore target');
    } else throw new HttpError(400, 'Unknown scene tool');
    const current = snapshot(store, chatId, args, original);
    const { source, editTarget } = current;
    if (name === 'scene.read')
      return {
        chatId,
        editTarget,
        representation: 'editable-stored-text',
        ...(current.displayed
          ? {
              displayedTranslation: {
                jobId: current.displayed.id,
                revision: current.displayed.revision,
                latestJobId: current.latest!.id,
                latestStatus: current.latest!.status,
              },
            }
          : {}),
        ...page(
          current.content,
          args,
          editTarget,
          { sourceId: source.id, target: current.target },
          chatId,
          name
        ),
      };
    if (name === 'scene.search') return sceneSearch(current, args);
    if (name === 'scene.versions') {
      checkGuards(args, editTarget, false);
      const retained = sourceVersions(store, source.id);
      if (args.versionRevision === undefined)
        return {
          chatId,
          editTarget,
          versions: retained.versions.map(({ revision, createdAt, text: content }) => ({
            revision,
            createdAt,
            length: content.length,
            current: revision === retained.currentRevision,
          })),
        };
      const version = retained.versions.find(
        (item) => item.revision === number(args.versionRevision, 'version revision', 0)
      );
      if (!version) throw new HttpError(404, 'Original version is no longer retained');
      const paged = page(
        version.text,
        args,
        editTarget,
        {
          sourceId: source.id,
          versionRevision: version.revision,
        },
        chatId,
        name
      );
      // target is implicit for this original-only tool, so its nextRead must remain schema-valid.
      if (paged.nextRead)
        delete (paged.nextRead.arguments.arguments as Record<string, unknown>).target;
      return { chatId, editTarget, versionRevision: version.revision, ...paged };
    }
    checkGuards(args, editTarget, true);
    if (
      (name === 'scene.patch' || args.expectedTextHash !== undefined) &&
      args.expectedTextHash !== editTarget.expectedTextHash
    )
      throw new HttpError(409, 'Scene text changed; read the current scene again');
    let content: string;
    if (name === 'scene.restore') {
      const version = number(args.versionRevision, 'version revision', 0);
      const retained = sourceVersions(store, source.id).versions.find(
        (item) => item.revision === version
      );
      if (!retained) throw new HttpError(404, 'Original version is no longer retained');
      content = retained.text;
    } else content = replacement(current.content, args);
    const changed = content !== current.content;
    let savedRevision = editTarget.expectedRevision;
    let sourceHash = source.hash;
    if (changed && current.target === 'original') {
      const saved = store.editSource(source.id, {
        text: content,
        expectedRevision: editTarget.expectedRevision,
      });
      savedRevision = saved.editRevision ?? 0;
      sourceHash = saved.hash;
    } else if (changed) {
      savedRevision =
        store.editTranslation(source.id, {
          text: content,
          expectedRevision: editTarget.expectedRevision,
          expectedSourceHash: source.hash,
        }).revision ?? 0;
    }
    return {
      changed,
      target: current.target,
      sourceId: source.id,
      chatId,
      revision: savedRevision,
      sourceHash,
      translationInvalidated: changed && current.target === 'original',
    };
  });
}
