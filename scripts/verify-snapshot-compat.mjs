import { attempt, request } from './snapshot-compat/requests.mjs';
import { unpack } from './snapshot-compat/archive.ts';
import { rulesForCommit } from './snapshot-compat/reviewed-changes.mjs';
import { parseArgs } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
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
  normalization,
  portable,
  normalizedBody,
  read,
} from './snapshot-compat/compare.mjs';

const { values } = parseArgs({
  options: {
    snapshot: { type: 'string' },
    old: { type: 'string', default: 'v0.18.1' },
    timeout: { type: 'string' },
    'self-check': { type: 'boolean' },
  },
});
const timeoutSeconds = values.timeout === undefined ? undefined : Number(values.timeout);
if (
  timeoutSeconds !== undefined &&
  (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 2147483)
)
  throw new Error('--timeout must be a positive whole number of seconds (maximum 2147483)');
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
const temporaryRoot = requireExternalPath(realpathSync(requireExternalPath(os.tmpdir())));
const tmp = mkdtempSync(path.join(temporaryRoot, 'uimori-compat-'));
const old = path.join(tmp, 'old');
const output = path.join(root, 'output', 'snapshot-compat', randomUUID() + '.json');
const children = [];
const report = {
  cap,
  normalization,
  coverage: {},
  completed: {},
  timeoutSeconds,
  oneSided: [],
  refusalOnly: [],
  rules: [],
  derivedContentLengths: 0,
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
function skipped(phase, url, reason) {
  report.errors.push({ phase, url, error: 'Skipped: ' + reason });
}
async function restore(phase, name, source, baseline) {
  const url = '/api/backup';
  if (!source || !baseline)
    return skipped(phase, url, 'source or current comparison instance unavailable');
  const exported = await attempt(
    report,
    phase,
    url,
    async () => {
      const response = await read(source, url, url, report, file(name));
      if (response.status !== 200)
        throw Object.assign(new Error('Backup export HTTP ' + response.status), { method: 'GET' });
      return true;
    },
    source.name
  );
  if (!exported) return skipped(phase, url, 'restore comparison requires a complete backup export');
  const restored = await attempt(report, phase, null, () => start(root, name), name);
  if (!restored) return skipped(phase, url, 'restored instance unavailable');
  await compare(phase, baseline, restored, report, tmp);
  return restored;
}
async function post(app, url, body, binary = false) {
  return request(
    app,
    url,
    async (res) => {
      if (!res.ok) throw new Error('Chat import HTTP ' + res.status + ' ' + (await res.text()));
      return res.json();
    },
    {
      method: 'POST',
      headers: { 'content-type': binary ? 'application/octet-stream' : 'application/json' },
      body: binary ? body : JSON.stringify(body),
    }
  );
}
const archiveUrl = (id) => '/api/chats/' + encodeURIComponent(id) + '/backup-archive';
function archive(app, id, source = false) {
  return request(app, archiveUrl(id), async (res) => {
    if (!res.ok) throw new Error('Chat export HTTP ' + res.status);
    const bytes = Buffer.from(await res.arrayBuffer());
    report.bytes += bytes.length;
    return {
      bytes,
      body: portable(normalizedBody('/api/chats/:id/backup-archive', unpack(bytes)), source),
    };
  });
}
async function roundTripChat(app, dest, id) {
  const source = await archive(app, id, true);
  const expected = source.body;
  const upload = await post(dest, '/api/uploads', source.bytes, true);
  const { preparedId, digest } = await post(dest, '/api/chats/prepare-backup-archive', {
    uploadId: upload.uploadId,
  });
  const imported = await post(dest, '/api/chats/import-backup-archive', {
    preparedId,
    digest,
    idempotencyKey: randomUUID(),
  });
  if (!imported.created || imported.chat.id === id)
    throw Object.assign(new Error('Chat import did not create independent copy'), {
      url: '/api/chats/import-backup-archive',
      method: 'POST',
      instance: dest.name,
    });
  const actual = (await archive(dest, imported.chat.id)).body;
  report.differences.push(
    ...differences(expected, actual).map((item) => ({
      phase: 'chat',
      url: archiveUrl(id),
      ...item,
    }))
  );
  report.chatRoundTrips++;
  if (values['self-check']) {
    database(
      dest.file,
      (db) =>
        db.prepare('UPDATE chats SET title=? WHERE id=?').run('changed-' + id, imported.chat.id),
      false
    );
    const changed = (await archive(dest, imported.chat.id)).body;
    if (!differences(expected, changed).some((item) => item.after === 'changed-' + id))
      throw new Error('Chat content canary missed');
    report.selfCheck.push('chat-title');
  }
}
async function chats(app) {
  if (!app) return skipped('chat', '/api/chats', 'current source instance unavailable');
  const dest = await attempt(
    report,
    'chat',
    null,
    () => start(root, 'chat-import', 'import'),
    'chat-import'
  );
  if (!dest)
    return skipped('chat', '/api/chats/import-backup-archive', 'chat import instance unavailable');
  const items = (await targets(app, '/api/chats/:id')).slice(0, 3);
  if (!items.length)
    return skipped('chat', '/api/chats', 'snapshot contains no chats for archive verification');
  for (const {
    ids: [id],
  } of items)
    await attempt(report, 'chat', archiveUrl(id), () => roundTripChat(app, dest, id));
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
  if (!reference || !subject)
    return skipped('self-check/' + label, null, 'required instance unavailable');
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
      'self-check/' + label,
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
  report.newBuild = (await attempt(report, 'build-current', null, assertBuild))?.buildId;
  report.oldCommit = await attempt(report, 'build-old', null, () => buildOld(old, values.old));
  report.rules = rulesForCommit(report.oldCommit);
  const copies = await attempt(report, 'copy', null, () => {
    const aFile = file('A');
    copyFileSync(snapshot, aFile);
    const seed = values['self-check'] ? addCanary(aFile) : null;
    copyFileSync(aFile, file('B'));
    return { seed };
  });
  const a =
    copies && report.oldCommit && (await attempt(report, 'boot', null, () => start(old, 'A'), 'A'));
  const b =
    copies && report.newBuild && (await attempt(report, 'boot', null, () => start(root, 'B'), 'B'));
  if (a && b) await attempt(report, 'old-new', null, () => compare('old-new', a, b, report, tmp));
  else skipped('old-new', null, 'old or current source instance unavailable');
  const fromOld = await attempt(report, 'old-restore', '/api/backup', () =>
    restore('old-restore', 'old-restored', a, b)
  );
  const fromNew = await attempt(report, 'new-restore', '/api/backup', () =>
    restore('new-restore', 'new-restored', b, b)
  );
  await attempt(report, 'chat', '/api/chats', () => chats(b));
  if (values['self-check']) {
    for (const [reference, subject, label] of [
      [b, fromOld, 'old-restore'],
      [b, fromNew, 'new-restore'],
      [a, b, 'old-new'],
    ])
      await attempt(report, 'self-check/' + label, null, () =>
        checkCanary(reference, subject, copies?.seed, label)
      );
  }
  if (!report.comparisons || !report.ids.size || !report.bytes)
    report.errors.push({ phase: 'coverage', url: null, error: 'Empty comparison' });
} catch (error) {
  report.errors.push({ phase: 'setup', url: null, error: String(error.stack ?? error) });
} finally {
  for (const close of children.reverse())
    try {
      await close();
    } catch (error) {
      report.errors.push({ phase: 'cleanup', url: null, error: String(error) });
    }
  try {
    if (existsSync(path.join(old, '.git'))) git('worktree', 'remove', '--force', old);
    rmSync(tmp, { recursive: true, force: true, maxRetries: 4 });
  } catch (error) {
    report.errors.push({ phase: 'cleanup', url: null, error: String(error) });
  }
  report.ids = report.ids.size;
  const unexpected = report.differences.length;
  const counts = Object.values(report.coverage['old-new'] ?? {});
  const endpoints = Object.values(report.completed['old-new'] ?? {}).filter(Boolean).length;
  const oneSided = report.oneSided.filter((item) => item.phase === 'old-new').length;
  const refusalOnly = report.refusalOnly.filter((item) => item.phase === 'old-new').length;
  report.pass = Boolean(
    endpoints && !unexpected && !report.blocked.length && !report.errors.length
  );
  mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  writeFileSync(output, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  for (const rule of report.rules) console.log(`rule=${rule.id} absorbed=${rule.absorbed}`);
  console.log(
    `${report.pass ? 'PASS' : 'FAIL'} endpoints=${endpoints} oneSided=${oneSided} zeroTarget=${counts.filter((n) => n === 0).length} refusalOnly=${refusalOnly} derivedLengths=${report.derivedContentLengths} ids=${report.ids} comparisons=${report.comparisons} bytes=${report.bytes} chats=${report.chatRoundTrips} unexpected=${unexpected} blocked=${report.blocked.length} errors=${report.errors.length} selfChecks=${report.selfCheck.length}\nReport ${output}`
  );
  if (!report.pass) process.exitCode = 1;
}
