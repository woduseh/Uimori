import { CONTEXT_SUMMARY_MAX_CHARS } from '../core/context-tools.js';
import { pruneContextHistory } from './context-retention.js';
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
import { fields, HttpError, number, record, text } from './request-validation.js';
import type { Store } from './store.js';

type Row = Record<string, any>;

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
      CREATE TABLE context_checkpoints(id TEXT PRIMARY KEY,scope_key TEXT NOT NULL,chat_id TEXT REFERENCES chats(id),revision INTEGER NOT NULL,hash TEXT NOT NULL,origin TEXT NOT NULL,plan TEXT NOT NULL,created_at TEXT NOT NULL,activated INTEGER NOT NULL);
      CREATE TABLE context_heads(scope_key TEXT PRIMARY KEY,chat_id TEXT REFERENCES chats(id),revision INTEGER NOT NULL,checkpoint_id TEXT REFERENCES context_checkpoints(id));
      CREATE TABLE context_commands(scope_key TEXT NOT NULL,chat_id TEXT NOT NULL REFERENCES chats(id),request_key TEXT NOT NULL,command_hash TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(scope_key,request_key));
      CREATE TABLE context_jobs(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES chats(id),branch_id TEXT NOT NULL REFERENCES branches(id),request_key TEXT NOT NULL,command TEXT NOT NULL,status TEXT NOT NULL,snapshot TEXT,checkpoint TEXT,error TEXT,noop INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(chat_id,request_key));
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
    const row = this.db
      .prepare(
        'SELECT id,scope_key,chat_id,revision,hash,origin,plan,created_at,activated FROM context_checkpoints WHERE id=?'
      )
      .get(value.id) as Row | undefined;
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
        .prepare('INSERT INTO context_checkpoints VALUES(?,?,?,?,?,?,?,?,?)')
        .run(
          checkpoint.id,
          checkpoint.scopeKey,
          checkpoint.chatId,
          checkpoint.revision,
          checkpoint.hash,
          checkpoint.origin,
          JSON.stringify(checkpoint.plan),
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
  /** Active metadata and its validated checkpoint, without loading UI history or job snapshots. */
  current(chatId: string, branchId?: string) {
    return this.currentState(chatId, this.scope(chatId, branchId));
  }
  private currentState(chatId: string, { scopeKey, branch }: ReturnType<ContextStore['scope']>) {
    const head = this.head(scopeKey);
    const checkpoint = head.checkpointId ? this.byId(head.checkpointId) : null;
    let usable = false;
    if (checkpoint) {
      try {
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
        };
        current = this.store.story.prepareRunInTransaction(current);
        usable =
          checkpoint.plan.dependencyKey === contextDependencyKey(current) &&
          isDeepStrictEqual(
            checkpoint.plan.compacted,
            contextSourceRefs(current).slice(0, checkpoint.plan.compacted.length)
          ) &&
          checkpoint.plan.compacted.length <= current.history.length;
      } catch (error) {
        // Keep saved summaries readable while the user repairs a deleted writing pin.
        if (!(error instanceof HttpError) || !error.message.startsWith('PINNED_PROMPT_UNAVAILABLE'))
          throw error;
      }
    }
    return {
      scopeKey,
      activeRevision: head.revision,
      notesRevision: this.store.story.notes.revision(chatId),
      headRevision: branch.headRevision,
      checkpoint,
      usable,
      invalidReason:
        checkpoint && !usable
          ? '원문·메모 또는 작문 설정이 바뀌어 다음 입력에 이 요약을 사용하지 않아요.'
          : null,
    };
  }
  detail(chatId: string, branchId?: string) {
    const scope = this.scope(chatId, branchId);
    return {
      ...this.currentState(chatId, scope),
      jobs: (
        this.db
          .prepare(
            'SELECT id FROM context_jobs WHERE chat_id=? AND branch_id=? ORDER BY rowid DESC LIMIT 10'
          )
          .all(chatId, scope.branch.id) as Row[]
      ).map((row) => {
        const { snapshot: _input, ...status } = this.job(row.id, false);
        return status;
      }),
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
    ]);
    const key = text(body.idempotencyKey, 'request key', 120);
    const digest = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    return this.store.transaction(() => {
      const { scopeKey } = this.scope(chatId, body.branchId);
      const receipt = this.db
        .prepare('SELECT command_hash FROM context_commands WHERE scope_key=? AND request_key=?')
        .get(scopeKey, key);
      if (receipt) {
        if (receipt.command_hash !== digest) throw new HttpError(409, 'Context request key reused');
        return this.detail(chatId, body.branchId);
      }
      this.expected(chatId, body);
      if (!snapshot.profile?.models.main) throw new HttpError(409, 'MODEL_REQUIRED:main');
      let prepared = this.prepareRun(snapshot, scopeKey);
      const previous = this.previous(prepared);
      const summary = text(body.summary, 'summary', CONTEXT_SUMMARY_MAX_CHARS);
      const compacted =
        previous?.compacted ??
        contextSourceRefs(prepared).slice(0, Math.max(0, prepared.history.length - 2));
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
      const revision = this.head(scopeKey).revision;
      this.db
        .prepare('INSERT INTO context_commands VALUES(?,?,?,?,?)')
        .run(scopeKey, chatId, key, digest, revision);
      pruneContextHistory(this.db);
      return this.detail(chatId, body.branchId);
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
  job(id: string, includeInput = true): ContextJob {
    const row = this.db
      .prepare(
        `SELECT id,chat_id,branch_id,status,checkpoint,error,noop,created_at,updated_at,${includeInput ? 'snapshot' : 'NULL'} AS snapshot FROM context_jobs WHERE id=?`
      )
      .get(id) as Row | undefined;
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
          "UPDATE context_jobs SET status='completed',snapshot=NULL,checkpoint=?,noop=?,updated_at=? WHERE id=? AND status='running'"
        )
        .run(
          JSON.stringify(published.contextPlan?.checkpoint ?? null),
          Number(!published.contextPlan?.summaryCalls),
          new Date().toISOString(),
          id
        );
      this.store.event(job.chatId, 'context.job.completed', id);
      this.releaseJobDetails(id);
      pruneContextHistory(this.db);
      return this.job(id);
    });
  }
  fail(id: string, error: string) {
    return this.store.transaction(() => {
      const job = this.job(id);
      const changed = this.db
        .prepare(
          "UPDATE context_jobs SET status='failed',snapshot=NULL,error=?,updated_at=? WHERE id=? AND status='running'"
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
          "UPDATE context_jobs SET status='cancelled',snapshot=NULL,error='CANCELLED',updated_at=? WHERE id=? AND status IN ('queued','running')"
        )
        .run(new Date().toISOString(), id);
      if (changed.changes) this.store.event(chatId, 'context.job.cancelled', id);
      return this.job(id);
    });
  }
  private releaseJobDetails(id: string) {
    this.db
      .prepare(`UPDATE attempts SET request=json_object('role',role,'modelId',model_id),
      response=json_object('status',status,'error',error)
      WHERE id IN (SELECT attempt_id FROM context_job_attempts WHERE job_id=?) AND status!='running'`)
      .run(id);
  }
  recover() {
    this.db
      .prepare(
        "UPDATE context_jobs SET status='interrupted',snapshot=NULL,error='Server stopped; explicit retry required',updated_at=? WHERE status IN ('queued','running')"
      )
      .run(new Date().toISOString());
  }
}
