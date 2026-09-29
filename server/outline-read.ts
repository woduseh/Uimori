import { createHash } from 'node:crypto';
import type { RunSnapshot } from '../core/types.js';
import type { OutlineLevel } from '../core/outline.js';
import type { Store } from './store.js';
import { HttpError, fields, number, text } from './request-validation.js';

const MAX_RESULT_CHARS = 24_000;
type Node = {
  id: string;
  parentId: string | null;
  level: OutlineLevel;
  position: number;
  title: string;
  revision: number;
  fixed: number;
  commandId: string | null;
  runId: string | null;
  sourceRevision: string | null;
  status: string | null;
  runStatus: string | null;
};
type Writing = {
  id: string;
  nodeId: string;
  sourceRevision: string | null;
  sourceHash: string | null;
  createdAt: string;
};

/** Metadata only: versions must cover the fields we expose, not repeatedly hash manuscript text. */
function outlineState(store: Store, chatId: string) {
  const chat = store.chat(chatId);
  const nodes = store.db
    .prepare(`SELECT n.id,n.parent_id AS parentId,n.level,n.position,n.title,
    n.revision,n.fixed,n.command_id AS commandId,c.run_id AS runId,c.source_revision AS sourceRevision,
    c.status,r.status AS runStatus FROM outline_nodes n
    LEFT JOIN scene_commands c ON c.id=n.command_id LEFT JOIN runs r ON r.id=c.run_id
    WHERE n.chat_id=? ORDER BY n.position,n.id`)
    .all(chatId) as Node[];
  const links = store.db
    .prepare(`SELECT l.node_id AS nodeId,l.related_id AS relatedId,l.position
    FROM outline_links l JOIN outline_nodes n ON n.id=l.node_id WHERE n.chat_id=?
    ORDER BY l.node_id,l.position,l.related_id`)
    .all(chatId) as { nodeId: string; relatedId: string; position: number }[];
  const writings = store.db
    .prepare(`SELECT w.id,w.node_id AS nodeId,
    COALESCE(w.source_id,c.source_revision) AS sourceRevision,
    COALESCE((SELECT hash FROM source_edits WHERE source_id=s.id ORDER BY revision DESC LIMIT 1),s.hash) AS sourceHash,
    w.created_at AS createdAt FROM outline_writings w JOIN outline_nodes n ON n.id=w.node_id
    LEFT JOIN scene_commands c ON c.id=w.command_id
    LEFT JOIN sources s ON s.id=COALESCE(w.source_id,c.source_revision)
    WHERE n.chat_id=? ORDER BY w.created_at,w.id`)
    .all(chatId) as Writing[];
  const version = createHash('sha256')
    .update(JSON.stringify([chatId, chat.headRevision, nodes, links, writings]))
    .digest('hex');
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = new Map<string | null, Node[]>();
  for (const node of nodes) {
    const group = children.get(node.parentId) ?? [];
    group.push(node);
    children.set(node.parentId, group);
  }
  const subtree = (root: string | null) => {
    const selected: { node: Node; depth: number }[] = [];
    const walk = (parent: string | null, depth: number) => {
      for (const node of children.get(parent) ?? []) {
        selected.push({ node, depth });
        walk(node.id, depth + 1);
      }
    };
    if (root !== null) selected.push({ node: byId.get(root)!, depth: 0 });
    walk(root, root === null ? 0 : 1);
    return selected;
  };
  return { chat, nodes, byId, children, links, writings, version, subtree };
}

export function outlineViewVersion(store: Store, chatId: string): string {
  return outlineState(store, chatId).version;
}

function progress(node: Node) {
  if (!node.commandId) return 'planned';
  if (node.status === 'consumed' && node.sourceRevision) return 'written';
  if (node.status === 'failed' || node.status === 'cancelled') return node.status;
  return node.runStatus === 'queued' || node.runStatus === 'running' ? 'writing' : 'scheduled';
}

export function outlineNextRead(chatId: string, args: Record<string, unknown>) {
  return { name: 'app.call', arguments: { name: 'outline.read', arguments: { ...args, chatId } } };
}

/** Size failures retry the same range: a rejected page was never consumed by the model. */
export function smallerOutlineRead(chatId: string, args: Record<string, unknown>) {
  return outlineNextRead(chatId, {
    ...args,
    ...(args.mode === 'detail' && (args.section ?? 'intent') === 'intent'
      ? { textLimit: Math.max(1, Math.min(2000, Math.floor(Number(args.textLimit ?? 6000) / 2))) }
      : { limit: Math.max(1, Math.min(5, Math.floor(Number(args.limit ?? 20) / 2))) }),
  });
}

/** Live outline projection. A read transaction binds the version and its data to one database view. */
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
    'textOffset',
    'textLimit',
  ]);
  if (args.chatId !== undefined && args.chatId !== chatId)
    throw new HttpError(403, 'OUTLINE_OUTSIDE_SCOPE');
  const mode = args.mode ?? 'overview';
  if (!['overview', 'subtree', 'detail'].includes(String(mode)))
    throw new HttpError(400, 'OUTLINE_MODE_INVALID');
  const nodeId = mode === 'overview' ? null : text(args.nodeId, 'outline node', 100);
  const section = mode === 'detail' ? (args.section ?? 'intent') : null;
  if (section !== null && !['intent', 'related', 'writings'].includes(String(section)))
    throw new HttpError(400, 'OUTLINE_SECTION_INVALID');
  if (
    (mode !== 'subtree' && args.depth !== undefined) ||
    (mode !== 'detail' &&
      [args.section, args.textOffset, args.textLimit].some((x) => x !== undefined)) ||
    (mode === 'overview' && args.nodeId !== undefined) ||
    (section !== 'intent' && [args.textOffset, args.textLimit].some((x) => x !== undefined)) ||
    (section === 'intent' && [args.offset, args.limit].some((x) => x !== undefined))
  )
    throw new HttpError(400, 'OUTLINE_ARGUMENTS_INVALID');
  const depth = args.depth === undefined ? null : number(args.depth, 'depth', 0, 4);
  const offset = number(args.offset ?? 0, 'offset', 0, Number.MAX_SAFE_INTEGER);
  const limit = number(args.limit ?? 20, 'limit', 1, 50);
  const textOffset = number(args.textOffset ?? 0, 'text offset', 0, Number.MAX_SAFE_INTEGER);
  const textLimit = number(args.textLimit ?? 6000, 'text limit', 1, 10000);
  const expected =
    args.expectedVersion === undefined ? undefined : text(args.expectedVersion, 'view version', 64);
  return store.transaction(() => {
    const state = outlineState(store, chatId);
    if (nodeId !== null && !state.byId.has(nodeId)) {
      if (expected && expected !== state.version)
        return {
          scope: { chatId, mode, nodeId, depth, section },
          version: state.version,
          error: 'OUTLINE_CHANGED',
          returned: false,
          guidance:
            'The selected node is no longer available. Rediscover it from the current overview.',
          nextRead: outlineNextRead(chatId, {
            mode: 'overview',
            offset: 0,
            expectedVersion: state.version,
          }),
        };
      throw new HttpError(404, 'OUTLINE_NODE_UNAVAILABLE');
    }
    const scope = { chatId, mode, nodeId, depth, section };
    const base = { scope, version: state.version };
    const restartArgs = {
      ...args,
      expectedVersion: state.version,
      ...(section === 'intent' ? { textOffset: 0 } : { offset: 0 }),
    };
    if (
      ((offset > 0 || textOffset > 0) && !expected) ||
      (expected !== undefined && expected !== state.version)
    )
      return {
        ...base,
        error: expected ? 'OUTLINE_CHANGED' : 'OUTLINE_VERSION_REQUIRED',
        returned: false,
        guidance: 'Do not combine pages from different views. Restart this scope using nextRead.',
        nextRead: outlineNextRead(chatId, restartArgs),
      };
    const next = (at: number) =>
      outlineNextRead(chatId, {
        ...args,
        expectedVersion: state.version,
        ...(section === 'intent' ? { textOffset: at } : { offset: at }),
      });
    const metadata = (node: Node, preview = true) => {
      const row = store.db
        .prepare(
          'SELECT length(intent) AS codePoints,substr(intent,1,160) AS preview FROM outline_nodes WHERE id=?'
        )
        .get(node.id)!;
      const excerpt = preview ? String(row.preview) : '';
      return {
        id: node.id,
        parentId: node.parentId,
        level: node.level,
        position: node.position,
        title: node.title,
        revision: node.revision,
        fixed: !!node.fixed,
        progress: { state: progress(node) },
        childCount: state.children.get(node.id)?.length ?? 0,
        // SQLite length/substr use Unicode code points; do not mislabel this as UTF-16 length.
        intentCodePoints: Number(row.codePoints),
        ...(preview
          ? {
              intentPreview: excerpt,
              previewRange: { start: 0, end: excerpt.length, unit: 'utf16-code-unit' },
              previewTruncated: Number(row.codePoints) > 160,
            }
          : {}),
      };
    };
    if (section === 'intent') {
      const node = metadata(state.byId.get(nodeId!)!, false);
      // Only the selected intent is materialized. No full-tree text, writing or review hydration.
      const value = String(
        store.db.prepare('SELECT intent FROM outline_nodes WHERE id=?').get(nodeId!)!.intent
      );
      if (textOffset > value.length) throw new HttpError(400, 'OUTLINE_RANGE_INVALID');
      let start = textOffset;
      const split = (at: number) =>
        at > 0 &&
        at < value.length &&
        /[\uD800-\uDBFF]/u.test(value[at - 1]) &&
        /[\uDC00-\uDFFF]/u.test(value[at]);
      if (split(start)) start--;
      let end = Math.min(value.length, start + textLimit);
      const build = () => ({
        ...base,
        node,
        text: value.slice(start, end),
        totalChars: value.length,
        range: { start, end, unit: 'utf16-code-unit' },
        coverage: { content: 'intent-range', complete: start === 0 && end === value.length },
        nextOffset: end < value.length ? end : null,
        nextRead: end < value.length ? next(end) : null,
      });
      for (;;) {
        if (split(end)) end--;
        if (end === start && start < value.length)
          end = start + ((value.codePointAt(start) ?? 0) > 0xffff ? 2 : 1);
        const result = build();
        if (JSON.stringify(result).length <= MAX_RESULT_CHARS) return result;
        if (end - start <= 2) throw new HttpError(400, 'OUTLINE_METADATA_TOO_LARGE');
        end = start + Math.floor((end - start) / 2);
      }
    }
    const all = state.subtree(nodeId);
    const selected =
      mode === 'detail' ? all : all.filter((item) => depth === null || item.depth <= depth);
    const ids = new Set(all.map((item) => item.node.id));
    const rows =
      section === 'related'
        ? state.links
            .filter((link) => link.nodeId === nodeId)
            .map((link) => state.byId.get(link.relatedId)!)
            .filter(Boolean)
        : section === 'writings'
          ? state.writings.filter((ref) => ids.has(ref.nodeId) && ref.sourceRevision !== null)
          : selected.map((item) => item.node);
    if (offset > rows.length) throw new HttpError(400, 'OUTLINE_RANGE_INVALID');
    const frozen =
      writing?.chatId === chatId
        ? new Map(writing.history.map((source) => [source.revision, source]))
        : new Map<string, RunSnapshot['history'][number]>();
    const current = new Set(
      section === 'writings'
        ? store.db
            .prepare(`WITH RECURSIVE history(id) AS (
      SELECT head_revision FROM chats WHERE id=? UNION ALL
      SELECT s.parent_revision FROM sources s JOIN history h ON s.id=h.id WHERE s.parent_revision IS NOT NULL
    ) SELECT id FROM history`)
            .all(chatId)
            .map((row) => String(row.id))
        : []
    );
    const sourceItem = (ref: Writing) => {
      const source = frozen.get(ref.sourceRevision!);
      const frozenHash = source
        ? (source.contentHash ?? createHash('sha256').update(source.text).digest('hex'))
        : null;
      const same = !!source && frozenHash === ref.sourceHash;
      const available = !!ref.sourceHash && (same || current.has(ref.sourceRevision!));
      const dataRef = {
        scope: same ? 'current' : 'chats',
        kind: 'chat',
        id: ref.sourceRevision!,
        chatId,
        revision: ref.sourceHash!,
        field: '/text',
        hash: ref.sourceHash!,
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
              nextRead: {
                name: 'data.read',
                arguments: { refs: [dataRef], offset: 0, limit: 4000 },
              },
            }
          : {}),
      };
    };
    const items: unknown[] = [];
    const build = () => {
      const end = offset + items.length;
      return {
        ...base,
        ...(mode === 'detail' ? { items } : { nodes: items }),
        coverage: {
          content: section === 'writings' ? 'source-references-only' : 'metadata-and-previews',
          scopeTotal: mode === 'detail' ? rows.length : all.length,
          total: rows.length,
          returned: items.length,
          excludedByDepth: mode === 'detail' ? 0 : all.length - selected.length,
        },
        offset,
        nextOffset: end < rows.length ? end : null,
        nextRead: end < rows.length ? next(end) : null,
      };
    };
    for (const row of rows.slice(offset, offset + limit)) {
      items.push(section === 'writings' ? sourceItem(row as Writing) : metadata(row as Node));
      if (JSON.stringify(build()).length > MAX_RESULT_CHARS) {
        items.pop();
        if (!items.length) throw new HttpError(400, 'OUTLINE_METADATA_TOO_LARGE');
        break;
      }
    }
    return build();
  });
}
