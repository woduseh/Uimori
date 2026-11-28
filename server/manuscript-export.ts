import type {
  ManuscriptExportMetadata,
  ManuscriptExportResult,
} from '../core/manuscript-export.js';
import type { Store } from './store.js';
import { HttpError } from './request-validation.js';
import type { ExportManuscript } from '#contracts/operations';
import { AppError } from './app-errors.js';
import { successfulTranslation } from './translation-artifacts.js';

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
    return { id: scene.id, number: sceneNumber };
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

export function exportManuscript(
  store: Store,
  chatId: string,
  { mode, fromScene, toScene, expectedHeadRevision }: Omit<ExportManuscript, 'id'>
): ManuscriptExportResult {
  const chat = store.chat(chatId);
  if (expectedHeadRevision !== chat.headRevision)
    throw new AppError(409, 'MANUSCRIPT_RANGE_CHANGED');
  const scenes = manuscriptScenes(store, chatId, chat.headRevision);
  if (!scenes.length) throw new AppError(400, 'MANUSCRIPT_EMPTY');
  const bound = (value: unknown, fallback: number) => {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 1e9)
      throw new AppError(400, 'MANUSCRIPT_RANGE_INVALID');
    return value;
  };
  const from = bound(fromScene, scenes[0].number);
  const to = bound(toScene, scenes.at(-1)!.number);
  if (
    from > to ||
    !scenes.some((scene) => scene.number === from) ||
    !scenes.some((scene) => scene.number === to)
  )
    throw new AppError(400, 'MANUSCRIPT_RANGE_INVALID');
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
    throw new AppError(409, 'MANUSCRIPT_TRANSLATION_MISSING', {
      scenes: missing.slice(0, 20).join(','),
      total: missing.length,
    });
  const title = chat.title
    .replace(/[<>:"/\\|?*\p{Cc}]/gu, '_')
    .replace(/[. ]+$/gu, '')
    .slice(0, 100);
  const range = fromScene !== undefined || toScene !== undefined ? `-${from}-${to}` : '';
  return {
    title,
    range,
    markdown: `${texts.join('\n\n')}\n`,
  };
}
