import { createHash, randomUUID } from 'node:crypto';
import type {
  HelperArtifact,
  HelperConversation,
  HelperEvent,
  HelperGrant,
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
export const HELPER_TABLES = [
  'helper_conversations',
  'helper_tasks',
  'helper_messages',
  'helper_events',
  'helper_grants',
  'helper_operations',
  'helper_artifact_jobs',
  'helper_task_attempts',
  'helper_artifacts',
  'helper_delegations',
] as const;
export function initHelperWorkspace(store: Store) {
  store.db.exec(`
    CREATE TABLE helper_conversations(id TEXT PRIMARY KEY,scope_key TEXT NOT NULL UNIQUE,chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE,branch_id TEXT REFERENCES branches(id) ON DELETE CASCADE,scope TEXT NOT NULL,revision INTEGER NOT NULL,persona TEXT NOT NULL,created_at TEXT NOT NULL,limits TEXT NOT NULL DEFAULT '{"totalCalls":24,"helperCalls":12,"artifacts":1}');
    CREATE TABLE helper_tasks(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES helper_conversations(id) ON DELETE CASCADE,request_key TEXT NOT NULL,request TEXT NOT NULL,status TEXT NOT NULL,generation INTEGER NOT NULL DEFAULT 0,owner TEXT,snapshot TEXT NOT NULL,error TEXT,usage TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(conversation_id,request_key));
    CREATE UNIQUE INDEX helper_one_active_task ON helper_tasks(conversation_id) WHERE status='running';
    CREATE TABLE helper_messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES helper_conversations(id) ON DELETE CASCADE,task_id TEXT NOT NULL REFERENCES helper_tasks(id) ON DELETE CASCADE,role TEXT NOT NULL,text TEXT NOT NULL,artifacts TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(task_id,role));
    CREATE TABLE helper_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,conversation_id TEXT NOT NULL REFERENCES helper_conversations(id) ON DELETE CASCADE,task_id TEXT REFERENCES helper_tasks(id) ON DELETE CASCADE,kind TEXT NOT NULL,data TEXT NOT NULL);
    CREATE INDEX helper_events_cursor ON helper_events(conversation_id,seq);
    CREATE TABLE helper_grants(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES helper_tasks(id) ON DELETE CASCADE,body TEXT NOT NULL);
    CREATE TABLE helper_operations(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES helper_tasks(id) ON DELETE CASCADE,request_hash TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE helper_artifact_jobs(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES helper_tasks(id) ON DELETE CASCADE,operation_id TEXT NOT NULL UNIQUE,snapshot TEXT NOT NULL,status TEXT NOT NULL,artifact_id TEXT,artifact_revision INTEGER,error TEXT,created_at TEXT NOT NULL);
    CREATE TABLE helper_task_attempts(task_id TEXT NOT NULL REFERENCES helper_tasks(id) ON DELETE CASCADE,attempt_id TEXT PRIMARY KEY REFERENCES attempts(id) ON DELETE CASCADE,purpose TEXT NOT NULL,segment INTEGER NOT NULL,artifact_job_id TEXT REFERENCES helper_artifact_jobs(id) ON DELETE CASCADE);
    CREATE TABLE helper_artifacts(id TEXT NOT NULL,revision INTEGER NOT NULL,conversation_id TEXT NOT NULL REFERENCES helper_conversations(id) ON DELETE CASCADE,task_id TEXT NOT NULL REFERENCES helper_tasks(id) ON DELETE CASCADE,request TEXT NOT NULL,text TEXT NOT NULL,snapshot TEXT NOT NULL,usage TEXT NOT NULL,created_at TEXT NOT NULL,origin TEXT NOT NULL,PRIMARY KEY(id,revision));
    CREATE TABLE helper_delegations(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES helper_conversations(id) ON DELETE CASCADE,revision INTEGER NOT NULL,body TEXT NOT NULL,revoked_at TEXT,created_at TEXT NOT NULL);
  `);
}

/** Only the separately submitted user message and selected editor confer authority.
 * References, model output, OOC text and retrieved content never reach this function. */
export function directHelperGrants(
  requestId: string,
  scope: HelperScope,
  request: string,
  editor?: { draftId: string }
): HelperGrant[] {
  const instruction = request
    .replace(/```[\s\S]*?```/gu, '')
    .replace(/^\s*>.*$/gmu, '')
    .replace(/\([^)]*\bOOC\s*:[^)]*\)/giu, '')
    .replace(/"[^"\n]*"|'[^'\n]*'|“[^”]*”|‘[^’]*’|`[^`]*`/gu, '')
    .trim();
  const imperative =
    /(?:해\s?줘(?:요)?|해\s?주세요|해\s?줄래|하자|바꿔\s?줘|고쳐\s?줘|남겨\s?줘|만들어\s?줘|써\s?줘|보여\s?줘|그려\s?줘|save|apply|compact|rename|fork)(?:[.!?。]\s*)?$/iu.test(
      instruction
    ) ||
    /^(?:please\s+)?(?:save|apply|compact|rename|fork|edit|change|update|write|remove|add|create)\b/iu.test(
      instruction
    );
  if (
    !imperative ||
    /(?:하지\s?마|하지\s?말|저장\s?없이|적용\s?없이|do not|don't|without saving)/iu.test(
      instruction
    )
  )
    return [];
  const actions: string[] = [];
  if (
    /(?:가정|장면|만약|다면|라면|what.if|scene)/iu.test(instruction) &&
    /(?:써\s?줘|작성해|만들어|보여\s?줘|그려\s?줘|수정해|다듬어|write|generate|revise)/iu.test(
      instruction
    )
  )
    actions.push('artifact.generate');
  const saveRequested =
    /(?:저장|적용)(?:해|하(?:고|자|세요|여))|(?:^|\band\s+)(?:please\s+)?(?:save|apply)\b/iu.test(
      instruction
    );
  if (
    /(?:이번|다음).*(?:요청|번|한\s?번).*(?:옵션|선택|값).*(?:적용|설정|지정)|(?:옵션).*(?:이번만|한\s?번만).*(?:적용|설정|지정)/iu.test(
      instruction
    )
  )
    actions.push('options.oneoff');
  if (
    /(?:이\s?채팅|채팅\s?전용|이\s?대화|여기).*(?:로어|설정).*(?:수정|바꿔|고쳐|삭제|되돌)|(?:chat.only lore)/iu.test(
      instruction
    )
  )
    actions.push('chat.lore');
  if (
    /(?:요약|문맥).*(?:압축|정리)(?:해\s*(?:줘|주세요|줄래)|하(?:고|자|세요))|^(?:please\s+)?compact\b/iu.test(
      instruction
    )
  )
    actions.push('context.compact');
  if (
    /(?:요약).*(?:(?:수정|저장)(?:해\s*(?:줘|주세요|줄래)|하(?:고|자|세요))|바꿔\s*줘)|^(?:please\s+)?edit (?:the )?summary/iu.test(
      instruction
    )
  )
    actions.push('context.edit');
  if (
    /(?:메모|정정).*(?:(?:추가|저장|수정|삭제)(?:해\s*(?:줘|주세요|줄래)|하(?:고|자|세요))|남겨\s*줘)|^(?:please\s+)?(?:save|add|remove) (?:a )?note/iu.test(
      instruction
    )
  )
    actions.push('notes.write');
  if (
    /(?:제목).*(?:(?:변경|수정|설정)(?:해\s*(?:줘|주세요|줄래)|하(?:고|자|세요))|바꿔\s*줘)|^(?:please\s+)?(?:rename|set (?:the )?title)/iu.test(
      instruction
    )
  )
    actions.push('title.write');
  if (
    /(?:포크|분기).*(?:만들어\s*줘|생성해\s*줘|해\s*줘)|^(?:please\s+)?(?:fork|create .*branch)/iu.test(
      instruction
    )
  )
    actions.push('chat.fork');
  const result: HelperGrant[] =
    actions.length && scope.kind === 'chat'
      ? [
          {
            id: randomUUID(),
            requestId,
            target: scope.chatId,
            actions,
            provenance: 'direct-user-request',
          },
        ]
      : [];
  if (scope.kind === 'library') {
    const libraryActions: string[] = [];
    const creating = /(?:만들어|생성해|작성해|구성해|복제해)|\b(?:create|make|duplicate)\b/iu.test(
      instruction
    );
    if (creating && /(?:새|신규|new|create).*(?:봇|bot)/iu.test(instruction))
      libraryActions.push('draft.create:bot');
    if (creating && /(?:새|신규|new|create).*(?:페르소나|persona)/iu.test(instruction))
      libraryActions.push('draft.create:persona');
    if (creating && /(?:새|신규|new|create).*(?:모듈|module)/iu.test(instruction))
      libraryActions.push('draft.create:module');
    if (creating && /(?:새|신규|new|create).*(?:프롬프트|prompt)/iu.test(instruction))
      libraryActions.push('draft.create:prompt-preset');
    if (
      /(?:폴더|서재).*(?:(?:정리|이동|생성)(?:해\s*(?:줘|주세요|줄래)|하(?:고|자|세요))|만들어\s*줘)|^(?:please\s+)?(?:organize|create .*folder|move)/iu.test(
        instruction
      )
    )
      libraryActions.push('library.organize');
    if (libraryActions.length) {
      if (saveRequested) libraryActions.push('draft.create.save');
      result.push({
        id: randomUUID(),
        requestId,
        target: `library:${scope.workId}`,
        actions: libraryActions,
        provenance: 'direct-user-request',
      });
    }
  }
  if (editor) {
    // Edits affect the selected draft only. A save is a distinct, explicit action.
    const draftActions =
      /(?:수정|편집|추가|삭제|작성)(?:해|하(?:고|자|세요|여))|(?:바꿔|고쳐|만들어)|(?:^|\band\s+)(?:please\s+)?(?:edit|change|update|write|remove|add)\b/iu.test(
        instruction
      )
        ? ['draft.patch']
        : [];
    if (saveRequested) draftActions.push('draft.save');
    if (draftActions.length)
      result.push({
        id: randomUUID(),
        requestId,
        target: editor.draftId,
        actions: draftActions,
        provenance: 'direct-user-request',
      });
  }
  return result;
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
      revision: row.revision,
      persona: row.persona,
      limits: JSON.parse(row.limits),
      createdAt: row.created_at,
    };
  }
  open(scope: HelperScope): HelperConversation {
    if (scope.kind === 'chat') this.store.product.branch(scope.chatId, scope.branchId);
    const key = json(scope);
    const old = this.store.db
      .prepare('SELECT id FROM helper_conversations WHERE scope_key=?')
      .get(key) as Row | undefined;
    if (old) return this.conversation(old.id);
    const id = randomUUID();
    this.store.db
      .prepare(
        'INSERT INTO helper_conversations(id,scope_key,chat_id,branch_id,scope,revision,persona,created_at) VALUES(?,?,?,?,?,1,?,?)'
      )
      .run(
        id,
        key,
        scope.kind === 'chat' ? scope.chatId : null,
        scope.kind === 'chat' ? scope.branchId : null,
        json(scope),
        '',
        now()
      );
    return this.conversation(id);
  }
  persona(id: string, revision: number, persona: string, limits = this.conversation(id).limits) {
    const changed = this.store.db
      .prepare(
        'UPDATE helper_conversations SET persona=?,limits=?,revision=revision+1 WHERE id=? AND revision=?'
      )
      .run(persona, json(limits), id, revision);
    if (!changed.changes) throw new HttpError(409, '도우미 설정이 다른 곳에서 변경됐어요.');
    return this.conversation(id);
  }
  messages(id: string, before?: string): HelperMessage[] {
    this.conversation(id);
    return (
      this.store.db
        .prepare(
          `SELECT * FROM helper_messages WHERE conversation_id=? ${before ? 'AND rowid < (SELECT rowid FROM helper_messages WHERE id=?)' : ''} ORDER BY rowid DESC LIMIT 100`
        )
        .all(...(before ? [id, before] : [id])) as Row[]
    )
      .reverse()
      .map((row) => ({
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
    return {
      id: row.id,
      conversationId: row.conversation_id,
      request: row.request,
      status: row.status,
      generation: row.generation,
      error: row.error,
      usage: JSON.parse(row.usage),
      snapshot: JSON.parse(row.snapshot),
    };
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
  existing(conversationId: string, key: string, request: string) {
    const row = this.store.db
      .prepare('SELECT id,request FROM helper_tasks WHERE conversation_id=? AND request_key=?')
      .get(conversationId, key) as Row | undefined;
    if (row && row.request !== request)
      throw new HttpError(409, '같은 요청 키로 다른 작업을 보낼 수 없어요.');
    return row ? this.task(row.id) : undefined;
  }
  enqueue(conversationId: string, key: string, request: string, snapshot: HelperTaskSnapshot) {
    return this.store.transaction(() => {
      const prior = this.existing(conversationId, key, request);
      if (prior) return prior;
      const id = randomUUID(),
        time = now();
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
      for (const grant of snapshot.grants)
        this.store.db
          .prepare('INSERT INTO helper_grants VALUES(?,?,?)')
          .run(grant.id, id, json(grant));
      this.store.db
        .prepare('INSERT INTO helper_messages VALUES(?,?,?,?,?,?,?)')
        .run(randomUUID(), conversationId, id, 'user', request, '[]', time);
      this.event(conversationId, id, 'task.queued');
      return this.task(id);
    });
  }
  start(id: string, owner: string) {
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
    return !!this.store.db
      .prepare(
        "UPDATE helper_tasks SET status='running',owner=?,generation=generation+1,updated_at=? WHERE id=? AND status='queued'"
      )
      .run(owner, now(), id).changes;
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
  authorize(taskId: string, target: string, action: string) {
    const task = this.task(taskId);
    if (task.status !== 'running') throw new HttpError(409, 'HELPER_TASK_NO_LONGER_ACTIVE');
    const grants = (
      this.store.db.prepare('SELECT body FROM helper_grants WHERE task_id=?').all(taskId) as Row[]
    ).map((row) => JSON.parse(row.body) as HelperGrant);
    if (!grants.some((grant) => grant.target === target && grant.actions.includes(action)))
      throw new HttpError(403, '명확한 사용자 요청이 필요한 변경이에요. 제안으로 남겨 주세요.');
  }
  grantCreatedDraft(taskId: string, draftId: string, contentKind: string) {
    const task = this.task(taskId),
      scope = task.snapshot.scope;
    if (scope.kind !== 'library') throw new HttpError(403, 'LIBRARY_SCOPE_REQUIRED');
    const target = `library:${scope.workId}`;
    this.authorize(taskId, target, `draft.create:${contentKind}`);
    const actions = ['draft.patch'];
    if (
      task.snapshot.grants.some(
        (grant) => grant.target === target && grant.actions.includes('draft.create.save')
      )
    )
      actions.push('draft.save');
    const grant: HelperGrant = {
      id: randomUUID(),
      requestId: taskId,
      target: draftId,
      actions,
      provenance: 'direct-user-request',
    };
    this.store.db
      .prepare('INSERT INTO helper_grants VALUES(?,?,?)')
      .run(grant.id, taskId, json(grant));
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
