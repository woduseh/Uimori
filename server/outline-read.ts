import { createHash } from 'node:crypto';
import type { RunSnapshot } from '../core/types.js';
import type { OutlineLevel } from '../core/outline.js';
import type { Json } from '../core/transport.js';
import type { Store } from './store.js';
import { HttpError, fields, number, text } from './request-validation.js';

const MAX_RESULT_CHARS = 24_000;
const stamp = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Node = {
  id: string;
  parentId: string | null;
  level: OutlineLevel;
  position: number;
  title: string;
  revision: number;
  fixed: number;
  childCount: number;
  commandId: string | null;
  sourceRevision: string | null;
  status: string | null;
  runStatus: string | null;
};
type Writing = {
  nodeId: string;
  sourceRevision: string;
  sourceHash: string | null;
  createdAt: string;
};

/** Intent reads need one node; tree navigation needs only structural metadata, never full prose. */
function outlineState(store: Store, chatId: string, onlyNode: string | null) {
  const chat = store.chat(chatId);
  const nodes = store.db
    .prepare(`SELECT n.id,n.parent_id AS parentId,n.level,n.position,n.title,
    n.revision,n.fixed,n.command_id AS commandId,c.source_revision AS sourceRevision,
    c.status,r.status AS runStatus,
    (SELECT COUNT(*) FROM outline_nodes child WHERE child.chat_id=n.chat_id AND child.parent_id=n.id) AS childCount
    FROM outline_nodes n LEFT JOIN scene_commands c ON c.id=n.command_id LEFT JOIN runs r ON r.id=c.run_id
    WHERE n.chat_id=? ${onlyNode ? 'AND n.id=?' : ''} ORDER BY n.position,n.id`)
    .all(chatId, ...(onlyNode ? [onlyNode] : [])) as Node[];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = new Map<string | null, Node[]>();
  for (const node of nodes) {
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node);
    children.set(node.parentId, siblings);
  }
  const subtree = (id: string | null) => {
    const rows: { node: Node; depth: number }[] = [];
    const walk = (parentId: string | null, depth: number) => {
      for (const node of children.get(parentId) ?? []) {
        rows.push({ node, depth });
        walk(node.id, depth + 1);
      }
    };
    if (id !== null) rows.push({ node: byId.get(id)!, depth: 0 });
    walk(id, id === null ? 0 : 1);
    return rows;
  };
  return { chat, byId, subtree };
}

function metadata(node: Node) {
  const state = !node.commandId
    ? 'planned'
    : node.status === 'consumed' && node.sourceRevision
      ? 'written'
      : node.status === 'failed' || node.status === 'cancelled'
        ? node.status
        : node.runStatus === 'queued' || node.runStatus === 'running'
          ? 'writing'
          : 'scheduled';
  return {
    id: node.id,
    parentId: node.parentId,
    level: node.level,
    position: node.position,
    title: node.title,
    revision: node.revision,
    fixed: !!node.fixed,
    childCount: node.childCount,
    progress: { state },
  };
}

/** One query for the selected page, rather than a text query per node. */
function previews(store: Store, nodes: Node[]) {
  const rows = store.db
    .prepare(`SELECT id,length(intent) AS codePoints,substr(intent,1,160) AS preview
    FROM outline_nodes WHERE id IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify(nodes.map((node) => node.id))) as {
    id: string;
    codePoints: number;
    preview: string;
  }[];
  const byId = new Map(rows.map((row) => [row.id, row]));
  return nodes.map((node) => {
    const row = byId.get(node.id)!;
    return {
      ...metadata(node),
      intentCodePoints: row.codePoints,
      intentPreview: row.preview,
      previewRange: { start: 0, end: row.preview.length, unit: 'utf16-code-unit' },
      previewTruncated: row.codePoints > 160,
    };
  });
}

function sourceReferences(store: Store, nodes: Node[]) {
  return store.db
    .prepare(`SELECT w.node_id AS nodeId,COALESCE(w.source_id,c.source_revision) AS sourceRevision,
    COALESCE((SELECT hash FROM source_edits WHERE source_id=s.id ORDER BY revision DESC LIMIT 1),s.hash) AS sourceHash,
    w.created_at AS createdAt FROM outline_writings w
    LEFT JOIN scene_commands c ON c.id=w.command_id
    LEFT JOIN sources s ON s.id=COALESCE(w.source_id,c.source_revision)
    WHERE w.node_id IN (SELECT value FROM json_each(?)) AND COALESCE(w.source_id,c.source_revision) IS NOT NULL
    ORDER BY w.created_at,w.id`)
    .all(JSON.stringify(nodes.map((node) => node.id))) as Writing[];
}

function sourcePages(store: Store, chatId: string, refs: Writing[], writing?: RunSnapshot) {
  const frozen = new Map(
    writing?.chatId === chatId ? writing.history.map((source) => [source.revision, source]) : []
  );
  const current = new Set(
    store.db
      .prepare(`WITH RECURSIVE history(id) AS (
    SELECT head_revision FROM chats WHERE id=? UNION ALL
    SELECT s.parent_revision FROM sources s JOIN history h ON s.id=h.id WHERE s.parent_revision IS NOT NULL
  ) SELECT id FROM history`)
      .all(chatId)
      .map((row) => String(row.id))
  );
  return refs.map((ref) => {
    const source = frozen.get(ref.sourceRevision);
    const frozenHash = source
      ? (source.contentHash ?? createHash('sha256').update(source.text).digest('hex'))
      : null;
    const same = !!source && frozenHash === ref.sourceHash;
    const available = !!ref.sourceHash && (same || current.has(ref.sourceRevision));
    const dataRef = {
      scope: same ? 'current' : 'chats',
      kind: 'chat',
      id: ref.sourceRevision,
      chatId,
      revision: ref.sourceHash,
      field: '/text',
      hash: ref.sourceHash,
    };
    return {
      nodeId: ref.nodeId,
      sourceRevision: ref.sourceRevision,
      sourceHash: ref.sourceHash,
      origin: same ? 'reserved-chat-source' : 'live-chat-source',
      changedSinceTaskStart: !!source && !same,
      available,
      ...(!available
        ? { unavailableReason: ref.sourceHash ? 'outside-current-history' : 'source-unavailable' }
        : {}),
      ...(available
        ? {
            ref: dataRef,
            nextRead: { name: 'data.read', arguments: { refs: [dataRef], offset: 0, limit: 4000 } },
          }
        : {}),
    };
  });
}

function fitList<T, R>(items: T[], build: () => R): R {
  for (;;) {
    const result = build();
    if (JSON.stringify(result).length <= MAX_RESULT_CHARS) return result;
    if (items.length <= 1) throw new HttpError(400, 'OUTLINE_METADATA_TOO_LARGE');
    items.pop();
  }
}

export function outlineNextRead(chatId: string, args: Record<string, Json>) {
  return { name: 'app.call', arguments: { name: 'outline.read', arguments: { ...args, chatId } } };
}

/** Live outline pages are bound to their selected scope, not unrelated edits elsewhere in the chat. */
export function readHelperOutline(
  store: Store,
  chatId: string,
  args: Record<string, unknown>,
  writing?: RunSnapshot
) {
  fields(args, [
    'chatId',
    'mode',
    'nodeId',
    'depth',
    'offset',
    'limit',
    'expectedVersion',
    'section',
  ]);
  if (args.chatId !== undefined && args.chatId !== chatId)
    throw new HttpError(403, 'OUTLINE_OUTSIDE_SCOPE');
  const mode = args.mode ?? 'overview';
  if (mode !== 'overview' && mode !== 'subtree' && mode !== 'detail')
    throw new HttpError(400, 'OUTLINE_MODE_INVALID');
  const nodeId = mode === 'overview' ? null : text(args.nodeId, 'outline node', 100);
  const section = mode === 'detail' ? (args.section ?? 'intent') : null;
  if (section !== null && section !== 'intent' && section !== 'related' && section !== 'writings')
    throw new HttpError(400, 'OUTLINE_SECTION_INVALID');
  if (
    (mode !== 'subtree' && args.depth !== undefined) ||
    (mode !== 'detail' && args.section !== undefined) ||
    (mode === 'overview' && args.nodeId !== undefined)
  )
    throw new HttpError(400, 'OUTLINE_ARGUMENTS_INVALID');
  const depth = args.depth === undefined ? null : number(args.depth, 'depth', 0, 4);
  const offset = number(args.offset ?? 0, 'offset', 0, Number.MAX_SAFE_INTEGER);
  const limit = Math.min(
    section === 'intent' ? 10000 : 50,
    number(args.limit ?? (section === 'intent' ? 6000 : 20), 'limit', 1, 10000)
  );
  const expected =
    args.expectedVersion === undefined ? undefined : text(args.expectedVersion, 'view version', 64);
  return store.transaction(() => {
    const state = outlineState(store, chatId, section === 'intent' ? nodeId : null);
    const scope = { chatId, mode, nodeId, depth, section };
    const target = nodeId === null ? undefined : state.byId.get(nodeId);
    if (nodeId !== null && !target) {
      if (!expected) throw new HttpError(404, 'OUTLINE_NODE_UNAVAILABLE');
      return {
        kind: 'error' as const,
        scope,
        error: 'OUTLINE_CHANGED',
        returned: false,
        guidance: 'The selected node is no longer available. Rediscover it from overview.',
        nextRead: outlineNextRead(chatId, { mode: 'overview' }),
      };
    }
    const all = state.subtree(nodeId);
    const related =
      section === 'related'
        ? store.db
            .prepare('SELECT related_id FROM outline_links WHERE node_id=? ORDER BY position')
            .all(nodeId!)
            .flatMap((link) => {
              const node = state.byId.get(String(link.related_id));
              return node ? [node] : [];
            })
        : [];
    const refs =
      section === 'writings'
        ? sourceReferences(
            store,
            all.map((item) => item.node)
          )
        : [];
    // A version belongs to this query's data: changing an unrelated sibling cannot invalidate it.
    const versionNodes =
      section === 'intent'
        ? [target!]
        : section === 'related'
          ? [target!, ...related]
          : all.map((item) => item.node);
    const version = stamp([
      scope,
      versionNodes,
      refs,
      section === 'writings' ? state.chat.headRevision : null,
    ]);
    const base = { scope, version };
    const query = {
      mode,
      ...(nodeId ? { nodeId } : {}),
      ...(section ? { section } : {}),
      ...(depth !== null ? { depth } : {}),
      limit,
    };
    const next = (at: number) =>
      outlineNextRead(chatId, { ...query, expectedVersion: version, offset: at });
    if ((offset > 0 && !expected) || (expected !== undefined && expected !== version))
      return {
        ...base,
        kind: 'error' as const,
        error: expected ? 'OUTLINE_CHANGED' : 'OUTLINE_VERSION_REQUIRED',
        returned: false,
        guidance: 'Restart this scope using nextRead; do not combine pages from different views.',
        nextRead: next(0),
      };
    const pageInfo = (returned: number, total: number) => ({
      offset,
      nextOffset: offset + returned < total ? offset + returned : null,
      nextRead: offset + returned < total ? next(offset + returned) : null,
    });

    if (section === 'intent') {
      const node = metadata(target!);
      const value = String(
        store.db.prepare('SELECT intent FROM outline_nodes WHERE id=?').get(nodeId!)!.intent
      );
      if (offset > value.length) throw new HttpError(400, 'OUTLINE_RANGE_INVALID');
      const split = (at: number) => at > 0 && (value.codePointAt(at - 1) ?? 0) > 0xffff;
      const start = split(offset) ? offset - 1 : offset;
      let end = Math.min(value.length, start + limit);
      for (;;) {
        if (split(end)) end--;
        if (end === start && start < value.length)
          end += (value.codePointAt(start) ?? 0) > 0xffff ? 2 : 1;
        const result = {
          ...base,
          kind: 'intent' as const,
          node,
          text: value.slice(start, end),
          totalChars: value.length,
          range: { start, end, unit: 'utf16-code-unit' },
          coverage: { content: 'intent-range', wholeField: start === 0 && end === value.length },
          nextOffset: end < value.length ? end : null,
          nextRead: end < value.length ? next(end) : null,
        };
        if (JSON.stringify(result).length <= MAX_RESULT_CHARS) return result;
        if (end - start <= 2) throw new HttpError(400, 'OUTLINE_METADATA_TOO_LARGE');
        end = start + Math.floor((end - start) / 2);
      }
    }
    if (section === 'writings') {
      if (offset > refs.length) throw new HttpError(400, 'OUTLINE_RANGE_INVALID');
      const items = sourcePages(store, chatId, refs.slice(offset, offset + limit), writing);
      return fitList(items, () => ({
        ...base,
        kind: 'writings' as const,
        items,
        coverage: {
          content: 'source-references-only',
          scopeTotal: refs.length,
          total: refs.length,
          returned: items.length,
          excludedByDepth: 0,
        },
        ...pageInfo(items.length, refs.length),
      }));
    }
    const selected =
      section === 'related'
        ? related
        : all.filter((item) => depth === null || item.depth <= depth).map((item) => item.node);
    if (offset > selected.length) throw new HttpError(400, 'OUTLINE_RANGE_INVALID');
    const nodes = previews(store, selected.slice(offset, offset + limit));
    const page = () => ({
      ...base,
      coverage: {
        content: 'metadata-and-previews',
        scopeTotal: section === 'related' ? related.length : all.length,
        total: selected.length,
        returned: nodes.length,
        excludedByDepth: section === 'related' ? 0 : all.length - selected.length,
      },
      ...pageInfo(nodes.length, selected.length),
    });
    return section === 'related'
      ? fitList(nodes, () => ({ ...page(), kind: 'related' as const, items: nodes }))
      : fitList(nodes, () => ({ ...page(), kind: 'nodes' as const, nodes }));
  });
}
