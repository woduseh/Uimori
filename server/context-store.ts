import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ContextCheckpointRef, ContextPlan } from '../core/context-plan.js';
import type { RunSnapshot } from '../core/types.js';
import {
  contextDependencyKey,
  contextSourceRefs,
  measureMainContext,
  seedContextPlan,
  validateContextPlan,
  withContextProjection,
} from './context-planning.js';
import { freezeSourceSegments } from '../core/package-source-segments.js';
import { fields, HttpError, number, record, text } from './request-validation.js';
import type { Store } from './store.js';

type Row = Record<string, any>;
export const CONTEXT_TABLES = [
  'context_checkpoints',
  'context_heads',
  'context_commands',
  'context_jobs',
  'context_job_attempts',
];
import type { ContextCheckpoint, ContextJob } from '../core/context-plan.js';
export type { ContextCheckpoint, ContextJob } from '../core/context-plan.js';
const parse = (v: unknown): any => (typeof v === 'string' ? JSON.parse(v) : v);
const projection = (plan: ContextPlan) => ({
  dependencyKey: plan.dependencyKey,
  compacted: plan.compacted,
  summary: plan.summary,
});
export const checkpointHash = (scopeKey: string, revision: number, plan: ContextPlan) =>
  createHash('sha256')
    .update(JSON.stringify([scopeKey, revision, projection(plan)]))
    .digest('hex');
const ref = (checkpoint: ContextCheckpoint): ContextCheckpointRef => ({
  id: checkpoint.id,
  revision: checkpoint.revision,
  hash: checkpoint.hash,
});

/** One immutable checkpoint format for automatic, manual and authored summaries. */
export class ContextStore {
  constructor(readonly store: Store) {}
  get db() {
    return this.store.db;
  }
  initFresh() {
    this.db.exec(`
      CREATE TABLE context_checkpoints(id TEXT PRIMARY KEY,scope_key TEXT NOT NULL,chat_id TEXT REFERENCES chats(id),revision INTEGER NOT NULL,hash TEXT NOT NULL,origin TEXT NOT NULL,plan TEXT NOT NULL,snapshot TEXT NOT NULL,created_at TEXT NOT NULL,activated INTEGER NOT NULL);
      CREATE TABLE context_heads(scope_key TEXT PRIMARY KEY,chat_id TEXT REFERENCES chats(id),revision INTEGER NOT NULL,checkpoint_id TEXT REFERENCES context_checkpoints(id));
      CREATE TABLE context_commands(scope_key TEXT NOT NULL,chat_id TEXT NOT NULL REFERENCES chats(id),request_key TEXT NOT NULL,command TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(scope_key,request_key));
      CREATE TABLE context_jobs(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES chats(id),branch_id TEXT NOT NULL REFERENCES branches(id),request_key TEXT NOT NULL,command TEXT NOT NULL,status TEXT NOT NULL,snapshot TEXT NOT NULL,checkpoint TEXT,error TEXT,noop INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(chat_id,request_key));
      CREATE UNIQUE INDEX one_active_context_job ON context_jobs(branch_id) WHERE status IN ('queued','running');
      CREATE TABLE context_job_attempts(job_id TEXT NOT NULL REFERENCES context_jobs(id),attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(id),PRIMARY KEY(job_id,attempt_id));
    `);
  }
  scope(chatId: string, branchId?: string) {
    const branch = this.store.product.branch(chatId, branchId);
    return { scopeKey: `chat:${chatId}:${branch.id}`, branch };
  }
  private head(scopeKey: string) {
    const row = this.db.prepare('SELECT * FROM context_heads WHERE scope_key=?').get(scopeKey) as
      | Row
      | undefined;
    return {
      revision: Number(row?.revision ?? 0),
      checkpointId: row?.checkpoint_id as string | undefined,
    };
  }
  checkpoint(value: ContextCheckpointRef): ContextCheckpoint {
    const row = this.db.prepare('SELECT * FROM context_checkpoints WHERE id=?').get(value.id) as
      | Row
      | undefined;
    if (!row || row.revision !== value.revision || row.hash !== value.hash)
      throw new HttpError(400, 'CONTEXT_CHECKPOINT_MISSING');
    const plan = parse(row.plan) as ContextPlan;
    if (row.hash !== checkpointHash(row.scope_key, row.revision, plan))
      throw new HttpError(400, 'CONTEXT_CHECKPOINT_HASH_MISMATCH');
    return {
      id: row.id,
      scopeKey: row.scope_key,
      chatId: row.chat_id,
      revision: row.revision,
      hash: row.hash,
      origin: row.origin,
      plan,
      createdAt: row.created_at,
      activated: row.activated === 1,
    };
  }
  private byId(id: string) {
    const row = this.db
      .prepare('SELECT id,revision,hash FROM context_checkpoints WHERE id=?')
      .get(id) as ContextCheckpointRef | undefined;
    if (!row) throw new HttpError(400, 'CONTEXT_CHECKPOINT_MISSING');
    return this.checkpoint(row);
  }
  prepareRun(
    snapshot: RunSnapshot,
    scopeKey = this.scope(snapshot.chatId, snapshot.branchId).scopeKey
  ): RunSnapshot {
    const seeded = seedContextPlan(snapshot);
    const head = this.head(scopeKey);
    return {
      ...seeded,
      contextBase: {
        scopeKey,
        activeRevision: head.revision,
        notesRevision: this.store.story.notes.revision(snapshot.chatId),
        checkpoint: head.checkpointId ? ref(this.byId(head.checkpointId)) : null,
      },
    };
  }
  previous(snapshot: RunSnapshot): ContextPlan | undefined {
    const base = snapshot.contextBase;
    if (!base?.checkpoint) return undefined;
    const checkpoint = this.checkpoint(base.checkpoint);
    if (checkpoint.chatId !== snapshot.chatId || checkpoint.scopeKey !== base.scopeKey)
      throw new HttpError(400, 'CONTEXT_CHECKPOINT_SCOPE_MISMATCH');
    const plan = checkpoint.plan;
    if (
      plan.dependencyKey !== snapshot.contextPlan?.dependencyKey ||
      !isDeepStrictEqual(
        plan.compacted,
        contextSourceRefs(snapshot).slice(0, plan.compacted.length)
      ) ||
      plan.compacted.length > snapshot.history.length
    )
      return undefined;
    return { ...structuredClone(plan), checkpoint: ref(checkpoint) };
  }
  /** A run that already activated its own checkpoint keeps activating later ones; a foreign head stays authoritative. */
  rebase(snapshot: RunSnapshot, own: ContextCheckpointRef | null): RunSnapshot {
    const base = snapshot.contextBase;
    if (!base || !own) return snapshot;
    const head = this.head(base.scopeKey);
    if (head.checkpointId !== own.id) return snapshot;
    return {
      ...snapshot,
      contextBase: { ...base, activeRevision: head.revision, checkpoint: own },
    };
  }
  assertSnapshot(snapshot: RunSnapshot) {
    const selected = snapshot.contextPlan?.checkpoint;
    if (!selected) {
      if (snapshot.contextPlan?.summary)
        throw new HttpError(400, 'CONTEXT_CHECKPOINT_RECEIPT_MISSING');
      return;
    }
    const checkpoint = this.checkpoint(selected);
    if (
      checkpoint.chatId !== snapshot.chatId ||
      checkpoint.scopeKey !== snapshot.contextBase?.scopeKey ||
      !isDeepStrictEqual(projection(checkpoint.plan), projection(snapshot.contextPlan!))
    )
      throw new HttpError(400, 'CONTEXT_CHECKPOINT_SNAPSHOT_MISMATCH');
  }
  publishPrepared(
    snapshot: RunSnapshot,
    options: { origin: ContextCheckpoint['origin']; activate?: boolean }
  ): RunSnapshot {
    const plan = snapshot.contextPlan,
      base = snapshot.contextBase;
    if (!plan || plan.status !== 'ready' || !base)
      throw new HttpError(400, 'CONTEXT_PREPARED_SNAPSHOT_REQUIRED');
    validateContextPlan(snapshot);
    if (!plan.summary) return snapshot;
    return this.store.transaction(() => {
      const previous = this.previous(snapshot);
      if (
        options.origin !== 'edit' &&
        previous?.checkpoint &&
        isDeepStrictEqual(projection(previous), projection(plan))
      )
        return { ...snapshot, contextPlan: { ...plan, checkpoint: previous.checkpoint } };
      const checkpoint: ContextCheckpoint = {
        id: randomUUID(),
        scopeKey: base.scopeKey,
        chatId: snapshot.chatId,
        revision: base.activeRevision + 1,
        hash: checkpointHash(base.scopeKey, base.activeRevision + 1, plan),
        origin: options.origin,
        plan: structuredClone(plan),
        createdAt: new Date().toISOString(),
        activated: false,
      };
      delete checkpoint.plan.checkpoint;
      const head = this.head(base.scopeKey);
      const branch = this.store.product.branch(snapshot.chatId, snapshot.branchId);
      const currentSources = this.store.history(branch.headRevision);
      const unchanged = isDeepStrictEqual(
        currentSources.slice(0, snapshot.history.length).map((s) => [s.revision, s.contentHash]),
        snapshot.history.map((s) => [s.revision, s.contentHash])
      );
      checkpoint.activated =
        options.activate !== false &&
        head.revision === base.activeRevision &&
        this.store.story.notes.revision(snapshot.chatId) === base.notesRevision &&
        unchanged;
      this.db
        .prepare('INSERT INTO context_checkpoints VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(
          checkpoint.id,
          checkpoint.scopeKey,
          checkpoint.chatId,
          checkpoint.revision,
          checkpoint.hash,
          checkpoint.origin,
          JSON.stringify(checkpoint.plan),
          JSON.stringify(snapshot),
          checkpoint.createdAt,
          Number(checkpoint.activated)
        );
      if (checkpoint.activated)
        this.db
          .prepare(
            'INSERT INTO context_heads VALUES(?,?,?,?) ON CONFLICT(scope_key) DO UPDATE SET revision=excluded.revision,checkpoint_id=excluded.checkpoint_id'
          )
          .run(checkpoint.scopeKey, checkpoint.chatId, checkpoint.revision, checkpoint.id);
      this.store.event(
        snapshot.chatId,
        checkpoint.activated ? 'context.updated' : 'context.candidate',
        checkpoint.id
      );
      return { ...snapshot, contextPlan: { ...plan, checkpoint: ref(checkpoint) } };
    });
  }
  detail(chatId: string, branchId?: string) {
    const { scopeKey, branch } = this.scope(chatId, branchId),
      head = this.head(scopeKey);
    const checkpoints = (
      this.db
        .prepare(
          'SELECT id,revision,hash FROM context_checkpoints WHERE scope_key=? ORDER BY rowid DESC LIMIT 100'
        )
        .all(scopeKey) as ContextCheckpointRef[]
    ).map((value) => this.checkpoint(value));
    const checkpoint = head.checkpointId ? this.byId(head.checkpointId) : null;
    let usable = false;
    if (checkpoint) {
      const chat = this.store.chat(chatId),
        profile = this.store.product.snapshot(chatId, 'inspect', branch.headRevision);
      let current: RunSnapshot = {
        chatId,
        branchId: branch.id,
        parentRevision: branch.headRevision,
        settingsRevision: chat.settingsRevision,
        settings: chat.settings,
        request: '',
        history: this.store.history(branch.headRevision),
        resources: this.store.product.resources(chatId, profile),
        profile,
        sourceSegments: freezeSourceSegments(profile),
      };
      current = this.store.story.prepareRunInTransaction(current);
      usable =
        checkpoint.plan.dependencyKey === contextDependencyKey(current) &&
        isDeepStrictEqual(
          checkpoint.plan.compacted,
          contextSourceRefs(current).slice(0, checkpoint.plan.compacted.length)
        ) &&
        checkpoint.plan.compacted.length <= current.history.length;
    }
    return {
      scopeKey,
      activeRevision: head.revision,
      notesRevision: this.store.story.notes.revision(chatId),
      headRevision: branch.headRevision,
      checkpoint,
      checkpoints,
      usable,
      invalidReason:
        checkpoint && !usable
          ? '원문·메모 또는 작문 설정이 바뀌어 다음 입력에 이 요약을 사용하지 않아요.'
          : null,
      jobs: (
        this.db
          .prepare(
            'SELECT id FROM context_jobs WHERE chat_id=? AND branch_id=? ORDER BY rowid DESC LIMIT 50'
          )
          .all(chatId, branch.id) as Row[]
      ).map((row) => this.job(row.id)),
    };
  }
  private expected(chatId: string, body: Row) {
    const { scopeKey, branch } = this.scope(chatId, body.branchId);
    if (
      body.expectedHeadRevision !== branch.headRevision ||
      number(body.expectedRevision, 'context revision', 0) !== this.head(scopeKey).revision
    )
      throw new HttpError(
        409,
        '문맥이나 원문이 변경됐어요. 최신 내용을 확인한 뒤 다시 적용해 주세요.'
      );
    return { scopeKey, branch };
  }
  edit(chatId: string, value: unknown, snapshot: RunSnapshot) {
    const body = record(value);
    fields(body, [
      'branchId',
      'expectedRevision',
      'expectedHeadRevision',
      'idempotencyKey',
      'summary',
      'restoreCheckpoint',
    ]);
    const key = text(body.idempotencyKey, 'request key', 120);
    return this.store.transaction(() => {
      const { scopeKey } = this.scope(chatId, body.branchId),
        command = JSON.stringify(body);
      const receipt = this.db
        .prepare('SELECT command,result FROM context_commands WHERE scope_key=? AND request_key=?')
        .get(scopeKey, key) as Row | undefined;
      if (receipt) {
        if (receipt.command !== command) throw new HttpError(409, 'Context request key reused');
        return parse(receipt.result);
      }
      this.expected(chatId, body);
      if (!snapshot.profile?.models.main) throw new HttpError(409, 'MODEL_REQUIRED:main');
      let prepared = this.prepareRun(snapshot, scopeKey);
      const previous = this.previous(prepared);
      let summary: string, compacted: ContextPlan['compacted'];
      if (body.restoreCheckpoint !== undefined) {
        if (body.summary !== undefined)
          throw new HttpError(400, 'Choose summary or restore checkpoint');
        const checkpoint = this.checkpoint(body.restoreCheckpoint);
        if (
          checkpoint.scopeKey !== scopeKey ||
          checkpoint.plan.dependencyKey !== prepared.contextPlan?.dependencyKey ||
          !isDeepStrictEqual(
            checkpoint.plan.compacted,
            contextSourceRefs(prepared).slice(0, checkpoint.plan.compacted.length)
          )
        )
          throw new HttpError(409, '되돌릴 요약의 원문이나 정정 기준이 현재와 달라요.');
        summary = checkpoint.plan.summary!;
        compacted = checkpoint.plan.compacted;
      } else {
        summary = text(body.summary, 'summary', 200000);
        compacted =
          previous?.compacted ??
          contextSourceRefs(prepared).slice(0, Math.max(0, prepared.history.length - 2));
      }
      prepared = withContextProjection(prepared, compacted, summary);
      const measured = measureMainContext(prepared);
      if (measured.estimatedInputTokens > prepared.contextPlan!.budget.inputTokenLimit)
        throw new HttpError(400, 'CONTEXT_FIXED_INPUT_TOO_LARGE');
      prepared = {
        ...measured.snapshot,
        contextPlan: {
          ...prepared.contextPlan!,
          estimatedInputTokens: measured.estimatedInputTokens,
        },
      };
      this.publishPrepared(prepared, { origin: 'edit' });
      const result = this.detail(chatId, body.branchId);
      this.db
        .prepare('INSERT INTO context_commands VALUES(?,?,?,?,?)')
        .run(scopeKey, chatId, key, command, JSON.stringify(result));
      return result;
    });
  }
  schedule(chatId: string, value: unknown, snapshot: RunSnapshot): ContextJob {
    const body = record(value);
    fields(body, ['branchId', 'expectedRevision', 'expectedHeadRevision', 'idempotencyKey']);
    const key = text(body.idempotencyKey, 'request key', 120),
      command = JSON.stringify(body);
    return this.store.transaction(() => {
      const existing = this.db
        .prepare('SELECT id,command FROM context_jobs WHERE chat_id=? AND request_key=?')
        .get(chatId, key) as Row | undefined;
      if (existing) {
        if (existing.command !== command) throw new HttpError(409, 'Context request key reused');
        return this.job(existing.id);
      }
      const { scopeKey, branch } = this.expected(chatId, body);
      if (!snapshot.profile?.models.main) throw new HttpError(409, 'MODEL_REQUIRED:main');
      if (
        this.db
          .prepare(
            "SELECT 1 FROM context_jobs WHERE branch_id=? AND status IN ('queued','running')"
          )
          .get(branch.id)
      )
        throw new HttpError(409, '문맥 정리가 이미 진행 중이에요.');
      const id = randomUUID(),
        time = new Date().toISOString();
      this.db
        .prepare(
          "INSERT INTO context_jobs(id,chat_id,branch_id,request_key,command,status,snapshot,created_at,updated_at) VALUES(?,?,?,?,?,'queued',?,?,?)"
        )
        .run(
          id,
          chatId,
          branch.id,
          key,
          command,
          JSON.stringify(this.prepareRun(snapshot, scopeKey)),
          time,
          time
        );
      this.store.event(chatId, 'context.job.queued', id);
      return this.job(id);
    });
  }
  job(id: string): ContextJob {
    const row = this.db.prepare('SELECT * FROM context_jobs WHERE id=?').get(id) as Row | undefined;
    if (!row) throw new HttpError(404, 'Context job not found');
    return {
      id: row.id,
      chatId: row.chat_id,
      branchId: row.branch_id,
      status: row.status,
      snapshot: parse(row.snapshot),
      checkpoint: parse(row.checkpoint),
      error: row.error,
      noop: row.noop === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  start(id: string) {
    return (
      Number(
        this.db
          .prepare(
            "UPDATE context_jobs SET status='running',updated_at=? WHERE id=? AND status='queued'"
          )
          .run(new Date().toISOString(), id).changes
      ) === 1
    );
  }
  finish(id: string, snapshot: RunSnapshot) {
    return this.store.transaction(() => {
      const job = this.job(id);
      if (job.status !== 'running') return job;
      const published = this.publishPrepared(snapshot, { origin: 'manual' });
      this.db
        .prepare(
          "UPDATE context_jobs SET status='completed',snapshot=?,checkpoint=?,noop=?,updated_at=? WHERE id=? AND status='running'"
        )
        .run(
          JSON.stringify(published),
          JSON.stringify(published.contextPlan?.checkpoint ?? null),
          Number(!published.contextPlan?.summaryCalls),
          new Date().toISOString(),
          id
        );
      this.store.event(job.chatId, 'context.job.completed', id);
      return this.job(id);
    });
  }
  fail(id: string, error: string) {
    return this.store.transaction(() => {
      const job = this.job(id);
      const changed = this.db
        .prepare(
          "UPDATE context_jobs SET status='failed',error=?,updated_at=? WHERE id=? AND status='running'"
        )
        .run(error, new Date().toISOString(), id);
      if (changed.changes) this.store.event(job.chatId, 'context.job.failed', id);
      return this.job(id);
    });
  }
  cancel(chatId: string, id: string) {
    return this.store.transaction(() => {
      const job = this.job(id);
      if (job.chatId !== chatId) throw new HttpError(404, 'Context job not found');
      const changed = this.db
        .prepare(
          "UPDATE context_jobs SET status='cancelled',error='CANCELLED',updated_at=? WHERE id=? AND status IN ('queued','running')"
        )
        .run(new Date().toISOString(), id);
      if (changed.changes) this.store.event(chatId, 'context.job.cancelled', id);
      return this.job(id);
    });
  }
  recover() {
    this.db
      .prepare(
        "UPDATE context_jobs SET status='interrupted',error='Server stopped; explicit retry required',updated_at=? WHERE status IN ('queued','running')"
      )
      .run(new Date().toISOString());
  }
  /** Copy eligible immutable summaries, including manual edits with no associated Run. */
  forkInTransaction(
    originalChatId: string,
    newChatId: string,
    mapSnapshot: (snapshot: RunSnapshot) => RunSnapshot,
    runIds: Map<string, string>,
    activeScopeKey: string
  ) {
    const scopeKey = this.scope(newChatId).scopeKey;
    const mappedRefs = new Map<string, ContextCheckpointRef>();
    const originals = this.db
      .prepare('SELECT * FROM context_checkpoints WHERE chat_id=? ORDER BY rowid')
      .all(originalChatId) as Row[];
    for (const row of originals) {
      if (!row.scope_key.startsWith(`chat:${originalChatId}:`)) continue;
      let snapshot: RunSnapshot;
      try {
        snapshot = mapSnapshot(parse(row.snapshot));
      } catch {
        continue;
      }
      const plan = snapshot.contextPlan;
      if (!plan?.summary) continue;
      delete plan.checkpoint;
      snapshot.contextBase = {
        scopeKey,
        activeRevision: row.revision - 1,
        notesRevision: this.store.story.notes.revision(newChatId),
        checkpoint: null,
      };
      const mapped = {
        id: randomUUID(),
        revision: Number(row.revision),
        hash: checkpointHash(scopeKey, Number(row.revision), plan),
      };
      this.db
        .prepare('INSERT INTO context_checkpoints VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(
          mapped.id,
          scopeKey,
          newChatId,
          mapped.revision,
          mapped.hash,
          row.origin,
          JSON.stringify(plan),
          JSON.stringify(snapshot),
          row.created_at,
          row.activated
        );
      mappedRefs.set(row.id, mapped);
      const originalHead = this.head(row.scope_key);
      // Copy the selected active checkpoint only; historical activated flags remain history.
      if (row.scope_key === activeScopeKey && originalHead.checkpointId === row.id)
        this.db
          .prepare(
            'INSERT INTO context_heads VALUES(?,?,?,?) ON CONFLICT(scope_key) DO UPDATE SET revision=excluded.revision,checkpoint_id=excluded.checkpoint_id'
          )
          .run(scopeKey, newChatId, mapped.revision, mapped.id);
    }
    for (const newRunId of runIds.values()) {
      const snapshot = this.store.run(newRunId).snapshot;
      if (snapshot.contextBase) {
        snapshot.contextBase = {
          ...snapshot.contextBase,
          scopeKey,
          checkpoint: snapshot.contextBase.checkpoint
            ? (mappedRefs.get(snapshot.contextBase.checkpoint.id) ?? null)
            : null,
        };
      }
      if (snapshot.contextPlan?.checkpoint) {
        const mapped = mappedRefs.get(snapshot.contextPlan.checkpoint.id);
        if (!mapped) throw new HttpError(400, 'Fork summary checkpoint dependency missing');
        snapshot.contextPlan.checkpoint = mapped;
      }
      this.db
        .prepare('UPDATE runs SET snapshot=? WHERE id=?')
        .run(JSON.stringify(snapshot), newRunId);
    }
  }
  validateArchive() {
    for (const row of this.db.prepare('SELECT * FROM context_checkpoints').all() as Row[]) {
      if (parse(row.snapshot).kind === 'helper') continue; // Validated with its real helper message/event owners.
      this.store.chat(row.chat_id);
      const cp = this.checkpoint({ id: row.id, revision: row.revision, hash: row.hash });
      if (
        !['automatic', 'manual', 'edit', 'model'].includes(cp.origin) ||
        !Number.isSafeInteger(cp.revision) ||
        cp.revision < 1 ||
        ![0, 1].includes(row.activated)
      )
        throw new HttpError(400, 'Invalid context checkpoint');
      const snapshot = parse(row.snapshot) as RunSnapshot;
      if (
        snapshot.chatId !== cp.chatId ||
        snapshot.contextBase?.scopeKey !== cp.scopeKey ||
        !isDeepStrictEqual(projection(snapshot.contextPlan!), projection(cp.plan)) ||
        !this.store.validateHistory(snapshot.history, snapshot.parentRevision)
      )
        throw new HttpError(400, 'Invalid checkpoint source snapshot');
      validateContextPlan(snapshot);
    }
    for (const row of this.db.prepare('SELECT * FROM context_heads').all() as Row[]) {
      const cp = this.byId(row.checkpoint_id);
      if (
        cp.chatId !== row.chat_id ||
        cp.scopeKey !== row.scope_key ||
        cp.revision !== row.revision ||
        !cp.activated
      )
        throw new HttpError(400, 'Invalid active context checkpoint');
    }
    for (const row of this.db.prepare('SELECT * FROM context_jobs').all() as Row[]) {
      const job = this.job(row.id);
      this.store.product.branch(job.chatId, job.branchId);
      if (
        !['completed', 'failed', 'cancelled', 'interrupted'].includes(job.status) ||
        job.snapshot.chatId !== job.chatId ||
        job.snapshot.branchId !== job.branchId ||
        !this.store.validateHistory(job.snapshot.history, job.snapshot.parentRevision)
      )
        throw new HttpError(400, 'Invalid context job');
      if (job.checkpoint) this.assertSnapshot(job.snapshot);
    }
    for (const row of this.db
      .prepare(
        'SELECT a.*,j.chat_id AS owner_chat FROM context_job_attempts x JOIN attempts a ON a.id=x.attempt_id JOIN context_jobs j ON j.id=x.job_id'
      )
      .all() as Row[])
      if (row.chat_id !== row.owner_chat || row.role !== 'context' || row.run_id !== null)
        throw new HttpError(400, 'Invalid context attempt owner');
  }
}
