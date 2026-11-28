import { createHash } from 'node:crypto';
import { createWriteStream, statSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { isDeepStrictEqual } from 'node:util';
import { shape, targets, tableDigests } from './probes.mjs';
import { unpack } from './archive.ts';

export const normalization = [
  { name: 'HTTP response date', header: 'date' },
  { name: 'HTTP entity tag', header: 'etag' },
  { name: 'Request duration', header: 'server-timing' },
  { name: 'Application build', route: '/api/health', path: 'buildId' },
  { name: 'Application version', route: '/api/health', path: 'version' },
  {
    name: 'Time of chat export',
    route: '/api/chats/:/backup-archive',
    path: 'manifest.backup.createdAt',
  },
  {
    name: 'Time of transcript export',
    route: '/api/chats/:/backup-archive',
    path: 'manifest.backup.chats.*.transcript.exportedAt',
  },
  {
    name: 'Resource identities assigned on chat import',
    alias: 'resource',
    paths: [
      'manifest.resources.contents.*.source.id',
      'manifest.resources.contents.*.source.package.id',
      'manifest.resources.prompts.*.source.id',
      'manifest.backup.chats.*.transcript.packageAttachments.*.id',
      'manifest.backup.chats.*.state.profile.pinned.mainPromptPresetId',
    ],
  },
  {
    name: 'Scene identities assigned on chat import',
    alias: 'scene',
    paths: ['manifest.backup.chats.*.state.messages.*.sourceId'],
  },
];
function normalize(obj, parts, transform = () => '<request metadata>') {
  if (!obj || typeof obj !== 'object') return;
  const [part, ...rest] = parts;
  for (const key of part === '*' ? Object.keys(obj) : [part]) {
    if (!Object.hasOwn(obj, key)) continue;
    if (rest.length) normalize(obj[key], rest, transform);
    else obj[key] = transform(obj[key]);
  }
}
export function portable(body) {
  const { resources, backup } = body.manifest;
  const resource = new Map(
    [...resources.contents, ...resources.prompts].map((entry) => [
      entry.source.id,
      'resource:' + entry.key,
    ])
  );
  const scene = new Map(
    backup.chats.flatMap((chat, c) =>
      (chat.state.messages ?? []).map((message, i) => [message.sourceId, 'scene:' + c + ':' + i])
    )
  );
  for (const rule of normalization) {
    if (!rule.alias) continue;
    const aliases = rule.alias === 'resource' ? resource : scene;
    for (const path of rule.paths) normalize(body, path.split('.'), (id) => aliases.get(id) ?? id);
  }
  return body;
}
export const digest = (value) => createHash('sha256').update(value).digest('hex');
export function differences(before, after, path = '$', out = []) {
  if (isDeepStrictEqual(before, after)) return out;
  if (
    before &&
    after &&
    typeof before === 'object' &&
    typeof after === 'object' &&
    Array.isArray(before) === Array.isArray(after)
  ) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      differences(
        before[key],
        after[key],
        path + '[' + (Array.isArray(before) ? key : JSON.stringify(key)) + ']',
        out
      );
    }
  } else out.push({ path, before, after });
  return out;
}
export async function read(instance, template, url, stats, backupFile) {
  const response =
    url === '/api/diagnostics/metrics' ? instance.initialMetrics() : await instance.request(url);
  const headers = Object.fromEntries(response.headers);
  for (const rule of normalization) if (rule.header) delete headers[rule.header];
  const type = headers['content-type'] ?? '';
  let body;
  if (response.ok && template === '/api/backup') {
    await pipeline(response.body, createWriteStream(backupFile, { mode: 0o600 }));
    stats.bytes += statSync(backupFile).size;
    body = tableDigests(backupFile, false);
  } else {
    let bytes;
    if (type.includes('text/event-stream')) {
      const reader = response.body.getReader();
      let frame = Buffer.alloc(0);
      try {
        while (frame.indexOf('\n\n') === -1) {
          const { done, value } = await reader.read();
          if (done) throw new Error('Event stream ended before first frame');
          frame = Buffer.concat([frame, value]);
        }
      } finally {
        await reader.cancel();
      }
      bytes = frame.subarray(0, frame.indexOf('\n\n') + 2);
    } else bytes = Buffer.from(await response.arrayBuffer());
    stats.bytes += bytes.length;
    if (type.includes('json')) body = JSON.parse(bytes);
    else if (response.ok && url.endsWith('/backup-archive')) body = unpack(bytes);
    else if (type.startsWith('text/')) body = bytes.toString();
    else body = { bytes: bytes.length, sha256: digest(bytes) };
  }
  for (const rule of normalization)
    if (rule.route === shape(template)) normalize(body, rule.path.split('.'));
  return { status: response.status, headers, body };
}
export async function compareRead(phase, url, left, right, report, findings = report.differences) {
  const [a, b] = await Promise.all([left, right]);
  if (a.status >= 400 && b.status >= 400) report.errors.push({ phase, url, left: a, right: b });
  for (const item of differences(a, b)) findings.push({ phase, url, ...item });
  report.comparisons++;
}
export async function compare(phase, left, right, report, dir) {
  const index = (side) => new Map(side.routes.map((route) => [shape(route), route]));
  const l = index(left),
    r = index(right);
  const inventory = (report.coverage[phase] = {});
  const routes = [...new Set([...l.keys(), ...r.keys()])].sort();
  for (const route of routes) {
    if (!l.has(route) || !r.has(route)) {
      report.oneSided.push({ phase, route, side: l.has(route) ? 'left' : 'right' });
      continue;
    }
    const requests = new Map();
    for (const [instance, template] of [
      [left, l.get(route)],
      [right, r.get(route)],
    ])
      for (const target of await targets(instance, template)) requests.set(target.url, target.ids);
    inventory[route] = requests.size;
    for (const [url, ids] of requests) {
      for (const id of ids) report.ids.add(id);
      await compareRead(
        phase,
        url,
        read(left, l.get(route), url, report, dir + '/left.sqlite'),
        read(right, r.get(route), url, report, dir + '/right.sqlite'),
        report
      );
    }
  }
}
