import { readImportReceipt, saveImportReceipt } from './import-operations.js';
import { createHash, randomUUID } from 'node:crypto';
import { REQUEST_TEXT_MAX_CHARS } from '../core/content-limits.js';
import type { RunSnapshot } from '../core/types.js';
import { canRecoverMainJudgment } from '../core/main-judgment-recovery.js';
import { HttpError, text } from './request-validation.js';
import { forkChat } from './chat-fork.js';
import type { Store, Run } from './store.js';

/** Current-resource retry; explicit last-response replacement defers head changes until commit. */
export function retryRun(
  store: Store,
  runId: string,
  key: string,
  options: {
    request?: string;
    title?: string;
    alwaysCopy?: boolean;
    judgmentOnly?: boolean;
    mode?: 'replace' | 'copy';
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
      ...(options.mode ? { mode: options.mode } : {}),
    });
    const digest = createHash('sha256').update(command).digest('hex');
    const previous = readImportReceipt<{ runId: string }>(
      store,
      requestKey,
      digest,
      'Idempotency key reused with a different retry'
    );
    if (previous) return { run: store.run(previous.runId), created: false };
    const original = store.run(runId);
    if (['queued', 'running'].includes(original.status))
      throw new HttpError(409, 'Original run is still active');
    if (original.snapshot.packageStart?.mode === 'authored' || original.snapshot.nativeRisuAuthored)
      throw new HttpError(409, '작성된 시작문은 생성 요청이 아니에요. 새 장면을 요청해 주세요.');
    const originalChat = store.chat(original.chatId);
    const replace =
      options.mode === 'replace' ||
      (options.mode !== 'copy' &&
        !options.alwaysCopy &&
        !original.sourceRevision &&
        !!original.snapshot.replacement);
    const replacement = replace
      ? original.sourceRevision
        ? store.source(original.sourceRevision)
        : original.snapshot.replacement
          ? store.source(original.snapshot.replacement.sourceRevision)
          : null
      : null;
    if (
      replace &&
      (!replacement ||
        (!original.snapshot.replacement && original.status !== 'completed') ||
        originalChat.headRevision !== replacement.id ||
        (!original.sourceRevision &&
          original.snapshot.replacement &&
          replacement.hash !== original.snapshot.replacement.sourceHash))
    )
      throw new HttpError(
        409,
        '마지막 완료 응답만 교체할 수 있어요. 이전 장면은 새 채팅에서 다시 요청해 주세요.'
      );
    let run: Run;
    if (options.judgmentOnly) {
      if (!canRecoverMainJudgment(original))
        throw new HttpError(409, '보존된 본문의 판정 실패만 다시 판정할 수 있어요.');
      if (
        originalChat.headRevision !==
          (original.snapshot.replacement?.sourceRevision ?? original.parentRevision) ||
        (original.snapshot.replacement &&
          store.source(original.snapshot.replacement.sourceRevision).hash !==
            original.snapshot.replacement.sourceHash)
      )
        throw new HttpError(409, '이야기가 이미 진행됐어요. 현재 내용에서 새 요청을 보내 주세요.');
      const id = randomUUID(),
        at = new Date().toISOString();
      const snapshot = { ...original.snapshot, judgmentRecovery: true };
      store.db
        .prepare(`INSERT INTO runs(id,chat_id,parent_revision,status,request,snapshot,request_key,command,created_at,updated_at)
        VALUES(?,?,?,'queued',?,?,?,?,?,?)`)
        .run(
          id,
          original.chatId,
          original.parentRevision,
          original.request,
          JSON.stringify(snapshot),
          key,
          command,
          at,
          at
        );
      store.event(original.chatId, 'run.queued', id);
      run = store.run(id);
    } else {
      const copied =
        !replacement &&
        (options.mode === 'copy' ||
          options.alwaysCopy ||
          !!original.sourceRevision ||
          originalChat.headRevision !== original.parentRevision);
      const chat = copied
        ? forkChat(store, original.chatId, {
            fromRevision: original.parentRevision,
            ...(options.title !== undefined ? { title: options.title } : {}),
            idempotencyKey: createHash('sha256').update(requestKey).digest('hex'),
          })
        : store.chat(original.chatId);
      const parentRevision = replacement ? replacement.parentRevision : chat.headRevision;
      const profile = store.product.snapshot(chat.id, 'main', parentRevision);
      const request =
        options.request === undefined
          ? original.request
          : text(options.request, 'request', REQUEST_TEXT_MAX_CHARS);
      const result = store.createRunInTransaction(
        chat.id,
        {
          request,
          expectedRevision: chat.headRevision,
          expectedSettingsRevision: chat.settingsRevision,
          expectedProfileRevision: profile.revision,
          idempotencyKey: key,
          ...(!copied ? { retryOf: original.id } : {}),
          ...(options.request !== undefined ? { requestEdited: true } : {}),
        },
        (current) => {
          const snapshot: RunSnapshot = {
            chatId: chat.id,
            request,
            parentRevision,
            ...(replacement
              ? { replacement: { sourceRevision: replacement.id, sourceHash: replacement.hash } }
              : {}),
            settingsRevision: current.settingsRevision,
            settings: current.settings,
            history: store.history(parentRevision),
            profile,
            resources: store.product.resources(chat.id, profile),
          };
          options.validate?.(snapshot);
          return snapshot;
        }
      );
      run = result.run;
    }
    saveImportReceipt(store, requestKey, digest, { runId: run.id });
    return { run, created: true };
  });
}
