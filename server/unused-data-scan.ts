import { DatabaseSync } from 'node:sqlite';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';

type Node = { kind: string; id: string; body: unknown };
export type UnusedDataPlan = { hidden: { kind: string; id: string }[]; images: string[] };
const media = /\/api\/(assets|illustration-images|package-image-blobs)\/([A-Za-z0-9_.-]+)/gu;

export function imageDataHashes(value: unknown): string[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text?.match(/[a-f0-9]{64}/gu) ?? [];
}

export function planUnusedData(db: DatabaseSync): UnusedDataPlan {
  const removedImages = new Set(
    db
      .prepare('SELECT hash FROM image_cleanup_candidates')
      .all()
      .map((row) => String(row.hash))
  );
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
  const themePreferences = db
    .prepare("SELECT value FROM app_metadata WHERE key='theme-preferences'")
    .get();
  if (typeof themePreferences?.value === 'string') scan(JSON.parse(themePreferences.value));
  for (const row of db
    .prepare("SELECT value FROM app_metadata WHERE key LIKE 'bot-defaults:%'")
    .iterate())
    scan(JSON.parse(String(row.value)));
  for (const node of nodes.values()) if (!hidden.has(`${node.kind}:${node.id}`)) visitId(node.id);
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
    ['helper_changes', 'baseline'],
  ]) {
    for (const row of db.prepare(`SELECT ${column} AS value FROM ${table}`).iterate())
      if (typeof row.value === 'string') scan(JSON.parse(row.value));
  }
  for (const sql of [
    'SELECT text AS value FROM sources',
    'SELECT text AS value FROM source_edits',
    'SELECT text AS value FROM helper_messages',
    'SELECT text AS value FROM helper_seed_messages',
    'SELECT text AS value FROM helper_message_changes WHERE deleted=0',
    'SELECT text AS value FROM helper_artifacts',
    'SELECT bot_id AS value FROM chat_organization',
    'SELECT hash AS value FROM library_folder_covers',
  ])
    for (const row of db.prepare(sql).iterate()) scan(row.value);
  for (const row of db
    .prepare('SELECT default_persona FROM chat_folders WHERE default_persona IS NOT NULL')
    .iterate())
    scan(JSON.parse(String(row.default_persona)));
  for (const row of db.prepare('SELECT snapshot,status FROM runs').iterate()) {
    const snapshot = JSON.parse(String(row.snapshot));
    scan(snapshot.requestImages);
    if (row.status === 'queued' || row.status === 'running') scan(snapshot);
    else {
      scan(snapshot.messageChanges);
      scan(snapshot.nativeRisuAuthored);
    }
  }
  for (const row of db.prepare('SELECT images FROM helper_message_attachments').iterate())
    scan(JSON.parse(String(row.images)));
  for (const row of db
    .prepare(`SELECT t.snapshot FROM helper_tasks t WHERE t.status!='completed'
      AND NOT EXISTS (SELECT 1 FROM helper_messages m JOIN helper_message_changes c ON c.message_id=m.id
        WHERE m.task_id=t.id AND c.deleted=1)`)
    .iterate())
    scan(JSON.parse(String(row.snapshot)));
  for (const row of db.prepare('SELECT hash FROM illustration_images').iterate())
    hashes.add(String(row.hash));
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
  const removedHidden: UnusedDataPlan['hidden'] = [];
  for (const key of hidden) {
    const separator = key.indexOf(':'),
      kind = key.slice(0, separator),
      id = key.slice(separator + 1);
    if (retained.has(id)) continue;
    for (const hash of imageDataHashes(nodes.get(id)?.body)) removedImages.add(hash);
    removedHidden.push({ kind, id });
  }
  return { hidden: removedHidden, images: [...removedImages].filter((hash) => !hashes.has(hash)) };
}

if (!isMainThread && workerData?.unusedDataPath) {
  const db = new DatabaseSync(String(workerData.unusedDataPath), { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN');
    parentPort!.postMessage({ plan: planUnusedData(db) });
  } catch {
    parentPort!.postMessage({ error: true });
  } finally {
    db.close();
  }
}
