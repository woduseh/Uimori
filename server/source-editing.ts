import { pruneSourceEdits, pruneTranslationHistory } from './text-retention.js';
import { currentBotTranslationGuide } from './translation-guide.js';
import { canRejudgeTranslation } from '../core/translation-recovery.js';
import { validateTranslationArtifact } from './translation-artifacts.js';
import { HttpError, fields, number, record, text } from './request-validation.js';
import { translationPolicy } from '../core/translation-settings.js';
import { workspaceModelRef } from '../core/product.js';
import { automaticImageSelection, invalidateTranslationImages } from './package-images.js';
import { promptWorkspace } from './prompt-workspace.js';
import { createHash, randomUUID } from 'node:crypto';
import type { Store, Source, Job } from './store.js';
import { SOURCE_TEXT_MAX_CHARS, TRANSLATION_TEXT_MAX_CHARS } from '../core/content-limits.js';

export function latestTranslation(store: Store, id: string): Job | null {
  const row = store.db
    .prepare(
      "SELECT id FROM jobs WHERE source_revision=? AND kind='translation' ORDER BY revision DESC,created_at DESC,id DESC LIMIT 1"
    )
    .get(id) as { id: string } | undefined;
  return row ? store.job(row.id) : null;
}
/** Revoke in-flight ownership; retention separately keeps the previous usable response. */
function stopTranslations(store: Store, sourceId: string) {
  store.db
    .prepare(
      "UPDATE jobs SET status='cancelled',generation=generation+1,owner=NULL,error='Translation replaced by direct edit' WHERE source_revision=? AND kind='translation' AND status IN ('queued','running')"
    )
    .run(sourceId);
}
export function editSource(store: Store, id: string, value: unknown): Source {
  const b = record(value);
  fields(b, ['text', 'expectedRevision']);
  const content = text(b.text, 'source', SOURCE_TEXT_MAX_CHARS);
  const expected = number(b.expectedRevision, 'source revision', 0);
  return store.transaction(() => {
    const source = store.source(id);
    if (source.editRevision !== expected) throw new HttpError(409, 'Source revision conflict');
    if (source.text === content) return source;
    store.db
      .prepare('INSERT INTO source_edits VALUES(?,?,?,?,?)')
      .run(
        id,
        expected + 1,
        content,
        createHash('sha256').update(content).digest('hex'),
        new Date().toISOString()
      );
    store.db
      .prepare(
        "UPDATE jobs SET status='stale',generation=generation+1,owner=NULL,error=NULL,updated_at=? WHERE source_revision=? AND status!='stale'"
      )
      .run(new Date().toISOString(), id);
    pruneSourceEdits(store.db, id);
    pruneTranslationHistory(store.db, id);
    store.event(source.chatId, 'source.edited', id);
    return store.source(id);
  });
}
export function requestTranslation(
  store: Store,
  id: string,
  force = false,
  validate?: (id: string) => void
): Job {
  return store.transaction(() => {
    const source = store.source(id);
    const latest = latestTranslation(store, id);
    if (latest && latest.sourceHash === source.hash) {
      if (['queued', 'running'].includes(latest.status)) {
        validate?.(latest.id);
        return latest;
      }
      if (!force && latest.status === 'completed') {
        try {
          validateTranslationArtifact(latest, source);
          return latest;
        } catch {
          /* Repair only on explicit demand. */
        }
      }
    }
    const workspace = promptWorkspace(store);
    const selected = workspaceModelRef(workspace, 'translation');
    const profile = store.product.snapshot(source.chatId, 'translation');
    const automatic = profile?.imageTranslation !== false;
    const selection = automatic
      ? automaticImageSelection(store, {
          ...store.run(source.runId).snapshot,
          ...(profile ? { profile } : {}),
        })
      : undefined;
    const input = {
      ...(selection ? { translationImageSelection: selection } : {}),
      translationGuide: currentBotTranslationGuide(store, source.chatId),
      translationPrompt: structuredClone(workspace.translation),
      promptWorkspaceRevision: workspace.revision,
      translationModelSelection: selected,
      ...(selected
        ? { translationModelSnapshot: store.product.modelSnapshot(selected.id, 'translation') }
        : {}),
      translationPolicy: translationPolicy(workspace.translationPolicy),
    };
    store.product.resolveJobPrompt(store.run(source.runId).snapshot, input);
    const jobId = randomUUID();
    const time = new Date().toISOString();
    store.db
      .prepare(
        "INSERT INTO jobs(id,chat_id,source_revision,source_hash,kind,status,revision,input,created_at,updated_at) VALUES(?,?,?,?,'translation','queued',?,?,?,?)"
      )
      .run(
        jobId,
        source.chatId,
        id,
        source.hash,
        (latest?.revision ?? 0) + 1,
        JSON.stringify(input),
        time,
        time
      );
    store.event(source.chatId, 'job.queued', jobId);
    validate?.(jobId);
    return store.job(jobId);
  });
}
/** One admitted recovery per failed job; replaying its request returns the same job. */
export function rejudgeTranslation(store: Store, id: string): Job {
  return store.transaction(() => {
    const original = store.job(id);
    const recoveryId = createHash('sha256').update(`translation-judgment:${id}`).digest('hex');
    if (store.db.prepare('SELECT 1 FROM jobs WHERE id=?').get(recoveryId))
      return store.job(recoveryId);
    const source = store.source(original.sourceRevision);
    const input = record(original.input);
    if (
      !canRejudgeTranslation(original) ||
      source.hash !== original.sourceHash ||
      latestTranslation(store, source.id)?.id !== id ||
      translationPolicy(input.translationPolicy).judgment.enabled === false
    )
      throw new HttpError(409, 'Translation judgment recovery unavailable');
    const time = new Date().toISOString();
    store.db
      .prepare(
        "INSERT INTO jobs(id,chat_id,source_revision,source_hash,kind,status,revision,input,created_at,updated_at) VALUES(?,?,?,?,'translation','queued',?,?,?,?)"
      )
      .run(
        recoveryId,
        source.chatId,
        source.id,
        source.hash,
        (original.revision ?? 0) + 1,
        JSON.stringify({
          ...input,
          judgmentRecovery: { text: original.result!.text, sourceHash: source.hash },
        }),
        time,
        time
      );
    store.event(source.chatId, 'job.queued', recoveryId);
    return store.job(recoveryId);
  });
}

export function translationRecovery(input: unknown, sourceHash: string): string | undefined {
  const value = record(input);
  if (value.judgmentRecovery === undefined) return undefined;
  const recovery = record(value.judgmentRecovery);
  fields(recovery, ['text', 'sourceHash']);
  if (
    recovery.sourceHash !== sourceHash ||
    translationPolicy(value.translationPolicy).judgment.enabled === false
  )
    throw new HttpError(400, 'Translation judgment recovery dependency mismatch');
  return text(recovery.text, 'translation recovery', TRANSLATION_TEXT_MAX_CHARS);
}

export function requestStatus(
  store: Store,
  id: string,
  expectedSourceHash: string,
  expectedJobId: string | null,
  validate?: (id: string) => void
): Job {
  return store.transaction(() => {
    const source = store.source(id);
    const latest = store.db
      .prepare(
        "SELECT id,status FROM jobs WHERE source_revision=? AND kind='status' ORDER BY revision DESC,created_at DESC,id DESC LIMIT 1"
      )
      .get(id) as { id: string; status: string } | undefined;
    if (source.hash !== expectedSourceHash || (latest?.id ?? null) !== expectedJobId)
      throw new HttpError(409, 'Status source or job changed; refresh before creating a new job');
    if (
      store.db
        .prepare(
          "SELECT 1 FROM jobs WHERE source_revision=? AND kind='status' AND status IN ('queued','running')"
        )
        .get(id)
    )
      throw new HttpError(409, 'Status job is already active');
    const selected = promptWorkspace(store).modelRoutes.status;
    const input = {
      statusModelSelection: selected,
      ...(selected
        ? { statusModelSnapshot: store.product.modelSnapshot(selected.id, 'status') }
        : {}),
    };
    store.product.resolveJobPrompt(store.run(source.runId).snapshot, input);
    const jobId = randomUUID();
    const time = new Date().toISOString();
    store.db
      .prepare(
        "INSERT INTO jobs(id,chat_id,source_revision,source_hash,kind,status,revision,input,created_at,updated_at) VALUES(?,?,?,?,'status','queued',?,?,?,?)"
      )
      .run(
        jobId,
        source.chatId,
        id,
        source.hash,
        latest ? (store.job(latest.id).revision ?? 1) + 1 : 1,
        JSON.stringify(input),
        time,
        time
      );
    validate?.(jobId);
    store.event(source.chatId, 'job.queued', jobId);
    return store.job(jobId);
  });
}
export function editTranslation(store: Store, id: string, value: unknown): Job {
  const b = record(value);
  fields(b, ['text', 'expectedRevision', 'expectedSourceHash']);
  const content = text(b.text, 'translation', 2e6);
  const expected = number(b.expectedRevision, 'translation revision', 0);
  text(b.expectedSourceHash, 'source hash', 64);
  return store.transaction(() => {
    const source = store.source(id);
    const latest = latestTranslation(store, id);
    if (source.hash !== b.expectedSourceHash || (latest?.revision ?? 0) !== expected)
      throw new HttpError(409, 'Translation revision conflict');
    stopTranslations(store, id);
    invalidateTranslationImages(store, id);
    const jobId = randomUUID();
    const time = new Date().toISOString();
    store.db
      .prepare(
        "INSERT INTO jobs(id,chat_id,source_revision,source_hash,kind,status,revision,generation,created_at,updated_at) VALUES(?,?,?,?,'translation','completed',?,1,?,?)"
      )
      .run(jobId, source.chatId, id, source.hash, (latest?.revision ?? 0) + 1, time, time);
    const result = {
      mock: false,
      manual: true,
      sourceRevision: id,
      sourceHash: source.hash,
      text: content,
    };
    store.db
      .prepare('INSERT INTO job_results VALUES(?,?,?,?)')
      .run(jobId, store.job(jobId).generation, JSON.stringify(result), time);
    pruneTranslationHistory(store.db, id);
    store.event(source.chatId, 'job.completed', jobId);
    return store.job(jobId);
  });
}
