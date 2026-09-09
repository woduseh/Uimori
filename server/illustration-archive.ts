import { createHash } from 'node:crypto';
import { isValidIllustrationImage } from '../core/illustration.js';
import type { Store } from './store.js';
import { HttpError, fields, number, record, text } from './request-validation.js';

type Row = Record<string, any>;
export type IllustrationAttemptOwner = {
  jobId: string;
  chatId: string;
  connectionId: string;
  modelId: string;
};

/** Local execution ownership is separate from a fork's copied image provenance. */
export function validateIllustrationArchive(store: Store): Map<string, IllustrationAttemptOwner> {
  const owners = new Map<string, IllustrationAttemptOwner>();
  const jobs = store.db.prepare('SELECT * FROM illustration_jobs').all() as Row[];
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const parse = (value: string) => record(JSON.parse(value));
  const fail = (message: string): never => {
    throw new HttpError(400, message);
  };
  for (const job of jobs) {
    const source = store.sourceAtHash(job.source_revision, job.source_hash);
    if (source.chatId !== job.chat_id) fail('Illustration source chat mismatch');
    if (!['automatic', 'manual'].includes(job.origin)) fail('Invalid illustration origin');
    if (
      !['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted'].includes(job.status)
    )
      fail('Invalid illustration status');
    number(job.generation, 'illustration generation', 0);
    number(job.attempt, 'illustration attempt', 1);
    const input = parse(job.input);
    if (input.version !== 1 || !['codex', 'comfyui', 'fixture'].includes(input.generator))
      fail('Invalid illustration input');
    number(input.settingsRevision, 'illustration settings revision', 1);
    number(input.maxAutoRetries, 'illustration retry limit', 0, 5);
    text(input.styleGuidance, 'illustration style', 2000, true);
    if (input.codex) {
      if (!Array.isArray(input.codex.references) || input.codex.references.length > 8)
        fail('Invalid frozen illustration references');
      for (const reference of input.codex.references) {
        const item = record(reference);
        const ref = text(item.ref, 'illustration reference', 200);
        const asset = store.db.prepare('SELECT chat_id FROM assets WHERE id=?').get(ref) as
          | Row
          | undefined;
        // Completed fork copies retain historical input provenance and cannot be rerun.
        if (job.status !== 'completed' && asset && asset.chat_id !== job.chat_id)
          fail('Frozen illustration reference chat mismatch');
      }
    }
    const diagnostic = job.diagnostic === null ? null : parse(job.diagnostic);
    if (diagnostic) {
      if (!Array.isArray(diagnostic.attempts) || !Array.isArray(diagnostic.retries))
        fail('Invalid illustration diagnostic');
      const model = input.generator === 'codex' ? input.codex?.model : input.comfyui?.promptModel;
      for (const id of diagnostic.attempts) {
        text(id, 'illustration attempt ID', 200);
        const attempt = store.db.prepare('SELECT chat_id,role FROM attempts WHERE id=?').get(id) as
          | Row
          | undefined;
        if (
          owners.has(id) ||
          !model ||
          !attempt ||
          attempt.chat_id !== job.chat_id ||
          attempt.role !== 'illustration'
        )
          fail('Illustration attempt ownership mismatch');
        owners.set(id, {
          jobId: job.id,
          chatId: job.chat_id,
          connectionId: model.connectionId,
          modelId: model.modelId,
        });
      }
    }
  }
  const positions = new Map<string, number[]>();
  for (const image of store.db
    .prepare('SELECT * FROM illustration_images ORDER BY job_id,position')
    .all() as Row[]) {
    const job = byId.get(image.job_id);
    if (!job || job.chat_id !== image.chat_id || job.status !== 'completed')
      fail('Illustration image target mismatch');
    const bytes = Buffer.from(image.bytes);
    if (!isValidIllustrationImage(bytes, image.mime))
      fail('Invalid illustration image bytes or MIME');
    if (createHash('sha256').update(bytes).digest('hex') !== image.hash)
      fail('Illustration image hash mismatch');
    const position = number(image.position, 'illustration image position', 0);
    const previous = positions.get(image.job_id) ?? [];
    if (position !== previous.length) fail('Illustration image position mismatch');
    previous.push(position);
    positions.set(image.job_id, previous);
    const body = parse(image.body);
    fields(body, ['caption', 'prompt', 'revisedPrompt']);
    text(body.caption, 'illustration caption', 10000, true);
    for (const key of ['prompt', 'revisedPrompt'])
      if (body[key] !== undefined) text(body[key], `illustration ${key}`, 100000, true);
  }
  for (const job of jobs) {
    if (job.status === 'completed' && !positions.has(job.id)) {
      const diagnostic = job.diagnostic === null ? null : parse(job.diagnostic);
      if (typeof diagnostic?.skipped !== 'string' || job.origin !== 'automatic')
        fail('Completed illustration has no result');
    }
  }
  for (const row of store.db.prepare('SELECT * FROM illustration_references').all() as Row[]) {
    store.chat(row.chat_id);
    number(row.revision, 'illustration reference revision', 1);
    const references: unknown = JSON.parse(row.body);
    if (!Array.isArray(references) || references.length > 8)
      fail('Invalid illustration references');
    const seen = new Set<string>();
    for (const entry of references as unknown[]) {
      const item = record(entry);
      fields(item, ['ref', 'role']);
      const ref = text(item.ref, 'illustration reference', 200);
      if (!['character', 'style'].includes(String(item.role)) || seen.has(ref))
        fail('Invalid illustration reference role or duplicate');
      seen.add(ref);
      // Missing references may legitimately have been removed after reservation.
      // Existing per-chat assets must never become another chat's reference.
      const asset = store.db.prepare('SELECT chat_id FROM assets WHERE id=?').get(ref) as
        | Row
        | undefined;
      if (asset && asset.chat_id !== row.chat_id) fail('Illustration reference chat mismatch');
    }
  }
  return owners;
}
