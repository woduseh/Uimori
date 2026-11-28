import { parseArgs } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { root, assertBuild } from './lib.mjs';
import { git, buildOld, boot } from './snapshot-compat/host.mjs';
import { cap, database, targets } from './snapshot-compat/probes.mjs';
import {
  compare,
  compareRead,
  differences,
  digest,
  normalization,
  portable,
  read,
} from './snapshot-compat/compare.mjs';

const { values } = parseArgs({
  options: {
    snapshot: { type: 'string' },
    old: { type: 'string', default: 'v0.18.1' },
    expect: { type: 'string' },
    'self-check': { type: 'boolean' },
  },
});
const worktrees = git('worktree', 'list', '--porcelain', '-z')
  .split('\0')
  .filter((line) => line.startsWith('worktree '))
  .map((line) => line.slice(9))
  .filter(existsSync)
  .map((p) => realpathSync(p));
function requireExternalPath(input) {
  const file = path.resolve(input);
  for (const tree of worktrees) {
    const rel = path.relative(tree, file);
    if (!rel || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)))
      throw new Error('Replay input and temporary storage must be outside repository worktrees');
  }
  return file;
}
function outside(input) {
  if (!input) throw new Error('Pass --snapshot <downloaded SQLite backup>');
  const file = requireExternalPath(realpathSync(requireExternalPath(input)));
  if (!statSync(file).isFile()) throw new Error('Expected a regular file');
  return file;
}
const snapshot = outside(values.snapshot);
const allowed = values.expect ? JSON.parse(readFileSync(outside(values.expect), 'utf8')) : [];
if (
  !Array.isArray(allowed) ||
  allowed.some((v) => typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v))
)
  throw new Error('--expect requires a JSON array of exact difference fingerprints');
const temporaryRoot = requireExternalPath(realpathSync(requireExternalPath(os.tmpdir())));
const tmp = mkdtempSync(path.join(temporaryRoot, 'uimori-compat-'));
const old = path.join(tmp, 'old');
const output = path.join(root, 'output', 'snapshot-compat', randomUUID() + '.json');
const children = [];
const report = {
  cap,
  normalization,
  coverage: {},
  oneSided: [],
  boot: {},
  blocked: [],
  differences: [],
  errors: [],
  selfCheck: [],
  comparisons: 0,
  bytes: 0,
  ids: new Set(),
  chatRoundTrips: 0,
};
function file(name) {
  const dir = path.join(tmp, name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, 'replay.sqlite');
}
const start = (tree, name, mode = 'read') =>
  boot(tree, path.dirname(file(name)), mode, report, children);
async function exportTo(instance, name) {
  const result = await read(instance, '/api/backup', '/api/backup', report, file(name));
  if (result.status !== 200) throw new Error('Backup export failed');
  return start(root, name);
}
async function post(app, url, body, binary = false) {
  const res = await app.request(url, {
    method: 'POST',
    headers: { 'content-type': binary ? 'application/octet-stream' : 'application/json' },
    body: binary ? body : JSON.stringify(body),
  });
  if (!res.ok)
    throw new Error('Chat import HTTP ' + res.status + ' ' + url + ' ' + (await res.text()));
  return res.json();
}
async function archive(app, id) {
  const url = '/api/chats/' + encodeURIComponent(id) + '/backup-archive';
  return (await read(app, '/api/chats/:id/backup-archive', url, report)).body;
}
async function chats(app) {
  const dest = await start(root, 'chat-import', 'import');
  for (const {
    ids: [id],
  } of (await targets(app, '/api/chats/:id')).slice(0, 3)) {
    const expected = portable(await archive(app, id));
    const res = await app.request('/api/chats/' + encodeURIComponent(id) + '/backup-archive');
    if (!res.ok) throw new Error('Export failed ' + res.status);
    const upload = await post(dest, '/api/uploads', Buffer.from(await res.arrayBuffer()), true);
    const { preparedId, digest } = await post(dest, '/api/chats/prepare-backup-archive', {
      uploadId: upload.uploadId,
    });
    const imported = await post(dest, '/api/chats/import-backup-archive', {
      preparedId,
      digest,
      idempotencyKey: randomUUID(),
    });
    if (!imported.created || imported.chat.id === id)
      throw new Error('Chat import did not create independent copy');
    const actual = portable(await archive(dest, imported.chat.id));
    const url = '/api/chats/' + id + '/backup-archive';
    report.differences.push(
      ...differences(expected, actual).map((item) => ({ phase: 'chat', url, ...item }))
    );
    if (values['self-check']) {
      database(
        dest.file,
        (db) =>
          db.prepare('UPDATE chats SET title=? WHERE id=?').run('changed-' + id, imported.chat.id),
        false
      );
      const changed = portable(await archive(dest, imported.chat.id));
      if (!differences(expected, changed).some((item) => item.after === 'changed-' + id))
        throw new Error('Chat content canary missed');
      report.selfCheck.push('chat-title');
    }
    report.chatRoundTrips++;
  }
  if (!report.chatRoundTrips)
    throw new Error('Snapshot contains no chats for archive verification');
}
function addCanary(file) {
  return database(
    file,
    (db) => {
      const row = db.prepare('SELECT chat_id,id FROM sources ORDER BY chat_id,id LIMIT 1').get();
      if (!row) throw new Error('Self-check needs a chat with a scene');
      const id = randomUUID(),
        stamp = '9999-12-31T00:00:00.000Z';
      db.prepare(
        'INSERT INTO bookmarks(id,chat_id,source_id,target,title,note,quote,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)'
      ).run(
        id,
        row.chat_id,
        row.id,
        JSON.stringify({ chatId: row.chat_id, sourceId: row.id, representation: 'original' }),
        'replay-' + id,
        '',
        '',
        1,
        stamp,
        stamp
      );
      return { id, chat: row.chat_id };
    },
    false
  );
}
async function checkCanary(reference, subject, seed, label) {
  database(
    subject.file,
    (db) => {
      db.prepare('UPDATE chats SET title=? WHERE id=?').run('changed-' + seed.id, seed.chat);
      if (db.prepare('DELETE FROM bookmarks WHERE id=?').run(seed.id).changes !== 1)
        throw new Error('Missing self-check seed');
    },
    false
  );
  const found = [];
  for (const path of ['/api/chats/:id', '/api/chats/:id/bookmarks']) {
    const url = path.replace(':id', encodeURIComponent(seed.chat));
    await compareRead(
      label,
      url,
      read(reference, path, url, report),
      read(subject, path, url, report),
      report,
      found
    );
  }
  report.selfCheck.push({ label, differences: found });
  if (
    !found.some((item) => item.after === 'changed-' + seed.id) ||
    !found.some((item) => item.before?.id === seed.id && item.after === undefined)
  )
    throw new Error('Content or missing-row canary missed in ' + label);
}
try {
  report.newBuild = (await assertBuild()).buildId;
  report.oldCommit = buildOld(old, values.old);
  const aFile = file('A');
  copyFileSync(snapshot, aFile);
  const seed = values['self-check'] ? addCanary(aFile) : null;
  copyFileSync(aFile, file('B'));
  const a = await start(old, 'A'),
    b = await start(root, 'B');
  await compare('old-new', a, b, report, tmp);
  const fromOld = await exportTo(a, 'old-restored'),
    fromNew = await exportTo(b, 'new-restored');
  await compare('old-restore', b, fromOld, report, tmp);
  await compare('new-restore', b, fromNew, report, tmp);
  await chats(b);
  if (seed) {
    await checkCanary(b, fromOld, seed, 'old-restore');
    await checkCanary(b, fromNew, seed, 'new-restore');
    await checkCanary(a, b, seed, 'old-new');
  }
  if (!report.comparisons || !report.ids.size || !report.bytes) throw new Error('Empty comparison');
} catch (error) {
  report.errors.push(String(error.stack ?? error));
} finally {
  for (const close of children.reverse())
    try {
      await close();
    } catch (error) {
      report.errors.push(String(error));
    }
  try {
    if (existsSync(path.join(old, '.git'))) git('worktree', 'remove', '--force', old);
    rmSync(tmp, { recursive: true, force: true, maxRetries: 4 });
  } catch (error) {
    report.errors.push(String(error));
  }
  report.ids = report.ids.size;
  const expected = new Set(allowed);
  for (const diff of report.differences) {
    diff.fingerprint = digest(JSON.stringify(diff));
    diff.expected = expected.has(diff.fingerprint);
  }
  const unexpected = report.differences.filter((diff) => !diff.expected).length;
  const endpoints = Object.values(report.coverage['old-new'] ?? {}).filter(Boolean).length;
  report.pass = Boolean(
    endpoints && !unexpected && !report.blocked.length && !report.errors.length
  );
  mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  writeFileSync(output, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(
    `${report.pass ? 'PASS' : 'FAIL'} endpoints=${endpoints} ids=${report.ids} comparisons=${report.comparisons} bytes=${report.bytes} chats=${report.chatRoundTrips} unexpected=${unexpected} blocked=${report.blocked.length} errors=${report.errors.length} selfChecks=${report.selfCheck.length}\nReport ${output}`
  );
  if (!report.pass) process.exitCode = 1;
}
