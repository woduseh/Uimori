import { HttpError, fields, number, record, text } from './request-validation.js';
import { translationChunkChars } from '../core/translation-settings.js';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Store, Source, Job } from './store.js';
import { validateStoredChunk } from './product-store.js';
import { aggregateTranslation, splitSource, validateTranslationPlan } from '../core/auxiliary.js';
import { sourceTimeContext } from './product-auxiliary.js';

export function latestTranslation(store: Store, id: string): Job | null {
  const row = store.db
    .prepare(
      "SELECT id FROM jobs WHERE source_revision=? AND kind='translation' ORDER BY revision DESC,created_at DESC,id DESC LIMIT 1"
    )
    .get(id) as { id: string } | undefined;
  return row ? store.job(row.id) : null;
}
export function validateTranslationArtifact(store: Store, job: Job, source: Source): void {
  const result = record(job.result);
  if (
    result.sourceRevision !== source.id ||
    result.sourceHash !== source.hash ||
    job.sourceHash !== source.hash ||
    typeof result.mock !== 'boolean'
  )
    throw new HttpError(400, 'Translation dependency mismatch');
  text(result.text, 'translation', 2e6);
  if (
    result.mock === true &&
    result.manual === undefined &&
    !store.run(source.runId).snapshot.profile &&
    !store.product.plan(job.id) &&
    !store.product.chunks(job.id).length &&
    result.segments === undefined
  )
    return;
  if (!Array.isArray(result.segments) || !result.segments.length)
    throw new HttpError(400, 'Translation segments missing');
  const anchors = result.segments.flatMap((raw: unknown) => {
    const segment = record(raw);
    text(segment.text, 'segment', 2e6);
    if (!Array.isArray(segment.anchors)) throw new HttpError(400, 'Invalid anchors');
    return segment.anchors;
  });
  if (
    !isDeepStrictEqual(
      anchors,
      splitSource(source).map((b) => b.anchor)
    ) ||
    result.text !== result.segments.map((s: any) => s.text).join('\n\n')
  )
    throw new HttpError(400, 'Translation coverage mismatch');
  const rawPlan = store.product.plan(job.id);
  const chunks = store.product.chunks(job.id);
  if (result.manual === true) {
    if (result.mock || rawPlan || chunks.length)
      throw new HttpError(400, 'Invalid manual translation');
    return;
  }
  if (result.manual !== undefined) throw new HttpError(400, 'Invalid authored marker');
  if (!rawPlan) throw new HttpError(400, 'Translation plan missing');
  const snapshot = store.product.resolveJobPrompt(store.run(source.runId).snapshot, job.input);
  const plan = validateTranslationPlan(source, sourceTimeContext(snapshot, 'translation'), rawPlan);
  if (
    chunks.length !== plan.chunks.length ||
    chunks.some((c) => c.status !== 'completed' || !c.result)
  )
    throw new HttpError(400, 'Incomplete translation chunks');
  const validated = chunks.map((c) => {
    const value = validateStoredChunk(plan, c.result);
    if (value.chunkId !== c.id) throw new HttpError(400, 'Chunk identity mismatch');
    return value;
  });
  const combined = aggregateTranslation(plan, validated);
  if (combined.status !== 'completed' || !isDeepStrictEqual(combined.segments, result.segments))
    throw new HttpError(400, 'Invalid stored translation');
}
function clear(store: Store, id: string) {
  store.db.prepare('DELETE FROM job_results WHERE job_id=?').run(id);
  store.db.prepare('DELETE FROM job_chunks WHERE job_id=?').run(id);
  store.db.prepare('UPDATE jobs SET plan=NULL,retry_chunk=NULL WHERE id=?').run(id);
}
function obsolete(store: Store, sourceId: string, except?: string) {
  const rows = store.db
    .prepare("SELECT id FROM jobs WHERE source_revision=? AND kind='translation'")
    .all(sourceId) as { id: string }[];
  for (const row of rows)
    if (row.id !== except) {
      clear(store, row.id);
      store.db
        .prepare(
          "UPDATE jobs SET status='stale',generation=generation+1,owner=NULL,input=NULL WHERE id=?"
        )
        .run(row.id);
    }
}
export function editSource(store: Store, id: string, value: unknown): Source {
  const b = record(value);
  fields(b, ['text', 'expectedRevision']);
  const content = text(b.text, 'source', 2e6);
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
    const jobs = store.db.prepare('SELECT id FROM jobs WHERE source_revision=?').all(id) as {
      id: string;
    }[];
    for (const job of jobs) {
      clear(store, job.id);
      store.db
        .prepare(
          "UPDATE jobs SET status='stale',generation=generation+1,owner=NULL,input=NULL,error=NULL,updated_at=? WHERE id=?"
        )
        .run(new Date().toISOString(), job.id);
    }
    store.story.onSourceEditedInTransaction(id);
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
          validateTranslationArtifact(store, latest, source);
          return latest;
        } catch {
          /* Repair only on explicit demand. */
        }
      }
    }
    const profile = store.product.profile(source.chatId);
    const ref = profile.prompts?.translation;
    const controls = ref ? profile.promptControls?.[`${ref.id}@${ref.revision}`] : undefined;
    const selected = profile.routes.translation;
    const input = {
      translationChunkChars: translationChunkChars(
        store.chat(source.chatId).settings.translationChunkChars
      ),
      promptSelection: { translation: ref ?? null },
      translationModelSelection: selected,
      ...(selected ? { translationModelSnapshot: store.product.modelSnapshot(selected.id) } : {}),
      promptControlSelection: controls ?? null,
    };
    store.product.resolveJobPrompt(store.run(source.runId).snapshot, input);
    const jobId = latest?.id ?? randomUUID();
    const time = new Date().toISOString();
    obsolete(store, id, jobId);
    if (latest) {
      clear(store, jobId);
      store.db
        .prepare(
          "UPDATE jobs SET source_hash=?,status='queued',generation=generation+1,revision=revision+1,owner=NULL,input=?,error=NULL,updated_at=? WHERE id=?"
        )
        .run(source.hash, JSON.stringify(input), time, jobId);
    } else
      store.db
        .prepare(
          "INSERT INTO jobs(id,chat_id,source_revision,source_hash,kind,status,input,created_at,updated_at) VALUES(?,?,?,?,'translation','queued',?,?,?)"
        )
        .run(jobId, source.chatId, id, source.hash, JSON.stringify(input), time, time);
    store.event(source.chatId, 'job.queued', jobId);
    validate?.(jobId);
    return store.job(jobId);
  });
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
    const profile = store.product.profile(source.chatId);
    const selected = profile.routes.status;
    const input = {
      statusModelSelection: selected,
      ...(selected ? { statusModelSnapshot: store.product.modelSnapshot(selected.id) } : {}),
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
    const jobId = latest?.id ?? randomUUID();
    const time = new Date().toISOString();
    obsolete(store, id, jobId);
    if (latest) {
      clear(store, jobId);
      store.db
        .prepare(
          "UPDATE jobs SET source_hash=?,status='completed',generation=generation+1,revision=revision+1,owner=NULL,input=NULL,error=NULL,updated_at=? WHERE id=?"
        )
        .run(source.hash, time, jobId);
    } else
      store.db
        .prepare(
          "INSERT INTO jobs(id,chat_id,source_revision,source_hash,kind,status,generation,created_at,updated_at) VALUES(?,?,?,?,'translation','completed',1,?,?)"
        )
        .run(jobId, source.chatId, id, source.hash, time, time);
    const result = {
      mock: false,
      manual: true,
      sourceRevision: id,
      sourceHash: source.hash,
      text: content,
      segments: [{ anchors: splitSource(source).map((b) => b.anchor), text: content }],
    };
    store.db
      .prepare('INSERT INTO job_results VALUES(?,?,?,?)')
      .run(jobId, store.job(jobId).generation, JSON.stringify(result), time);
    store.event(source.chatId, 'job.completed', jobId);
    return store.job(jobId);
  });
}
