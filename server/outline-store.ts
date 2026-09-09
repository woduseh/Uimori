import { HttpError, fields, number, record, text } from './request-validation.js';
import { deleteSceneCommand } from './chat-deletion.js';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Store } from './store.js';
import type { RunSnapshot } from '../core/types.js';
import {
  OUTLINE_INTENT_MAX,
  OUTLINE_LEVELS,
  OUTLINE_LEVEL_LABELS,
  OUTLINE_TITLE_MAX,
  outlineParentLevel,
  outlineSnapshotNode,
  outlineTree,
  sealOutlineSnapshot,
  outlineWritable,
  type OutlineDetail,
  type OutlineLevel,
  type OutlineNode,
  type OutlineProgress,
  type OutlineSnapshot,
} from '../core/outline.js';

type Row = Record<string, any>;
const now = () => new Date().toISOString();
const ACTIVE_RUN = ['queued', 'running', 'waiting_for_state'];
/** One request's frozen input keeps a bounded amount of already-written history. */
const WRITTEN_LIMIT = 40;
const BATCH_LIMIT = 200;

export const OUTLINE_TABLES = ['outline_nodes'] as const;

/** Additive, idempotent table; a schema 15 database gains it on open and keeps its version. */
export function initOutline(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS outline_nodes (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), branch_id TEXT NOT NULL REFERENCES branches(id), parent_id TEXT REFERENCES outline_nodes(id), level TEXT NOT NULL, position INTEGER NOT NULL, title TEXT NOT NULL, intent TEXT NOT NULL, fixed INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL, command_id TEXT REFERENCES scene_commands(id), request_key TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(chat_id,request_key));
    CREATE INDEX IF NOT EXISTS outline_nodes_branch ON outline_nodes(chat_id,branch_id,parent_id,position);
  `);
}

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
    }
  | {
      op: 'update';
      id: string;
      expectedRevision: number;
      title?: string;
      intent?: string;
      fixed?: boolean;
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

export function parseOutlineOperations(value: unknown): OutlineOperation[] {
  if (!Array.isArray(value) || !value.length)
    throw new HttpError(400, '적용할 구성 변경이 필요해요.');
  if (value.length > BATCH_LIMIT)
    throw new HttpError(400, `한 번에 적용할 수 있는 구성 변경은 ${BATCH_LIMIT}개까지예요.`);
  return value.map((item) => {
    const body = record(item);
    if (body.op === 'create') {
      fields(body, ['op', 'ref', 'parentRef', 'parentId', 'level', 'title', 'intent', 'position']);
      if (body.parentRef !== undefined && body.parentId !== undefined)
        throw new HttpError(400, '상위 항목은 parentRef 또는 parentId 하나만 지정해 주세요.');
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
        ...(body.position === undefined
          ? {}
          : { position: number(body.position, 'outline position', 0, 1e6) }),
      };
    }
    if (body.op === 'update') {
      fields(body, ['op', 'id', 'expectedRevision', 'title', 'intent', 'fixed']);
      if (body.title === undefined && body.intent === undefined && body.fixed === undefined)
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
    return { chatId, branchId: branch.id, nodes: this.nodes(chatId, branch.id) };
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
  /**
   * A model-driven write changes only unwritten, unpinned composition. A user's own explicit
   * instruction is its own authority and may edit anything it addresses with a matching revision.
   * A pin guards that item's own wording and existence; it never blocks planning beneath it.
   */
  private assertWritable(
    authority: OutlineAuthority,
    node: OutlineNode,
    action: string,
    scope: 'self' | 'children' = 'self'
  ) {
    if (node.progress.state === 'writing')
      throw new HttpError(409, '진행 중인 원문 생성을 먼저 취소해 주세요.');
    if (authority === 'user') return;
    if (node.fixed && scope === 'self')
      throw new HttpError(
        409,
        `고정한 구성 '${node.title}'과 충돌하는 ${action} 요청이에요. 고정을 해제할지 사용자에게 확인해 주세요.`
      );
    if (node.progress.state === 'written')
      throw new HttpError(
        409,
        `'${node.title}'은 이미 집필한 구성이에요. 남은 구성만 바꿀 수 있어요.`
      );
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
    if (authority === 'model' && operations.some((item) => item.op === 'update' && 'fixed' in item))
      throw new HttpError(403, '구성 고정은 사용자만 바꿀 수 있어요.');
    return this.store.transaction(() => {
      const branch = this.store.product.branch(
        chatId,
        body.branchId === undefined ? undefined : text(body.branchId, 'branch', 100)
      );
      const created: { ref?: string; id: string }[] = [];
      const refs = new Map<string, string>();
      const time = now();
      for (const operation of operations) {
        const live = () => this.nodes(chatId, branch.id);
        if (operation.op === 'create') {
          const requestKey = `${key}:${operation.ref ?? created.length}`;
          const prior = this.db
            .prepare('SELECT id FROM outline_nodes WHERE chat_id=? AND request_key=?')
            .get(chatId, requestKey) as Row | undefined;
          if (prior) {
            if (operation.ref) refs.set(operation.ref, prior.id);
            created.push({ ...(operation.ref ? { ref: operation.ref } : {}), id: prior.id });
            continue;
          }
          const parentId =
            operation.parentRef !== undefined
              ? (refs.get(operation.parentRef) ??
                (() => {
                  throw new HttpError(400, `구성 참조 '${operation.parentRef}'를 찾을 수 없어요.`);
                })())
              : (operation.parentId ?? null);
          const expected = outlineParentLevel(operation.level);
          if (parentId === null) {
            if (expected !== null)
              throw new HttpError(
                400,
                `${OUTLINE_LEVEL_LABELS[operation.level]}은 ${OUTLINE_LEVEL_LABELS[expected]} 아래에 넣어 주세요.`
              );
          } else {
            const parent = live().find((item) => item.id === parentId);
            if (!parent) throw new HttpError(404, '상위 구성 항목을 찾을 수 없어요.');
            if (expected === null || parent.level !== expected)
              throw new HttpError(
                400,
                `${OUTLINE_LEVEL_LABELS[operation.level]}의 상위는 ${expected === null ? '없음' : OUTLINE_LEVEL_LABELS[expected]}이어야 해요.`
              );
            this.assertWritable(authority, parent, '하위 구성 추가', 'children');
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
              requestKey,
              time,
              time
            );
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
          this.assertWritable(authority, node, '수정');
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
        } else if (operation.op === 'move') {
          this.assertWritable(authority, node, '이동');
          const parentId = operation.parentId === undefined ? node.parentId : operation.parentId;
          const expected = outlineParentLevel(node.level);
          if (parentId === null) {
            if (expected !== null) throw new HttpError(400, '이 수준은 상위 구성이 필요해요.');
          } else {
            const siblings = live();
            const parent = siblings.find((item) => item.id === parentId);
            if (!parent || expected === null || parent.level !== expected)
              throw new HttpError(400, '상위 구성의 수준이 맞지 않아요.');
            if (
              parentId === node.id ||
              this.descendants(siblings, node.id).some((i) => i.id === parentId)
            )
              throw new HttpError(400, '구성 항목을 자신의 하위로 옮길 수 없어요.');
            this.assertWritable(authority, parent, '하위 구성 이동', 'children');
          }
          this.db
            .prepare(
              'UPDATE outline_nodes SET parent_id=?,position=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?'
            )
            .run(parentId, operation.position, time, node.id, operation.expectedRevision);
        } else {
          const subtree = [node, ...this.descendants(live(), node.id)];
          for (const item of subtree) {
            if (item.progress.state === 'written')
              throw new HttpError(
                409,
                `'${item.title}'은 이미 집필한 구성이에요. 집필한 구성은 삭제하지 않아요.`
              );
            this.assertWritable(authority, item, '삭제');
          }
          for (const item of [...subtree].reverse()) {
            if (item.progress.commandId) {
              this.db.prepare('UPDATE outline_nodes SET command_id=NULL WHERE id=?').run(item.id);
              if (item.progress.runId) this.store.story.cancelCommand(item.progress.commandId);
              else deleteSceneCommand(this.store, item.progress.commandId, {});
            }
            this.db.prepare('DELETE FROM outline_nodes WHERE id=?').run(item.id);
          }
        }
      }
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
    fields(body, ['idempotencyKey', 'request']);
    const key = text(body.idempotencyKey, 'command key', 120);
    return this.store.transaction(() => {
      const node = this.node(id);
      if (!outlineWritable(node.level))
        throw new HttpError(
          400,
          `${OUTLINE_LEVEL_LABELS[node.level]}은 한 번에 집필하는 단위가 아니에요. ${OUTLINE_LEVEL_LABELS.episode} 또는 ${OUTLINE_LEVEL_LABELS.beat}를 선택해 주세요.`
        );
      if (node.progress.state === 'written') throw new HttpError(409, '이미 집필한 구성이에요.');
      if (node.progress.state === 'writing')
        throw new HttpError(409, '이미 이 구성의 원문을 생성하고 있어요.');
      if (node.progress.state === 'scheduled' && node.progress.commandId)
        return this.store.story.command(node.progress.commandId);
      const request =
        body.request === undefined
          ? [`${OUTLINE_LEVEL_LABELS[node.level]} 집필 요청: ${node.title}`, node.intent]
              .filter(Boolean)
              .join('\n')
              .slice(0, 4000)
          : text(body.request, 'scene request', 4000);
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
      .prepare('SELECT * FROM outline_nodes WHERE command_id=?')
      .get(sceneCommandId) as Row | undefined;
    if (!row) return undefined;
    const nodes = this.nodes(row.chat_id, row.branch_id);
    const target = nodes.find((item) => item.id === row.id);
    if (!target) return undefined;
    const path: OutlineNode[] = [];
    for (let current: OutlineNode | undefined = target; current; ) {
      path.unshift(current);
      const parentId: string | null = current.parentId;
      current = parentId === null ? undefined : nodes.find((item) => item.id === parentId);
    }
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
      children: nodes.filter((item) => item.parentId === target.id).map(outlineSnapshotNode),
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

/**
 * Copy composition for a fork. A unit written on another line keeps its plan but loses the
 * binding, so a past-point fork never inherits a later branch's real events.
 */
export function copyOutlineFork(
  store: Store,
  originalChatId: string,
  sourceBranchId: string,
  newChatId: string,
  branchId: string,
  commandIds: Map<string, string>
) {
  const rows = store.db
    .prepare('SELECT * FROM outline_nodes WHERE chat_id=? AND branch_id=? ORDER BY rowid')
    .all(originalChatId, sourceBranchId) as Row[];
  const ids = new Map(rows.map((row) => [String(row.id), randomUUID()]));
  for (const row of rows) {
    const command = row.command_id ? (commandIds.get(String(row.command_id)) ?? null) : null;
    store.db
      .prepare(
        'INSERT INTO outline_nodes(id,chat_id,branch_id,parent_id,level,position,title,intent,fixed,revision,command_id,request_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,?,?)'
      )
      .run(
        ids.get(String(row.id))!,
        newChatId,
        branchId,
        row.parent_id ? (ids.get(String(row.parent_id)) ?? null) : null,
        row.level,
        row.position,
        row.title,
        row.intent,
        row.fixed,
        row.revision,
        command,
        row.created_at,
        row.updated_at
      );
  }
}

export function validateOutlineArchive(store: Store) {
  const reject = (reason: string) => {
    throw new HttpError(400, `Archive outline is invalid: ${reason}`);
  };
  const rows = store.db.prepare('SELECT * FROM outline_nodes').all() as Row[];
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  const keys = new Set<string>();
  for (const row of rows) {
    if (!(OUTLINE_LEVELS as readonly string[]).includes(row.level)) reject('level');
    if (!Number.isSafeInteger(Number(row.revision)) || Number(row.revision) < 1) reject('revision');
    if (row.request_key !== null) {
      const key = `${row.chat_id}:${row.request_key}`;
      if (keys.has(key)) reject('duplicate request key');
      keys.add(key);
    }
    const branch = store.db.prepare('SELECT chat_id FROM branches WHERE id=?').get(row.branch_id) as
      | Row
      | undefined;
    if (!branch || branch.chat_id !== row.chat_id) reject('branch owner');
    const expected = outlineParentLevel(row.level as OutlineLevel);
    if (row.parent_id === null) {
      if (expected !== null) reject('missing parent level');
    } else {
      const parent = byId.get(String(row.parent_id));
      if (!parent) reject('parent');
      else if (
        parent.chat_id !== row.chat_id ||
        parent.branch_id !== row.branch_id ||
        parent.level !== expected
      )
        reject('parent level');
    }
    if (row.command_id) {
      const command = store.db
        .prepare('SELECT chat_id,branch_id FROM scene_commands WHERE id=?')
        .get(row.command_id) as Row | undefined;
      if (!command || command.chat_id !== row.chat_id || command.branch_id !== row.branch_id)
        reject('scene command owner');
      if (!outlineWritable(row.level as OutlineLevel)) reject('bound level');
    }
  }
  for (const row of rows) {
    const seen = new Set<string>([String(row.id)]);
    let current = row.parent_id ? byId.get(String(row.parent_id)) : undefined;
    while (current) {
      if (seen.has(String(current.id))) reject('parent cycle');
      seen.add(String(current.id));
      current = current.parent_id ? byId.get(String(current.parent_id)) : undefined;
    }
  }
}
