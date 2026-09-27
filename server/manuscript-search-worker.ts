import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import MarkdownIt from 'markdown-it';
import type {
  ManuscriptSearchQuery,
  ManuscriptSearchResult,
  SearchDocument,
  SearchIndexBatch,
  SearchKind,
  SearchMatch,
} from '../core/manuscript-search.js';

// Source execution is also used in focused tests: only native/package runtime imports here.
const input = workerData as {
  path: string;
  operation: 'index' | 'search';
  query?: ManuscriptSearchQuery;
};
const db = new DatabaseSync(input.path, { readOnly: true });
db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN');
const md = new MarkdownIt({ html: true });
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const fold = (text: string) => text.normalize('NFC').toLowerCase();
function plain(text: string): string {
  const withoutPrograms = text.replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/giu, ' ');
  const htmlText = (value: string) =>
    md.utils.unescapeAll(
      value.replace(/<!--[\s\S]*?(?:-->|$)/gu, ' ').replace(/<\/?[a-z][^>]*>/giu, ' ')
    );
  const values: string[] = [];
  for (const token of md.parse(withoutPrograms, {})) {
    if (token.type === 'inline') {
      for (const child of token.children ?? []) {
        if (['text', 'code_inline', 'image'].includes(child.type)) values.push(child.content);
        else if (child.type === 'softbreak' || child.type === 'hardbreak') values.push('\n');
      }
      values.push('\n');
    } else if (token.type === 'html_block') values.push(htmlText(token.content), '\n');
    else if (
      (token.type === 'fence' || token.type === 'code_block') &&
      !/^(?:javascript|js|ts|css|lua|html)\b/iu.test(token.info.trim())
    )
      values.push(token.content, '\n');
  }
  return values
    .join('')
    .normalize('NFC')
    .replace(/[\t\r ]+/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}
function currentDocuments(sourceId: string): SearchDocument[] {
  const row = db
    .prepare(`SELECT s.id,s.chat_id,COALESCE(e.text,s.text) AS text,COALESCE(e.hash,s.hash) AS hash,r.request
    FROM sources s JOIN runs r ON r.id=s.run_id LEFT JOIN source_edits e ON e.source_id=s.id
      AND e.revision=(SELECT MAX(revision) FROM source_edits WHERE source_id=s.id) WHERE s.id=?`)
    .get(sourceId);
  if (!row) return [];
  const result: SearchDocument[] = [];
  const append = (kind: SearchKind, text: string, contentHash: string) => {
    const value = plain(text);
    if (value)
      result.push({ sourceId, chatId: String(row.chat_id), kind, contentHash, text: value });
  };
  append('original', String(row.text), String(row.hash));
  if (row.request) append('request', String(row.request), hash(String(row.request)));
  // The reader retains the previous complete translation while a newer attempt is pending/failed.
  const latest = db
    .prepare(`SELECT id,status,source_hash,revision FROM jobs WHERE source_revision=? AND kind='translation'
    ORDER BY revision DESC,created_at DESC,id DESC LIMIT 1`)
    .get(sourceId);
  if (latest && latest.source_hash === row.hash && latest.status !== 'stale') {
    const translated = db
      .prepare(`SELECT j.status,j.source_hash,r.result FROM jobs j JOIN job_results r ON r.job_id=j.id
      WHERE j.source_revision=? AND j.source_hash=? AND j.kind='translation' AND j.status='completed' AND j.revision<=?
      ORDER BY j.revision DESC,j.created_at DESC,j.id DESC LIMIT 1`)
      .get(sourceId, String(row.hash), Number(latest.revision));
    if (translated) {
      const artifact = JSON.parse(String(translated.result));
      if (
        artifact.sourceRevision === sourceId &&
        artifact.sourceHash === row.hash &&
        typeof artifact.text === 'string' &&
        typeof artifact.mock === 'boolean' &&
        (artifact.manual === undefined || (artifact.manual === true && !artifact.mock)) &&
        Object.keys(artifact).every((key) =>
          ['mock', 'manual', 'text', 'sourceRevision', 'sourceHash'].includes(key)
        )
      )
        append('translation', artifact.text, hash(artifact.text));
    }
  }
  return result;
}
function termsOf(query: string): string[] {
  return [...query.matchAll(/"([^"]+)"|([^\s"]+)/gu)]
    .map((match) => fold(match[1] ?? match[2]))
    .filter(Boolean);
}
function snippet(text: string, terms: string[]): SearchMatch['snippet'] {
  const folded = fold(text);
  const first = Math.min(
    ...terms.map((term) => folded.indexOf(term)).filter((index) => index >= 0)
  );
  const start = Math.max(0, first - 70);
  const end = Math.min(text.length, start + 260);
  const result: SearchMatch['snippet'] = start ? [{ text: '…', match: false }] : [];
  // Case folding may change string length (e.g. dotted I). Never project its offsets into a different string.
  if (folded.length !== text.length)
    return [
      {
        text: `${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`,
        match: false,
      },
    ];
  let at = start;
  while (at < end) {
    const next = terms
      .map((term) => ({ at: folded.indexOf(term, at), term }))
      .filter((item) => item.at >= at && item.at < end)
      .sort((a, b) => a.at - b.at || b.term.length - a.term.length)[0];
    if (!next) {
      result.push({ text: text.slice(at, end), match: false });
      break;
    }
    if (next.at > at) result.push({ text: text.slice(at, next.at), match: false });
    const until = Math.min(end, next.at + next.term.length);
    result.push({ text: text.slice(next.at, until), match: true });
    at = until;
  }
  if (end < text.length) result.push({ text: '…', match: false });
  return result;
}
function search(query: ManuscriptSearchQuery): ManuscriptSearchResult {
  const terms = termsOf(query.query);
  if (!terms.length || terms.length > 16) throw new Error('SEARCH_QUERY_INVALID');
  const revision = String(
    db.prepare("SELECT value FROM app_metadata WHERE key='search-revision'").get()!.value
  );
  const signature = hash(
    JSON.stringify({
      terms,
      scope: query.scope,
      chat: query.chatId,
      bot: query.botId,
      kinds: [...query.kinds].sort(),
    })
  );
  let after = 0;
  if (query.cursor) {
    const cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString());
    if (
      cursor.signature !== signature ||
      cursor.revision !== revision ||
      !Number.isSafeInteger(cursor.after) ||
      cursor.after < 0
    )
      throw new Error('SEARCH_CURSOR_STALE');
    after = cursor.after;
  }
  const scope =
    query.scope === 'chat' ? 'AND b.chat_id=?' : query.scope === 'bot' ? 'AND o.bot_id=?' : '';
  const params: (string | number)[] =
    query.scope === 'chat' ? [query.chatId!] : query.scope === 'bot' ? [query.botId!] : [];
  const long = terms.filter((term) => [...term].length >= 3);
  // The trigram tokenizer folds Unicode independently. Fold verification remains authoritative;
  // dirty rows bypass the index and are projected from the same read transaction.
  const fts = long.length
    ? `AND (EXISTS(SELECT 1 FROM search_dirty_sources d WHERE d.source_id=v.source_id)
    OR v.source_id IN (SELECT d.source_id FROM search_fts f JOIN search_documents d ON d.id=f.rowid WHERE search_fts MATCH ?))`
    : '';
  params.push(after);
  if (long.length) params.push(long.map((term) => `"${term.replaceAll('"', '""')}"`).join(' AND '));
  const rows = db
    .prepare(`WITH RECURSIVE visible(chat_id,branch_id,source_id) AS (
    SELECT b.chat_id,b.id,b.head_revision FROM branches b JOIN chat_organization o ON o.chat_id=b.chat_id
      WHERE b.is_default=1 AND b.head_revision IS NOT NULL ${scope}
    UNION SELECT v.chat_id,v.branch_id,s.parent_revision FROM visible v JOIN sources s ON s.id=v.source_id WHERE s.parent_revision IS NOT NULL
  ), numbered AS (
    SELECT v.*,s.rowid AS ordinal,c.title,o.bot_id,
      SUM(CASE WHEN json_extract(r.snapshot,'$.packageStart.mode')='authored' THEN 0 ELSE 1 END)
        OVER(PARTITION BY v.chat_id,v.branch_id ORDER BY s.rowid) AS scene_number
    FROM visible v JOIN sources s ON s.id=v.source_id JOIN runs r ON r.id=s.run_id
      JOIN chats c ON c.id=v.chat_id JOIN chat_organization o ON o.chat_id=c.id
  ) SELECT v.* FROM numbered v WHERE v.ordinal>? ${fts} ORDER BY v.ordinal LIMIT 201`)
    .all(...params);
  const items: ManuscriptSearchResult['items'] = [];
  const started = performance.now();
  let processed = 0;
  for (const row of rows.slice(0, 200)) {
    const sourceId = String(row.source_id);
    const dirty = db.prepare('SELECT 1 FROM search_dirty_sources WHERE source_id=?').get(sourceId);
    const documents = dirty
      ? currentDocuments(sourceId)
      : (db
          .prepare(
            `SELECT source_id AS sourceId,chat_id AS chatId,kind,content_hash AS contentHash,text FROM search_documents WHERE source_id=?`
          )
          .all(sourceId) as SearchDocument[]);
    const matches = documents
      .filter(
        (doc) =>
          query.kinds.includes(doc.kind) && terms.every((term) => fold(doc.text).includes(term))
      )
      .map((doc) => ({
        kind: doc.kind,
        contentHash: doc.contentHash,
        snippet: snippet(doc.text, terms),
      }));
    if (matches.length) {
      const chosen = matches.find((match) => match.kind !== 'request') ?? matches[0];
      items.push({
        title: String(row.title),
        botId: String(row.bot_id),
        sceneNumber: Number(row.scene_number),
        target: {
          chatId: String(row.chat_id),
          branchId: String(row.branch_id),
          sourceId,
          representation: chosen.kind === 'translation' ? 'translation' : 'original',
          ...(chosen.kind !== 'request' ? { contentHash: chosen.contentHash } : {}),
        },
        matches,
      });
    }
    after = Number(row.ordinal);
    processed++;
    if (items.length >= (query.limit ?? 20) || performance.now() - started > 250) break;
  }
  const more = processed < rows.length;
  const building = !!db.prepare('SELECT 1 FROM search_dirty_sources LIMIT 1').get();
  return {
    items,
    nextCursor: more
      ? Buffer.from(JSON.stringify({ signature, revision, after })).toString('base64url')
      : null,
    coverage: more ? 'partial' : building ? 'building' : 'complete',
  };
}
try {
  if (input.operation === 'index') {
    const rows = db
      .prepare('SELECT source_id,revision FROM search_dirty_sources ORDER BY rowid LIMIT 8')
      .all();
    const batch: SearchIndexBatch = rows.map((row) => ({
      sourceId: String(row.source_id),
      revision: Number(row.revision),
      documents: currentDocuments(String(row.source_id)),
    }));
    parentPort!.postMessage({ result: batch });
  } else parentPort!.postMessage({ result: search(input.query!) });
} catch (error) {
  const message = (error as Error).message;
  parentPort!.postMessage({
    error: ['SEARCH_CURSOR_STALE', 'SEARCH_QUERY_INVALID'].includes(message)
      ? message
      : 'SEARCH_FAILED',
  });
} finally {
  db.close();
}
