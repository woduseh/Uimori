import { readImportReceipt, saveImportReceipt } from './import-operations.js';
import { createHash, randomUUID } from 'node:crypto';
import { REQUEST_TEXT_MAX_CHARS } from '../core/content-limits.js';
import type { RunSnapshot, Usage } from '../core/types.js';
import { enqueueTerminalNotification } from './push-events.js';
import { readRunStatus } from './run-projections.js';
import { canRecoverMainJudgment } from '../core/main-judgment-recovery.js';
import { HttpError, text } from './request-validation.js';
import { forkChat } from './chat-fork.js';
import { chatGenerationDefaults } from './chat-generation-defaults.js';
import { autoRefusalRetryLimit } from '../core/chat-settings.js';
import { imageInputSupported } from '../core/provider-images.js';
import type { Store, Run } from './store.js';
import { AppError } from './app-errors.js';

const AUTOMATIC_REFUSAL_RETRY_KEY = 'auto-refusal-retry:';

export function automaticRefusalRetryDepth(store: Store, runId: string): number {
  const read = store.db.prepare(
    "SELECT request_key AS requestKey,json_extract(command,'$.retryOf') AS retryOf FROM runs WHERE id=?"
  );
  const seen = new Set<string>();
  let depth = 0;
  for (let id: string | null = runId; id && !seen.has(id); ) {
    seen.add(id);
    const row = read.get(id) as { requestKey: string | null; retryOf: string | null } | undefined;
    if (!row?.requestKey?.startsWith(AUTOMATIC_REFUSAL_RETRY_KEY)) break;
    depth++;
    id = row.retryOf;
  }
  return depth;
}

export function requireRequestModel(
  snapshot: RunSnapshot,
  requireModel: (target: unknown, role: string) => void
) {
  const target = snapshot.profile?.models.main;
  requireModel(target, 'main');
  if (
    snapshot.requestImages?.length &&
    target &&
    imageInputSupported(target.connection.protocol, target.modelId) === false
  )
    throw new AppError(400, 'IMAGE_INPUT_UNSUPPORTED_MODEL');
}

export function queueAutomaticRefusalRetry(
  store: Store,
  runId: string,
  requireModel: (target: unknown, role: string) => void
): Run | undefined {
  const refused = store.run(runId);
  const chat = store.chat(refused.chatId);
  if (
    (refused.status !== 'refused' && refused.status !== 'failed') ||
    automaticRefusalRetryDepth(store, runId) >=
      autoRefusalRetryLimit(chat.settings, chatGenerationDefaults(store.db)) ||
    chat.headRevision !== (refused.snapshot.replacement?.sourceRevision ?? refused.parentRevision)
  )
    return undefined;
  try {
    const result = retryRun(store, runId, `${AUTOMATIC_REFUSAL_RETRY_KEY}${runId}`, {
      validate: (snapshot) => requireRequestModel(snapshot, requireModel),
    });
    return result.created ? result.run : undefined;
  } catch (error) {
    if (error instanceof HttpError) return undefined;
    throw error;
  }
}

export function finishRefusalWithAutomaticRetry(
  store: Store,
  runId: string,
  refusal: { status: 'refused' | 'failed'; error: string; partialText: string; usage: Usage },
  options: { retryAllowed: boolean; requireModel: (target: unknown, role: string) => void }
): Run | undefined {
  return store.transaction(() => {
    const ended = !['queued', 'running'].includes(readRunStatus(store, runId));
    const run = store.finishRun(
      runId,
      refusal.status,
      refusal.error,
      refusal.partialText,
      refusal.usage,
      { notify: false }
    );
    if (ended) return undefined;
    const retry = options.retryAllowed
      ? queueAutomaticRefusalRetry(store, runId, options.requireModel)
      : undefined;
    if (!retry)
      enqueueTerminalNotification(
        store.db,
        run.chatId,
        `run.${refusal.status}`,
        runId,
        new Date().toISOString()
      );
    return retry;
  });
}

export function retryRun(
  store: Store,
  runId: string,
  key: string,
  options: {
    request?: string;
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
      ...(options.judgmentOnly ? { title: '판정 복구' } : {}),
      alwaysCopy: false,
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
    if (original.snapshot.invalidatedBySceneDeletion)
      throw new AppError(409, 'SCENE_DELETED_RETRY_UNAVAILABLE');
    if (['queued', 'running'].includes(original.status))
      throw new HttpError(409, 'Original run is still active');
    if (original.snapshot.packageStart?.mode === 'authored' || original.snapshot.nativeRisuAuthored)
      throw new AppError(409, 'RUN_RETRY_AUTHORED_FIRST_MESSAGE');
    const originalChat = store.chat(original.chatId);
    const replace =
      options.mode === 'replace' ||
      (options.mode !== 'copy' && !original.sourceRevision && !!original.snapshot.replacement);
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
      throw new AppError(409, 'RUN_RETRY_REPLACE_LATEST_ONLY');
    let run: Run;
    if (options.judgmentOnly) {
      if (!canRecoverMainJudgment(original)) throw new AppError(409, 'RUN_REJUDGE_UNAVAILABLE');
      if (
        originalChat.headRevision !==
          (original.snapshot.replacement?.sourceRevision ?? original.parentRevision) ||
        (original.snapshot.replacement &&
          store.source(original.snapshot.replacement.sourceRevision).hash !==
            original.snapshot.replacement.sourceHash)
      )
        throw new AppError(409, 'RUN_RETRY_STORY_ADVANCED');
      if (
        store.db
          .prepare("SELECT 1 FROM runs WHERE chat_id=? AND status IN ('queued','running')")
          .get(original.chatId)
      )
        throw new HttpError(409, 'A run already owns this head');
      if (
        store.db
          .prepare('SELECT 1 FROM runs WHERE chat_id=? AND request_key=?')
          .get(original.chatId, key)
      )
        throw new HttpError(409, 'Idempotency key reused with different command');
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
          !!original.sourceRevision ||
          originalChat.headRevision !== original.parentRevision);
      const chat = copied
        ? forkChat(store, original.chatId, {
            fromRevision: original.parentRevision,
            idempotencyKey: createHash('sha256').update(requestKey).digest('hex'),
          })
        : store.chat(original.chatId);
      const parentRevision = replacement ? replacement.parentRevision : chat.headRevision;
      const action = options.request === undefined ? original.snapshot.storyUiAction : undefined;
      if (
        action &&
        (!parentRevision || store.sourceMetadata(parentRevision).hash !== action.sourceHash)
      )
        throw new HttpError(409, 'STORY_UI_STALE_SOURCE');
      const profile = store.product.snapshot(chat.id, 'main', parentRevision);
      const request =
        options.request === undefined
          ? original.request
          : text(
              options.request,
              'request',
              REQUEST_TEXT_MAX_CHARS,
              !!original.snapshot.requestImages?.length
            );
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
            ...(action && parentRevision
              ? { storyUiAction: { ...action, sourceRevision: parentRevision } }
              : {}),
            ...(original.snapshot.requestImages?.length
              ? { requestImages: structuredClone(original.snapshot.requestImages) }
              : {}),
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
