import { createHash } from 'node:crypto';
import { createWriteStream, statSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { isDeepStrictEqual } from 'node:util';
import { shape, targets, tableDigests } from './probes.mjs';
import { classify } from './reviewed-changes.mjs';
import { unpack } from './archive.ts';

const importedRevision = {
  name: 'Newly imported content starts at revision one',
  scope: 'chat-source',
  paths: [
    'manifest.resources.contents.*.source.revision',
    'manifest.resources.contents.*.source.package.revision',
    'manifest.backup.chats.*.transcript.packageAttachments.*.revision',
  ],
};

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
  importedRevision,
  {
    name: 'Import materializes an empty module list',
    scope: 'chat-source',
    path: 'manifest.resources.contents.*.source.package.modules',
  },
  {
    name: 'Inherited illustration profile identity',
    scope: 'chat',
    path: 'manifest.backup.chats.*.state.illustrationReferences.characterProfiles.*.id',
  },
  {
    name: 'Imported illustration image references',
    scope: 'chat',
    paths: [
      'manifest.backup.chats.*.state.illustrationReferences.characterProfiles.*.referenceRef',
      'manifest.backup.chats.*.state.illustrationReferences.references.*.ref',
      'manifest.backup.chats.*.state.illustrationReferences.images.*.ref',
    ],
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
function projectedImport(body) {
  const { resources } = body.manifest;
  for (const entry of resources.contents) {
    const pkg = entry.source.package;
    if (!Object.hasOwn(pkg, 'modules') && entry.modules.length === 0) pkg.modules = [];
  }
  for (const path of importedRevision.paths)
    normalize(body, path.split('.'), (revision) =>
      Number.isSafeInteger(revision) && revision > 0 ? 1 : revision
    );
}
function normalizeIllustrationReferences(chat, resources, resourceAliases) {
  const refs = chat.state.illustrationReferences;
  if (!refs) return;
  const images = new Map((refs.images ?? []).map((item, i) => [item.ref, { image: i }]));
  const profiles = new Map();
  for (const attachment of chat.transcript.packageAttachments) {
    const entry = resources.contents.find((x) => x.source.id === attachment.id);
    if (!entry || !['bot', 'persona'].includes(attachment.role)) continue;
    const native = entry.source.package.nativeRisu;
    const doc = native && (Object.keys(native.card).length ? native.card : native.module);
    for (const item of doc?.extensions?.uimori?.illustrationProfiles ?? []) {
      const identity = attachment.role + ':' + item.id;
      profiles.set('default:' + digest(attachment.id + ':' + identity), {
        resource: entry.key,
        role: attachment.role,
        profile: item.id,
      });
    }
  }
  const reference = (ref) => {
    if (images.has(ref)) return images.get(ref);
    const parts = /^package:(.+):(bot|persona|module):([^:]+)$/u.exec(ref);
    return parts && resourceAliases.has(parts[1])
      ? { ...resourceAliases.get(parts[1]), role: parts[2], image: parts[3] }
      : ref;
  };
  for (const profile of refs.characterProfiles) {
    if (profiles.has(profile.id)) profile.id = profiles.get(profile.id);
    if (profile.referenceRef) profile.referenceRef = reference(profile.referenceRef);
  }
  for (const item of [...refs.references, ...refs.images]) item.ref = reference(item.ref);
}
export function portable(body, source = false) {
  const { resources, backup } = body.manifest;
  const resource = new Map(
    [...resources.contents, ...resources.prompts].map((entry) => [
      entry.source.id,
      { resource: entry.key },
    ])
  );
  const scene = new Map(
    backup.chats.flatMap((chat, c) =>
      (chat.state.messages ?? []).map((message, i) => [message.sourceId, { chat: c, scene: i }])
    )
  );
  if (source) projectedImport(body);
  for (const chat of backup.chats) normalizeIllustrationReferences(chat, resources, resource);
  for (const rule of normalization) {
    if (!rule.alias) continue;
    const aliases = rule.alias === 'resource' ? resource : scene;
    for (const path of rule.paths) normalize(body, path.split('.'), (id) => aliases.get(id) ?? id);
  }
  return body;
}
export const digest = (value) => createHash('sha256').update(value).digest('hex');
export function differences(before, after, path = '$', out = [], segments = []) {
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
        out,
        [...segments, Array.isArray(before) ? Number(key) : key]
      );
    }
  } else out.push({ path, before, after, segments });
  return out;
}
const responseBytes = new WeakMap();
export async function read(instance, template, url, stats, backupFile) {
  const response =
    url === '/api/diagnostics/metrics' ? instance.initialMetrics() : await instance.request(url);
  const headers = Object.fromEntries(response.headers);
  for (const rule of normalization) if (rule.header) delete headers[rule.header];
  const type = headers['content-type'] ?? '';
  let body, byteLength;
  if (response.ok && template === '/api/backup') {
    await pipeline(response.body, createWriteStream(backupFile, { mode: 0o600 }));
    byteLength = statSync(backupFile).size;
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
    byteLength = bytes.length;
    if (!response.ok && url.endsWith('/backup-archive') && bytes[0] === 123)
      body = JSON.parse(bytes);
    else if (type.includes('json')) body = JSON.parse(bytes);
    else if (response.ok && url.endsWith('/backup-archive')) body = unpack(bytes);
    else if (type.startsWith('text/')) body = bytes.toString();
    else body = { bytes: bytes.length, sha256: digest(bytes) };
  }
  for (const rule of normalization)
    if (rule.route === shape(template)) normalize(body, rule.path.split('.'));
  const result = { status: response.status, headers, body };
  stats.bytes += byteLength;
  responseBytes.set(result, byteLength);
  return result;
}
export async function compareRead(
  phase,
  url,
  left,
  right,
  report,
  findings = report.differences,
  template,
  file
) {
  const [a, b] = await Promise.all([left, right]);
  let diffs = differences(a, b);
  if (phase === 'old-new' && template && diffs.length) {
    const reviewed = classify(report.rules, template, url, a, b, diffs, file, [
      responseBytes.get(a),
      responseBytes.get(b),
    ]);
    diffs = reviewed.remaining;
    if (reviewed.derivedLength) report.derivedContentLengths++;
  }
  for (const { segments, ...item } of diffs) findings.push({ phase, url, ...item });
  report.comparisons++;
  return a.status >= 400 && b.status >= 400;
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
    let refused = 0;
    for (const [url, ids] of requests) {
      for (const id of ids) report.ids.add(id);
      if (
        await compareRead(
          phase,
          url,
          read(left, l.get(route), url, report, dir + '/left.sqlite'),
          read(right, r.get(route), url, report, dir + '/right.sqlite'),
          report,
          report.differences,
          route,
          right.file
        )
      )
        refused++;
    }
    if (refused && refused === requests.size)
      report.refusalOnly.push({ phase, route, requests: refused });
  }
}
