import { DatabaseSync, constants, type SQLInputValue } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { HelperTaskSnapshot } from '../core/helper.js';

// Only Node builtins are runtime imports: this entry also runs under Node's TS stripping in tests.
export type DataScope = 'current' | 'library' | 'chats' | 'editor';
export type DataRef = {
  scope: DataScope;
  kind: string;
  id: string;
  revision: number | string;
  field: string;
  hash: string;
  chatId?: string;
  branchId?: string;
};
export type DataOperation = {
  path: string;
  taskId: string;
  name: 'data.search' | 'data.read' | 'db.query';
  args: Record<string, unknown>;
};
type Document = Omit<DataRef, 'field' | 'hash'> & {
  title: string;
  origin: string;
  fields: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};
const MAX_RESULT_CHARS = 16_000;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const fold = (value: string) => value.normalize('NFKC').toLocaleLowerCase('en');
const object = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('DATA_OBJECT_REQUIRED');
  return value as Record<string, any>;
};
const number = (value: unknown, fallback: number, max: number, min = 0) => {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || Number(n) < min || Number(n) > max)
    throw new Error('DATA_RANGE_INVALID');
  return Number(n);
};
const string = (value: unknown, fallback = '', max = 512) => {
  const s = value ?? fallback;
  if (typeof s !== 'string' || s.length > max) throw new Error('DATA_STRING_INVALID');
  return s;
};
const only = (args: Record<string, unknown>, keys: string[]) => {
  if (Object.keys(args).some((key) => !keys.includes(key)))
    throw new Error('DATA_UNKNOWN_ARGUMENT');
};
const strings = (value: unknown, max: number): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) throw new Error('DATA_LIST_INVALID');
  return value.map((item) => string(item));
};
const pointer = (key: string) => key.replaceAll('~', '~0').replaceAll('/', '~1');
function* fields(value: unknown, path = ''): Generator<[string, string]> {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    yield [path, String(value)];
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value))
      yield* fields(child, `${path}/${pointer(key)}`);
  }
}
function authored(model: Record<string, any>): Record<string, unknown> {
  const native = model.package?.nativeRisu;
  if (native)
    return {
      title: model.title ?? model.package.title,
      card: native.card ?? {},
      ...(native.module ? { module: native.module } : {}),
    };
  return model.program
    ? { title: model.title, program: model.program, values: model.values }
    : model;
}
function installViews(db: DatabaseSync) {
  db.exec(`
    CREATE TEMP VIEW agent_resources AS
      SELECT v.id,v.revision,json_extract(v.body,'$.kind') kind,json_extract(v.body,'$.title') title,
        json_extract(v.body,'$.description') description,
        json_object('card',json_extract(v.body,'$.package.nativeRisu.card'),
                    'module',json_extract(v.body,'$.package.nativeRisu.module')) document
      FROM versions v WHERE v.kind='content' AND NOT EXISTS
        (SELECT 1 FROM library_hidden h WHERE h.kind=v.kind AND h.id=v.id)
      UNION ALL
      SELECT v.id,v.revision,'prompt',json_extract(v.body,'$.title'),'Saved prompt',
        json_object('program',json_extract(v.body,'$.program'),'values',json_extract(v.body,'$.values'))
      FROM versions v WHERE v.kind='prompt-preset' AND NOT EXISTS
        (SELECT 1 FROM library_hidden h WHERE h.kind=v.kind AND h.id=v.id);
    CREATE TEMP VIEW agent_chats AS
      SELECT c.id,c.title,c.created_at,b.id branch_id,b.head_revision,
        json_extract(p.body,'$.packageAttachments') attachments
      FROM chats c JOIN branches b ON b.chat_id=c.id LEFT JOIN profiles p ON p.chat_id=c.id;
    CREATE TEMP VIEW agent_messages AS
      WITH RECURSIVE ancestry(chat_id,branch_id,head_revision,id,depth) AS (
        SELECT chat_id,id,head_revision,head_revision,0 FROM branches WHERE head_revision IS NOT NULL
        UNION ALL SELECT a.chat_id,a.branch_id,a.head_revision,s.parent_revision,a.depth+1
        FROM ancestry a JOIN sources s ON s.id=a.id WHERE s.parent_revision IS NOT NULL
      )
      SELECT s.id,a.chat_id,a.branch_id,a.head_revision,s.hash,s.created_at,
        row_number() OVER (PARTITION BY a.branch_id ORDER BY a.depth DESC) scene_number,
        r.request,s.text FROM ancestry a JOIN sources s ON s.id=a.id JOIN runs r ON r.id=s.run_id;
    CREATE TEMP VIEW agent_helper_inputs AS
      SELECT seq,task_id, json_extract(data,'$.attemptId') attempt_id,
        json_extract(data,'$.helperCall') helper_call, json_extract(data,'$.segment') segment,
        json_extract(data,'$.estimatedInputTokens') estimated_input_tokens,
        json_extract(data,'$.componentEstimates.instructions') instructions_tokens,
        json_extract(data,'$.componentEstimates.toolSchemas') tool_schema_tokens,
        json_extract(data,'$.componentEstimates.history') history_tokens,
        json_extract(data,'$.componentEstimates.source') source_tokens,
        json_extract(data,'$.componentEstimates.toolResults') tool_result_tokens,
        json_extract(data,'$.preparationMs') preparation_ms,
        json_extract(data,'$.compactionMs') compaction_ms,
        json_extract(data,'$.estimator') estimator
      FROM helper_events WHERE kind='input.measured';
    CREATE TEMP VIEW agent_usage AS
      SELECT a.id,a.chat_id,a.run_id,a.job_id,a.role,a.model_id,a.status,a.input_tokens,a.output_tokens,
        a.cost_usd,h.task_id helper_task_id,h.purpose,h.segment
      FROM attempts a LEFT JOIN helper_task_attempts h ON h.attempt_id=a.id;
  `);
}
const VIEW_NAMES = [
  'agent_resources',
  'agent_chats',
  'agent_messages',
  'agent_usage',
  'agent_helper_inputs',
];
function query(db: DatabaseSync, args: Record<string, unknown>) {
  only(args, ['sql', 'params', 'limit']);
  if (args.sql === undefined)
    return {
      scope:
        'live database; all chats. Filter chat_id/branch_id explicitly. No draft or inferred facts.',
      views: VIEW_NAMES.map((name) => ({
        name,
        columns: db
          .prepare(`PRAGMA table_info(${name})`)
          .all()
          .map((r) => r.name),
      })),
      examples: [
        "SELECT id,title,revision FROM agent_resources WHERE kind='bot' ORDER BY title LIMIT 20",
        'SELECT title,attachments FROM agent_chats WHERE id=?',
        'SELECT helper_task_id,SUM(input_tokens) input_tokens,COUNT(*) calls FROM agent_usage WHERE helper_task_id IS NOT NULL GROUP BY helper_task_id ORDER BY input_tokens DESC LIMIT 10',
      ],
      guidance:
        'SELECT/CTE over these views only. JSON functions are available. document contains authored native fields once. Use data.search/read for excerpts and exact field hashes. Read schemas once; do not SELECT * from large documents. SQL usage is provider-reported, not local estimates.',
    };
  const sql = string(args.sql, '', 12_000).trim().replace(/;\s*$/u, '');
  if (!sql) throw new Error('DATA_SQL_REQUIRED');
  const limit = number(args.limit, 50, 200, 1);
  const params = args.params ?? [];
  if (
    !Array.isArray(params) ||
    params.length > 50 ||
    params.some(
      (p) =>
        p !== null &&
        (typeof p === 'number' ? !Number.isFinite(p) : typeof p !== 'string' || p.length > 12000)
    )
  )
    throw new Error('DATA_SQL_PARAMS_INVALID');
  // Native SQLite authorizer, not a SQL keyword denylist. The connection itself is read-only too.
  const columns: Record<string, readonly string[]> = {
    versions: ['kind', 'id', 'revision', 'body'],
    library_hidden: ['kind', 'id'],
    chats: ['id', 'title', 'created_at'],
    branches: ['chat_id', 'id', 'head_revision'],
    profiles: ['chat_id', 'body'],
    sources: ['id', 'parent_revision', 'chat_id', 'hash', 'created_at', 'text', 'run_id'],
    runs: ['id', 'request'],
    attempts: [
      'id',
      'chat_id',
      'run_id',
      'job_id',
      'role',
      'model_id',
      'status',
      'input_tokens',
      'output_tokens',
      'cost_usd',
    ],
    helper_task_attempts: ['attempt_id', 'task_id', 'purpose', 'segment'],
    helper_events: ['seq', 'task_id', 'data', 'kind'],
  };
  db.setAuthorizer((action, table, fn, _database, view) => {
    if ([constants.SQLITE_SELECT, constants.SQLITE_RECURSIVE].includes(action))
      return constants.SQLITE_OK;
    if (action === constants.SQLITE_FUNCTION && fn !== 'load_extension') return constants.SQLITE_OK;
    if (
      action === constants.SQLITE_READ &&
      (VIEW_NAMES.includes(table ?? '') ||
        ((VIEW_NAMES.includes(view ?? '') || view === 'ancestry') &&
          columns[table ?? '']?.includes(fn ?? '')))
    )
      return constants.SQLITE_OK;
    return constants.SQLITE_DENY;
  });
  // A subquery permits one SELECT/CTE, not a second statement or a mutation hidden after it.
  const wrapped = `SELECT * FROM (${sql}\n) LIMIT ${limit + 1}`;
  const statement = db.prepare(wrapped);
  if (statement.sourceSQL !== wrapped) throw new Error('DATA_SINGLE_QUERY_REQUIRED');
  statement.setReadBigInts(true);
  const rows: unknown[] = [];
  let truncated = false;
  let truncatedCells = 0;
  let chars = 0;
  for (const row of statement.iterate(...(params as SQLInputValue[]))) {
    if (rows.length >= limit) {
      truncated = true;
      break;
    }
    const projected = Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        typeof value === 'bigint'
          ? value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
            ? Number(value)
            : value.toString()
          : value instanceof Uint8Array
            ? { bytes: value.byteLength, omitted: true }
            : typeof value === 'string' && value.length > 2000
              ? (++truncatedCells,
                { preview: value.slice(0, 2000), totalChars: value.length, truncated: true })
              : value,
      ])
    );
    const size = JSON.stringify(projected).length;
    if (chars + size > MAX_RESULT_CHARS) {
      truncated = true;
      break;
    }
    rows.push(projected);
    chars += size;
  }
  return {
    scope: 'live-database',
    rows,
    truncated,
    truncatedCells,
    ...(truncated || truncatedCells > 0
      ? {
          continuation:
            'Narrow columns/conditions or use deterministic ORDER BY with SQL LIMIT/OFFSET. Large cell previews are not complete values.',
        }
      : {}),
  };
}
function* documents(
  db: DatabaseSync,
  snapshot: HelperTaskSnapshot,
  scope: DataScope,
  args: Record<string, unknown>
): Generator<Document> {
  const ids = strings(args.ids, 50);
  const accepts = (id: string) => !ids.length || ids.includes(id);
  if (scope === 'editor') {
    const editor = snapshot.editor;
    if (!editor?.model) return;
    const id = editor.targetId ?? 'unsaved';
    if (accepts(id))
      yield {
        scope,
        kind: 'editor',
        id,
        revision: editor.revision ?? 0,
        title: editor.title,
        origin: 'unsaved-device-editor',
        fields: authored(object(editor.model)),
      };
    return;
  }
  if (scope === 'current') {
    const writing = snapshot.writing;
    if (!writing) throw new Error('DATA_CURRENT_CHAT_REQUIRED: use library or editor scope');
    const common = { scope, chatId: writing.chatId, branchId: writing.branchId };
    for (const pkg of writing.profile?.packages ?? []) {
      if (!accepts(pkg.id)) continue;
      const kind =
        writing.profile?.packageAttachments?.find((a) => a.id === pkg.id)?.role ?? 'module';
      yield {
        ...common,
        kind,
        id: pkg.id,
        revision: pkg.revision,
        title: pkg.title,
        origin: 'reserved-chat-package; raw authored fields, not executed CBS',
        fields: authored({ title: pkg.title, package: pkg }),
      };
    }
    const requests = new Map<string, string[]>();
    for (const message of writing.logicalHistory ?? []) {
      if (message.role !== 'user' || message.current || !message.sourceRevision) continue;
      const group = requests.get(message.sourceRevision) ?? [];
      group.push(message.text);
      requests.set(message.sourceRevision, group);
    }
    for (const [index, source] of writing.history.entries()) {
      if (!accepts(source.revision)) continue;
      if (source.contentHash && source.contentHash !== sha(source.text))
        throw new Error('DATA_SOURCE_CHANGED');
      const request = requests.get(source.revision)?.join('\n');
      yield {
        ...common,
        kind: 'chat',
        id: source.revision,
        revision: source.contentHash ?? sha(source.text),
        title: `Scene ${index + 1}`,
        origin: 'reserved-chat-source',
        metadata: { sceneNumber: index + 1, headRevision: writing.parentRevision },
        fields: { ...(request ? { request } : {}), text: source.text },
      };
    }
    for (const note of writing.story?.notes ?? []) {
      if (note.retired || !accepts(note.id)) continue;
      yield {
        ...common,
        kind: 'note',
        id: note.id,
        revision: sha(note.text),
        title: note.kind,
        origin: note.kind,
        fields: { text: note.text },
        metadata: {
          kind: note.kind,
          author: note.declaration.author,
          atRevision: note.atRevision,
          ...(note.origin ? { importedOrigin: note.origin } : {}),
        },
      };
    }
    for (const entry of writing.profile?.chatOverrides?.entries ?? []) {
      if (entry.retired || !accepts(entry.id)) continue;
      const conflict = writing.profile?.chatOverrides?.conflicts.some(
        (c) => c.overrideId === entry.id
      );
      yield {
        ...common,
        kind: 'override',
        id: entry.id,
        revision: entry.revision,
        title: `Chat override: ${entry.selector.loreId}`,
        origin: conflict ? 'conflicting-chat-override; not an applied fact' : 'chat-override',
        fields: { selector: entry.selector, value: entry.value, atSource: entry.atSource },
      };
    }
    return;
  }
  if (scope === 'library') {
    const kinds = strings(args.kinds, 8);
    const conditions = [
      ids.length ? `id IN (${ids.map(() => '?').join(',')})` : '',
      kinds.length ? `kind IN (${kinds.map(() => '?').join(',')})` : '',
    ].filter(Boolean);
    const query = string(args.query);
    const rows = db
      .prepare(
        `SELECT * FROM agent_resources ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY kind,id`
      )
      .iterate(...ids, ...kinds);
    for (const row of rows) {
      if (query && !fold(`${row.title} ${row.id} ${row.kind}`).includes(fold(query))) continue;
      yield {
        scope,
        kind: String(row.kind),
        id: String(row.id),
        revision: Number(row.revision),
        title: String(row.title),
        origin: 'live-library-original',
        fields: { title: row.title, ...JSON.parse(String(row.document)) },
      };
    }
    return;
  }
  const chatId = args.chatId === undefined ? undefined : string(args.chatId);
  const branchId = args.branchId === undefined ? undefined : string(args.branchId);
  const conditions = [
    chatId ? 'm.chat_id=?' : '',
    branchId ? 'm.branch_id=?' : '',
    ids.length ? `m.id IN (${ids.map(() => '?').join(',')})` : '',
  ].filter(Boolean);
  const rows = db
    .prepare(
      `SELECT m.*,c.title FROM agent_messages m JOIN chats c ON c.id=m.chat_id ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY m.chat_id,m.branch_id,m.scene_number`
    )
    .iterate(...(chatId ? [chatId] : []), ...(branchId ? [branchId] : []), ...ids);
  for (const row of rows)
    yield {
      scope,
      kind: 'chat',
      id: String(row.id),
      revision: String(row.hash),
      title: `${row.title} / Scene ${row.scene_number}`,
      chatId: String(row.chat_id),
      branchId: String(row.branch_id),
      origin: 'live-chat-source',
      metadata: { sceneNumber: Number(row.scene_number), headRevision: row.head_revision },
      fields: { request: row.request, text: row.text },
    };
}
function reference(doc: Document, field: string, text: string): DataRef {
  const { title: _title, origin: _origin, fields: _fields, metadata: _metadata, ...ref } = doc;
  return { ...ref, field, hash: sha(text) };
}
// Adjust only surrogate boundaries, never normalize source text or invent offsets.
function boundary(text: string, offset: number) {
  return offset > 0 &&
    offset < text.length &&
    /[\uD800-\uDBFF]/u.test(text[offset - 1]) &&
    /[\uDC00-\uDFFF]/u.test(text[offset])
    ? offset - 1
    : offset;
}
function excerpt(
  doc: Document,
  field: string,
  text: string,
  start: number,
  end: number,
  ref = reference(doc, field, text)
) {
  start = boundary(text, start);
  end = boundary(text, end);
  if (end <= start && start < text.length) end = Math.min(text.length, start + 2);
  return {
    ref,
    ...(doc.metadata ? { metadata: doc.metadata } : {}),
    title: doc.title,
    origin: doc.origin,
    text: text.slice(start, end),
    range: { start, end, unit: 'utf16-code-unit' },
    line: text.slice(0, start).split('\n').length,
    totalChars: text.length,
    truncated: start > 0 || end < text.length,
    nextOffset: end < text.length ? end : null,
  };
}
/** Each page contains distinct matching windows, including later hits in the same long field. */
function* matchingExcerpts(doc: Document, expressions: RegExp[], mode: string, context: number) {
  if (!expressions.length) {
    yield {
      ref: reference(doc, '', JSON.stringify(doc.fields)),
      title: doc.title,
      origin: doc.origin,
      ...(doc.metadata ? { metadata: doc.metadata } : {}),
      read: 'data.read returns a field directory; then read a returned field reference.',
    };
    return;
  }
  for (const [field, text] of fields(doc.fields)) {
    if (
      mode === 'all' &&
      expressions.some((expression) => {
        expression.lastIndex = 0;
        return !expression.test(text);
      })
    )
      continue;
    let position = 0;
    let ref: DataRef | undefined;
    while (position <= text.length) {
      const found = expressions
        .map((expression) => {
          expression.lastIndex = position;
          return expression.exec(text);
        })
        .filter((match): match is RegExpExecArray => match !== null)
        .sort((a, b) => a.index - b.index);
      const hit = found[0];
      if (!hit) break;
      const start = Math.max(0, hit.index - context);
      const end = Math.min(
        text.length,
        Math.max(hit.index + Math.min(Math.max(hit[0].length, 1), 800) + context, start + 240),
        start + 2000
      );
      ref ??= reference(doc, field, text);
      yield {
        ...excerpt(doc, field, text, start, end, ref),
        matchRange: { start: hit.index, end: hit.index + hit[0].length },
      };
      // Advancing by code point also terminates zero-width Unicode expressions at a surrogate pair.
      const next =
        hit.index + Math.max(hit[0].length, (text.codePointAt(hit.index) ?? 0) > 0xffff ? 2 : 1);
      position = Math.max(end, next);
    }
  }
}
function search(db: DatabaseSync, snapshot: HelperTaskSnapshot, args: Record<string, unknown>) {
  only(args, [
    'scope',
    'query',
    'patterns',
    'match',
    'regex',
    'kinds',
    'ids',
    'chatId',
    'branchId',
    'offset',
    'limit',
    'context',
  ]);
  const scope = string(
    args.scope,
    snapshot.editor?.model ? 'editor' : snapshot.writing ? 'current' : 'library'
  ) as DataScope;
  if (!['current', 'library', 'chats', 'editor'].includes(scope))
    throw new Error('DATA_SCOPE_INVALID');
  if (scope !== 'chats' && (args.chatId !== undefined || args.branchId !== undefined))
    throw new Error('DATA_USE_CHATS_SCOPE');
  const patterns = strings(args.patterns, 8);
  if (patterns.some((p) => !p.trim())) throw new Error('DATA_EMPTY_PATTERN');
  if (args.regex !== undefined && typeof args.regex !== 'boolean')
    throw new Error('DATA_REGEX_INVALID');
  const mode = string(args.match, 'any');
  if (!['any', 'all'].includes(mode)) throw new Error('DATA_MATCH_INVALID');
  const expressions = patterns.map(
    (p) => new RegExp(args.regex ? p : p.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'giu')
  );
  const kinds = strings(args.kinds, 8);
  const offset = number(args.offset, 0, 1_000_000),
    limit = number(args.limit, 10, 50, 1),
    context = number(args.context, 160, 1200);
  const query = fold(string(args.query));
  const items: unknown[] = [];
  let matches = 0,
    inspected = 0,
    resultChars = 0,
    more = false;
  outer: for (const doc of documents(db, snapshot, scope, args)) {
    if (kinds.length && !kinds.includes(doc.kind)) continue;
    if (query && !fold(`${doc.title} ${doc.id} ${doc.kind}`).includes(query)) continue;
    inspected++;
    for (const item of matchingExcerpts(doc, expressions, mode, context)) {
      if (matches++ < offset) continue;
      if (items.length >= limit) {
        more = true;
        break outer;
      }
      const size = JSON.stringify(item).length;
      if (resultChars + size > MAX_RESULT_CHARS) {
        if (!items.length) throw new Error('DATA_RESULT_TOO_LARGE: narrow the query');
        more = true;
        break outer;
      }
      items.push(item);
      resultChars += size;
    }
  }

  return {
    scope,
    ...(scope === 'current'
      ? {
          chatId: snapshot.writing?.chatId,
          branchId: snapshot.writing?.branchId,
          headRevision: snapshot.writing?.parentRevision,
        }
      : {}),
    items,
    inspectedDocuments: inspected,
    complete: !more,
    nextOffset: more ? offset + items.length : null,
    semantics:
      'Matches are paged non-overlapping windows; all-mode requires every pattern in the same field, not necessarily the same excerpt. Match/excerpt offsets refer to exact original text. Matches are not proof of unread content. current uses this task reservation; library/chats are live originals; editor is unsaved. No-match is not proof that a fact is absent. Use another pattern or read the relevant fields.',
  };
}
function read(db: DatabaseSync, snapshot: HelperTaskSnapshot, args: Record<string, unknown>) {
  only(args, ['ref', 'offset', 'limit']);
  const ref = object(args.ref) as DataRef;
  if (
    !['current', 'library', 'chats', 'editor'].includes(ref.scope) ||
    Object.keys(ref).some(
      (key) =>
        !['scope', 'kind', 'id', 'revision', 'field', 'hash', 'chatId', 'branchId'].includes(key)
    ) ||
    typeof ref.kind !== 'string' ||
    !['string', 'number'].includes(typeof ref.revision) ||
    typeof ref.id !== 'string' ||
    typeof ref.field !== 'string' ||
    typeof ref.hash !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(ref.hash)
  )
    throw new Error('DATA_REFERENCE_INVALID');
  const doc = [
    ...documents(db, snapshot, ref.scope, {
      ids: [ref.id],
      ...(ref.chatId ? { chatId: ref.chatId } : {}),
      ...(ref.branchId ? { branchId: ref.branchId } : {}),
    }),
  ].find(
    (d) =>
      d.kind === ref.kind &&
      d.id === ref.id &&
      d.chatId === ref.chatId &&
      d.branchId === ref.branchId
  );
  if (!doc) throw new Error('DATA_RESOURCE_UNAVAILABLE');
  const all = [...fields(doc.fields)];
  const text =
    ref.field === '' ? JSON.stringify(doc.fields) : all.find(([path]) => path === ref.field)?.[1];
  if (text === undefined) throw new Error('DATA_FIELD_UNAVAILABLE');
  if (doc.revision !== ref.revision || sha(text) !== ref.hash)
    throw new Error('DATA_SOURCE_CHANGED: search again for the current reference');
  const offset = number(args.offset, 0, Number.MAX_SAFE_INTEGER);
  if (ref.field === '') {
    if (offset > all.length) throw new Error('DATA_RANGE_INVALID');
    const limit = number(args.limit, 20, 50, 1);
    const rows: unknown[] = [];
    let size = 0;
    for (const [field, value] of all.slice(offset, offset + limit)) {
      const row = {
        ref: reference(doc, field, value),
        totalChars: value.length,
        preview: value.slice(0, 80),
      };
      const chars = JSON.stringify(row).length;
      if (size + chars > MAX_RESULT_CHARS) {
        if (!rows.length) throw new Error('DATA_RESULT_TOO_LARGE');
        break;
      }
      rows.push(row);
      size += chars;
    }
    return {
      title: doc.title,
      origin: doc.origin,
      fields: rows,
      total: all.length,
      nextOffset: offset + rows.length < all.length ? offset + rows.length : null,
    };
  }
  if (offset > text.length) throw new Error('DATA_RANGE_INVALID');
  const limit = number(args.limit, 4000, 10_000, 1);
  return excerpt(doc, ref.field, text, offset, Math.min(text.length, offset + limit));
}
function runDataOperation(input: DataOperation): unknown {
  const db = new DatabaseSync(input.path, { readOnly: true, allowExtension: false });
  try {
    // This limit is process-local; arbitrary SQL allocation cannot exhaust the application process.
    db.exec('PRAGMA hard_heap_limit=134217728; PRAGMA busy_timeout=500; BEGIN');
    installViews(db);
    db.exec('PRAGMA query_only=ON');
    if (input.name === 'db.query') return query(db, input.args);
    const row = db
      .prepare(
        "SELECT json_extract(snapshot,'$.scope') scope, json_type(snapshot,'$.editor.model') has_editor, json_type(snapshot,'$.writing') has_writing FROM helper_tasks WHERE id=?"
      )
      .get(input.taskId);
    if (!row) throw new Error('DATA_TASK_UNAVAILABLE');
    const snapshot = { scope: JSON.parse(String(row.scope)) } as HelperTaskSnapshot;
    const requestedRefs =
      input.name === 'data.read' && Array.isArray(input.args.refs)
        ? input.args.refs
        : [input.args.ref];
    const scopes =
      input.name === 'data.search'
        ? [
            input.args.scope ??
              (row.has_editor ? 'editor' : row.has_writing ? 'current' : 'library'),
          ]
        : requestedRefs.map((ref) => object(ref).scope);
    if (scopes.includes('current')) {
      const writing = db
        .prepare("SELECT json_extract(snapshot,'$.writing') body FROM helper_tasks WHERE id=?")
        .get(input.taskId)?.body;
      if (writing) snapshot.writing = JSON.parse(String(writing));
    }
    if (scopes.includes('editor')) {
      const editor = db
        .prepare("SELECT json_extract(snapshot,'$.editor') body FROM helper_tasks WHERE id=?")
        .get(input.taskId)?.body;
      if (editor) snapshot.editor = JSON.parse(String(editor));
    }
    if (input.name === 'data.search')
      return search(db, snapshot, { ...input.args, scope: scopes[0] });
    if (input.args.refs === undefined) return read(db, snapshot, input.args);
    only(input.args, ['refs', 'offset', 'limit']);
    if (!Array.isArray(input.args.refs) || !input.args.refs.length || input.args.refs.length > 16)
      throw new Error('DATA_LIST_INVALID');
    const items: unknown[] = [];
    let size = 0;
    for (const ref of input.args.refs) {
      let item: unknown;
      try {
        item = {
          ref,
          read: read(db, snapshot, {
            ref,
            offset: input.args.offset,
            limit: input.args.limit ?? (object(ref).field === '' ? 8 : 2000),
          }),
        };
      } catch (error) {
        item = { ref, error: error instanceof Error ? error.message : 'DATA_READ_FAILED' };
      }
      const chars = JSON.stringify(item).length;
      if (size + chars > MAX_RESULT_CHARS && items.length) break;
      items.push(item);
      size += chars;
    }
    return { items, nextIndex: items.length < input.args.refs.length ? items.length : null };
  } finally {
    db.close();
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 200_000) throw new Error('DATA_INPUT_TOO_LARGE');
  }
  try {
    process.stdout.write(JSON.stringify({ ok: true, result: runDataOperation(JSON.parse(input)) }));
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : 'DATA_QUERY_FAILED',
      })
    );
  }
}
