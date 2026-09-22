import type { DatabaseSync } from 'node:sqlite';

type Node = { kind: string; id: string; body: unknown };
const media = /\/api\/(assets|illustration-images|package-image-blobs)\/([A-Za-z0-9_.-]+)/gu;

/** Explicit deletion collects only unreachable data, never historical evidence as a retention root.
 * Current resources, saved prose and pending/retryable work own their referenced images.
 * Called in the deletion/save transaction, not on reader requests or every model token.
 */
export function imageDataHashes(value: unknown): string[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text?.match(/[a-f0-9]{64}/gu) ?? [];
}

export function queueImageCleanup(db: DatabaseSync, candidates: Iterable<string>): void {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO image_cleanup_candidates(hash) SELECT hash FROM image_blobs WHERE hash=?'
  );
  for (const hash of candidates) insert.run(hash);
}

/** Worker completion/restart only revisits work explicitly deferred by a deletion or edit. */
export function flushPendingImageCleanup(db: DatabaseSync): void {
  if (
    db.prepare('SELECT 1 FROM image_cleanup_candidates LIMIT 1').get() ||
    db.prepare("SELECT 1 FROM app_metadata WHERE key='image-cleanup-needed'").get()
  )
    pruneUnusedData(db);
}

export function pruneUnusedData(db: DatabaseSync, candidates: Iterable<string> | null = []): void {
  if (candidates === null)
    db.exec('INSERT OR IGNORE INTO image_cleanup_candidates SELECT hash FROM image_blobs');
  else queueImageCleanup(db, candidates);
  const pending = db.prepare('SELECT hash FROM image_cleanup_candidates').all();
  const hasHidden = !!db.prepare('SELECT 1 FROM library_hidden LIMIT 1').get();
  if (!pending.length && !hasHidden) {
    db.prepare("DELETE FROM app_metadata WHERE key='image-cleanup-needed'").run();
    return;
  }
  // Persist the intent before any busy check: a restart or a later ordinary flush must not lose it.
  db.prepare("INSERT OR REPLACE INTO app_metadata VALUES('image-cleanup-needed','1')").run();
  // A provider or image conversion may hold an in-memory selection not yet persisted.
  for (const table of [
    'runs',
    'jobs',
    'context_jobs',
    'helper_tasks',
    'helper_artifact_jobs',
    'illustration_jobs',
    'attempts',
    'provider_connection_tests',
  ])
    if (db.prepare(`SELECT 1 FROM ${table} WHERE status IN ('queued','running') LIMIT 1`).get())
      return;
  const removedImages = new Set(pending.map((row) => String(row.hash)));
  const hidden = new Set(
    db
      .prepare('SELECT kind,id FROM library_hidden')
      .all()
      .map((row) => `${row.kind}:${row.id}`)
  );
  const nodes = new Map<string, Node>();
  for (const table of ['versions', 'provider_settings'])
    for (const row of db.prepare(`SELECT kind,id,body FROM ${table}`).all())
      nodes.set(String(row.id), {
        kind: String(row.kind),
        id: String(row.id),
        body: JSON.parse(String(row.body)),
      });
  for (const row of db.prepare('SELECT id,body FROM assets').all())
    nodes.set(String(row.id), {
      kind: 'asset',
      id: String(row.id),
      body: JSON.parse(String(row.body)),
    });
  const images = new Map(
    db
      .prepare('SELECT id,hash FROM illustration_images')
      .all()
      .map((row) => [String(row.id), String(row.hash)])
  );
  const undo = new Map(
    db
      .prepare('SELECT kind,id,model FROM resource_undo')
      .all()
      .map((row) => [`${row.kind}:${row.id}`, String(row.model)])
  );
  const retained = new Set<string>(),
    hashes = new Set<string>(),
    queue: Node[] = [];
  const visitId = (id: string) => {
    const node = nodes.get(id);
    if (node && !retained.has(id)) {
      retained.add(id);
      queue.push(node);
    }
  };
  const scan = (value: unknown): void => {
    if (typeof value === 'string') {
      visitId(value);
      if (/^[a-f0-9]{64}$/u.test(value)) hashes.add(value);
      for (const match of value.matchAll(media)) {
        if (match[1] === 'package-image-blobs') hashes.add(match[2]);
        else if (match[1] === 'assets') visitId(match[2]);
        else {
          const hash = images.get(match[2]);
          if (hash) hashes.add(hash);
        }
      }
    } else if (Array.isArray(value)) value.forEach(scan);
    else if (value && typeof value === 'object') Object.values(value).forEach(scan);
  };
  for (const node of nodes.values()) if (!hidden.has(`${node.kind}:${node.id}`)) visitId(node.id);
  // Text roots and authored JSON are kept separate from disposable execution/command logs.
  for (const [table, column] of [
    ['profiles', 'body'],
    ['prompt_workspace', 'body'],
    ['author_notes', 'entry'],
    ['chat_lore_overrides', 'body'],
    ['chat_variable_states', 'values_json'],
    ['chat_variable_outputs', 'body'],
    ['illustration_settings', 'body'],
    ['illustration_references', 'body'],
    ['job_results', 'result'],
    ['jobs', 'input'],
  ]) {
    for (const row of db.prepare(`SELECT ${column} AS value FROM ${table}`).iterate())
      if (typeof row.value === 'string') scan(JSON.parse(row.value));
  }
  for (const sql of [
    'SELECT text AS value FROM sources',
    'SELECT text AS value FROM source_edits',
    'SELECT text AS value FROM helper_messages',
    'SELECT text AS value FROM helper_artifacts',
    'SELECT bot_id AS value FROM chat_organization',
  ])
    for (const row of db.prepare(sql).iterate()) scan(row.value);
  for (const row of db
    .prepare('SELECT default_persona FROM chat_folders WHERE default_persona IS NOT NULL')
    .iterate())
    scan(JSON.parse(String(row.default_persona)));
  for (const row of db.prepare('SELECT snapshot,status FROM runs').iterate()) {
    const snapshot = JSON.parse(String(row.snapshot));
    if (row.status === 'queued' || row.status === 'running') scan(snapshot);
    else {
      scan(snapshot.messageChanges);
      scan(snapshot.nativeRisuAuthored);
    }
  }
  for (const row of db
    .prepare("SELECT snapshot FROM helper_tasks WHERE status!='completed'")
    .iterate())
    scan(JSON.parse(String(row.snapshot)));
  for (const row of db.prepare('SELECT hash FROM illustration_images').iterate())
    hashes.add(String(row.hash));
  // Unfinished work can still resolve its pinned source and model without the library row being visible.
  for (const sql of [
    "SELECT body AS value FROM provider_connection_tests WHERE status='running'",
    'SELECT snapshot AS value FROM context_jobs WHERE snapshot IS NOT NULL',
    "SELECT snapshot AS value FROM helper_artifact_jobs WHERE status IN ('queued','running')",
    "SELECT input AS value FROM illustration_jobs WHERE status IN ('queued','running')",
  ])
    for (const row of db.prepare(sql).iterate())
      if (typeof row.value === 'string') scan(JSON.parse(row.value));
  for (const [key, body] of undo)
    if (key.startsWith('prompt-workspace:') || key.startsWith('theme:')) scan(JSON.parse(body));
  while (queue.length) {
    const node = queue.pop()!;
    scan(node.body);
    const previous = undo.get(`${node.kind}:${node.id}`);
    if (previous) scan(JSON.parse(previous));
  }
  for (const key of hidden) {
    const separator = key.indexOf(':'),
      kind = key.slice(0, separator),
      id = key.slice(separator + 1);
    if (retained.has(id)) continue;
    for (const hash of imageDataHashes(nodes.get(id)?.body)) removedImages.add(hash);
    if (kind === 'asset') db.prepare('DELETE FROM assets WHERE id=?').run(id);
    else
      db.prepare(
        `DELETE FROM ${kind === 'connection' || kind === 'model' ? 'provider_settings' : 'versions'} WHERE kind=? AND id=?`
      ).run(kind, id);
    db.prepare('DELETE FROM resource_undo WHERE kind=? AND id=?').run(kind, id);
    db.prepare('DELETE FROM library_hidden WHERE kind=? AND id=?').run(kind, id);
  }
  const selected = [...removedImages];
  db.prepare('DELETE FROM image_blobs WHERE hash IN (SELECT value FROM json_each(?))').run(
    JSON.stringify(selected.filter((hash) => !hashes.has(hash)))
  );
  db.exec('DELETE FROM image_cleanup_candidates');
  db.prepare("DELETE FROM app_metadata WHERE key='image-cleanup-needed'").run();
}
