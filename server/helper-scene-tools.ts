import { countTextTokens, textTokenExcerpt } from '../core/text-tokens.js';
import { createHash } from 'node:crypto';
import type { Json, ProviderTool } from '../core/transport.js';
import { SOURCE_TEXT_MAX_CHARS } from '../core/content-limits.js';
import { displayTranslationJob } from '../core/translation-display.js';
import { latestTranslation, sourceVersions } from './source-editing.js';
import { HttpError, choice, fields, number, record, text } from './request-validation.js';
import type { Store } from './store.js';
import { matchHelperText, type HelperTextNormalization } from './helper-resource-editing.js';
import { withHelperChange } from './helper-changes.js';
import { compileEditedSourceText } from './story-ui-assets.js';
import type { HelperTask } from '../core/helper.js';

const schema = (properties: Record<string, Json>, required: string[] = []): Json => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const revision: Json = { type: 'integer', minimum: 0 };
const hash: Json = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const sourceId: Json = {
  type: 'string',
  minLength: 1,
  maxLength: 100,
  description: 'Id of the scene, from chat.read, scene.search or data.search.',
};
const target: Json = {
  type: 'string',
  enum: ['original', 'translation'],
  description: 'Which stored text of the scene: the original or its translation.',
};
const guards = {
  expectedRevision: {
    ...(revision as Record<string, Json>),
    description:
      'Guard from editTarget.expectedRevision of the read or search this call builds on.',
  },
  expectedSourceHash: {
    ...(hash as Record<string, Json>),
    description: 'Guard from editTarget.expectedSourceHash of the same read or search.',
  },
};
const expectedTextHash: Json = {
  ...(hash as Record<string, Json>),
  description: 'Guard from editTarget.expectedTextHash: the hash of the exact text that was read.',
};
const paging = {
  offset: {
    ...(revision as Record<string, Json>),
    description:
      'Start position in the text, in UTF-16 code units. A nonzero offset needs the three guards of the same read; copying nextRead supplies them.',
  },
  limit: {
    type: 'integer',
    minimum: 1,
    maximum: 10000,
    description:
      'Maximum text to return, in UTF-16 code units. Omit to read up to about 3000 tokens.',
  } as Json,
  ...guards,
  expectedTextHash,
};
const mutationRequired = [
  'sourceId',
  'target',
  'expectedRevision',
  'expectedSourceHash',
  'expectedTextHash',
];
const editProperties = {
  chatId: {
    type: 'string',
    minLength: 1,
    maxLength: 100,
    description: 'Chat that owns the scene. Omit for the current chat.',
  } as Json,
  sourceId,
  target,
  ...guards,
  expectedTextHash,
  text: {
    type: 'string',
    minLength: 1,
    maxLength: SOURCE_TEXT_MAX_CHARS,
    description:
      'Complete replacement text. Use either text or changes. Send it only after reading the whole scene.',
  },
  changes: {
    type: 'array',
    minItems: 1,
    maxItems: 100,
    description:
      'Literal replacements, all checked against the same saved text before anything is saved. Use either changes or text.',
    items: schema(
      {
        oldText: {
          type: 'string',
          minLength: 1,
          maxLength: SOURCE_TEXT_MAX_CHARS,
          description: 'Exact existing text, case-sensitive. Whitespace-only text is allowed.',
        },
        newText: {
          type: 'string',
          maxLength: SOURCE_TEXT_MAX_CHARS,
          description: 'Replacement text. An empty string deletes oldText.',
        },
        expectedCount: {
          type: 'integer',
          minimum: 1,
          maximum: 100000,
          description:
            'How many times oldText must occur; all of them are replaced. Default 1. A different count rejects the edit.',
        },
      },
      ['oldText', 'newText']
    ),
  },
};
const patchProperties = {
  ...editProperties,
  translation: {
    ...(schema(editProperties, mutationRequired) as Record<string, Json>),
    description:
      'Only when target is original: a second complete patch for the translation of the same scene, with its own guards from a translation read. Both save together and the translation stays current.',
  },
};
export const HELPER_SCENE_TOOLS: ProviderTool[] = [
  {
    name: 'scene.read',
    description:
      'Read the saved text of one scene in a chat as it can be edited: the original, or the completed translation the reader currently shows. This is the live stored text, not rendered HTML and not the frozen history that story.read returns. Find the sourceId with chat.read, scene.search or data.search. The result includes editTarget with the guards (expectedRevision, expectedSourceHash, expectedTextHash) that scene.patch needs. Long scenes come in pages within about 9000 tokens: copy nextRead for the next page, or pass any offset directly, and read every relevant page before replacing a whole scene. The guards are optional on a read: when they are passed, a scene that changed between pages is reported so it can be read again from the start; without them compare textHash across pages. While a new translation is being generated, displayedTranslation identifies the earlier completed translation that is still shown. Asking for a translation that does not exist is an error.',
    inputSchema: schema({ sourceId, target, ...paging }, ['sourceId', 'target']),
  },
  {
    name: 'scene.search',
    description:
      'Find exact text in the saved scenes of a chat and get what scene.patch needs to change it. Use it to locate a typo, a name or a repeated phrase before an edit; for text in the library or in other chats use data.search. Give sourceId to search one scene, or omit it to search every enabled scene the chat owns, in story order. Patterns are case-sensitive literals unless regex is set. Each match returns the matched text, its UTF-16 position, surrounding context and an editTarget with the save guards. Copy nextSearch for more matches. A whole-chat search needs the searchHash that nextSearch carries, and has to start again if a scene or the story changed in between; a search of one scene accepts any offset directly. Regex matches do not overlap, and a match longer than 1000 characters comes back truncated with its offsets, so read it with scene.read before patching it.',
    inputSchema: schema(
      {
        sourceId: {
          ...(sourceId as Record<string, Json>),
          description: 'Scene to search. Omit to search the whole chat.',
        },
        target,
        patterns: {
          type: 'array',
          minItems: 1,
          maxItems: 8,
          items: { type: 'string', minLength: 1, maxLength: 256 },
          description: 'Texts to find. Case-sensitive literals unless regex is true.',
        },
        regex: {
          type: 'boolean',
          description: 'Treat patterns as case-sensitive Unicode regular expressions.',
        },
        includeDisabled: {
          type: 'boolean',
          description: 'Whole-chat search only: also search disabled scenes.',
        },
        searchHash: {
          ...(hash as Record<string, Json>),
          description: 'Whole-chat continuation guard. Copying nextSearch supplies it.',
        },
        context: {
          type: 'integer',
          minimum: 0,
          maximum: 120,
          description: 'Characters of surrounding text per match. Default 80.',
        },
        offset: {
          type: 'integer',
          minimum: 0,
          description: 'Match offset. Copying nextSearch supplies it together with its guards.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 20,
          description: 'Maximum matches per page. Default 10.',
        },
        ...guards,
        expectedTextHash,
      },
      ['target', 'patterns']
    ),
  },
  {
    name: 'scene.patch',
    description:
      'Save an edit to one saved scene: its original text or its translation. Give either text, a complete replacement, or changes, a list of exact literal replacements. Every oldText must occur exactly expectedCount times in the saved text and the matches must not overlap; all changes are checked against the same pre-edit text and then saved together, or nothing is saved. The three guards come from editTarget in scene.read or scene.search, and they reject the save when the scene changed after it was read. Editing an original makes its existing translation outdated unless you also pass translation, a second complete patch for the translation: then both save together and the translation is kept as a current manual translation. There is no regex replace and no unchecked replace-all. For several scenes at once use scene.patchMany. The result is a short saved receipt, not the scene text.',
    inputSchema: schema(patchProperties, mutationRequired),
  },
  {
    name: 'scene.patchMany',
    description:
      'Save edits to 1-16 different scenes of a chat as one atomic change, for example the same correction found by a whole-chat scene.search. Each item is a complete scene.patch request with its own guards from editTarget, and a scene may appear only once. Either every item saves or nothing does. The result lists each saved scene. Scene edits made this way have no grouped undo; each original keeps its own retained versions for scene.restore.',
    inputSchema: schema(
      {
        items: {
          type: 'array',
          minItems: 1,
          maxItems: 16,
          description: 'One scene.patch request per scene.',
          items: schema(patchProperties, mutationRequired),
        },
      },
      ['items']
    ),
  },
  {
    name: 'scene.versions',
    description:
      'List the earlier versions kept for the original text of one scene, and read one of them. Only the first original and up to two most recent edits are kept, so this is not a full history, and translations have no version history. Without versionRevision it returns the version list; with versionRevision it returns that version in text pages, where copying nextRead continues the read and any offset can be passed directly. The editTarget in the result guards the current original and is what scene.restore needs. Guards are optional on a read; to pass them with an offset, take expectedRevision and expectedSourceHash from editTarget but expectedTextHash from the textHash of the version page being read.',
    inputSchema: schema(
      {
        sourceId,
        versionRevision: {
          ...(revision as Record<string, Json>),
          description: 'Revision of the kept version to read, from the version list. Omit to list.',
        },
        ...paging,
      },
      ['sourceId']
    ),
  },
  {
    name: 'scene.restore',
    description:
      'Bring back one kept earlier version of the original text of a scene. The restored text is saved as a new edit, so the text it replaces becomes a kept version in turn, under the same limit of the first original plus two recent edits. Take versionRevision from scene.versions and the guards from the current editTarget of scene.versions or scene.read. Translations cannot be restored, and the existing translation of the scene becomes outdated as with any original edit.',
    inputSchema: schema(
      {
        sourceId,
        target: {
          type: 'string',
          enum: ['original'],
          description: 'Only original text can be restored. May be omitted.',
        },
        versionRevision: {
          ...(revision as Record<string, Json>),
          description: 'Revision of the kept version to restore, from scene.versions.',
        },
        ...guards,
        expectedTextHash,
      },
      ['sourceId', 'versionRevision', 'expectedRevision', 'expectedSourceHash']
    ),
  },
];

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function helperSceneSource(
  store: Store,
  chatId: string,
  id: string,
  ancestry?: ReadonlySet<string>
) {
  const inAncestry = ancestry
    ? ancestry.has(id)
    : store.history(store.chat(chatId).headRevision).some((item) => item.revision === id);
  if (!inAncestry) throw new HttpError(404, 'Scene is not in the current chat ancestry');
  const source = store.source(id);
  if (source.chatId !== chatId) throw new HttpError(409, 'Scene belongs to another chat');
  return source;
}
function snapshot(
  store: Store,
  chatId: string,
  args: Record<string, unknown>,
  original = false,
  knownOwned = false
) {
  const id = text(args.sourceId, 'source ID', 100);
  const selected = original
    ? 'original'
    : choice(args.target, ['original', 'translation'], 'scene target');
  const source = knownOwned ? store.source(id) : helperSceneSource(store, chatId, id);
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
  required = false
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
  const limit =
    args.limit === undefined
      ? textTokenExcerpt(content.slice(offset), 3_000).text.length || 1
      : number(args.limit, 'text limit', 1, 10000);
  checkGuards(args, editTarget);
  const textHash = digest(content);
  if (args.expectedTextHash !== undefined && args.expectedTextHash !== textHash)
    throw new HttpError(409, 'Scene text changed; restart paging');
  if (offset > content.length) throw new HttpError(400, 'Text offset exceeds scene length');
  if (splitsPair(content, offset))
    throw new HttpError(400, 'Text offset splits a Unicode character');
  let end = Math.min(offset + limit, content.length);
  if (splitsPair(content, end)) end = end === offset + 1 ? end + 1 : end - 1;
  while (countTextTokens(JSON.stringify(content.slice(offset, end))) > 9_000) {
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
                ...(args.limit === undefined ? {} : { limit }),
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
  checkGuards(args, current.editTarget);
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

function searchChatScenes(store: Store, chatId: string, args: Record<string, unknown>) {
  const raw = args.patterns;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 8)
    throw new HttpError(400, 'Invalid search patterns');
  const patterns = raw.map((value) => text(value, 'search pattern', 256));
  const target = choice(args.target, ['original', 'translation'], 'scene target');
  const includeDisabled = args.includeDisabled === true;
  if (args.includeDisabled !== undefined && typeof args.includeDisabled !== 'boolean')
    throw new HttpError(400, 'Invalid includeDisabled');
  const context = args.context === undefined ? 80 : number(args.context, 'search context', 0, 120);
  const offset = args.offset === undefined ? 0 : number(args.offset, 'match offset', 0);
  const limit = args.limit === undefined ? 10 : number(args.limit, 'match limit', 1, 20);
  const chat = store.chat(chatId);
  const history = store.history(chat.headRevision);
  const candidates = history.filter(
    (entry) =>
      (includeDisabled || entry.sceneContext?.sceneEnabled !== false) &&
      store.source(entry.revision).chatId === chatId
  );
  const snapshots = candidates.flatMap((entry) => {
    try {
      return [snapshot(store, chatId, { sourceId: entry.revision, target }, false, true)];
    } catch (error) {
      if (
        target === 'translation' &&
        error instanceof HttpError &&
        error.statusCode === 409 &&
        error.message === 'Scene has no usable completed translation'
      )
        return [];
      throw error;
    }
  });
  const searchHash = digest(
    JSON.stringify({
      chatHead: chat.headRevision,
      target,
      includeDisabled,
      patterns,
      scenes: snapshots.map((item) => item.editTarget),
    })
  );
  if (offset > 0 && args.searchHash === undefined)
    throw new HttpError(400, 'SCENE_SEARCH_GUARDS_REQUIRED: Copy nextSearch or restart');
  if (args.searchHash !== undefined && args.searchHash !== searchHash)
    throw new HttpError(409, 'Scene search changed; restart search');
  const matches: Record<string, unknown>[] = [];
  let totalMatches = 0;
  let matchedScenes = 0;
  for (const current of snapshots) {
    const content = current.content;
    let sceneMatched = false;
    for (const [patternIndex, pattern] of patterns.entries()) {
      for (
        let start = content.indexOf(pattern);
        start !== -1;
        start = content.indexOf(pattern, start + 1)
      ) {
        sceneMatched = true;
        if (totalMatches >= offset && matches.length < limit) {
          const end = start + pattern.length;
          let beforeStart = Math.max(0, start - context);
          let afterEnd = Math.min(content.length, end + context);
          if (splitsPair(content, beforeStart)) beforeStart--;
          if (splitsPair(content, afterEnd)) afterEnd++;
          matches.push({
            editTarget: current.editTarget,
            patternIndex,
            start,
            end,
            match: content.slice(start, end),
            before: content.slice(beforeStart, start),
            after: content.slice(end, afterEnd),
          });
        }
        totalMatches++;
      }
    }
    if (sceneMatched) matchedScenes++;
  }
  const nextOffset = offset + matches.length < totalMatches ? offset + matches.length : null;
  return {
    chatId,
    target,
    searchHash,
    scannedScenes: snapshots.length,
    excludedScenes: history.length - candidates.length,
    unmatchedTranslations: candidates.length - snapshots.length,
    matchedScenes,
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
                chatId,
                target,
                patterns,
                includeDisabled,
                context,
                searchHash,
                offset: nextOffset,
                limit,
              },
            },
          },
  };
}

type SceneTextMatch = { changeIndex: number; normalization: HelperTextNormalization };
function replacement(content: string, args: Record<string, unknown>) {
  if ((args.text === undefined) === (args.changes === undefined))
    throw new HttpError(400, 'Supply either complete text or literal changes');
  const normalizations: SceneTextMatch[] = [];
  if (args.text !== undefined)
    return { content: text(args.text, 'scene text', SOURCE_TEXT_MAX_CHARS), normalizations };
  if (!Array.isArray(args.changes) || args.changes.length < 1 || args.changes.length > 100)
    throw new HttpError(400, 'Invalid scene changes');
  const changes = args.changes
    .flatMap((value, changeIndex) => {
      const change = record(value);
      fields(change, ['oldText', 'newText', 'expectedCount']);
      const oldText = text(change.oldText, 'old text', SOURCE_TEXT_MAX_CHARS, true);
      if (oldText.length === 0) throw new HttpError(400, 'Invalid old text');
      const newText = text(change.newText, 'new text', SOURCE_TEXT_MAX_CHARS, true);
      const expectedCount =
        change.expectedCount === undefined
          ? 1
          : number(change.expectedCount, 'expected count', 1, 100000);
      const match = matchHelperText(content, oldText, expectedCount);
      if (!match.ranges) throw new HttpError(409, 'Scene replacement count mismatch');
      if (match.normalization)
        normalizations.push({ changeIndex, normalization: match.normalization });
      return match.ranges.map((range) => ({ ...range, newText }));
    })
    .sort((a, b) => a.start - b.start);
  if (changes.some((item, index) => index > 0 && item.start < changes[index - 1]!.end))
    throw new HttpError(409, 'Scene changes overlap');
  let result = content;
  for (const change of changes.toReversed())
    result = result.slice(0, change.start) + change.newText + result.slice(change.end);
  return { content: text(result, 'scene text', SOURCE_TEXT_MAX_CHARS), normalizations };
}

export function invokeHelperSceneTool(
  store: Store,
  chatId: string,
  name: string,
  args: Record<string, unknown>,
  task?: Pick<HelperTask, 'id' | 'conversationId'>
): unknown {
  return store.transaction(() => {
    const original = name === 'scene.versions' || name === 'scene.restore';
    const common = ['sourceId', 'expectedRevision', 'expectedSourceHash'];
    if (name === 'scene.read')
      fields(args, [...common, 'target', 'offset', 'limit', 'expectedTextHash']);
    else if (name === 'scene.search')
      fields(args, [
        'includeDisabled',
        'regex',
        'searchHash',
        ...common,
        'target',
        'patterns',
        'context',
        'offset',
        'limit',
        'expectedTextHash',
      ]);
    else if (name === 'scene.patch')
      fields(args, [...common, 'target', 'text', 'changes', 'translation', 'expectedTextHash']);
    else if (name === 'scene.patchMany') {
      fields(args, ['items']);
      if (!Array.isArray(args.items) || args.items.length < 1 || args.items.length > 16)
        throw new HttpError(400, 'Invalid scene batch');
      const seen = new Set<string>();
      const items = args.items.map((value) => {
        const item = record(value);
        fields(item, [
          ...common,
          'chatId',
          'target',
          'text',
          'changes',
          'translation',
          'expectedTextHash',
        ]);
        if (item.chatId !== undefined && item.chatId !== chatId)
          throw new HttpError(409, 'Scene batch chat mismatch');
        const id = text(item.sourceId, 'source ID', 100);
        if (seen.has(id)) throw new HttpError(400, 'Duplicate scene sourceId in batch');
        seen.add(id);
        return item;
      });
      const results = items.map((item, index) => {
        try {
          const { chatId: _itemChatId, ...patch } = item;
          return invokeHelperSceneTool(store, chatId, 'scene.patch', patch, task);
        } catch (error) {
          throw new HttpError(
            error instanceof HttpError ? error.statusCode : 500,
            `Scene batch item ${index} (${item.sourceId}): ${error instanceof Error ? error.message : 'failed'}`
          );
        }
      });
      const receipts = results as { changed: boolean; sourceId: string }[];
      return {
        changed: receipts.some((item) => item.changed),
        sourceIds: receipts.filter((item) => item.changed).map((item) => item.sourceId),
        items: results,
      };
    } else if (name === 'scene.versions')
      fields(args, [...common, 'versionRevision', 'offset', 'limit', 'expectedTextHash']);
    else if (name === 'scene.restore') {
      fields(args, [...common, 'target', 'versionRevision', 'expectedTextHash']);
      if (args.target !== undefined) choice(args.target, ['original'], 'restore target');
    } else throw new HttpError(400, 'Unknown scene tool');
    if (name === 'scene.search' && args.regex === true)
      throw new HttpError(400, 'Regex scene search requires isolated worker');
    if (name === 'scene.search' && args.regex !== undefined && args.regex !== false)
      throw new HttpError(400, 'Invalid regex option');
    if (name === 'scene.search' && args.sourceId === undefined)
      return searchChatScenes(store, chatId, args);
    if (
      name === 'scene.search' &&
      (args.searchHash !== undefined || args.includeDisabled !== undefined)
    )
      throw new HttpError(400, 'Chat-wide search parameters require omitted sourceId');
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
      checkGuards(args, editTarget);
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
    let matches: SceneTextMatch[] = [];
    if (name === 'scene.restore') {
      const version = number(args.versionRevision, 'version revision', 0);
      const retained = sourceVersions(store, source.id).versions.find(
        (item) => item.revision === version
      );
      if (!retained) throw new HttpError(404, 'Original version is no longer retained');
      content = retained.text;
    } else ({ content, normalizations: matches } = replacement(current.content, args));
    let translationEdit:
      | { content: string; changed: boolean; revision: number; matches: SceneTextMatch[] }
      | undefined;
    if (name === 'scene.patch' && args.translation !== undefined) {
      if (current.target !== 'original')
        throw new HttpError(400, 'Translation co-edit requires original target');
      const patch = record(args.translation);
      fields(patch, [...common, 'chatId', 'target', 'text', 'changes', 'expectedTextHash']);
      if (
        patch.sourceId !== source.id ||
        (patch.chatId !== undefined && patch.chatId !== chatId) ||
        patch.target !== 'translation'
      )
        throw new HttpError(400, 'Translation co-edit must target the same scene');
      const translated = snapshot(store, chatId, patch, false, true);
      checkGuards(patch, translated.editTarget, true);
      if (patch.expectedTextHash !== translated.editTarget.expectedTextHash)
        throw new HttpError(409, 'Scene translation changed; read it again');
      const replaced = replacement(translated.content, patch);
      translationEdit = {
        content: replaced.content,
        changed: replaced.content !== translated.content,
        revision: translated.editTarget.expectedRevision,
        matches: replaced.normalizations,
      };
    }
    const changed = content !== current.content;
    let savedRevision = editTarget.expectedRevision;
    let sourceHash = source.hash;
    const tracked = <T>(field: 'original' | 'translation', save: () => T) =>
      withHelperChange(store, task, { domain: 'scene', chatId, sourceId: source.id, field }, save);
    if (changed && current.target === 'original') {
      const saved = tracked('original', () =>
        store.editSource(source.id, {
          text: compileEditedSourceText(store, source.id, content),
          expectedRevision: editTarget.expectedRevision,
        })
      );
      savedRevision = saved.editRevision ?? 0;
      sourceHash = saved.hash;
    } else if (changed && !translationEdit) {
      savedRevision =
        tracked('translation', () =>
          store.editTranslation(source.id, {
            text: content,
            expectedRevision: editTarget.expectedRevision,
            expectedSourceHash: source.hash,
          })
        ).revision ?? 0;
    }
    let translationRevision: number | undefined;
    if (translationEdit && (changed || translationEdit.changed)) {
      translationRevision =
        tracked('translation', () =>
          store.editTranslation(source.id, {
            text: translationEdit.content,
            expectedRevision: translationEdit.revision,
            expectedSourceHash: sourceHash,
          })
        ).revision ?? 0;
    }
    return {
      changed: changed || translationEdit?.changed === true,
      target: current.target,
      sourceId: source.id,
      chatId,
      revision: savedRevision,
      sourceHash,
      translationInvalidated: changed && current.target === 'original' && !translationEdit,
      ...(translationRevision !== undefined ? { translationRevision } : {}),
      ...(matches.length ? { matches } : {}),
      ...(translationEdit?.matches.length ? { translationMatches: translationEdit.matches } : {}),
      editTarget: {
        ...editTarget,
        expectedRevision: savedRevision,
        expectedSourceHash: sourceHash,
        expectedTextHash: digest(content),
      },
      ...(translationEdit
        ? {
            translationEditTarget: {
              chatId,
              sourceId: source.id,
              target: 'translation',
              expectedRevision: translationRevision ?? translationEdit.revision,
              expectedSourceHash: sourceHash,
              expectedTextHash: digest(translationEdit.content),
            },
          }
        : {}),
    };
  });
}
