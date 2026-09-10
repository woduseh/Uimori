import { isDeepStrictEqual } from 'node:util';
import type { HelperTaskSnapshot } from '../core/helper.js';
import type { RunSnapshot } from '../core/types.js';
import { validateModelSnapshot } from './provider-archive.js';
import { validateRunSnapshot } from './snapshot-archive.js';
import { validateHelperContexts, helperHistory } from './helper-context.js';
import { fields, HttpError, number, record, text } from './request-validation.js';
import type { Store } from './store.js';

type Row = Record<string, any>;
const reject = (reason: string): never => {
  throw new HttpError(400, `Invalid helper archive: ${reason}`);
};
const terminal = ['completed', 'failed', 'cancelled', 'interrupted'];
function disableModel(raw: unknown) {
  if (!raw) return;
  const model = record(raw),
    connection = record(model.connection);
  for (const key of ['credentialEnv', 'secret', 'apiKey', 'accessToken']) delete connection[key];
  connection.enabled = false;
}
function disableWriting(raw: unknown) {
  if (!raw) return;
  const snapshot = record(raw);
  for (const section of [snapshot.profile, snapshot.story]) {
    if (!section) continue;
    for (const model of [
      ...Object.values(section.models ?? {}),
      ...Object.values(section.collaborationModels ?? {}),
      section.contextModel,
    ])
      disableModel(model);
  }
}
export function normalizeHelperArchiveRow(table: string, row: Row) {
  if (table === 'helper_artifact_jobs') {
    const snapshot = JSON.parse(row.snapshot);
    disableWriting(snapshot);
    row.snapshot = JSON.stringify(snapshot);
    if (row.status === 'running') {
      row.status = 'interrupted';
      row.error = 'Restored uncertain artifact job; explicit retry required';
    }
  }
  if (table === 'helper_tasks') {
    const snapshot = JSON.parse(row.snapshot);
    disableModel(snapshot.model);
    disableModel(snapshot.contextModel);
    disableWriting(snapshot.writing);
    row.snapshot = JSON.stringify(snapshot);
    row.owner = null;
    if (['queued', 'running'].includes(row.status)) {
      row.status = 'interrupted';
      row.error = 'Restored uncertain helper task; explicit retry required';
    }
  }
  if (table === 'helper_artifacts') {
    const snapshot = JSON.parse(row.snapshot);
    disableWriting(snapshot);
    row.snapshot = JSON.stringify(snapshot);
  }
  if (table === 'context_jobs' || table === 'context_checkpoints') {
    const snapshot = JSON.parse(row.snapshot);
    if (snapshot.kind !== 'helper') {
      disableWriting(snapshot);
      row.snapshot = JSON.stringify(snapshot);
    }
  }
}
export function validateHelperArchive(
  store: Store,
  validateStorySnapshot: (snapshot: RunSnapshot) => void
) {
  const conversations = new Map(
    (store.db.prepare('SELECT * FROM helper_conversations').all() as Row[]).map((row) => [
      row.id,
      row,
    ])
  );
  for (const row of conversations.values()) {
    const scope = record(JSON.parse(row.scope));
    if (row.scope_key !== JSON.stringify(scope)) reject('conversation identity');
    number(row.revision, 'helper revision');
    text(row.persona, 'persona', 2000, true);
    const limits = record(JSON.parse(row.limits));
    fields(limits, ['totalCalls', 'helperCalls', 'artifacts']);
    number(limits.totalCalls, 'total call limit', 2, 100);
    number(limits.helperCalls, 'helper call limit', 1, Number(limits.totalCalls));
    number(limits.artifacts, 'artifact jobs', 1, 10);
    if (scope.kind === 'chat') {
      fields(scope, ['kind', 'chatId', 'branchId']);
      store.product.branch(scope.chatId, scope.branchId);
      if (scope.chatId !== row.chat_id || scope.branchId !== row.branch_id) reject('chat scope');
    } else {
      fields(scope, ['kind', 'workId']);
      if (scope.kind !== 'library' || row.chat_id !== null || row.branch_id !== null)
        reject('library scope');
      text(scope.workId, 'library work ID', 100);
    }
  }
  const tasks = new Map(
    (store.db.prepare('SELECT * FROM helper_tasks').all() as Row[]).map((row) => [row.id, row])
  );
  for (const row of tasks.values()) {
    const conversation = conversations.get(row.conversation_id),
      snapshot = JSON.parse(row.snapshot) as HelperTaskSnapshot;
    if (
      !conversation ||
      !terminal.includes(row.status) ||
      !isDeepStrictEqual(snapshot.scope, JSON.parse(conversation.scope))
    )
      reject('task owner');
    number(row.generation, 'generation', 0);
    text(row.request_key, 'request key', 100);
    text(row.request, 'request', 100_000);
    validateModelSnapshot(snapshot.model);
    if (snapshot.contextModel) validateModelSnapshot(snapshot.contextModel);
    fields(snapshot.limits, ['totalCalls', 'helperCalls', 'artifacts']);
    number(snapshot.limits.totalCalls, 'call limit', 1, 100);
    number(snapshot.limits.helperCalls, 'helper call limit', 1, snapshot.limits.totalCalls);
    number(snapshot.limits.artifacts, 'artifact limit', 1, 20);
    const own = store.db
      .prepare("SELECT * FROM helper_messages WHERE task_id=? AND role='user'")
      .get(row.id) as Row | undefined;
    if (!own || own.text !== row.request || own.conversation_id !== row.conversation_id)
      reject('user request provenance');
    const all = helperHistory(store, row.conversation_id),
      prefix = all.slice(
        0,
        all.findIndex((message) => message.id === own!.id)
      );
    // A queued snapshot may predate the previous task's completion; it is never replayed after restore.
    if (
      snapshot.history.some((message) => !prefix.some((item) => isDeepStrictEqual(item, message)))
    )
      reject('task history outside scope');
    if (snapshot.context?.checkpoint) {
      const cp = store.context.checkpoint(snapshot.context.checkpoint);
      if (
        cp.scopeKey !== `helper:${row.conversation_id}` ||
        cp.revision !== snapshot.context.activeRevision
      )
        reject('task checkpoint owner');
    }
    if (snapshot.writing) {
      validateStorySnapshot(snapshot.writing);
      if (
        snapshot.scope.kind !== 'chat' ||
        snapshot.writing.chatId !== snapshot.scope.chatId ||
        snapshot.writing.branchId !== snapshot.scope.branchId ||
        snapshot.writing.executionPurpose !== 'artifact' ||
        !store.validateHistory(snapshot.writing.history, snapshot.writing.parentRevision)
      )
        reject('writing scope');
      for (const model of Object.values(snapshot.writing.profile?.models ?? {}))
        validateModelSnapshot(model);
    }
    if (snapshot.selection) {
      const selection = snapshot.selection;
      const source = snapshot.writing?.history.find(
        (source) => source.revision === selection.sourceId
      );
      if (
        !source ||
        store.sourceAtHash(selection.sourceId, selection.sourceHash).text !== source.text
      )
        reject('selected source provenance');
      text(selection.text, 'selected text', 100_000);
    }
    const attempts = store.db
      .prepare(
        'SELECT a.*,x.purpose,x.segment,x.artifact_job_id FROM helper_task_attempts x JOIN attempts a ON a.id=x.attempt_id WHERE x.task_id=?'
      )
      .all(row.id) as Row[];
    const usage = JSON.parse(row.usage);
    if (usage.modelCalls !== attempts.length || usage.modelCalls > snapshot.limits.totalCalls)
      reject('root call accounting');
    for (const attempt of attempts) {
      if (
        attempt.chat_id !== conversation!.chat_id ||
        attempt.run_id !== null ||
        attempt.job_id !== null ||
        attempt.story_job_id !== null ||
        !['helper', 'context', 'writing'].includes(attempt.purpose)
      )
        reject('attempt owner');
      number(attempt.segment, 'segment', 0);
      const child = attempt.artifact_job_id
        ? (store.db
            .prepare('SELECT * FROM helper_artifact_jobs WHERE id=? AND task_id=?')
            .get(attempt.artifact_job_id, row.id) as Row | undefined)
        : undefined;
      if ((attempt.purpose === 'writing') !== !!child) reject('artifact attempt owner');
      const writing = child ? (JSON.parse(child.snapshot) as RunSnapshot) : undefined;
      const models =
        attempt.purpose === 'helper'
          ? [snapshot.model]
          : attempt.purpose === 'context'
            ? [snapshot.contextModel, snapshot.writing?.profile?.contextModel]
            : [
                writing?.profile?.models.main,
                writing?.profile?.contextModel,
                ...Object.values(writing?.profile?.collaborationModels ?? {}),
              ];
      const allowedRoles: Record<string, string[]> = {
        helper: ['helper'],
        context: ['context'],
        writing: ['main', 'context'],
      };
      if (
        !models.some(
          (model) =>
            model &&
            model.modelId === attempt.model_id &&
            model.connectionId === attempt.connection_id
        ) ||
        !(allowedRoles[attempt.purpose] ?? []).includes(attempt.role)
      )
        reject('attempt model');
    }
  }
  for (const row of store.db.prepare('SELECT * FROM helper_artifact_jobs').all() as Row[]) {
    const task = tasks.get(row.task_id),
      snapshot = JSON.parse(row.snapshot) as RunSnapshot;
    validateStorySnapshot(snapshot);
    if (
      !task ||
      snapshot.executionPurpose !== 'artifact' ||
      !terminal.includes(row.status) ||
      snapshot.chatId !== conversations.get(task.conversation_id)?.chat_id ||
      !store.validateHistory(snapshot.history, snapshot.parentRevision)
    )
      reject('artifact job owner');
    for (const model of [
      ...Object.values(snapshot.profile?.models ?? {}),
      ...Object.values(snapshot.profile?.collaborationModels ?? {}),
      snapshot.profile?.contextModel,
    ])
      if (model) validateModelSnapshot(model);
    if (row.status === 'completed') {
      const artifact = store.db
        .prepare('SELECT * FROM helper_artifacts WHERE id=? AND revision=? AND task_id=?')
        .get(row.artifact_id, row.artifact_revision, row.task_id) as Row | undefined;
      if (!artifact || !isDeepStrictEqual(JSON.parse(artifact.snapshot), snapshot))
        reject('artifact job receipt');
    } else if (row.artifact_id !== null || row.artifact_revision !== null)
      reject('unfinished artifact result');
  }
  for (const row of store.db
    .prepare('SELECT * FROM helper_artifacts ORDER BY id,revision')
    .all() as Row[]) {
    const task = tasks.get(row.task_id),
      snapshot = JSON.parse(row.snapshot) as RunSnapshot;
    validateStorySnapshot(snapshot);
    if (
      !task ||
      task.conversation_id !== row.conversation_id ||
      snapshot.executionPurpose !== 'artifact' ||
      snapshot.chatId !== conversations.get(row.conversation_id)?.chat_id ||
      !['model', 'edit'].includes(row.origin) ||
      !store.validateHistory(snapshot.history, snapshot.parentRevision)
    )
      reject('artifact owner');
    number(row.revision, 'artifact revision');
    text(row.text, 'artifact text', 500_000);
    if (
      row.revision > 1 &&
      !store.db
        .prepare('SELECT 1 FROM helper_artifacts WHERE id=? AND revision=? AND conversation_id=?')
        .get(row.id, row.revision - 1, row.conversation_id)
    )
      reject('artifact revision gap');
    for (const model of Object.values(snapshot.profile?.models ?? {})) validateModelSnapshot(model);
    validateRunSnapshot(store, snapshot);
    store.context.assertSnapshot(snapshot);
  }
  for (const row of store.db.prepare('SELECT * FROM helper_messages').all() as Row[]) {
    if (
      tasks.get(row.task_id)?.conversation_id !== row.conversation_id ||
      !['user', 'assistant'].includes(row.role)
    )
      reject('message owner');
    for (const ref of JSON.parse(row.artifacts))
      if (
        !store.db
          .prepare('SELECT 1 FROM helper_artifacts WHERE id=? AND revision=? AND conversation_id=?')
          .get(ref.id, ref.revision, row.conversation_id)
      )
        reject('artifact reference');
  }
  for (const row of store.db
    .prepare('SELECT * FROM helper_events WHERE task_id IS NOT NULL')
    .all() as Row[])
    if (tasks.get(row.task_id)?.conversation_id !== row.conversation_id) reject('event owner');
  for (const row of store.db.prepare('SELECT * FROM helper_grants').all() as Row[]) {
    const grant = record(JSON.parse(row.body)),
      task = tasks.get(row.task_id);
    if (
      !task ||
      grant.id !== row.id ||
      !['direct-user-request', 'delegation'].includes(grant.provenance) ||
      !Array.isArray(grant.actions) ||
      !grant.actions.length ||
      grant.actions.some((action: unknown) => typeof action !== 'string')
    )
      reject('grant provenance');
  }
  for (const row of store.db.prepare('SELECT * FROM helper_operations').all() as Row[]) {
    if (!tasks.has(row.task_id) || !/^([0-9a-f]{64})$/u.test(row.request_hash))
      reject('operation receipt');
    JSON.parse(row.result);
  }
  validateHelperContexts(store);
}
