import { releaseCompletedHelperInputs } from './execution-retention.js';
import { createHash, randomUUID } from 'node:crypto';
import type {
  HelperArtifact,
  HelperConversation,
  HelperConversationDeletion,
  HelperConversationSummary,
  HelperEvent,
  HelperMessage,
  HelperScope,
  HelperTask,
  HelperTaskSnapshot,
  HelperStatus,
} from '../core/helper.js';
import type { RunSnapshot, Usage } from '../core/types.js';
import type { ProviderResult, WireRecord } from '../core/transport.js';
import { HttpError } from './request-validation.js';
import type { Store } from './store.js';

type Row = Record<string, any>;
const json = JSON.stringify;
const now = () => new Date().toISOString();
const emptyUsage = (): Usage => ({ modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });

export function initHelperWorkspace(store: Store) {
  store.db.exec(`
    CREATE TABLE helper_conversations(id TEXT PRIMARY KEY,scope_key TEXT NOT NULL,creation_key TEXT NOT NULL,creation_hash TEXT NOT NULL,chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE,branch_id TEXT REFERENCES branches(id) ON DELETE CASCADE,scope TEXT NOT NULL,title TEXT NOT NULL,auto_title INTEGER NOT NULL,revision INTEGER NOT NULL,persona TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,limits TEXT NOT NULL DEFAULT '{"totalCalls":24,"helperCalls":12,"artifacts":1}',UNIQUE(scope_key,creation_key));
    CREATE INDEX helper_conversations_scope ON helper_conversations(chat_id,branch_id,updated_at);
    CREATE TABLE helper_tasks(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES helper_conversations(id) ON DELETE CASCADE,request_key TEXT NOT NULL,request TEXT NOT NULL,status TEXT NOT NULL,generation INTEGER NOT NULL DEFAULT 0,owner TEXT,snapshot TEXT NOT NULL,error TEXT,usage TEXT NOT NULL,created_at TEXT NOT NULL,started_at TEXT,updated_at TEXT NOT NULL,UNIQUE(conversation_id,request_key));
    CREATE UNIQUE INDEX helper_one_active_task ON helper_tasks(conversation_id) WHERE status='running';
    CREATE TABLE helper_messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES helper_conversations(id) ON DELETE CASCADE,task_id TEXT NOT NULL REFERENCES helper_tasks(id) ON DELETE CASCADE,role TEXT NOT NULL,text TEXT NOT NULL,artifacts TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(task_id,role));
    CREATE TABLE helper_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,conversation_id TEXT NOT NULL REFERENCES helper_conversations(id) ON DELETE CASCADE,task_id TEXT REFERENCES helper_tasks(id) ON DELETE CASCADE,kind TEXT NOT NULL,data TEXT NOT NULL);
    CREATE INDEX helper_events_cursor ON helper_events(conversation_id,seq);
    CREATE TABLE helper_operations(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES helper_tasks(id) ON DELETE CASCADE,request_hash TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE helper_artifact_jobs(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES helper_tasks(id) ON DELETE CASCADE,operation_id TEXT NOT NULL UNIQUE,snapshot TEXT NOT NULL,status TEXT NOT NULL,artifact_id TEXT,artifact_revision INTEGER,error TEXT,created_at TEXT NOT NULL);
    CREATE TABLE helper_task_attempts(task_id TEXT NOT NULL REFERENCES helper_tasks(id) ON DELETE CASCADE,attempt_id TEXT PRIMARY KEY REFERENCES attempts(id) ON DELETE CASCADE,purpose TEXT NOT NULL,segment INTEGER NOT NULL,artifact_job_id TEXT REFERENCES helper_artifact_jobs(id) ON DELETE CASCADE);
    CREATE TABLE helper_artifacts(id TEXT NOT NULL,revision INTEGER NOT NULL,conversation_id TEXT NOT NULL REFERENCES helper_conversations(id) ON DELETE CASCADE,task_id TEXT NOT NULL REFERENCES helper_tasks(id) ON DELETE CASCADE,request TEXT NOT NULL,text TEXT NOT NULL,snapshot TEXT NOT NULL,usage TEXT NOT NULL,created_at TEXT NOT NULL,origin TEXT NOT NULL,PRIMARY KEY(id,revision));
  `);
}

export class HelperWorkspace {
  constructor(readonly store: Store) {}
  conversation(id: string): HelperConversation {
    const row = this.store.db.prepare('SELECT * FROM helper_conversations WHERE id=?').get(id) as
      | Row
      | undefined;
    if (!row) throw new HttpError(404, '도우미 대화를 찾을 수 없어요.');
    return {
      id: row.id,
      scope: JSON.parse(row.scope),
      title: row.title,
      revision: row.revision,
      persona: row.persona,
      limits: JSON.parse(row.limits),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  open(scope: HelperScope): HelperConversation {
    return this.create(scope, 'default');
  }
  create(scope: HelperScope, creationKey: string, title?: string): HelperConversation {
    return this.store.transaction(() => {
      if (scope.kind === 'chat') this.store.product.branch(scope.chatId, scope.branchId);
      const key = json(scope),
        creationHash = createHash('sha256')
          .update(json({ title: title ?? null }))
          .digest('hex');
      const old = this.store.db
        .prepare(
          'SELECT id,creation_hash FROM helper_conversations WHERE scope_key=? AND creation_key=?'
        )
        .get(key, creationKey) as Row | undefined;
      if (old) {
        if (old.creation_hash !== creationHash)
          throw new HttpError(409, '대화 생성 요청 키가 다른 요청에 사용됐어요.');
        return this.conversation(old.id);
      }
      const id = randomUUID(),
        time = now();
      this.store.db
        .prepare(
          'INSERT INTO helper_conversations(id,scope_key,creation_key,creation_hash,chat_id,branch_id,scope,title,auto_title,revision,persona,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,1,?,?,?)'
        )
        .run(
          id,
          key,
          creationKey,
          creationHash,
          scope.kind === 'chat' ? scope.chatId : null,
          scope.kind === 'chat' ? scope.branchId : null,
          key,
          title ?? '새 도우미 대화',
          Number(title === undefined),
          '',
          time,
          time
        );
      return this.conversation(id);
    });
  }
  list(
    scope: { kind: 'chat'; chatId: string; branchId?: string } | { kind: 'library' }
  ): HelperConversationSummary[] {
    if (scope.kind === 'chat') {
      this.store.chat(scope.chatId);
      if (scope.branchId) this.store.product.branch(scope.chatId, scope.branchId);
    }
    const rows =
      scope.kind === 'library'
        ? this.store.db
            .prepare(
              'SELECT id FROM helper_conversations WHERE chat_id IS NULL ORDER BY updated_at DESC,rowid DESC'
            )
            .all()
        : this.store.db
            .prepare(
              `SELECT id FROM helper_conversations WHERE chat_id=? ${scope.branchId ? 'AND branch_id=?' : ''} ORDER BY updated_at DESC,rowid DESC`
            )
            .all(...(scope.branchId ? [scope.chatId, scope.branchId] : [scope.chatId]));
    return rows.map((row) => {
      const activity = this.store.db
        .prepare(
          "SELECT COALESCE(SUM(status='running'),0) AS running,COALESCE(SUM(status='queued'),0) AS queued FROM helper_tasks WHERE conversation_id=?"
        )
        .get(row.id)!;
      return {
        ...this.conversation(String(row.id)),
        activity: { running: Number(activity.running), queued: Number(activity.queued) },
        latestEventSeq: Number(
          this.store.db
            .prepare(
              'SELECT COALESCE(MAX(seq),0) AS seq FROM helper_events WHERE conversation_id=?'
            )
            .get(row.id)?.seq
        ),
      };
    });
  }
  persona(id: string, revision: number, persona: string, limits = this.conversation(id).limits) {
    return this.update(id, revision, { persona, limits });
  }
  update(
    id: string,
    revision: number,
    changes: Partial<Pick<HelperConversation, 'title' | 'persona' | 'limits'>>
  ) {
    const previous = this.conversation(id);
    const changed = this.store.db
      .prepare(
        'UPDATE helper_conversations SET title=?,auto_title=CASE WHEN ? THEN 0 ELSE auto_title END,persona=?,limits=?,updated_at=?,revision=revision+1 WHERE id=? AND revision=?'
      )
      .run(
        changes.title ?? previous.title,
        Number(changes.title !== undefined),
        changes.persona ?? previous.persona,
        json(changes.limits ?? previous.limits),
        now(),
        id,
        revision
      );
    if (!changed.changes) throw new HttpError(409, '도우미 설정이 다른 곳에서 변경됐어요.');
    this.event(id, null, 'conversation.updated');
    return this.conversation(id);
  }
  deletionImpact(id: string): HelperConversationDeletion {
    const conversation = this.conversation(id);
    const count = (sql: string) => Number(this.store.db.prepare(sql).get(id)?.n ?? 0);
    const activeTasks = count(
      "SELECT COUNT(*) AS n FROM helper_tasks WHERE conversation_id=? AND status IN ('queued','running')"
    );
    const unsettledAttempts = count(
      "SELECT COUNT(*) AS n FROM attempts a JOIN helper_task_attempts x ON x.attempt_id=a.id JOIN helper_tasks t ON t.id=x.task_id WHERE t.conversation_id=? AND a.status='running'"
    );
    return {
      request: {
        expectedRevision: conversation.revision,
        expectedEventSequence: count(
          'SELECT COALESCE(MAX(seq),0) AS n FROM helper_events WHERE conversation_id=?'
        ),
      },
      activeTasks,
      unsettledAttempts,
      workerActive: false,
      canDelete: activeTasks === 0 && unsettledAttempts === 0,
      description:
        '이 도우미 대화의 메시지·작업·가정 장면·개인 요약을 삭제해요. 이미 저장한 본편·공통 자료와 다음 요청 옵션은 유지돼요. 진행 중인 작업은 먼저 중지해 주세요.',
    };
  }
  delete(id: string, expected: HelperConversationDeletion['request']) {
    return this.store.transaction(() => {
      const impact = this.deletionImpact(id);
      if (
        impact.request.expectedRevision !== expected.expectedRevision ||
        impact.request.expectedEventSequence !== expected.expectedEventSequence
      )
        throw new HttpError(
          409,
          '도우미 대화가 변경됐어요. 최신 내용을 확인한 뒤 다시 삭제해 주세요.'
        );
      if (!impact.canDelete)
        throw new HttpError(
          409,
          '진행 중인 작업을 중지하고 공급자 요청이 종료된 뒤 삭제해 주세요.'
        );
      const tasks = this.store.db
        .prepare('SELECT id FROM helper_tasks WHERE conversation_id=?')
        .all(id);
      for (const scopeKey of [`helper:${id}`, ...tasks.map((task) => `artifact:${task.id}`)])
        for (const table of ['context_heads', 'context_checkpoints'])
          this.store.db.prepare(`DELETE FROM ${table} WHERE scope_key=?`).run(scopeKey);
      this.store.db
        .prepare(
          'DELETE FROM attempts WHERE id IN (SELECT x.attempt_id FROM helper_task_attempts x JOIN helper_tasks t ON t.id=x.task_id WHERE t.conversation_id=?)'
        )
        .run(id);
      this.store.db.prepare('DELETE FROM helper_conversations WHERE id=?').run(id);
      return { deleted: true as const };
    });
  }
  messages(id: string, before?: string): HelperMessage[] {
    this.conversation(id);
    return (
      this.store.db
        .prepare(
          `SELECT m.*, COALESCE(json_extract(t.snapshot,'$.requestGroupId'), t.id) AS request_group_id, root.rowid AS request_order,
          (SELECT latest.id FROM helper_tasks latest WHERE latest.conversation_id=m.conversation_id AND COALESCE(json_extract(latest.snapshot,'$.requestGroupId'),latest.id)=root.id ORDER BY latest.rowid DESC LIMIT 1) AS latest_task_id
          FROM helper_messages m JOIN helper_tasks t ON t.id=m.task_id JOIN helper_tasks root ON root.id=COALESCE(json_extract(t.snapshot,'$.requestGroupId'), t.id)
          WHERE m.conversation_id=? ${before ? 'AND m.rowid < (SELECT rowid FROM helper_messages WHERE id=?)' : ''} ORDER BY m.rowid DESC LIMIT 100`
        )
        .all(...(before ? [id, before] : [id])) as Row[]
    )
      .reverse()
      .map((row) => ({
        requestGroupId: row.request_group_id,
        latestTaskId: row.latest_task_id,
        requestOrder: row.request_order,
        id: row.id,
        conversationId: id,
        taskId: row.task_id,
        role: row.role,
        text: row.text,
        artifacts: JSON.parse(row.artifacts),
        createdAt: row.created_at,
      }));
  }
  event(conversationId: string, taskId: string | null, kind: string, data: unknown = null) {
    this.store.db
      .prepare('UPDATE helper_conversations SET updated_at=? WHERE id=?')
      .run(now(), conversationId);
    this.store.db
      .prepare('INSERT INTO helper_events(conversation_id,task_id,kind,data) VALUES(?,?,?,?)')
      .run(conversationId, taskId, kind, json(data));
    if (kind.startsWith('task.') || kind === 'artifact.saved') {
      const scope = this.conversation(conversationId).scope;
      if (scope.kind === 'chat')
        this.store.event(scope.chatId, `helper.${kind}`, taskId ?? conversationId);
    }
  }
  events(id: string, after = 0): HelperEvent[] {
    this.conversation(id);
    return (
      this.store.db
        .prepare(
          'SELECT * FROM helper_events WHERE conversation_id=? AND seq>? ORDER BY seq LIMIT 500'
        )
        .all(id, after) as Row[]
    ).map((r) => ({
      seq: r.seq,
      conversationId: r.conversation_id,
      taskId: r.task_id,
      kind: r.kind,
      data: JSON.parse(r.data),
    }));
  }
  task(id: string): HelperTask {
    const row = this.store.db.prepare('SELECT * FROM helper_tasks WHERE id=?').get(id) as
      | Row
      | undefined;
    if (!row) throw new HttpError(404, '도우미 작업을 찾을 수 없어요.');
    const completedEffects = ['failed', 'cancelled', 'interrupted'].includes(row.status)
      ? this.completedEffects(id)
      : undefined;
    return {
      id: row.id,
      conversationId: row.conversation_id,
      request: row.request,
      status: row.status,
      generation: row.generation,
      error: row.error,
      usage: JSON.parse(row.usage),
      createdAt: row.created_at,
      startedAt: row.started_at ?? null,
      updatedAt: row.updated_at,
      snapshot: JSON.parse(row.snapshot),
      ...(completedEffects?.count ? { completedEffects } : {}),
    };
  }
  /** Read receipts, never streamed tool output: the worker may stop before tool.finished. */
  private completedEffects(id: string) {
    const count = Number(
      this.store.db.prepare('SELECT count(*) AS n FROM helper_operations WHERE task_id=?').get(id)
        ?.n ?? 0
    );
    return { count, labels: count ? ['완료된 도우미 작업'] : [] };
  }
  tasks(id: string, before?: string) {
    this.conversation(id);
    return (
      this.store.db
        .prepare(
          `SELECT id FROM helper_tasks WHERE conversation_id=? ${before ? 'AND rowid < (SELECT rowid FROM helper_tasks WHERE id=? AND conversation_id=?)' : ''} ORDER BY rowid DESC LIMIT 50`
        )
        .all(...(before ? [id, before, id] : [id])) as Row[]
    ).map((r) => this.task(r.id));
  }
  existing(conversationId: string, key: string, request: string, retryOf?: string) {
    const row = this.store.db
      .prepare('SELECT id,request FROM helper_tasks WHERE conversation_id=? AND request_key=?')
      .get(conversationId, key) as Row | undefined;
    if (row && (row.request !== request || this.task(row.id).snapshot.retryOf !== retryOf))
      throw new HttpError(409, '같은 요청 키로 다른 작업을 보낼 수 없어요.');
    return row ? this.task(row.id) : undefined;
  }
  enqueue(conversationId: string, key: string, request: string, snapshot: HelperTaskSnapshot) {
    return this.store.transaction(() => {
      const prior = this.existing(conversationId, key, request, snapshot.retryOf);
      if (prior) return prior;
      if (snapshot.retryOf) {
        const previous = this.task(snapshot.retryOf);
        if (previous.conversationId !== conversationId)
          throw new HttpError(403, '다른 대화의 요청은 재시도할 수 없어요.');
        if (!['failed', 'cancelled', 'interrupted'].includes(previous.status))
          throw new HttpError(409, '종료된 실패 요청만 재시도할 수 있어요.');
        if (previous.completedEffects?.count)
          throw new HttpError(409, 'HELPER_EFFECTS_ALREADY_COMMITTED');
        snapshot.requestGroupId = previous.snapshot.requestGroupId ?? previous.id;
        const latest = this.store.db
          .prepare(
            "SELECT id FROM helper_tasks WHERE conversation_id=? AND COALESCE(json_extract(snapshot, '$.requestGroupId'),id)=? ORDER BY rowid DESC LIMIT 1"
          )
          .get(conversationId, snapshot.requestGroupId);
        if (latest?.id !== previous.id)
          throw new HttpError(409, '이미 다시 시도한 요청이에요. 최신 결과를 확인해 주세요.');
      }
      const id = randomUUID(),
        time = now();
      const titled = this.store.db
        .prepare(
          'UPDATE helper_conversations SET title=?,auto_title=0,revision=revision+1,updated_at=? WHERE id=? AND auto_title=1 AND revision=1 AND NOT EXISTS (SELECT 1 FROM helper_tasks WHERE conversation_id=?)'
        )
        .run(
          Array.from(request.trim().replace(/\s+/gu, ' ')).slice(0, 80).join(''),
          time,
          conversationId,
          conversationId
        );
      if (titled.changes) this.event(conversationId, null, 'conversation.updated');
      this.store.db
        .prepare(
          'INSERT INTO helper_tasks(id,conversation_id,request_key,request,status,snapshot,usage,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)'
        )
        .run(
          id,
          conversationId,
          key,
          request,
          'queued',
          json(snapshot),
          json(emptyUsage()),
          time,
          time
        );
      this.store.db
        .prepare('INSERT INTO helper_messages VALUES(?,?,?,?,?,?,?)')
        .run(randomUUID(), conversationId, id, 'user', request, '[]', time);
      this.event(conversationId, id, 'task.queued');
      return this.task(id);
    });
  }
  start(id: string, owner: string) {
    if (
      Number(
        this.store.db.prepare("SELECT COUNT(*) AS n FROM helper_tasks WHERE status='running'").get()
          ?.n
      ) >= 2
    )
      return false;
    const task = this.task(id);
    if (
      this.store.db
        .prepare("SELECT 1 FROM helper_tasks WHERE conversation_id=? AND status='running'")
        .get(task.conversationId)
    )
      return false;
    const next = this.store.db
      .prepare(
        "SELECT id FROM helper_tasks WHERE conversation_id=? AND status='queued' ORDER BY rowid LIMIT 1"
      )
      .get(task.conversationId);
    if (next?.id !== id) return false;
    const claimed = now();
    return !!this.store.db
      .prepare(
        "UPDATE helper_tasks SET status='running',owner=?,generation=generation+1,started_at=?,updated_at=? WHERE id=? AND status='queued'"
      )
      .run(owner, claimed, claimed, id).changes;
  }
  active(id: string, owner: string, generation: number) {
    return !!this.store.db
      .prepare(
        "SELECT 1 FROM helper_tasks WHERE id=? AND owner=? AND generation=? AND status='running'"
      )
      .get(id, owner, generation);
  }
  assertActive(id: string, owner: string, generation: number) {
    if (!this.active(id, owner, generation))
      throw new HttpError(409, 'HELPER_TASK_NO_LONGER_ACTIVE');
  }
  assertRunning(taskId: string) {
    const row = this.store.db.prepare('SELECT status FROM helper_tasks WHERE id=?').get(taskId);
    if (row?.status !== 'running') throw new HttpError(409, 'HELPER_TASK_NO_LONGER_ACTIVE');
  }
  operation<T>(taskId: string, operationId: string, input: unknown, apply: () => T): T {
    return this.store.transaction(() => {
      const hash = createHash('sha256').update(json(input)).digest('hex');
      const prior = this.store.db
        .prepare('SELECT * FROM helper_operations WHERE id=?')
        .get(operationId) as Row | undefined;
      if (prior) {
        if (prior.task_id !== taskId || prior.request_hash !== hash)
          throw new HttpError(409, 'OPERATION_ID_CONFLICT');
        return JSON.parse(prior.result) as T;
      }
      if (this.task(taskId).status !== 'running')
        throw new HttpError(409, 'HELPER_TASK_NO_LONGER_ACTIVE');
      const result = apply();
      this.store.db
        .prepare('INSERT INTO helper_operations VALUES(?,?,?,?,?)')
        .run(operationId, taskId, hash, json(result), now());
      return result;
    });
  }
  operationResult<T>(taskId: string, operationId: string, input: unknown): T | undefined {
    const row = this.store.db
      .prepare('SELECT * FROM helper_operations WHERE id=?')
      .get(operationId) as Row | undefined;
    if (!row) return undefined;
    const hash = createHash('sha256').update(json(input)).digest('hex');
    if (row.task_id !== taskId || row.request_hash !== hash)
      throw new HttpError(409, 'OPERATION_ID_CONFLICT');
    return JSON.parse(row.result) as T;
  }
  startAttempt(
    taskId: string,
    owner: string,
    generation: number,
    purpose: string,
    segment: number,
    wire: WireRecord
  ) {
    return this.store.transaction(() => {
      this.assertActive(taskId, owner, generation);
      const task = this.task(taskId),
        usage = task.usage;
      if (usage.modelCalls >= task.snapshot.limits.totalCalls)
        throw new HttpError(409, 'MODEL_CALL_BUDGET_EXHAUSTED');
      if (
        purpose === 'helper' &&
        Number(
          this.store.db
            .prepare(
              "SELECT COUNT(*) AS n FROM helper_task_attempts WHERE task_id=? AND purpose='helper'"
            )
            .get(taskId)?.n
        ) >= task.snapshot.limits.helperCalls
      )
        throw new HttpError(409, 'HELPER_CALL_BUDGET_EXHAUSTED');
      const scope = task.snapshot.scope;
      const id = this.store.product.startAttempt(
        scope.kind === 'chat' ? scope.chatId : null,
        null,
        null,
        wire
      );
      this.store.db
        .prepare(
          'INSERT INTO helper_task_attempts(task_id,attempt_id,purpose,segment) VALUES(?,?,?,?)'
        )
        .run(taskId, id, purpose, segment);
      usage.modelCalls++;
      this.store.db.prepare('UPDATE helper_tasks SET usage=? WHERE id=?').run(json(usage), taskId);
      this.event(task.conversationId, taskId, 'attempt.started', { id, purpose, segment });
      return id;
    });
  }
  finishAttempt(taskId: string, id: string, result: ProviderResult) {
    this.store.transaction(() => {
      const row = this.store.db
        .prepare(
          'SELECT status FROM attempts WHERE id=? AND id IN (SELECT attempt_id FROM helper_task_attempts WHERE task_id=?)'
        )
        .get(id, taskId) as Row | undefined;
      if (!row || row.status !== 'running') return;
      this.store.product.finishAttempt(id, result);
      const task = this.task(taskId),
        usage = task.usage;
      for (const key of ['inputTokens', 'outputTokens', 'costUsd'] as const)
        usage[key] =
          usage[key] === null || result.usage[key] === null ? null : usage[key] + result.usage[key];
      this.store.db.prepare('UPDATE helper_tasks SET usage=? WHERE id=?').run(json(usage), taskId);
      this.event(task.conversationId, taskId, 'attempt.finished', { id, status: result.status });
    });
  }
  finish(
    id: string,
    owner: string,
    generation: number,
    status: HelperStatus,
    text: string,
    error: string | null,
    artifacts: { id: string; revision: number }[] = []
  ) {
    return this.store.transaction(() => {
      if (!this.active(id, owner, generation)) return false;
      const task = this.task(id);
      this.store.db
        .prepare('UPDATE helper_tasks SET status=?,error=?,updated_at=? WHERE id=?')
        .run(status, error, now(), id);
      if (text || artifacts.length)
        this.store.db
          .prepare('INSERT INTO helper_messages VALUES(?,?,?,?,?,?,?)')
          .run(randomUUID(), task.conversationId, id, 'assistant', text, json(artifacts), now());
      if (status === 'completed') releaseCompletedHelperInputs(this.store.db, id);
      this.event(task.conversationId, id, `task.${status}`, { error, artifacts });
      return true;
    });
  }
  cancel(id: string) {
    const task = this.task(id);
    this.store.transaction(() => {
      const changed = this.store.db
        .prepare(
          "UPDATE helper_tasks SET status='cancelled',error='CANCELLED',updated_at=? WHERE id=? AND status IN ('queued','running')"
        )
        .run(now(), id).changes;
      if (changed) this.event(task.conversationId, id, 'task.cancelled');
    });
    return this.task(id);
  }
  interrupt() {
    this.store.transaction(() => {
      this.store.db
        .prepare(
          "UPDATE helper_artifact_jobs SET status='interrupted',error='Server stopped; execution was not replayed' WHERE status='running'"
        )
        .run();
      const rows = this.store.db
        .prepare("SELECT id,conversation_id FROM helper_tasks WHERE status IN ('queued','running')")
        .all() as Row[];
      for (const row of rows) {
        this.store.db
          .prepare(
            "UPDATE helper_tasks SET status='interrupted',error='Server stopped; execution was not replayed',updated_at=? WHERE id=?"
          )
          .run(now(), row.id);
        this.event(row.conversation_id, row.id, 'task.interrupted');
      }
    });
  }
  artifact(id: string, revision?: number): HelperArtifact {
    const row = this.store.db
      .prepare(
        `SELECT * FROM helper_artifacts WHERE id=? ${revision === undefined ? 'ORDER BY revision DESC LIMIT 1' : 'AND revision=?'}`
      )
      .get(...(revision === undefined ? [id] : [id, revision])) as Row | undefined;
    if (!row) throw new HttpError(404, '가정 장면을 찾을 수 없어요.');
    return {
      id: row.id,
      revision: row.revision,
      origin: row.origin,
      conversationId: row.conversation_id,
      taskId: row.task_id,
      request: row.request,
      text: row.text,
      snapshot: JSON.parse(row.snapshot),
      usage: JSON.parse(row.usage),
      createdAt: row.created_at,
    };
  }
  saveArtifact(
    taskId: string,
    operationId: string,
    request: string,
    text: string,
    snapshot: RunSnapshot,
    usage: Usage,
    previous?: { id: string; revision: number }
  ) {
    return this.operation(
      taskId,
      operationId,
      { kind: 'artifact', request, previous: previous ?? null },
      () => {
        const task = this.task(taskId),
          id = previous?.id ?? randomUUID();
        if (previous) {
          const current = this.artifact(id);
          if (
            current.conversationId !== task.conversationId ||
            current.revision !== previous.revision
          )
            throw new HttpError(409, '가정 장면이 다른 곳에서 수정됐어요.');
        }
        const revision = (previous?.revision ?? 0) + 1;
        this.store.db
          .prepare('INSERT INTO helper_artifacts VALUES(?,?,?,?,?,?,?,?,?,?)')
          .run(
            id,
            revision,
            task.conversationId,
            taskId,
            request,
            text,
            json(snapshot),
            json(usage),
            now(),
            'model'
          );
        this.event(task.conversationId, taskId, 'artifact.saved', { id, revision });
        return this.artifact(id, revision);
      }
    );
  }
  editArtifact(id: string, revision: number, body: string, requestKey: string) {
    return this.store.transaction(() => {
      const previous = this.artifact(id),
        operationId = `artifact-edit:${id}:${requestKey}`;
      const input = { kind: 'artifact.edit', id, revision, text: body };
      const old = this.operationResult<HelperArtifact>(previous.taskId, operationId, input);
      if (old) return old;
      if (previous.revision !== revision)
        throw new HttpError(409, '가정 장면이 다른 곳에서 수정됐어요. 최신 개정을 확인해 주세요.');
      const updated = {
        ...previous,
        revision: revision + 1,
        text: body,
        origin: 'edit' as const,
        createdAt: now(),
      };
      this.store.db
        .prepare('INSERT INTO helper_artifacts VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(
          id,
          updated.revision,
          previous.conversationId,
          previous.taskId,
          previous.request,
          body,
          json(previous.snapshot),
          json(previous.usage),
          updated.createdAt,
          'edit'
        );
      this.store.db
        .prepare('INSERT INTO helper_operations VALUES(?,?,?,?,?)')
        .run(
          operationId,
          previous.taskId,
          createHash('sha256').update(json(input)).digest('hex'),
          json(updated),
          updated.createdAt
        );
      this.event(previous.conversationId, previous.taskId, 'artifact.saved', {
        id,
        revision: updated.revision,
        origin: 'edit',
      });
      return updated;
    });
  }
}
