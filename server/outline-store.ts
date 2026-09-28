import { HttpError, fields, number, record, text } from './request-validation.js';
import { textTokenExcerpt } from '../core/text-tokens.js';
import { REQUEST_TEXT_MAX_CHARS } from '../core/content-limits.js';
import { deleteSceneCommand } from './chat-deletion.js';
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Store } from './store.js';
import type { RunSnapshot } from '../core/types.js';
import {
  OUTLINE_INTENT_MAX,
  OUTLINE_LEVELS,
  OUTLINE_LEVEL_LABELS,
  OUTLINE_TITLE_MAX,
  outlineParentAllowed,
  outlineSnapshotNode,
  outlineTree,
  outlineWritable,
  type OutlineDetail,
  type OutlineLevel,
  type OutlineNode,
  type OutlineProgress,
  type OutlineSnapshot,
  type OutlineWriting,
  type OutlineReview,
  type OutlineHelperContext,
  type OutlineTarget,
} from '../core/outline.js';

/** Seal what was actually frozen, so a later read can tell the applied composition apart. */
const sealOutlineSnapshot = (outline: Omit<OutlineSnapshot, 'hash'>): OutlineSnapshot => ({
  ...outline,
  hash: createHash('sha256').update(JSON.stringify(outline)).digest('hex'),
});

type Row = Record<string, any>;
const now = () => new Date().toISOString();
const ACTIVE_RUN = ['queued', 'running'];
/** One request's frozen input keeps a bounded amount of already-written history. */
const WRITTEN_LIMIT = 40;
const BATCH_LIMIT = 200;
type OutlineSelection = { path: OutlineNode[]; children: OutlineNode[]; related: OutlineNode[] };

/** The same path and direct children feed both a reservation check and the eventual Run. */
function outlineSelection(nodes: readonly OutlineNode[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = new Map<string, OutlineNode[]>();
  for (const node of nodes) {
    if (node.parentId === null) continue;
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node);
    children.set(node.parentId, siblings);
  }
  return (id: string): OutlineSelection => {
    const path: OutlineNode[] = [];
    for (let node = byId.get(id); node; ) {
      path.unshift(node);
      node = node.parentId === null ? undefined : byId.get(node.parentId);
    }
    const direct = children.get(id) ?? [];
    const included = new Set([...path, ...direct].map((node) => node.id));
    const related = [...new Set([...path, ...direct].flatMap((node) => node.relatedIds ?? []))]
      .filter((ref) => !included.has(ref))
      .flatMap((ref) => (byId.get(ref) ? [byId.get(ref)!] : []));
    return { path, children: direct, related };
  };
}

/** Binding a command changes revision/progress, but not the plan the request was written for. */
function plannedContent(selection: OutlineSelection) {
  const content = (node: OutlineNode) => [node.id, node.level, node.title, node.intent, node.fixed];
  return JSON.stringify({
    path: selection.path.map(content),
    children: selection.children.map(content),
    related: selection.related.map(content),
  });
}

/** Create current tables during fresh database initialization. */
export function initOutline(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS outline_nodes (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), branch_id TEXT NOT NULL REFERENCES branches(id), parent_id TEXT REFERENCES outline_nodes(id), level TEXT NOT NULL, position INTEGER NOT NULL, title TEXT NOT NULL, intent TEXT NOT NULL, fixed INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL, command_id TEXT REFERENCES scene_commands(id), request_key TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(chat_id,request_key));
    CREATE INDEX IF NOT EXISTS outline_nodes_branch ON outline_nodes(chat_id,branch_id,parent_id,position);
    CREATE TABLE IF NOT EXISTS outline_batches (chat_id TEXT NOT NULL REFERENCES chats(id), branch_id TEXT NOT NULL REFERENCES branches(id), request_key TEXT NOT NULL, authority TEXT NOT NULL, operations TEXT NOT NULL, created TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(chat_id,request_key));
  `);
}

/** Small plan references and source links; no duplicated manuscript or completed input archive. */
export function initOutlineWorkspace(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS outline_links (
      node_id TEXT NOT NULL REFERENCES outline_nodes(id) ON DELETE CASCADE,
      related_id TEXT NOT NULL REFERENCES outline_nodes(id) ON DELETE CASCADE,
      position INTEGER NOT NULL, PRIMARY KEY(node_id,related_id));
    CREATE TABLE IF NOT EXISTS outline_writings (
      id TEXT PRIMARY KEY, node_id TEXT NOT NULL REFERENCES outline_nodes(id) ON DELETE CASCADE,
      command_id TEXT UNIQUE REFERENCES scene_commands(id) ON DELETE SET NULL,
      source_id TEXT REFERENCES sources(id) ON DELETE CASCADE,
      node_revision INTEGER, plan_hash TEXT, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS outline_writings_node ON outline_writings(node_id,created_at);
    CREATE TABLE IF NOT EXISTS outline_reviews (
      task_id TEXT PRIMARY KEY REFERENCES helper_tasks(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL REFERENCES outline_nodes(id) ON DELETE CASCADE,
      plan_hash TEXT NOT NULL, sources TEXT NOT NULL, partial INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS outline_reviews_node ON outline_reviews(node_id,created_at);
    INSERT OR IGNORE INTO outline_writings(id,node_id,command_id,created_at)
      SELECT 'legacy:'||id,id,command_id,updated_at FROM outline_nodes WHERE command_id IS NOT NULL;
  `);
}

/** Retained as a receipt-origin tag for replay comparison, not two levels of edit permission. */
export type OutlineAuthority = 'user' | 'model';
export type OutlineOperation =
  | {
      op: 'create';
      ref?: string;
      parentRef?: string;
      parentId?: string | null;
      level: OutlineLevel;
      title: string;
      intent: string;
      position?: number;
      relatedIds?: string[];
    }
  | {
      op: 'update';
      id: string;
      expectedRevision: number;
      title?: string;
      intent?: string;
      fixed?: boolean;
      relatedIds?: string[];
    }
  | {
      op: 'move';
      id: string;
      expectedRevision: number;
      parentId?: string | null;
      position: number;
    }
  | { op: 'remove'; id: string; expectedRevision: number };

const level = (value: unknown): OutlineLevel => {
  if (typeof value !== 'string' || !(OUTLINE_LEVELS as readonly string[]).includes(value))
    throw new HttpError(400, 'Invalid outline level');
  return value as OutlineLevel;
};
const boolean = (value: unknown, name: string): boolean => {
  if (typeof value !== 'boolean') throw new HttpError(400, `Invalid ${name}`);
  return value;
};
const optionalId = (value: unknown, name: string): string | null =>
  value === null ? null : text(value, name, 100);

function parseRelatedIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 40)
    throw new HttpError(400, '함께 참고할 구성은 40개까지 연결해요.');
  const ids = value.map((id) => text(id, 'related outline', 100));
  if (new Set(ids).size !== ids.length) throw new HttpError(400, '구성 참조가 중복됐어요.');
  return ids;
}

export function parseOutlineOperations(value: unknown): OutlineOperation[] {
  if (!Array.isArray(value) || !value.length)
    throw new HttpError(400, '적용할 구성 변경이 필요해요.');
  if (value.length > BATCH_LIMIT)
    throw new HttpError(400, `한 번에 적용할 수 있는 구성 변경은 ${BATCH_LIMIT}개까지예요.`);
  const refs = new Set<string>();
  return value.map((item) => {
    const body = record(item);
    if (body.op === 'create') {
      fields(body, [
        'op',
        'ref',
        'parentRef',
        'parentId',
        'level',
        'title',
        'intent',
        'position',
        'relatedIds',
      ]);
      if (body.parentRef !== undefined && body.parentId !== undefined)
        throw new HttpError(400, '상위 항목은 parentRef 또는 parentId 하나만 지정해 주세요.');
      if (body.ref !== undefined) {
        const ref = text(body.ref, 'outline ref', 100);
        if (refs.has(ref)) throw new HttpError(400, `구성 참조 '${ref}'가 중복됐어요.`);
        refs.add(ref);
      }
      return {
        op: 'create' as const,
        ...(body.ref === undefined ? {} : { ref: text(body.ref, 'outline ref', 100) }),
        ...(body.parentRef === undefined
          ? {}
          : { parentRef: text(body.parentRef, 'outline parent ref', 100) }),
        ...(body.parentId === undefined
          ? {}
          : { parentId: optionalId(body.parentId, 'outline parent') }),
        level: level(body.level),
        title: text(body.title, 'outline title', OUTLINE_TITLE_MAX),
        intent: text(body.intent, 'outline intent', OUTLINE_INTENT_MAX, true),
        ...(body.relatedIds === undefined ? {} : { relatedIds: parseRelatedIds(body.relatedIds) }),
        ...(body.position === undefined
          ? {}
          : { position: number(body.position, 'outline position', 0, 1e6) }),
      };
    }
    if (body.op === 'update') {
      fields(body, ['op', 'id', 'expectedRevision', 'title', 'intent', 'fixed', 'relatedIds']);
      if (
        body.title === undefined &&
        body.intent === undefined &&
        body.fixed === undefined &&
        body.relatedIds === undefined
      )
        throw new HttpError(400, '변경할 내용이 필요해요.');
      return {
        op: 'update' as const,
        id: text(body.id, 'outline node', 100),
        expectedRevision: number(body.expectedRevision, 'outline revision'),
        ...(body.title === undefined
          ? {}
          : { title: text(body.title, 'outline title', OUTLINE_TITLE_MAX) }),
        ...(body.intent === undefined
          ? {}
          : { intent: text(body.intent, 'outline intent', OUTLINE_INTENT_MAX, true) }),
        ...(body.fixed === undefined ? {} : { fixed: boolean(body.fixed, 'outline pin') }),
        ...(body.relatedIds === undefined ? {} : { relatedIds: parseRelatedIds(body.relatedIds) }),
      };
    }
    if (body.op === 'move') {
      fields(body, ['op', 'id', 'expectedRevision', 'parentId', 'position']);
      return {
        op: 'move' as const,
        id: text(body.id, 'outline node', 100),
        expectedRevision: number(body.expectedRevision, 'outline revision'),
        ...(body.parentId === undefined
          ? {}
          : { parentId: optionalId(body.parentId, 'outline parent') }),
        position: number(body.position, 'outline position', 0, 1e6),
      };
    }
    if (body.op === 'remove') {
      fields(body, ['op', 'id', 'expectedRevision']);
      return {
        op: 'remove' as const,
        id: text(body.id, 'outline node', 100),
        expectedRevision: number(body.expectedRevision, 'outline revision'),
      };
    }
    throw new HttpError(400, 'Invalid outline operation');
  });
}

/** Composition is owned by one chat branch, exactly like the scene commands it schedules. */
export class OutlineStore {
  constructor(readonly store: Store) {}
  get db() {
    return this.store.db;
  }
  private progress(commandId: string | null): OutlineProgress {
    const planned: OutlineProgress = {
      state: 'planned',
      commandId: null,
      runId: null,
      sourceRevision: null,
    };
    if (!commandId) return planned;
    const row = this.db.prepare('SELECT * FROM scene_commands WHERE id=?').get(commandId) as
      | Row
      | undefined;
    if (!row) return planned;
    const bound = { commandId, runId: row.run_id ?? null, sourceRevision: row.source_revision };
    if (row.status === 'consumed' && row.source_revision)
      return { ...bound, state: 'written', sourceRevision: row.source_revision };
    if (row.status === 'failed') return { ...bound, state: 'failed' };
    if (row.status === 'cancelled') return { ...bound, state: 'cancelled' };
    if (!row.run_id) return { ...bound, state: 'scheduled' };
    const run = this.db.prepare('SELECT status FROM runs WHERE id=?').get(row.run_id) as
      | Row
      | undefined;
    return { ...bound, state: run && ACTIVE_RUN.includes(run.status) ? 'writing' : 'scheduled' };
  }
  private map(row: Row): OutlineNode {
    return {
      id: row.id,
      chatId: row.chat_id,
      branchId: row.branch_id,
      parentId: row.parent_id ?? null,
      level: row.level,
      position: Number(row.position),
      title: row.title,
      intent: row.intent,
      fixed: !!Number(row.fixed),
      revision: Number(row.revision),
      progress: this.progress(row.command_id ?? null),
      relatedIds: this.db
        .prepare('SELECT related_id FROM outline_links WHERE node_id=? ORDER BY position')
        .all(row.id)
        .map((link) => String(link.related_id)),
      writings: this.writings(row.id),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  node(id: string): OutlineNode {
    const row = this.db.prepare('SELECT * FROM outline_nodes WHERE id=?').get(id) as
      | Row
      | undefined;
    if (!row) throw new HttpError(404, '구성 항목을 찾을 수 없어요.');
    return this.map(row);
  }
  private branchRows(chatId: string, branchId: string): Row[] {
    return this.db
      .prepare('SELECT * FROM outline_nodes WHERE chat_id=? AND branch_id=?')
      .all(chatId, branchId) as Row[];
  }
  nodes(chatId: string, branchId: string): OutlineNode[] {
    return outlineTree(this.branchRows(chatId, branchId).map((row) => this.map(row)));
  }
  detail(chatId: string, branchId?: string): OutlineDetail {
    const branch = this.store.product.branch(chatId, branchId);
    const nodes = this.nodes(chatId, branch.id);
    return {
      chatId,
      branchId: branch.id,
      nodes: nodes.map((node) => {
        const review = this.latestReview(node.id, nodes);
        return review ? { ...node, latestReview: review } : node;
      }),
    };
  }

  writings(nodeId: string): OutlineWriting[] {
    return this.db
      .prepare(`SELECT DISTINCT w.node_id AS nodeId,s.id AS sourceRevision,
      COALESCE((SELECT hash FROM source_edits WHERE source_id=s.id ORDER BY revision DESC LIMIT 1),s.hash) AS sourceHash,
      w.created_at AS createdAt
      FROM outline_writings w LEFT JOIN scene_commands c ON c.id=w.command_id
      JOIN sources s ON s.id=COALESCE(w.source_id,c.source_revision)
      WHERE w.node_id=? ORDER BY w.created_at,w.id`)
      .all(nodeId) as OutlineWriting[];
  }
  unitSources(id: string, nodes?: OutlineNode[]): OutlineWriting[] {
    const node = this.node(id);
    const all = nodes ?? this.nodes(node.chatId, node.branchId);
    const subtree = [node, ...this.descendants(all, id)];
    const unique = new Map<string, OutlineWriting>();
    for (const item of subtree)
      for (const source of item.writings ?? []) unique.set(source.sourceRevision, source);
    return [...unique.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  private setRelated(id: string, ids: string[]) {
    const node = this.node(id);
    for (const relatedId of ids) {
      const related = this.node(relatedId);
      if (relatedId === id || related.chatId !== node.chatId || related.branchId !== node.branchId)
        throw new HttpError(400, '같은 채팅의 다른 구성만 참고할 수 있어요.');
    }
    this.db.prepare('DELETE FROM outline_links WHERE node_id=?').run(id);
    const insert = this.db.prepare('INSERT INTO outline_links VALUES(?,?,?)');
    ids.forEach((relatedId, position) => {
      insert.run(id, relatedId, position);
    });
  }
  planHash(id: string, nodes?: OutlineNode[]) {
    const node = this.node(id);
    return createHash('sha256')
      .update(plannedContent(outlineSelection(nodes ?? this.nodes(node.chatId, node.branchId))(id)))
      .digest('hex');
  }
  preview(id: string) {
    const node = this.node(id),
      nodes = this.nodes(node.chatId, node.branchId);
    const { path, children, related } = outlineSelection(nodes)(id);
    return {
      expectedRevision: node.revision,
      planHash: this.planHash(id, nodes),
      outline: sealOutlineSnapshot({
        version: 1,
        path: path.map(outlineSnapshotNode),
        children: children.map(outlineSnapshotNode),
        related: related.map(outlineSnapshotNode),
        sources: this.unitSources(id, nodes),
        written: [],
      }),
    };
  }
  helperContext(
    chatId: string,
    branchId: string,
    target: OutlineTarget,
    inputTokenLimit: number
  ): OutlineHelperContext {
    if (!target.nodeId) {
      if (target.purpose === 'review' || target.expectedRevision !== null)
        throw new HttpError(400, '점검할 구성을 선택해 주세요.');
      return { target, brief: null, sources: [], partial: false };
    }
    const node = this.node(target.nodeId);
    if (node.chatId !== chatId || node.branchId !== branchId)
      throw new HttpError(403, 'OUTLINE_OUTSIDE_SCOPE');
    if (node.revision !== target.expectedRevision)
      throw new HttpError(409, '선택한 구성이 변경됐어요. 다시 선택해 주세요.');
    const brief = this.preview(node.id).outline;
    const sources: OutlineHelperContext['sources'] = [];
    // Seed excerpts leave room for plan/history and can be expanded with the existing read tools.
    let remaining = Math.floor(inputTokenLimit / 4);
    if (target.purpose === 'review') {
      const refs = brief.sources ?? [];
      if (!refs.length)
        throw new HttpError(409, '먼저 이 구성이나 하위 항목에 원문을 작성해 주세요.');
      for (const [index, ref] of refs.entries()) {
        const source = this.store.source(ref.sourceRevision);
        const excerpt = textTokenExcerpt(
          source.text,
          Math.floor(remaining / (refs.length - index))
        );
        remaining -= excerpt.tokens;
        sources.push({
          id: source.id,
          hash: source.hash,
          start: 0,
          end: excerpt.text.length,
          total: source.text.length,
          text: excerpt.text,
        });
      }
    }
    return { target, brief, sources, partial: sources.some((source) => source.end < source.total) };
  }
  recordReview(taskId: string, context: OutlineHelperContext) {
    if (context.target.purpose !== 'review' || !context.target.nodeId) return;
    this.db
      .prepare('INSERT OR IGNORE INTO outline_reviews VALUES(?,?,?,?,?,?)')
      .run(
        taskId,
        context.target.nodeId,
        this.planHash(context.target.nodeId),
        JSON.stringify(context.sources.map(({ text: _text, ...ref }) => ref)),
        Number(context.partial),
        now()
      );
    this.store.event(this.node(context.target.nodeId).chatId, 'outline.review', taskId);
  }
  latestReview(id: string, nodes?: OutlineNode[]): OutlineReview | null {
    const row = this.db
      .prepare(`SELECT r.*,t.status,t.conversation_id FROM outline_reviews r
      JOIN helper_tasks t ON t.id=r.task_id WHERE r.node_id=? ORDER BY r.created_at DESC,r.rowid DESC LIMIT 1`)
      .get(id);
    if (!row) return null;
    const sources = JSON.parse(String(row.sources)) as OutlineReview['sources'];
    const current = this.unitSources(id, nodes);
    const stale =
      row.plan_hash !== this.planHash(id, nodes) ||
      sources.length !== current.length ||
      sources.some(
        (source) =>
          !current.some(
            (item) => item.sourceRevision === source.id && item.sourceHash === source.hash
          )
      );
    return {
      taskId: String(row.task_id),
      conversationId: String(row.conversation_id),
      status: String(row.status),
      createdAt: String(row.created_at),
      partial: !!row.partial,
      stale,
      sources,
    };
  }

  // -------------------------------------------------------------------------
  // Writing composition
  // -------------------------------------------------------------------------
  private descendants(nodes: readonly OutlineNode[], id: string): OutlineNode[] {
    const result: OutlineNode[] = [];
    const walk = (parentId: string) => {
      for (const node of nodes.filter((item) => item.parentId === parentId)) {
        result.push(node);
        walk(node.id);
      }
    };
    walk(id);
    return result;
  }
  /** Accepted writers keep their frozen inputs; do not edit their own active unit. */
  private assertIdle(node: OutlineNode) {
    if (node.progress.state === 'writing')
      throw new HttpError(409, '진행 중인 원문 생성을 먼저 취소해 주세요.');
  }
  private siblingPosition(chatId: string, branchId: string, parentId: string | null): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(position),-1) AS position FROM outline_nodes WHERE chat_id=? AND branch_id=? AND parent_id IS ${parentId === null ? 'NULL' : '?'}`
      )
      .get(...([chatId, branchId, ...(parentId === null ? [] : [parentId])] as string[])) as Row;
    return Number(row.position) + 1;
  }
  apply(
    chatId: string,
    value: unknown,
    authority: OutlineAuthority
  ): { detail: OutlineDetail; created: { ref?: string; id: string }[] } {
    const body = record(value);
    fields(body, ['branchId', 'operations', 'idempotencyKey']);
    const key = text(body.idempotencyKey, 'outline key', 120);
    const operations = parseOutlineOperations(body.operations);

    return this.store.transaction(() => {
      const branch = this.store.product.branch(
        chatId,
        body.branchId === undefined ? undefined : text(body.branchId, 'branch', 100)
      );
      const canonical = JSON.stringify(operations);
      const prior = this.db
        .prepare('SELECT * FROM outline_batches WHERE chat_id=? AND request_key=?')
        .get(chatId, key) as Row | undefined;
      if (prior) {
        if (
          prior.branch_id !== branch.id ||
          prior.authority !== authority ||
          prior.operations !== canonical
        )
          throw new HttpError(409, '구성 요청 키가 다른 내용이나 권한에 사용됐어요.');
        return { detail: this.detail(chatId, branch.id), created: JSON.parse(prior.created) };
      }
      const pending = this.db
        .prepare(
          "SELECT n.id,n.command_id FROM outline_nodes n JOIN scene_commands c ON c.id=n.command_id WHERE n.chat_id=? AND n.branch_id=? AND c.status='pending' AND c.run_id IS NULL"
        )
        .all(chatId, branch.id) as { id: string; command_id: string }[];
      const before = pending.length ? outlineSelection(this.nodes(chatId, branch.id)) : null;
      const created: { ref?: string; id: string }[] = [];
      const refs = new Map<string, string>();
      const time = now();
      for (const operation of operations) {
        const live = () => this.nodes(chatId, branch.id);
        if (operation.op === 'create') {
          const parentId =
            operation.parentRef !== undefined
              ? (refs.get(operation.parentRef) ??
                (() => {
                  throw new HttpError(400, `구성 참조 '${operation.parentRef}'를 찾을 수 없어요.`);
                })())
              : (operation.parentId ?? null);
          if (parentId !== null) {
            const parent = this.node(parentId);
            if (parent.chatId !== chatId || parent.branchId !== branch.id)
              throw new HttpError(400, '다른 채팅의 상위 구성 항목이에요.');
            if (!outlineParentAllowed(parent.level, operation.level))
              throw new HttpError(
                400,
                '상위 구성은 더 큰 수준이어야 해요. 중간 단계는 생략할 수 있어요.'
              );
            this.assertIdle(parent);
          }
          const id = randomUUID();
          this.db
            .prepare(
              'INSERT INTO outline_nodes(id,chat_id,branch_id,parent_id,level,position,title,intent,fixed,revision,command_id,request_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,0,1,NULL,?,?,?)'
            )
            .run(
              id,
              chatId,
              branch.id,
              parentId,
              operation.level,
              operation.position ?? this.siblingPosition(chatId, branch.id, parentId),
              operation.title,
              operation.intent,
              null,
              time,
              time
            );
          if (operation.relatedIds) this.setRelated(id, operation.relatedIds);
          if (operation.ref) refs.set(operation.ref, id);
          created.push({ ...(operation.ref ? { ref: operation.ref } : {}), id });
          continue;
        }
        const node = this.node(operation.id);
        if (node.chatId !== chatId || node.branchId !== branch.id)
          throw new HttpError(400, '다른 분기의 구성 항목이에요.');
        if (node.revision !== operation.expectedRevision)
          throw new HttpError(409, '구성이 변경됐어요. 최신 구성을 확인한 뒤 다시 시도해 주세요.');
        if (operation.op === 'update') {
          this.assertIdle(node);
          this.db
            .prepare(
              'UPDATE outline_nodes SET title=?,intent=?,fixed=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?'
            )
            .run(
              operation.title ?? node.title,
              operation.intent ?? node.intent,
              (operation.fixed ?? node.fixed) ? 1 : 0,
              time,
              node.id,
              operation.expectedRevision
            );
          if (operation.relatedIds) this.setRelated(node.id, operation.relatedIds);
        } else if (operation.op === 'move') {
          const siblings = live();
          const descendants = this.descendants(siblings, node.id);
          for (const item of [node, ...descendants]) this.assertIdle(item);
          const parentId = operation.parentId === undefined ? node.parentId : operation.parentId;
          if (parentId !== null) {
            const parent = siblings.find((item) => item.id === parentId);
            if (!parent || !outlineParentAllowed(parent.level, node.level))
              throw new HttpError(400, '상위 구성의 수준이 맞지 않아요.');
            if (parentId === node.id || descendants.some((i) => i.id === parentId))
              throw new HttpError(400, '구성 항목을 자신의 하위로 옮길 수 없어요.');
            this.assertIdle(parent);
          }
          this.db
            .prepare(
              'UPDATE outline_nodes SET parent_id=?,position=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?'
            )
            .run(parentId, operation.position, time, node.id, operation.expectedRevision);
        } else {
          const subtree = [node, ...this.descendants(live(), node.id)];
          for (const item of subtree) {
            if (item.writings?.length)
              throw new HttpError(
                409,
                `'${item.title}'은 이미 집필한 구성이에요. 집필한 구성은 삭제하지 않아요.`
              );
            this.assertIdle(item);
          }
          for (const item of [...subtree].reverse()) {
            this.db.prepare('DELETE FROM outline_writings WHERE node_id=?').run(item.id);
            if (item.progress.commandId) {
              this.db.prepare('UPDATE outline_nodes SET command_id=NULL WHERE id=?').run(item.id);
              if (item.progress.runId) this.store.story.cancelCommand(item.progress.commandId);
              else deleteSceneCommand(this.store, item.progress.commandId, {});
            }
            this.db.prepare('DELETE FROM outline_nodes WHERE id=?').run(item.id);
          }
        }
      }
      if (before) {
        const after = outlineSelection(this.nodes(chatId, branch.id));
        for (const item of pending) {
          // Explicit node removal already deletes its unexecuted command.
          const current = after(item.id);
          if (current.path.length && plannedContent(before(item.id)) !== plannedContent(current))
            this.store.story.cancelCommand(item.command_id);
        }
      }
      this.db
        .prepare(
          'INSERT INTO outline_batches(chat_id,branch_id,request_key,authority,operations,created,created_at) VALUES(?,?,?,?,?,?,?)'
        )
        .run(chatId, branch.id, key, authority, canonical, JSON.stringify(created), time);
      this.store.event(chatId, 'outline.updated', chatId);
      return { detail: this.detail(chatId, branch.id), created };
    });
  }

  // -------------------------------------------------------------------------
  // Writing the story from composition
  // -------------------------------------------------------------------------
  /** Bind one composition unit to a scene command on the existing main writing path. */
  sceneCommand(id: string, value: unknown) {
    const body = record(value);
    fields(body, ['idempotencyKey', 'request', 'expectedRevision', 'expectedPlanHash']);
    const key = text(body.idempotencyKey, 'command key', 120);
    return this.store.transaction(() => {
      const node = this.node(id);
      if (!outlineWritable(node.level))
        throw new HttpError(
          400,
          `${OUTLINE_LEVEL_LABELS[node.level]}은 한 번에 집필하는 단위가 아니에요. ${OUTLINE_LEVEL_LABELS.episode} 또는 ${OUTLINE_LEVEL_LABELS.beat}를 선택해 주세요.`
        );
      const prior = this.db
        .prepare('SELECT id FROM scene_commands WHERE chat_id=? AND request_key=?')
        .get(node.chatId, key) as Row | undefined;
      if (prior) {
        if (
          !this.db
            .prepare('SELECT 1 FROM outline_writings WHERE node_id=? AND command_id=?')
            .get(node.id, prior.id)
        )
          throw new HttpError(409, '이 집필 요청 키는 다른 구성 예약에 사용됐어요.');
        const command = this.store.story.command(prior.id);
        if (
          body.request !== undefined &&
          text(body.request, 'scene request', REQUEST_TEXT_MAX_CHARS) !== command.request
        )
          throw new HttpError(409, '집필 요청 키가 다른 내용에 사용됐어요.');
        return command;
      }
      if (
        body.expectedRevision !== undefined &&
        number(body.expectedRevision, 'outline revision') !== node.revision
      )
        throw new HttpError(409, '구성이 변경됐어요. 최신 구성을 확인한 뒤 다시 집필해 주세요.');
      if (
        body.expectedPlanHash !== undefined &&
        text(body.expectedPlanHash, 'plan hash', 64) !== this.planHash(node.id)
      )
        throw new HttpError(409, '집필에 참고할 구성이 변경됐어요. 미리보기를 다시 확인해 주세요.');
      if (node.progress.state === 'writing')
        throw new HttpError(409, '이미 이 구성의 원문을 생성하고 있어요.');
      if (node.progress.state === 'scheduled' && node.progress.commandId) {
        const command = this.store.story.command(node.progress.commandId);
        if (
          body.request !== undefined &&
          text(body.request, 'scene request', REQUEST_TEXT_MAX_CHARS) !== command.request
        )
          throw new HttpError(409, '이 구성은 다른 요청문으로 이미 예약됐어요.');
        return command;
      }
      const request =
        body.request === undefined
          ? [
              `${OUTLINE_LEVEL_LABELS[node.level]} ${this.unitSources(node.id).length ? '이어 쓰기' : '집필 요청'}: ${node.title}`,
              node.intent,
            ]
              .filter(Boolean)
              .join('\n')
          : text(body.request, 'scene request', REQUEST_TEXT_MAX_CHARS);
      const command = this.store.story.createCommand(node.chatId, {
        label: `${OUTLINE_LEVEL_LABELS[node.level]} ${node.title}`.slice(0, 120),
        request,
        branchId: node.branchId,
        idempotencyKey: key,
      });
      this.db
        .prepare(
          'UPDATE outline_nodes SET command_id=?,revision=revision+1,updated_at=? WHERE id=?'
        )
        .run(command.id, now(), node.id);
      this.db
        .prepare(
          'INSERT INTO outline_writings(id,node_id,command_id,node_revision,plan_hash,created_at) VALUES(?,?,?,?,?,?)'
        )
        .run(randomUUID(), node.id, command.id, node.revision, this.planHash(node.id), now());
      this.store.event(node.chatId, 'outline.updated', node.chatId);
      return command;
    });
  }
  /**
   * Freeze the applied composition for one run. Only the path to the written unit, its direct
   * children and units already written inside this run's own ancestry enter the input.
   */
  freeze(sceneCommandId: string, snapshot: RunSnapshot): OutlineSnapshot | undefined {
    const row = this.db
      .prepare(
        'SELECT n.* FROM outline_nodes n JOIN outline_writings w ON w.node_id=n.id WHERE w.command_id=?'
      )
      .get(sceneCommandId) as Row | undefined;
    if (!row) return undefined;
    const nodes = this.nodes(row.chat_id, row.branch_id);
    const target = nodes.find((item) => item.id === row.id);
    if (!target) return undefined;
    const command = this.store.story.command(sceneCommandId);
    if (command.status === 'cancelled' && !command.runId)
      throw new HttpError(
        409,
        '구성의 집필 예약이 취소됐어요. 최신 구성을 확인하고 다시 집필해 주세요.'
      );
    const { path, children, related } = outlineSelection(nodes)(target.id);
    this.db
      .prepare('UPDATE outline_writings SET node_revision=?,plan_hash=? WHERE command_id=?')
      .run(target.revision, this.planHash(target.id, nodes), sceneCommandId);
    const ancestry = new Set(snapshot.history.map((entry) => entry.revision));
    const written = nodes
      .filter(
        (item) =>
          item.id !== target.id &&
          item.progress.state === 'written' &&
          item.progress.sourceRevision &&
          ancestry.has(item.progress.sourceRevision)
      )
      .slice(-WRITTEN_LIMIT)
      .map((item) => ({
        id: item.id,
        level: item.level,
        title: item.title,
        sourceRevision: item.progress.sourceRevision as string,
      }));
    return sealOutlineSnapshot({
      version: 1,
      path: path.map(outlineSnapshotNode),
      children: children.map(outlineSnapshotNode),
      ...(related.length ? { related: related.map(outlineSnapshotNode) } : {}),
      sources: this.unitSources(target.id).filter((source) => ancestry.has(source.sourceRevision)),
      written,
    });
  }
}

/** Freeze composition at reservation time so the run keeps the intent it was scheduled with. */
export function freezeOutline(
  store: Store,
  sceneCommandId: string,
  snapshot: RunSnapshot
): RunSnapshot {
  const outline = store.outline.freeze(sceneCommandId, snapshot);
  return outline ? { ...snapshot, outline } : snapshot;
}
