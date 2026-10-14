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
      'Read the latest editable stored original or displayed completed translation in this chat ancestry, not rendered HTML. Discover sourceId through chat.read/story tools. Pages use UTF-16 offsets (default limit 6000, max 10000); copy nextRead unchanged. Read every relevant page before full replacement. editTarget contains current save guards, while displayedTranslation identifies the visible previous success during regeneration. Missing translation is an error. Stale pages require restarting.',
    inputSchema: schema({ sourceId, target, ...paging }, ['sourceId', 'target']),
  },
  {
    name: 'scene.patch',
    description:
      'Save one existing original or translation only after the user requests saving. Copy editTarget from scene.read. Supply either complete text or changes of literal oldText/newText. Every oldText must match exactly once in the same pre-edit text; overlapping changes fail atomically. No regex. Source edits invalidate translations and preserve only original plus two recent edits. Translation edits require an existing usable translation. Conflicts require rereading; never overwrite unseen concurrent work.',
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
      'List retained ORIGINAL version metadata (initial original and up to two recent edits), never a full archive. Select versionRevision to read bounded text pages; copy nextRead unchanged. Translation history is not supported. editTarget guards the current original for restore.',
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
  checkGuards(args, editTarget, offset > 0);
  const textHash = digest(content);
  if ((offset > 0 || args.expectedTextHash !== undefined) && args.expectedTextHash !== textHash)
    throw new HttpError(409, 'Scene text changed; restart paging');
  const splitsPair = (index: number) =>
    index > 0 &&
    index < content.length &&
    /[\uD800-\uDBFF]/u.test(content[index - 1]!) &&
    /[\uDC00-\uDFFF]/u.test(content[index]!);
  if (splitsPair(offset)) throw new HttpError(400, 'Text offset splits a Unicode character');
  let end = Math.min(offset + limit, content.length);
  if (splitsPair(end)) end = end === offset + 1 ? end + 1 : end - 1;
  // Reserve room for guards and provenance; control characters can expand sixfold in JSON.
  while (JSON.stringify(content.slice(offset, end)).length > 18000) {
    end = offset + Math.floor((end - offset) / 2);
    if (splitsPair(end)) end--;
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
function replacement(content: string, args: Record<string, unknown>) {
  if ((args.text === undefined) === (args.changes === undefined))
    throw new HttpError(400, 'Supply either complete text or literal changes');
  if (args.text !== undefined) return text(args.text, 'scene text', SOURCE_TEXT_MAX_CHARS);
  if (!Array.isArray(args.changes) || args.changes.length < 1 || args.changes.length > 100)
    throw new HttpError(400, 'Invalid scene changes');
  const changes = args.changes
    .map((value) => {
      const change = record(value);
      fields(change, ['oldText', 'newText']);
      const oldText = text(change.oldText, 'old text', SOURCE_TEXT_MAX_CHARS);
      const newText = text(change.newText, 'new text', SOURCE_TEXT_MAX_CHARS, true);
      const start = content.indexOf(oldText);
      if (start < 0 || content.indexOf(oldText, start + 1) !== -1)
        throw new HttpError(409, 'Each oldText must match exactly once');
      return { start, end: start + oldText.length, newText };
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
