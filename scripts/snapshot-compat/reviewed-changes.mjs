import { isDeepStrictEqual } from 'node:util';
import { database } from './probes.mjs';
import * as v0181 from './rules/v0.18.1.mjs';

export function rulesForCommit(commit) {
  return (commit === v0181.commit ? v0181.rules : []).map((rule) => ({ ...rule, absorbed: 0 }));
}
function matchesRoute(pattern, template, url) {
  const expected = pattern.split('/'),
    params = template.split('/'),
    values = url.split('?')[0].split('/');
  return (
    expected.length === params.length &&
    expected.every((part, i) => (part === ':' ? params[i] === ':' : part === values[i]))
  );
}
function matchesValue(value, expected) {
  if (!expected || typeof expected !== 'object') return value === expected;
  switch (expected.type) {
    case 'array':
      return Array.isArray(value);
    case 'strings':
      return Array.isArray(value) && value.every((v) => typeof v === 'string');
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    default:
      return typeof value === expected.type;
  }
}
function matchesPath(path, segments) {
  const parts = path.split('.');
  return (
    parts.length === segments.length &&
    parts.every((part, i) =>
      part === '*' ? typeof segments[i] === 'number' : part === segments[i]
    )
  );
}
function eligible(rule, a, b, url, file) {
  if (!rule.when) return true;
  if (rule.when === 'scene-detail-refusal')
    return (
      isDeepStrictEqual(a.body, { error: 'Scene invocation not found' }) &&
      isDeepStrictEqual(b.body, { code: 'LIBRARY_ITEM_DELETED' })
    );
  if (rule.when === 'deleted-refusal')
    return a.body.error === 'Library item not found' && b.body.code === 'LIBRARY_ITEM_DELETED';
  const id = decodeURIComponent(url.split('/').at(rule.when === 'hidden-content' ? -1 : -2));
  if (rule.when === 'hidden-content') {
    if (b.body.code !== 'LIBRARY_ITEM_DELETED' || a.body.id !== id) return false;
    return database(file, (db) =>
      Boolean(db.prepare("SELECT 1 FROM library_hidden WHERE kind='content' AND id=?").get(id))
    );
  }
  if (rule.when === 'hidden-archive-root') {
    if (a.body.error !== 'Library item deleted' || b.body.manifest?.kind !== 'chat') return false;
    const { resources, backup } = b.body.manifest;
    return database(file, (db) => {
      const row = db
        .prepare(
          'SELECT c.title,p.body FROM chats c JOIN profiles p ON c.id=p.chat_id WHERE c.id=?'
        )
        .get(id);
      if (!row || backup?.title !== row.title) return false;
      const profile = JSON.parse(row.body);
      const hidden = db.prepare('SELECT 1 FROM library_hidden WHERE kind=? AND id=?');
      return resources.roots.some(({ kind, key }) => {
        const entry = (kind === 'content' ? resources.contents : resources.prompts).find(
          (x) => x.key === key
        );
        if (!entry) return false;
        const target = entry.source.id;
        const attached =
          kind === 'content'
            ? profile.packageAttachments?.some((x) => x.id === target)
            : kind === 'prompt-preset' && profile.pinned?.mainPromptPresetId === target;
        return attached && Boolean(hidden.get(kind, target));
      });
    });
  }
  throw new Error('Unknown review condition ' + rule.when);
}
export function classify(rules, template, url, a, b, diffs, file, lengths) {
  const applicable = rules.filter(
    (rule) =>
      isDeepStrictEqual(rule.status, [a.status, b.status]) &&
      rule.routes.some((route) => matchesRoute(route, template, url)) &&
      eligible(rule, a, b, url, file)
  );
  const remaining = [];
  let acceptedBody = false;
  for (const diff of diffs) {
    const rule = applicable.find(({ fields }) =>
      fields.some(
        (f) =>
          matchesPath(f.path, diff.segments) &&
          matchesValue(diff.before, f.before) &&
          matchesValue(diff.after, f.after)
      )
    );
    if (!rule) {
      remaining.push(diff);
      continue;
    }
    if (diff.segments[0] === 'body') acceptedBody = true;
    rule.absorbed++;
  }
  const derivedLength =
    acceptedBody &&
    !remaining.some((d) => d.segments[0] === 'body') &&
    remaining.find((d) => matchesPath('headers.content-length', d.segments)) &&
    [a, b].every(
      (r, i) =>
        r.headers['content-length'] === String(lengths[i]) ||
        (r.headers['content-length'] === undefined && r.headers['transfer-encoding'] === 'chunked')
    );
  return {
    remaining: derivedLength
      ? remaining.filter((d) => !matchesPath('headers.content-length', d.segments))
      : remaining,
    derivedLength: Boolean(derivedLength),
  };
}
