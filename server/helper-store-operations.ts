import { libraryCategory, libraryOperations } from '#contracts/operations';
import { textTokenExcerpt } from '../core/text-tokens.js';
import { HelperToolError } from './app-errors.js';
import { parseInput } from './endpoint.js';
import type { HelperReadFit } from './helper-read-fit.js';
import { sceneTranslationState } from './helper-scene-tools.js';
import type { HelperWorkspace } from './helper-workspace.js';
import { choice, fields, HttpError, number, record, text } from './request-validation.js';
import { sceneTitle } from './scene-titles.js';
import type { Store } from './store.js';

const CHAT_READ_REQUEST_TOKENS = 200;

export function listHelperChats(store: Store, args: Record<string, unknown>) {
  fields(args, ['query', 'offset', 'limit']);
  const query =
    args.query === undefined ? '' : text(args.query, 'chat query', 200, true).toLowerCase();
  const offset = number(args.offset ?? 0, 'offset', 0);
  const limit = number(args.limit ?? 20, 'limit', 1, 50);
  const all = store.chats().filter((chat) => chat.title.toLowerCase().includes(query));
  const chats = all.slice(offset, offset + limit).map((chat) => ({
    id: chat.id,
    title: chat.title,
    headRevision: chat.headRevision,
    titleRevision: chat.titleRevision,
    lastActivityAt: chat.lastActivityAt,
  }));
  return {
    chats,
    total: all.length,
    nextOffset: offset + chats.length < all.length ? offset + chats.length : null,
  };
}

export function readHelperChatIndex(store: Store, chatId: string, args: Record<string, unknown>) {
  fields(args, ['includePreview', 'includeRequest', 'order', 'offset', 'limit']);
  for (const key of ['includePreview', 'includeRequest'])
    if (args[key] !== undefined && typeof args[key] !== 'boolean')
      throw new HttpError(400, `Invalid ${key}`);
  const order =
    args.order === undefined ? 'oldest' : choice(args.order, ['oldest', 'newest'], 'scene order');
  const offset = number(args.offset ?? 0, 'offset', 0);
  const limit = number(args.limit ?? 50, 'limit', 1, 100);
  const chat = store.chat(chatId);
  const history = store.history(chat.headRevision);
  let visible = 0;
  const numbered = history.map((item) => {
    const sceneEnabled = item.sceneContext?.sceneEnabled !== false;
    if (sceneEnabled) visible++;
    return { item, sceneEnabled, sceneNumber: sceneEnabled ? visible : null };
  });
  const ordered = order === 'newest' ? numbered.reverse() : numbered;
  const request = store.db.prepare(
    'SELECT CASE WHEN COALESCE(sc.request_enabled,1)=0 THEN NULL ELSE COALESCE(sc.request_text,r.request) END AS request FROM sources s JOIN runs r ON r.id=s.run_id LEFT JOIN scene_context sc ON sc.source_id=s.id WHERE s.id=?'
  );
  const messages = ordered
    .slice(offset, offset + limit)
    .map(({ item, sceneEnabled, sceneNumber }) => {
      const source = store.source(item.revision);
      const title = sceneTitle(store, item.revision);
      const requestText = args.includeRequest
        ? (request.get(item.revision)?.request as string | null | undefined)
        : undefined;
      return {
        id: item.revision,
        hash: item.contentHash,
        sceneNumber,
        sceneEnabled,
        requestEnabled: item.sceneContext?.requestEnabled !== false,
        contextRevision: item.sceneContext?.revision ?? 0,
        editRevision: source.editRevision ?? 0,
        translation: sceneTranslationState(store, source),
        originalLength: item.text.length,
        ...(title ? { title } : {}),
        ...(args.includePreview ? { preview: textTokenExcerpt(item.text, 60).text } : {}),
        ...(args.includeRequest
          ? {
              request:
                typeof requestText === 'string'
                  ? textTokenExcerpt(requestText, CHAT_READ_REQUEST_TOKENS).text
                  : null,
            }
          : {}),
      };
    });
  return {
    chat,
    messages,
    total: history.length,
    nextOffset: offset + limit < history.length ? offset + limit : null,
  };
}

export function organizeHelperLibrary(store: Store, args: Record<string, unknown>) {
  const organization = store.libraryOrganization;
  if (args.action === 'read') return organization.snapshot();
  if (args.action === 'create-folder')
    return organization.createFolder(parseInput(libraryOperations.createFolder.input, args.body));
  if (args.action === 'move')
    return organization.move(parseInput(libraryOperations.moveItems.input, args.body));
  if (args.action === 'update-folder' || args.action === 'delete-folder') {
    const { folderId, category, ...body } = record(args.body);
    const expectedCategory = parseInput(libraryCategory, category);
    return args.action === 'delete-folder'
      ? organization.deleteFolder(
          parseInput(libraryOperations.deleteFolder.input, { ...body, id: folderId }),
          expectedCategory
        )
      : organization.updateFolder(
          parseInput(libraryOperations.updateFolder.input, { ...body, id: folderId }),
          expectedCategory
        );
  }
  throw new HelperToolError(400, 'INVALID_LIBRARY_ACTION');
}

export function readHelperArtifact(
  workspace: HelperWorkspace,
  args: Record<string, unknown>,
  fits: HelperReadFit
) {
  const artifact = workspace.artifact(
    text(args.id, 'artifact ID', 100),
    number(args.revision, 'artifact revision')
  );
  const field: unknown = args.field ?? 'text';
  if (field !== 'text' && field !== 'request')
    throw new HelperToolError(400, 'INVALID_ARTIFACT_FIELD');
  const value = artifact[field];
  const offset = number(args.offset ?? 0, 'artifact offset', 0, value.length);
  const boundary = (at: number) =>
    at > 0 && /[\uD800-\uDBFF]/u.test(value[at - 1]) && /[\uDC00-\uDFFF]/u.test(value[at] ?? '')
      ? at - 1
      : at;
  const start = boundary(offset);
  const limit =
    args.limit === undefined
      ? textTokenExcerpt(value.slice(start), 2000).text.length
      : number(args.limit, 'artifact limit', 1, 10000);
  let end = boundary(Math.min(value.length, start + limit));
  if (end === start && start < value.length) end = Math.min(value.length, start + 2);
  const page = () => ({
    id: artifact.id,
    revision: artifact.revision,
    origin: artifact.origin,
    field,
    text: value.slice(start, end),
    range: { start, end, unit: 'utf16-code-unit' },
    totalChars: value.length,
    nextOffset: end < value.length ? end : null,
  });
  while (end - start > 2 && !fits(page()))
    end = boundary(start + Math.max(2, Math.floor((end - start) / 2)));
  return page();
}
