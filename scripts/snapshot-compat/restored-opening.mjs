import { isDeepStrictEqual } from 'node:util';
import { database } from './probes.mjs';

export function restoredOpening(file, chatId) {
  return database(file, (db) => {
    const run = db
      .prepare(
        `SELECT id,COALESCE(json_extract(snapshot,'$.nativeRisuAuthored.greeting')=1,0) AS greeting,
        json_type(snapshot,'$.packageStart') AS start
        FROM runs WHERE chat_id=? ORDER BY created_at,id LIMIT 1`
      )
      .get(chatId);
    if (!run?.greeting || run.start !== null) return null;
    const root = db
      .prepare(
        `WITH RECURSIVE chain(id,parent) AS (
          SELECT id,parent_revision FROM sources WHERE id=(SELECT head_revision FROM chats WHERE id=?)
          UNION ALL SELECT s.id,s.parent_revision FROM sources s JOIN chain c ON s.id=c.parent)
          SELECT s.id FROM chain JOIN sources s ON s.id=chain.id WHERE chain.parent IS NULL AND s.run_id=?`
      )
      .get(chatId, run.id);
    return root ? { runId: run.id, sourceId: root.id } : null;
  });
}

const shifted = (before, after) =>
  Array.isArray(before) &&
  Array.isArray(after) &&
  before.length > 0 &&
  before.length === after.length &&
  before.every(
    (item, i) => Number.isInteger(item?.number) && after[i]?.number === item.number - 1
  ) &&
  after[0].number === 0;

const lostTitle = (before, after) =>
  Array.isArray(before) &&
  Array.isArray(after) &&
  before.some((run, i) => typeof run?.modelTitle === 'string' && after[i]?.modelTitle === null);

const openingTitleOnly = (before, after, { runId }) =>
  before.every(
    (run, i) =>
      isDeepStrictEqual(run.modelTitle, after[i]?.modelTitle) ||
      (run.id === runId &&
        after[i]?.id === runId &&
        run.opening === undefined &&
        after[i].opening === true)
  );

export const restoredOpeningConditions = {
  'restored-opening-manuscript': (a, b, find) =>
    shifted(a.body?.scenes, b.body?.scenes) && find() !== null,
  'restored-opening-reader': (a, b, find) => {
    const navigation = b.body?.reader?.navigation;
    if (!shifted(a.body?.reader?.navigation, navigation)) return false;
    const opening = find();
    return (
      opening !== null &&
      navigation[0].id === opening.sourceId &&
      navigation[0].opening === true &&
      a.body.reader.navigation[0].opening === undefined &&
      Array.isArray(a.body.runs) &&
      Array.isArray(b.body.runs) &&
      openingTitleOnly(a.body.runs, b.body.runs, opening)
    );
  },
  'restored-opening-reader-runs': (a, b, find) => {
    if (!lostTitle(a.body, b.body)) return false;
    const opening = find();
    return opening !== null && openingTitleOnly(a.body, b.body, opening);
  },
  'restored-opening-archive': (a, b, find) => {
    const chats = [a, b].map((r) => r.body?.manifest?.backup?.chats);
    if (!chats.every((list) => Array.isArray(list) && list.length === 1)) return false;
    const [before, after] = chats.map(([chat]) => chat.state?.messages?.[0]);
    if (
      before?.authored?.greeting !== true ||
      before.opening !== undefined ||
      after?.authored !== undefined ||
      after.opening !== true
    )
      return false;
    const opening = find();
    return opening !== null && after.sourceId === opening.sourceId;
  },
};
