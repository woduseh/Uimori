import { detachAttemptUsage, helperUsageKind } from './usage-accounting.js';
import { releaseCompletedHelperInputs } from './execution-retention.js';
import { createHash, randomUUID } from 'node:crypto';
import type {
  HelperArtifact,
  HelperConversation,
  HelperConversationDeletion,
  HelperConversationSummary,
  HelperProject,
  HelperEvent,
  HelperMessage,
  HelperMessageMutation,
  HelperScope,
  HelperTask,
  HelperTaskSnapshot,
  HelperStatus,
  HelperInstruction,
  HelperLimits,
} from '../core/helper.js';
import { HELPER_TASK_LIMITS } from '../core/helper.js';
import { UI_HELPER_PERSONA } from '../core/helper-persona.js';
import type { Usage } from '../core/types.js';
import type { ProviderResult, WireRecord } from '../core/transport.js';
import { HttpError } from './request-validation.js';
import type { Store } from './store.js';
import type { SynchronousResult } from './synchronous-transaction.js';

type Row = Record<string, any>;
const json = JSON.stringify;
const now = () => new Date().toISOString();
const emptyUsage = (): Usage => ({ modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });

function currentLimits(value: HelperLimits): HelperLimits {
  return { totalCalls: value.totalCalls, helperCalls: value.helperCalls };
}

function conversationData(row: Row): HelperConversation {
  return {
    id: row.id,
    scope: JSON.parse(row.scope),
    title: row.title,
    revision: row.revision,
    historyRevision: Number(row.history_revision ?? 0),
    persona: row.persona,
    limits: currentLimits(JSON.parse(row.limits)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Keep the existing call identity so older durable receipts can be matched to their events. */
export function helperCallOperationId(taskId: string, callId: string): string {
  return createHash('sha256').update(`${taskId}\0${callId}`).digest('hex');
}

function taskData(row: Row, completedEffects = 0): Omit<HelperTask, 'snapshot'> {
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
    ...(completedEffects
      ? { completedEffects: { count: completedEffects, labels: ['완료된 도우미 작업'] } }
      : {}),
  };
}

export function initHelperWorkspace(store: Store) {
  store.db.exec(`
    CREATE TABLE helper_conversations(id TEXT PRIMARY KEY,scope_key TEXT NOT NULL,creation_key TEXT NOT NULL,creation_hash TEXT NOT NULL,chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE,scope TEXT NOT NULL,title TEXT NOT NULL,auto_title INTEGER NOT NULL,revision INTEGER NOT NULL,persona TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,limits TEXT NOT NULL DEFAULT '{"totalCalls":24,"helperCalls":12,"artifacts":1}',UNIQUE(scope_key,creation_key));
    CREATE INDEX helper_conversations_scope ON helper_conversations(chat_id,updated_at);
    CREATE TABLE helper_tasks(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES helper_conversations(id) ON DELETE CASCADE,request_key TEXT NOT NULL,request TEXT NOT NULL,status TEXT NOT NULL,generation INTEGER NOT NULL DEFAULT 0,owner TEXT,snapshot TEXT NOT NULL,error TEXT,usage TEXT NOT NULL,created_at TEXT NOT NULL,started_at TEXT,updated_at TEXT NOT NULL,UNIQUE(conversation_id,request_key));
    CREATE UNIQUE INDEX helper_one_active_task ON helper_tasks(conversation_id) WHERE status='running';
    CREATE TABLE helper_messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES helper_conversations(id) ON DELETE CASCADE,task_id TEXT NOT NULL REFERENCES helper_tasks(id) ON DELETE CASCADE,role TEXT NOT NULL,text TEXT NOT NULL,artifacts TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(task_id,role));
    CREATE TABLE helper_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,conversation_id TEXT NOT NULL REFERENCES helper_conversations(id) ON DELETE CASCADE,task_id TEXT REFERENCES helper_tasks(id) ON DELETE CASCADE,kind TEXT NOT NULL,data TEXT NOT NULL);
    CREATE INDEX helper_events_cursor ON helper_events(conversation_id,seq);
    CREATE TABLE helper_operations(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES helper_tasks(id) ON DELETE CASCADE,request_hash TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE helper_artifact_jobs(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES helper_tasks(id) ON DELETE CASCADE,operation_id TEXT NOT NULL UNIQUE,snapshot TEXT NOT NULL,status TEXT NOT NULL,artifact_id TEXT,artifact_revision INTEGER,error TEXT,created_at TEXT NOT NULL);
    CREATE TABLE helper_task_attempts(task_id TEXT NOT NULL REFERENCES helper_tasks(id) ON DELETE CASCADE,attempt_id TEXT PRIMARY KEY REFERENCES attempts(id) ON DELETE CASCADE,purpose TEXT NOT NULL,segment INTEGER NOT NULL,artifact_job_id TEXT REFERENCES helper_artifact_jobs(id) ON DELETE CASCADE);
    CREATE TABLE helper_artifacts(id TEXT NOT NULL,revision INTEGER NOT NULL,conversation_id TEXT NOT NULL REFERENCES helper_conversations(id) ON DELETE CASCADE,task_id TEXT NOT NULL REFERENCES helper_tasks(id) ON DELETE CASCADE,request TEXT NOT NULL,text TEXT NOT NULL,usage TEXT NOT NULL,created_at TEXT NOT NULL,origin TEXT NOT NULL,PRIMARY KEY(id,revision));
  `);
}

export class HelperWorkspace {
  constructor(readonly store: Store) {}
  conversation(id: string): HelperConversation {
    const row = this.store.db
      .prepare(`SELECT c.*,
      (SELECT COALESCE(MAX(seq),0) FROM helper_events WHERE conversation_id=c.id AND kind='messages.changed') AS history_revision
      FROM helper_conversations c WHERE id=?`)
      .get(id) as Row | undefined;
    if (!row) throw new HttpError(404, '도우미 대화를 찾을 수 없어요.');
    return conversationData(row);
  }
  open(scope: HelperScope): HelperConversation {
    return this.create(scope, 'default');
  }
  create(scope: HelperScope, creationKey: string, title?: string): HelperConversation {
    return this.store.transaction(() => {
      if (scope.kind === 'chat') this.store.chat(scope.chatId);
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
          'INSERT INTO helper_conversations(id,scope_key,creation_key,creation_hash,chat_id,scope,title,auto_title,revision,persona,created_at,updated_at,limits) VALUES(?,?,?,?,?,?,?,?,1,?,?,?,?)'
        )
        .run(
          id,
          key,
          creationKey,
          creationHash,
          scope.kind === 'chat' ? scope.chatId : null,
          key,
          title ?? '새 도우미 대화',
          Number(title === undefined),
          UI_HELPER_PERSONA,
          time,
          time,
          json(HELPER_TASK_LIMITS)
        );
      return this.conversation(id);
    });
  }
  groups(): HelperProject[] {
    return this.store.db
      .prepare('SELECT id,title,revision FROM helper_conversation_groups ORDER BY rowid')
      .all() as HelperProject[];
  }
  private group(id: string): HelperProject {
    const row = this.store.db
      .prepare('SELECT id,title,revision FROM helper_conversation_groups WHERE id=?')
      .get(id) as HelperProject | undefined;
    if (!row) throw new HttpError(404, '도우미 프로젝트를 찾을 수 없어요.');
    return row;
  }
  createGroup(title: string, key: string): HelperProject {
    return this.store.transaction(() => {
      const previous = this.store.db
        .prepare('SELECT id,creation_title FROM helper_conversation_groups WHERE creation_key=?')
        .get(key);
      if (previous) {
        if (previous.creation_title !== title)
          throw new HttpError(409, '프로젝트 생성 요청이 이전 요청과 충돌했어요.');
        return this.group(String(previous.id));
      }
      const id = randomUUID();
      this.store.db
        .prepare('INSERT INTO helper_conversation_groups VALUES(?,?,1,?,?)')
        .run(id, title, key, title);
      return this.group(id);
    });
  }
  renameGroup(id: string, revision: number, title: string): HelperProject {
    this.group(id);
    const result = this.store.db
      .prepare(
        'UPDATE helper_conversation_groups SET title=?,revision=revision+1 WHERE id=? AND revision=?'
      )
      .run(title, id, revision);
    if (!result.changes) throw new HttpError(409, '도우미 프로젝트가 다른 곳에서 변경됐어요.');
    return this.group(id);
  }
  deleteGroup(id: string, revision: number) {
    return this.store.transaction(() => {
      const group = this.group(id);
      if (group.revision !== revision)
        throw new HttpError(409, '도우미 프로젝트가 다른 곳에서 변경됐어요.');
      const members = this.store.db
        .prepare('SELECT conversation_id FROM helper_conversation_memberships WHERE group_id=?')
        .all(id);
      this.store.db.prepare('DELETE FROM helper_conversation_groups WHERE id=?').run(id);
      for (const member of members) this.groupChanged(String(member.conversation_id));
      return { deleted: true as const };
    });
  }
  private groupChanged(id: string) {
    this.store.db
      .prepare('UPDATE helper_conversations SET revision=revision+1,updated_at=? WHERE id=?')
      .run(now(), id);
    this.event(id, null, 'conversation.updated');
  }
  moveGroup(id: string, revision: number, groupId: string | null): HelperConversation {
    return this.store.transaction(() => {
      const conversation = this.conversation(id);
      if (conversation.revision !== revision)
        throw new HttpError(409, '도우미 대화가 다른 곳에서 변경됐어요.');
      if (groupId !== null) this.group(groupId);
      const existing = this.store.db
        .prepare('SELECT group_id FROM helper_conversation_memberships WHERE conversation_id=?')
        .get(id);
      if ((existing?.group_id ?? null) === groupId) return conversation;
      if (groupId === null)
        this.store.db
          .prepare('DELETE FROM helper_conversation_memberships WHERE conversation_id=?')
          .run(id);
      else
        this.store.db
          .prepare(
            'INSERT INTO helper_conversation_memberships VALUES(?,?) ON CONFLICT(conversation_id) DO UPDATE SET group_id=excluded.group_id'
          )
          .run(id, groupId);
      this.groupChanged(id);
      return this.conversation(id);
    });
  }
  copy(id: string, requestKey: string, expected: HelperConversationDeletion['request']) {
    return this.store.transaction(() => {
      const source = this.conversation(id);
      const scopeKey = json(source.scope);
      const creationKey = `copy:${id}:${requestKey}`;
      const hash = createHash('sha256').update(json({ id, expected })).digest('hex');
      const old = this.store.db
        .prepare(
          'SELECT id,creation_hash FROM helper_conversations WHERE scope_key=? AND creation_key=?'
        )
        .get(scopeKey, creationKey);
      if (old) {
        if (old.creation_hash !== hash)
          throw new HttpError(409, '대화 복사 요청이 이전 요청과 충돌했어요.');
        return this.conversation(String(old.id));
      }
      const impact = this.deletionImpact(id);
      if (
        impact.request.expectedRevision !== expected.expectedRevision ||
        impact.request.expectedEventSequence !== expected.expectedEventSequence
      )
        throw new HttpError(
          409,
          '도우미 대화가 변경됐어요. 최신 내용을 확인한 뒤 다시 복사해 주세요.'
        );
      if (!impact.canDelete) throw new HttpError(409, '진행 중인 작업이 끝난 뒤 복사해 주세요.');
      const pages: HelperMessage[][] = [];
      let before: string | undefined;
      do {
        const page = this.messages(id, before);
        pages.unshift(page);
        before = page.length === 100 ? page[0].id : undefined;
      } while (before);
      const newId = randomUUID(),
        time = now();
      this.store.db
        .prepare(`INSERT INTO helper_conversations(id,scope_key,creation_key,creation_hash,chat_id,scope,title,auto_title,revision,persona,created_at,updated_at,limits)
        VALUES(?,?,?,?,?,?,?,0,1,?,?,?,?)`)
        .run(
          newId,
          scopeKey,
          creationKey,
          hash,
          source.scope.kind === 'chat' ? source.scope.chatId : null,
          scopeKey,
          source.title,
          source.persona,
          time,
          time,
          json(source.limits)
        );
      this.store.db
        .prepare(
          'INSERT INTO helper_conversation_memberships SELECT ?,group_id FROM helper_conversation_memberships WHERE conversation_id=?'
        )
        .run(newId, id);
      const add = this.store.db.prepare('INSERT INTO helper_seed_messages VALUES(?,?,?,?,?,?)');
      const visible = pages
        .flat()
        .filter((message) => !message.latestTaskId || message.latestTaskId === message.taskId)
        .sort((a, b) =>
          a.requestOrder === undefined || b.requestOrder === undefined
            ? 0
            : a.requestOrder - b.requestOrder ||
              (a.role === b.role ? 0 : a.role === 'user' ? -1 : 1)
        );
      visible.forEach((message, ordinal) => {
        add.run(randomUUID(), newId, ordinal, message.role, message.text, message.createdAt);
      });
      return this.conversation(newId);
    });
  }
  list(
    scope: { kind: 'chat'; chatId: string } | { kind: 'library' | 'all' }
  ): HelperConversationSummary[] {
    if (scope.kind === 'chat') {
      this.store.chat(scope.chatId);
    }
    const rows = this.store.db
      .prepare(
        `SELECT c.*,chat.title AS chat_title, member.group_id,
          (SELECT json_object('running',COALESCE(SUM(status='running'),0),
            'queued',COALESCE(SUM(status='queued'),0)) FROM helper_tasks WHERE conversation_id=c.id) AS activity,
          (SELECT COALESCE(MAX(seq),0) FROM helper_events WHERE conversation_id=c.id) AS latest_seq,
          (SELECT COALESCE(MAX(seq),0) FROM helper_events WHERE conversation_id=c.id AND kind='messages.changed') AS history_revision
        FROM helper_conversations c LEFT JOIN chats chat ON chat.id=c.chat_id
        LEFT JOIN helper_conversation_memberships member ON member.conversation_id=c.id
        WHERE ${scope.kind === 'all' ? '1' : scope.kind === 'library' ? 'c.chat_id IS NULL' : 'c.chat_id=?'}
        ORDER BY c.updated_at DESC,c.rowid DESC`
      )
      .all(...(scope.kind === 'chat' ? [scope.chatId] : []));
    return rows.map((row) => ({
      ...conversationData(row),
      projectId: row.group_id === null ? null : String(row.group_id),
      ...(scope.kind === 'all' && typeof row.chat_title === 'string'
        ? { chatTitle: row.chat_title }
        : {}),
      activity: JSON.parse(String(row.activity)),
      latestEventSeq: Number(row.latest_seq),
    }));
  }
  persona(id: string, revision: number, persona: string) {
    return this.update(id, revision, { persona });
  }
  update(
    id: string,
    revision: number,
    changes: Partial<Pick<HelperConversation, 'title' | 'persona'>>
  ) {
    const previous = this.conversation(id);
    const changed = this.store.db
      .prepare(
        'UPDATE helper_conversations SET title=?,auto_title=CASE WHEN ? THEN 0 ELSE auto_title END,persona=?,updated_at=?,revision=revision+1 WHERE id=? AND revision=?'
      )
      .run(
        changes.title ?? previous.title,
        Number(changes.title !== undefined),
        changes.persona ?? previous.persona,
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
        '이 도우미 대화의 메시지, 작업, 가정 장면, 개인 요약을 삭제해요. 이미 저장한 본편, 공통 자료와 다음 요청 옵션은 유지돼요. 사용량 숫자는 내용 없이 유지해요. 진행 중인 작업은 먼저 중지해 주세요.',
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
          '진행 중인 작업을 중지하고 프로바이더 요청이 종료된 뒤 삭제해 주세요.'
        );
      const tasks = this.store.db
        .prepare('SELECT id FROM helper_tasks WHERE conversation_id=?')
        .all(id);
      for (const scopeKey of [`helper:${id}`, ...tasks.map((task) => `artifact:${task.id}`)])
        for (const table of ['context_heads', 'context_checkpoints'])
          this.store.db.prepare(`DELETE FROM ${table} WHERE scope_key=?`).run(scopeKey);
      const attemptIds = this.store.db
        .prepare(
          'SELECT x.attempt_id FROM helper_task_attempts x JOIN helper_tasks t ON t.id=x.task_id WHERE t.conversation_id=?'
        )
        .all(id)
        .map((row) => String(row.attempt_id));
      detachAttemptUsage(this.store.db, attemptIds);
      this.store.db.prepare('DELETE FROM helper_conversations WHERE id=?').run(id);
      return { deleted: true as const };
    });
  }
  private transcriptEntries(id: string) {
    return this.store.db
      .prepare(`
      SELECT m.id,COALESCE(json_extract(t.snapshot,'$.requestGroupId'),t.id) AS group_id,
        1 AS phase,root.rowid AS position,COALESCE(c.deleted,0) AS deleted
      FROM helper_messages m JOIN helper_tasks t ON t.id=m.task_id
      JOIN helper_tasks root ON root.id=COALESCE(json_extract(t.snapshot,'$.requestGroupId'),t.id)
      LEFT JOIN helper_message_changes c ON c.message_id=m.id
      WHERE m.conversation_id=?
      UNION ALL
      SELECT s.id,'seed:' || COALESCE((SELECT u.id FROM helper_seed_messages u
        WHERE u.conversation_id=s.conversation_id AND u.role='user' AND u.ordinal<=s.ordinal
        ORDER BY u.ordinal DESC LIMIT 1),s.id) AS group_id,
        0 AS phase,COALESCE((SELECT MAX(u.ordinal) FROM helper_seed_messages u
          WHERE u.conversation_id=s.conversation_id AND u.role='user' AND u.ordinal<=s.ordinal),s.ordinal) AS position,
        COALESCE(c.deleted,0) AS deleted
      FROM helper_seed_messages s LEFT JOIN helper_message_changes c ON c.message_id=s.id
      WHERE s.conversation_id=?`)
      .all(id, id) as (Row & {
      id: string;
      group_id: string;
      phase: number;
      position: number;
      deleted: number;
    })[];
  }
  private changeMessages(
    id: string,
    messageId: string,
    expectedRevision: number,
    change: { text: string } | { scope: 'pair' | 'following' }
  ): HelperMessageMutation {
    return this.store.transaction(() => {
      const conversation = this.conversation(id);
      if (conversation.revision !== expectedRevision)
        throw new HttpError(
          409,
          '도우미 대화가 변경됐어요. 최신 내용을 확인한 뒤 다시 시도해 주세요.'
        );
      if (!this.deletionImpact(id).canDelete)
        throw new HttpError(
          409,
          '진행 중인 작업을 중지하고 프로바이더 요청이 종료된 뒤 수정해 주세요.'
        );
      const entries = this.transcriptEntries(id);
      const selected = entries.find((entry) => entry.id === messageId && !entry.deleted);
      if (!selected) throw new HttpError(404, '도우미 메시지를 찾을 수 없어요.');
      let projection: Omit<HelperMessageMutation, 'conversation'>;
      if ('text' in change) {
        this.store.db
          .prepare(`INSERT INTO helper_message_changes(message_id,conversation_id,text)
          VALUES(?,?,?) ON CONFLICT(message_id) DO UPDATE SET text=excluded.text`)
          .run(messageId, id, change.text);
        projection = { updatedMessage: { id: messageId, text: change.text } };
      } else {
        const deletedMessageIds = entries
          .filter(
            (entry) =>
              !entry.deleted &&
              (change.scope === 'pair'
                ? entry.group_id === selected.group_id
                : entry.phase > selected.phase ||
                  (entry.phase === selected.phase && entry.position >= selected.position))
          )
          .map((entry) => entry.id);
        const mark =
          this.store.db.prepare(`INSERT INTO helper_message_changes(message_id,conversation_id,deleted)
          VALUES(?,?,1) ON CONFLICT(message_id) DO UPDATE SET deleted=1`);
        for (const messageId of deletedMessageIds) mark.run(messageId, id);
        projection = { deletedMessageIds };
      }
      // A checkpoint may contain edited/deleted text, including in its recent exact tail.
      // Retain the immutable checkpoint as evidence and detach its active pointer.
      this.store.db
        .prepare(
          'UPDATE context_heads SET revision=revision+1,checkpoint_id=NULL WHERE scope_key=?'
        )
        .run(`helper:${id}`);
      this.store.db
        .prepare('UPDATE helper_conversations SET revision=revision+1,updated_at=? WHERE id=?')
        .run(now(), id);
      this.event(id, null, 'messages.changed', {
        revision: conversation.revision + 1,
        ...projection,
      });
      return { conversation: this.conversation(id), ...projection };
    });
  }
  editMessage(id: string, messageId: string, expectedRevision: number, text: string) {
    return this.changeMessages(id, messageId, expectedRevision, { text });
  }
  deleteMessages(
    id: string,
    messageId: string,
    expectedRevision: number,
    scope: 'pair' | 'following'
  ) {
    return this.changeMessages(id, messageId, expectedRevision, { scope });
  }
  assertRetryVisible(taskId: string) {
    const hidden = this.store.db
      .prepare(`SELECT 1 FROM helper_tasks t
      JOIN helper_tasks member ON member.conversation_id=t.conversation_id
        AND COALESCE(json_extract(member.snapshot,'$.requestGroupId'),member.id)=COALESCE(json_extract(t.snapshot,'$.requestGroupId'),t.id)
      JOIN helper_messages m ON m.task_id=member.id
      JOIN helper_message_changes c ON c.message_id=m.id AND c.deleted=1
      WHERE t.id=? LIMIT 1`)
      .get(taskId);
    if (hidden) throw new HttpError(409, '삭제한 도우미 요청은 재시도할 수 없어요.');
  }
  messages(id: string, before?: string): HelperMessage[] {
    this.conversation(id);
    const seedCursor = before
      ? (this.store.db
          .prepare('SELECT ordinal FROM helper_seed_messages WHERE conversation_id=? AND id=?')
          .get(id, before) as { ordinal: number } | undefined)
      : undefined;
    const rows = seedCursor
      ? []
      : (this.store.db
          .prepare(
            `SELECT m.*,COALESCE(c.text,CASE WHEN m.role='user' THEN t.request ELSE m.text END) AS display_text, t.status AS task_status, COALESCE(json_extract(t.snapshot,'$.requestGroupId'), t.id) AS request_group_id, root.rowid AS request_order,
        (SELECT latest.id FROM helper_tasks latest WHERE latest.conversation_id=m.conversation_id AND COALESCE(json_extract(latest.snapshot,'$.requestGroupId'),latest.id)=root.id ORDER BY latest.rowid DESC LIMIT 1) AS latest_task_id
        FROM helper_messages m JOIN helper_tasks t ON t.id=m.task_id JOIN helper_tasks root ON root.id=COALESCE(json_extract(t.snapshot,'$.requestGroupId'), t.id)
        LEFT JOIN helper_message_changes c ON c.message_id=m.id
        WHERE m.conversation_id=? AND COALESCE(c.deleted,0)=0 ${before ? 'AND m.rowid < (SELECT rowid FROM helper_messages WHERE id=? AND conversation_id=m.conversation_id)' : ''} ORDER BY m.rowid DESC LIMIT 100`
          )
          .all(...(before ? [id, before] : [id])) as Row[]);
    const remaining = 100 - rows.length;
    const seeds = remaining
      ? (this.store.db
          .prepare(`SELECT s.*,COALESCE(c.text,s.text) AS display_text FROM helper_seed_messages s
      LEFT JOIN helper_message_changes c ON c.message_id=s.id
      WHERE s.conversation_id=? AND COALESCE(c.deleted,0)=0 AND ordinal<? ORDER BY ordinal DESC LIMIT ?`)
          .all(id, seedCursor?.ordinal ?? Number.MAX_SAFE_INTEGER, remaining) as Row[])
      : [];
    return [
      ...seeds.reverse().map((row) => ({
        requestGroupId: `seed:${row.id}`,
        latestTaskId: `seed:${row.id}`,
        requestOrder: -1000000000 + row.ordinal,
        id: row.id,
        conversationId: id,
        taskId: `seed:${row.id}`,
        taskStatus: 'completed' as const,
        role: row.role as 'user' | 'assistant',
        text: row.display_text,
        artifacts: [],
        createdAt: row.created_at,
      })),
      ...rows.reverse().map((row) => ({
        requestGroupId: row.request_group_id,
        latestTaskId: row.latest_task_id,
        requestOrder: row.request_order,
        id: row.id,
        conversationId: id,
        taskId: row.task_id,
        taskStatus: row.task_status,
        role: row.role,
        text: row.display_text,
        artifacts: JSON.parse(row.artifacts),
        createdAt: row.created_at,
      })),
    ];
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
  latestEventSequence(id: string): number {
    return Number(
      this.store.db
        .prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM helper_events WHERE conversation_id=?')
        .get(id)!.seq
    );
  }
  events(id: string, after = 0, view: 'full' | 'updates' = 'full'): HelperEvent[] {
    this.conversation(id);
    return (
      this.store.db
        .prepare(
          `SELECT seq,conversation_id,task_id,kind,${view === 'updates' ? "CASE WHEN kind='messages.changed' THEN data ELSE NULL END" : 'data'} AS data FROM helper_events WHERE conversation_id=? AND seq>? ORDER BY seq LIMIT 500`
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
    // Read receipts, never streamed tool output: the worker may stop before tool.finished.
    const completedEffects = ['failed', 'cancelled', 'interrupted'].includes(row.status)
      ? Number(
          this.store.db
            .prepare('SELECT count(*) AS n FROM helper_operations WHERE task_id=?')
            .get(id)?.n ?? 0
        )
      : 0;
    const snapshot = JSON.parse(row.snapshot) as HelperTaskSnapshot;
    if (snapshot.limits) snapshot.limits = currentLimits(snapshot.limits);
    return {
      ...taskData(row, completedEffects),
      snapshot,
      instructions: this.instructions(id),
    };
  }
  /** Live execution counters and identity never need to hydrate the reserved manuscript. */
  taskState(
    id: string
  ): Pick<HelperTask, 'id' | 'conversationId' | 'status' | 'generation' | 'usage'> {
    const row = this.store.db
      .prepare('SELECT id,conversation_id,status,generation,usage FROM helper_tasks WHERE id=?')
      .get(id) as Row | undefined;
    if (!row) throw new HttpError(404, '도우미 작업을 찾을 수 없어요.');
    return {
      id: row.id,
      conversationId: row.conversation_id,
      status: row.status,
      generation: row.generation,
      usage: JSON.parse(row.usage),
    };
  }
  private readTaskSummaries(predicate: string, args: string[]) {
    // Only the selected page crosses into JS. Receipt counts share one scan instead of
    // loading a full reservation and querying completed effects for every task.
    const rows = this.store.db
      .prepare(
        `WITH page AS (
          SELECT t.rowid AS task_order,t.id,t.conversation_id,t.request,t.status,t.generation,
            t.error,t.usage,t.created_at,t.started_at,t.updated_at,
            json_extract(t.snapshot,'$.model.title') AS model_title
          FROM helper_tasks t WHERE ${predicate} ORDER BY t.rowid DESC LIMIT 50
        ), effects AS (
          SELECT task_id,COUNT(*) AS count FROM helper_operations
          WHERE task_id IN (SELECT id FROM page WHERE status IN ('failed','cancelled','interrupted'))
          GROUP BY task_id
        )
        SELECT page.*,COALESCE(effects.count,0) AS completed_effects
        FROM page LEFT JOIN effects ON effects.task_id=page.id ORDER BY page.task_order DESC`
      )
      .all(...args) as Row[];
    const instructions = this.readInstructions(rows.map((row) => String(row.id)));
    return rows.map((row) => ({
      ...taskData(row, Number(row.completed_effects)),
      modelTitle: row.model_title as string,
      instructions: instructions.get(String(row.id)) ?? [],
    }));
  }
  private readInstructions(taskIds: string[]) {
    const result = new Map<string, HelperInstruction[]>();
    if (!taskIds.length) return result;
    const rows = this.store.db
      .prepare(`SELECT e.seq,e.task_id,e.data,t.status
      FROM helper_events e JOIN helper_tasks t ON t.id=e.task_id
      WHERE e.kind='task.instruction' AND e.task_id IN (${taskIds.map(() => '?').join(',')})
      ORDER BY e.seq`)
      .all(...taskIds);
    for (const row of rows) {
      const instruction = {
        ...JSON.parse(String(row.data)),
        id: Number(row.seq),
      } as HelperInstruction;
      if (instruction.status === 'pending' && row.status !== 'running')
        instruction.status = 'not-delivered';
      const list = result.get(String(row.task_id)) ?? [];
      list.push(instruction);
      result.set(String(row.task_id), list);
    }
    return result;
  }
  instructions(taskId: string): HelperInstruction[] {
    return this.readInstructions([taskId]).get(taskId) ?? [];
  }
  /** Existing events hold the delivery receipt; the conversation keeps confirmed user input. */
  addInstruction(taskId: string, requestKey: string, text: string): HelperInstruction {
    return this.store.transaction(() => {
      const previous = this.instructions(taskId).find((item) => item.requestKey === requestKey);
      if (previous) {
        if (previous.text !== text)
          throw new HttpError(409, '같은 요청 키로 내용을 바꿀 수 없어요.');
        return previous;
      }
      this.assertRunning(taskId);
      const task = this.taskState(taskId);
      this.event(task.conversationId, taskId, 'task.instruction', {
        requestKey,
        text,
        status: 'pending',
      });
      return this.instructions(taskId).at(-1)!;
    });
  }
  instructionStatus(taskId: string, instructionId: number, status: HelperInstruction['status']) {
    return this.store.transaction(() => {
      const instruction = this.instructions(taskId).find((item) => item.id === instructionId);
      if (!instruction || instruction.status === 'delivered') return;
      const { id: _id, ...data } = instruction;
      this.store.db
        .prepare('UPDATE helper_events SET data=? WHERE seq=? AND task_id=?')
        .run(json({ ...data, status }), instructionId, taskId);
      if (status === 'delivered')
        this.store.db
          .prepare("UPDATE helper_messages SET text=text || ? WHERE task_id=? AND role='user'")
          .run(`\n\n추가 사용자 지시:\n${instruction.text}`, taskId);
      this.event(this.taskState(taskId).conversationId, taskId, 'task.instruction-updated', {
        instructionId,
        status,
      });
    });
  }
  taskSummary(id: string) {
    const task = this.readTaskSummaries('t.id=?', [id])[0];
    if (!task) throw new HttpError(404, '도우미 작업을 찾을 수 없어요.');
    return task;
  }
  taskSummaries(id: string, before?: string) {
    this.conversation(id);
    return this.readTaskSummaries(
      `t.conversation_id=? ${before ? 'AND t.rowid < (SELECT rowid FROM helper_tasks WHERE id=? AND conversation_id=?)' : ''}`,
      before ? [id, before, id] : [id]
    );
  }
  existing(conversationId: string, key: string, request: string, retryOf?: string) {
    const row = this.store.db
      .prepare('SELECT id,request FROM helper_tasks WHERE conversation_id=? AND request_key=?')
      .get(conversationId, key) as Row | undefined;
    const task = row ? this.task(row.id) : undefined;
    if (task && (task.request !== request || task.snapshot.retryOf !== retryOf))
      throw new HttpError(409, '같은 요청 키로 다른 작업을 보낼 수 없어요.');
    return task;
  }
  enqueue(conversationId: string, key: string, request: string, snapshot: HelperTaskSnapshot) {
    return this.store.transaction(() => {
      const prior = this.existing(conversationId, key, request, snapshot.retryOf);
      if (prior) return prior;
      if (snapshot.retryOf) {
        this.assertRetryVisible(snapshot.retryOf);
        const previous = this.task(snapshot.retryOf);
        if (previous.conversationId !== conversationId)
          throw new HttpError(403, '다른 대화의 요청은 재시도할 수 없어요.');
        if (previous.snapshot.invalidatedBySceneDeletion)
          throw new HttpError(409, 'SCENE_DELETED_RETRY_UNAVAILABLE');
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
        // Retry replaces this task in helperHistory. A checkpoint depends on both
        // summarized and exact retained messages, including its current request.
        // Invalidate its active pointer atomically; retention owns the checkpoint.
        this.store.db
          .prepare(
            `UPDATE context_heads SET revision=revision+1,checkpoint_id=NULL
             WHERE scope_key=? AND EXISTS (
               SELECT 1 FROM context_checkpoints c
               JOIN helper_messages m ON m.task_id=?
               WHERE c.id=context_heads.checkpoint_id AND (
                 EXISTS (SELECT 1 FROM json_each(c.plan,'$.compacted') source
                         WHERE json_extract(source.value,'$.revision')=m.id)
                 OR EXISTS (SELECT 1 FROM json_each(c.plan,'$.recentSourceRevisions') source
                            WHERE source.value=m.id)
               )
             )`
          )
          .run(`helper:${conversationId}`, previous.id);
      }
      const id = randomUUID(),
        time = now();
      const titled = this.store.db
        .prepare(
          'UPDATE helper_conversations SET title=?,auto_title=0,revision=revision+1,updated_at=? WHERE id=? AND auto_title=1 AND NOT EXISTS (SELECT 1 FROM helper_tasks WHERE conversation_id=?)'
        )
        .run(
          Array.from(request.trim().replace(/\s+/gu, ' ')).slice(0, 80).join(''),
          time,
          conversationId,
          conversationId
        );
      if (titled.changes) this.event(conversationId, null, 'conversation.updated');
      else
        this.store.db
          .prepare('UPDATE helper_conversations SET revision=revision+1,updated_at=? WHERE id=?')
          .run(time, conversationId);
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
      // The current call receives selection separately; later turns retain it as conversation
      // text after completed-task snapshots are released. Editing still uses the exact request.
      const message = snapshot.selection
        ? `${request}\n\n선택한 원문 ${snapshot.selection.sourceId} (SHA-256: ${snapshot.selection.sourceHash}):\n${snapshot.selection.text}`
        : request;
      this.store.db
        .prepare('INSERT INTO helper_messages VALUES(?,?,?,?,?,?,?)')
        .run(randomUUID(), conversationId, id, 'user', message, '[]', time);
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
    const task = this.taskState(id);
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
  operation<T>(
    taskId: string,
    operationId: string,
    input: unknown,
    apply: () => SynchronousResult<T>
  ): SynchronousResult<T> {
    return this.store.transaction<T>(() => {
      const hash = createHash('sha256').update(json(input)).digest('hex');
      const prior = this.store.db
        .prepare('SELECT * FROM helper_operations WHERE id=?')
        .get(operationId) as Row | undefined;
      if (prior) {
        if (prior.task_id !== taskId || prior.request_hash !== hash)
          throw new HttpError(409, 'OPERATION_ID_CONFLICT');
        const result = JSON.parse(prior.result);
        if (result?.detailsOmitted) throw new HttpError(409, 'HELPER_TASK_NO_LONGER_ACTIVE');
        return result as SynchronousResult<T>;
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
    const result = JSON.parse(row.result);
    if (result?.detailsOmitted) throw new HttpError(409, 'HELPER_TASK_NO_LONGER_ACTIVE');
    return result as T;
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
      const task = this.store.db
        .prepare(`SELECT conversation_id,usage,
          json_extract(snapshot,'$.limits.totalCalls') AS total_calls,
          json_extract(snapshot,'$.limits.helperCalls') AS helper_calls,
          CASE WHEN json_extract(snapshot,'$.scope.kind')='chat'
            THEN json_extract(snapshot,'$.scope.chatId') END AS chat_id
          FROM helper_tasks WHERE id=?`)
        .get(taskId)!;
      const usage = JSON.parse(String(task.usage)) as Usage;
      if (usage.modelCalls >= Number(task.total_calls))
        throw new HttpError(409, 'MODEL_CALL_BUDGET_EXHAUSTED');
      if (
        purpose === 'helper' &&
        Number(
          this.store.db
            .prepare(
              "SELECT COUNT(*) AS n FROM helper_task_attempts WHERE task_id=? AND purpose='helper'"
            )
            .get(taskId)?.n
        ) >= Number(task.helper_calls)
      )
        throw new HttpError(409, 'HELPER_CALL_BUDGET_EXHAUSTED');
      const id = this.store.product.startAttempt(
        task.chat_id === null ? null : String(task.chat_id),
        null,
        null,
        wire,
        { kind: helperUsageKind(purpose, wire) }
      );
      this.store.db
        .prepare(
          'INSERT INTO helper_task_attempts(task_id,attempt_id,purpose,segment) VALUES(?,?,?,?)'
        )
        .run(taskId, id, purpose, segment);
      usage.modelCalls++;
      this.store.db.prepare('UPDATE helper_tasks SET usage=? WHERE id=?').run(json(usage), taskId);
      this.event(String(task.conversation_id), taskId, 'attempt.started', { id, purpose, segment });
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
      const task = this.taskState(taskId),
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
    error: string | null
  ) {
    return this.store.transaction(() => {
      if (!this.active(id, owner, generation)) return false;
      const task = this.taskState(id);
      this.store.db
        .prepare('UPDATE helper_tasks SET status=?,error=?,updated_at=? WHERE id=?')
        .run(status, error, now(), id);
      if (text)
        this.store.db
          .prepare('INSERT INTO helper_messages VALUES(?,?,?,?,?,?,?)')
          .run(randomUUID(), task.conversationId, id, 'assistant', text, '[]', now());
      if (status === 'completed') releaseCompletedHelperInputs(this.store.db, id);
      this.event(task.conversationId, id, `task.${status}`, { error });
      return true;
    });
  }
  cancel(id: string) {
    const task = this.taskState(id);
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
      usage: JSON.parse(row.usage),
      createdAt: row.created_at,
    };
  }
}
