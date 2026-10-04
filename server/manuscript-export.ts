import type {
  ManuscriptExportMetadata,
  ManuscriptExportResult,
} from '../core/manuscript-export.js';
import type { Store } from './store.js';
import { choice, fields, HttpError, number, record } from './request-validation.js';
import { successfulTranslation } from './translation-artifacts.js';

/** Follow the active branch without loading source bodies or execution snapshots. */
function manuscriptScenes(store: Store, chatId: string, head: string | null) {
  const read =
    store.db.prepare(`SELECT s.id,s.chat_id AS chatId,s.parent_revision AS parentRevision,
    json_extract(r.snapshot,'$.packageStart.mode') AS startMode
    FROM sources s JOIN runs r ON r.id=s.run_id WHERE s.id=?`);
  const chain: { id: string; opening: boolean }[] = [];
  const seen = new Set<string>();
  while (head) {
    if (seen.has(head)) throw new HttpError(400, 'Source ancestry cycle');
    seen.add(head);
    const row = read.get(head) as
      | { id: string; chatId: string; parentRevision: string | null; startMode: string | null }
      | undefined;
    if (!row) throw new HttpError(404, 'Source not found');
    if (row.chatId !== chatId) throw new HttpError(400, 'Source outside chat');
    chain.push({ id: row.id, opening: row.startMode === 'authored' });
    head = row.parentRevision;
  }
  let sceneNumber = 0;
  return chain.reverse().map((scene) => {
    if (!scene.opening) sceneNumber++;
    return {
      id: scene.id,
      number: sceneNumber,
      label: scene.opening ? '첫 메시지' : `장면 ${sceneNumber}`,
    };
  });
}

export function manuscriptExportMetadata(store: Store, chatId: string): ManuscriptExportMetadata {
  const chat = store.chat(chatId);
  return {
    title: chat.title,
    headRevision: chat.headRevision,
    scenes: manuscriptScenes(store, chatId, chat.headRevision).map(
      ({ id: _id, ...scene }) => scene
    ),
  };
}

/** Reading export only: no requests, notes, model calls or stored-data changes. */
export function exportManuscript(
  store: Store,
  chatId: string,
  value: unknown
): ManuscriptExportResult {
  const body = record(value);
  fields(body, ['mode', 'fromScene', 'toScene', 'expectedHeadRevision']);
  const mode = choice(body.mode, ['source', 'translation'], 'manuscript mode');
  const chat = store.chat(chatId);
  if (body.expectedHeadRevision !== chat.headRevision)
    throw new HttpError(409, 'MANUSCRIPT_RANGE_CHANGED');
  const scenes = manuscriptScenes(store, chatId, chat.headRevision);
  if (!scenes.length) throw new HttpError(400, 'MANUSCRIPT_EMPTY');
  for (const bound of [body.fromScene, body.toScene])
    if (bound !== undefined && (!Number.isSafeInteger(bound) || bound < 0 || bound > 1e9))
      throw new HttpError(400, 'MANUSCRIPT_RANGE_INVALID');
  const from =
    body.fromScene === undefined ? scenes[0].number : number(body.fromScene, 'start scene', 0);
  const to =
    body.toScene === undefined ? scenes.at(-1)!.number : number(body.toScene, 'end scene', 0);
  if (
    from > to ||
    !scenes.some((scene) => scene.number === from) ||
    !scenes.some((scene) => scene.number === to)
  )
    throw new HttpError(400, 'MANUSCRIPT_RANGE_INVALID');
  const selected = scenes.filter((scene) => scene.number >= from && scene.number <= to);
  const selectedIds = new Set(selected.map((scene) => scene.id));
  const history = store.history(chat.headRevision).filter((item) => selectedIds.has(item.revision));
  const sceneNumbers = new Map(selected.map((scene) => [scene.id, scene.number]));
  const missing: number[] = [];
  const texts = history.map((item) => {
    if (mode === 'source') return item.text;
    const source = store.sourceMetadata(item.revision);
    const job = successfulTranslation(store, source);
    const result = job?.result;
    if (
      !result ||
      result.sourceRevision !== source.id ||
      result.sourceHash !== source.hash ||
      typeof result.text !== 'string' ||
      !result.text.trim()
    ) {
      missing.push(sceneNumbers.get(item.revision)!);
      return '';
    }
    return result.text;
  });
  if (missing.length)
    throw new HttpError(
      409,
      `MANUSCRIPT_TRANSLATION_MISSING:${missing.slice(0, 20).join(',')}:${missing.length}`
    );
  const name =
    chat.title
      .replace(/[<>:"/\\|?*\p{Cc}]/gu, '_')
      .replace(/[. ]+$/gu, '')
      .slice(0, 100) || '원고';
  const range = body.fromScene !== undefined || body.toScene !== undefined ? `-${from}-${to}` : '';
  return {
    filename: `${name}${range}-${mode === 'source' ? '원문' : '번역'}.md`,
    markdown: `${texts.join('\n\n')}\n`,
  };
}
