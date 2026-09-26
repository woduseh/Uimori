import { createHash, randomUUID } from 'node:crypto';
import { REQUEST_TEXT_MAX_CHARS } from '../core/content-limits.js';
import type { RunSnapshot } from '../core/types.js';
import { canRecoverMainJudgment } from '../core/main-judgment-recovery.js';
import { HttpError, text } from './request-validation.js';
import { forkChat } from './chat-fork.js';
import type { Store, Run } from './store.js';

/** Retries use current resources. Rewriting existing prose starts an independent chat copy. */
export function retryRun(
  store: Store,
  runId: string,
  key: string,
  options: {
    request?: string;
    title?: string;
    alwaysCopy?: boolean;
    judgmentOnly?: boolean;
    validate?: (snapshot: RunSnapshot) => void;
  } = {}
): { run: Run; created: boolean } {
  return store.transaction(() => {
    const requestKey = `retry:${runId}:${key}`;
    const command = JSON.stringify({
      runId,
      request: options.request,
      title: options.title,
      alwaysCopy: !!options.alwaysCopy,
      judgmentOnly: !!options.judgmentOnly,
    });
    const digest = createHash('sha256').update(command).digest('hex');
    const previous = store.db
      .prepare('SELECT digest,result FROM import_operations WHERE key=?')
      .get(requestKey);
    if (previous) {
      if (previous.digest !== digest)
        throw new HttpError(409, 'Idempotency key reused with a different retry');
      return { run: store.run(JSON.parse(String(previous.result)).runId), created: false };
    }
    const original = store.run(runId);
    if (['queued', 'running'].includes(original.status))
      throw new HttpError(409, 'Original run is still active');
    if (original.snapshot.packageStart?.mode === 'authored' || original.snapshot.nativeRisuAuthored)
      throw new HttpError(409, '작성된 시작문은 생성 요청이 아니에요. 새 장면을 요청해 주세요.');
    const sourceBranch = store.product.branch(original.chatId, original.snapshot.branchId);
    let run: Run;
    if (options.judgmentOnly) {
      if (!canRecoverMainJudgment(original))
        throw new HttpError(409, '보존된 본문의 판정 실패만 다시 판정할 수 있어요.');
      if (sourceBranch.headRevision !== original.parentRevision)
        throw new HttpError(409, '이야기가 이미 진행됐어요. 현재 내용에서 새 요청을 보내 주세요.');
      const id = randomUUID(),
        at = new Date().toISOString();
      const snapshot = { ...original.snapshot, judgmentRecovery: true };
      delete snapshot.candidateOf;
      store.db
        .prepare(`INSERT INTO runs(id,chat_id,parent_revision,status,request,snapshot,request_key,command,created_at,updated_at,branch_id)
        VALUES(?,?,?,'queued',?,?,?,?,?,?,?)`)
        .run(
          id,
          original.chatId,
          original.parentRevision,
          original.request,
          JSON.stringify(snapshot),
          key,
          command,
          at,
          at,
          sourceBranch.id
        );
      store.event(original.chatId, 'run.queued', id);
      run = store.run(id);
    } else {
      const copied =
        options.alwaysCopy ||
        !!original.sourceRevision ||
        sourceBranch.headRevision !== original.parentRevision;
      const chat = copied
        ? forkChat(store, original.chatId, {
            fromRevision: original.parentRevision,
            branchId: sourceBranch.id,
            title:
              options.title ?? `${store.chat(original.chatId).title} · 새 이야기`.slice(0, 200),
            idempotencyKey: createHash('sha256').update(requestKey).digest('hex'),
          })
        : store.chat(original.chatId);
      const branch = store.product.branch(chat.id);
      const profile = store.product.snapshot(chat.id);
      const request =
        options.request === undefined
          ? original.request
          : text(options.request, 'request', REQUEST_TEXT_MAX_CHARS);
      const result = store.createRunInTransaction(
        chat.id,
        {
          request,
          branchId: branch.id,
          expectedRevision: branch.headRevision,
          expectedSettingsRevision: chat.settingsRevision,
          expectedProfileRevision: profile.revision,
          idempotencyKey: key,
          ...(!copied ? { retryOf: original.id } : {}),
          ...(options.request !== undefined ? { requestEdited: true } : {}),
        },
        (current) => {
          const snapshot: RunSnapshot = {
            chatId: chat.id,
            branchId: branch.id,
            request,
            parentRevision: current.headRevision,
            settingsRevision: current.settingsRevision,
            settings: current.settings,
            history: store.history(current.headRevision),
            profile,
            resources: store.product.resources(chat.id, profile),
          };
          options.validate?.(snapshot);
          return snapshot;
        }
      );
      run = result.run;
    }
    store.db
      .prepare('INSERT INTO import_operations(key,digest,result) VALUES(?,?,?)')
      .run(requestKey, digest, JSON.stringify({ runId: run.id }));
    return { run, created: true };
  });
}
