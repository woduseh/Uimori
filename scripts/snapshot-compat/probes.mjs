import { request } from './requests.mjs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

export const cap = 12;
export const shape = (path) => path.replace(/:\w+/g, ':');
const single = {
  chats: 'chats',
  sources: 'sources',
  attempts: 'attempts',
  jobs: 'jobs',
  runs: 'runs',
  'helper/conversations': 'helper_conversations',
  'helper/tasks': 'helper_tasks',
  'helper/artifacts': 'helper_artifacts',
  'outline-nodes': 'outline_nodes',
  illustrations: 'illustration_jobs',
  'illustration-images': 'illustration_images',
  'provider-management/tests': 'provider_connection_tests',
  assets: 'assets',
};
const queries = {
  '/chats/:/sources/:': 'SELECT chat_id,id FROM sources',
  '/chats/:/assets/:': 'SELECT chat_id,id FROM assets',
  '/chats/:/context/jobs/:': 'SELECT chat_id,id FROM context_jobs',
  '/response-streams/:/:': 'SELECT task_kind,task_id FROM response_stream_tasks',
  '/package-image-blobs/:': 'SELECT hash FROM image_blobs',
  '/theme-assets/:': 'SELECT hash FROM theme_assets',
  '/request-files/:': 'SELECT hash FROM attachment_blobs',
  '/revisions/:/:/:':
    "SELECT kind,id,revision FROM versions WHERE kind IN ('content','prompt-preset')",
  '/provider-management/:/:': 'SELECT kind,id FROM provider_settings',
  '/resources/:/:':
    "SELECT DISTINCT kind,id FROM versions WHERE kind IN ('content','prompt-preset','theme','illustration-preset') UNION SELECT 'prompt-workspace','workspace'",
  '/content/:': "SELECT DISTINCT id FROM versions WHERE kind='content'",
  '/bots/:':
    "SELECT DISTINCT bot_id FROM chat_organization WHERE bot_id IS NOT NULL UNION SELECT id FROM versions WHERE kind='content' AND json_extract(body,'$.kind')='bot'",
  '/prompt-presets/:': "SELECT DISTINCT id FROM versions WHERE kind='prompt-preset'",
  '/connections/:': "SELECT id FROM provider_settings WHERE kind='connection'",
  '/model-presets/:': "SELECT id FROM provider_settings WHERE kind='model'",
};
const catalogs = {
  '/themes/:': ['themes', 'themes'],
  '/palettes/:': ['palettes', 'palettes'],
  '/fonts/:': ['fonts', 'fonts'],
  '/illustration-presets/:': ['illustration-presets', 'presets'],
  '/prompt-templates/:': ['prompt-templates', null],
  '/backups/:': ['backups', 'backups'],
};
for (const [prefix, table] of Object.entries(single))
  queries['/' + prefix + '/:'] = 'SELECT id FROM ' + table;
export function database(file, fn, readOnly = true) {
  const db = new DatabaseSync(file, { readOnly });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}
export async function targets(instance, template) {
  const path = shape(template).slice(4);
  if (path === '/content/:/risu-preview') {
    return database(instance.file, (db) =>
      db
        .prepare(`SELECT v.id,v.revision,json_extract(start.value,'$.id') AS startId
      FROM versions v,json_each(v.body,'$.package.starts') start
      WHERE v.kind='content' AND json_extract(start.value,'$.mode')='authored'
      AND v.revision=(SELECT max(revision) FROM versions WHERE kind=v.kind AND id=v.id)
      ORDER BY v.id,startId LIMIT ?`)
        .all(cap)
        .map(({ id, revision, startId }) => ({
          url:
            template.replace(/:\w+/, encodeURIComponent(id)) +
            '?' +
            new URLSearchParams({ revision, startId }),
          ids: [id, startId],
        }))
    );
  }
  const prefix = path.slice(0, path.lastIndexOf(':') + 1);
  let tuples = [[]];
  if (prefix in catalogs) {
    const [url, key] = catalogs[prefix];
    tuples = await request(instance, '/api/' + url, async (response) => {
      if (!response.ok) throw new Error('Catalog HTTP ' + response.status);
      const value = await response.json();
      return (key ? value[key] : value)
        .map((item) => [item.id])
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .slice(0, cap);
    });
  } else if (prefix) {
    if (!queries[prefix]) throw new Error('Missing parameter discovery for ' + template);
    const count = (prefix.match(/:/g) || []).length;
    const order = Array.from({ length: count }, (_, i) => i + 1).join(',');
    const sql =
      path === '/resources/:/:/previous' ? 'SELECT kind,id FROM resource_undo' : queries[prefix];
    tuples = database(instance.file, (db) =>
      db
        .prepare(sql + ' ORDER BY ' + order + ' LIMIT ' + cap)
        .all()
        .map(Object.values)
    );
  }
  let query = '';
  if (path === '/usage' || path === '/usage/export') query = '?from=2000-01-01&to=2099-12-31';
  if (path === '/helper/conversations') query = '?kind=all';
  if (path === '/push' || path.endsWith('/reading-position'))
    query = '?clientId=00000000-0000-4000-8000-000000000001';
  return tuples.map((tuple) => {
    let i = 0;
    const url = template.replace(/:\w+/g, () => encodeURIComponent(tuple[i++]));
    return { url: url + query, ids: tuple };
  });
}
export function tableDigests(file, workOnly) {
  return database(file, (db) => {
    const tables = db
      .prepare(
        "SELECT name FROM pragma_table_list WHERE schema='main' AND type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all();
    const result = {};
    for (const { name } of tables) {
      if (workOnly && !/(?:runs|jobs|tasks|attempts|batches|push_outbox)$/.test(name)) continue;
      const id = '"' + name.replaceAll('"', '""') + '"';
      const cols = db.prepare('PRAGMA table_info(' + id + ')').all();
      const pk = cols
        .filter((c) => c.pk)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => '"' + c.name.replaceAll('"', '""') + '"')
        .join(',');
      const stmt = db.prepare('SELECT * FROM ' + id + ' ORDER BY ' + (pk || 'rowid'));
      result[name] = rowDigest(stmt);
    }
    return result;
  });
}

function rowDigest(stmt, params = []) {
  stmt.setReadBigInts(true);
  const hash = createHash('sha256');
  let rows = 0;
  for (const row of stmt.iterate(...params)) {
    hash.update(
      JSON.stringify(row, (_k, v) =>
        typeof v === 'bigint'
          ? { integer: String(v) }
          : v instanceof Uint8Array
            ? { blob: createHash('sha256').update(v).digest('hex') }
            : v
      ) + '\n'
    );
    rows++;
  }
  return { rows, sha256: hash.digest('hex') };
}
export function expectedQueueAfterHelperChangesDrop(file) {
  return database(file, (db) => {
    const hashes = db
      .prepare('SELECT baseline FROM helper_changes WHERE baseline IS NOT NULL')
      .all()
      .flatMap(({ baseline }) => String(baseline).match(/[a-f0-9]{64}/gu) ?? []);
    return rowDigest(
      db.prepare(`SELECT hash FROM image_cleanup_candidates
        UNION SELECT hash FROM image_blobs WHERE hash IN (SELECT value FROM json_each(?))
        ORDER BY hash`),
      [JSON.stringify(hashes)]
    );
  });
}
export function expectedReplayOutbox(file) {
  const authority = createHash('sha256').update('').digest('hex');
  return database(file, (db) =>
    rowDigest(
      db.prepare(`SELECT o.* FROM push_outbox o
    WHERE NOT EXISTS (SELECT 1 FROM push_subscriptions p JOIN access_sessions s ON s.token_hash=p.session_hash
      WHERE p.id=o.subscription_id AND s.authority_hash!=?) ORDER BY o.id`),
      [authority]
    )
  );
}
