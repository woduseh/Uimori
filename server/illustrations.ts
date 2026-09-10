import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { HttpError, fields, number, record, text } from './request-validation.js';
import type { Source, Store } from './store.js';
import { assertModelSelection } from './provider-selection.js';
import type { PackageImageBlob } from './package-images.js';
import { packageImages } from '../core/package-images.js';
import { resolvePackageProfile } from './package-features.js';
import type { Asset, Connection, ModelPreset, ModelRef } from '../core/product.js';
import {
  defaultIllustrationSettings,
  ILLUSTRATION_GENERATORS,
  ILLUSTRATION_MAX_AUTO_RETRIES,
  ILLUSTRATION_MAX_PER_SOURCE,
  ILLUSTRATION_REFERENCE_ROLES,
  IllustrationError,
  isValidIllustrationImage,
  parseComfyWorkflow,
  type FrozenIllustrationReference,
  type Illustration,
  type IllustrationDiagnostic,
  type IllustrationImage,
  type IllustrationImageMime,
  type IllustrationJobInput,
  type IllustrationReference,
  type IllustrationReferences,
  type IllustrationSettings,
  type IllustrationStatus,
} from '../core/illustration.js';
import { comfyUISystemStats, validateComfyBaseUrl } from './comfyui-client.js';

type Row = Record<string, any>;
const now = () => new Date().toISOString();
const json = (value: unknown) => JSON.stringify(value);
const parse = (value: unknown) => (value == null ? null : JSON.parse(String(value)));
const ACTIVE: IllustrationStatus[] = ['queued', 'running'];
const RETRYABLE_STATUSES: IllustrationStatus[] = ['failed', 'cancelled', 'interrupted'];

export const ILLUSTRATION_TABLES = [
  'illustration_settings',
  'illustration_references',
  'illustration_jobs',
  'illustration_images',
] as const;

/** Additive, idempotent tables; schema 15 databases gain them on open and keep their version. */
export function initIllustrations(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS illustration_settings (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS illustration_references (chat_id TEXT PRIMARY KEY REFERENCES chats(id), revision INTEGER NOT NULL, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS illustration_jobs (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), source_revision TEXT NOT NULL REFERENCES sources(id), source_hash TEXT NOT NULL, origin TEXT NOT NULL CHECK(origin IN ('automatic','manual')), status TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0, owner TEXT, attempt INTEGER NOT NULL DEFAULT 1, input TEXT NOT NULL, diagnostic TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS illustration_jobs_source ON illustration_jobs(source_revision,created_at);
    CREATE INDEX IF NOT EXISTS illustration_jobs_chat ON illustration_jobs(chat_id,created_at);
    CREATE TABLE IF NOT EXISTS illustration_images (id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES illustration_jobs(id), chat_id TEXT NOT NULL REFERENCES chats(id), position INTEGER NOT NULL, mime TEXT NOT NULL, hash TEXT NOT NULL, body TEXT NOT NULL, bytes BLOB NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS illustration_images_job ON illustration_images(job_id,position);
  `);
  db.prepare('INSERT OR IGNORE INTO illustration_settings(id,body) VALUES(1,?)').run(
    json(defaultIllustrationSettings())
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
function modelRef(value: unknown, name: string): ModelRef | null {
  if (value === null || value === undefined) return null;
  const ref = record(value);
  fields(ref, ['id']);
  return { id: text(ref.id, name, 100) };
}
const boolean = (value: unknown, name: string): boolean => {
  if (typeof value !== 'boolean') throw new HttpError(400, `Invalid ${name}`);
  return value;
};
const httpFromIllustration = (error: unknown, status = 400): never => {
  if (error instanceof IllustrationError) throw new HttpError(status, error.code);
  throw error;
};
export function validateIllustrationSettings(
  value: unknown,
  options: { revision: number; testMode?: boolean }
): IllustrationSettings {
  const b = record(value);
  fields(b, [
    'generator',
    'automatic',
    'maxPerSource',
    'maxAutoRetries',
    'styleGuidance',
    'codex',
    'comfyui',
  ]);
  if (!ILLUSTRATION_GENERATORS.includes(b.generator)) throw new HttpError(400, 'Invalid generator');
  if (b.generator === 'fixture' && !options.testMode)
    throw new HttpError(400, 'Fixture generator requires test mode');
  const codex = record(b.codex);
  fields(codex, ['model', 'useReferences']);
  const comfyui = record(b.comfyui);
  fields(comfyui, [
    'baseUrl',
    'authorizationEnv',
    'workflow',
    'timeoutMs',
    'pollIntervalMs',
    'promptModel',
    'negativeGuidance',
  ]);
  const baseUrl = text(comfyui.baseUrl, 'ComfyUI address', 2000, true).trim();
  const authorizationEnv = text(comfyui.authorizationEnv, 'ComfyUI credential env', 128, true);
  if (authorizationEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(authorizationEnv))
    throw new HttpError(400, 'Invalid ComfyUI credential env');
  const workflow = text(comfyui.workflow, 'ComfyUI workflow', 400_000, true);
  try {
    if (workflow.trim()) parseComfyWorkflow(workflow);
  } catch (error) {
    httpFromIllustration(error);
  }
  return {
    revision: options.revision,
    generator: b.generator,
    automatic: boolean(b.automatic, 'automatic'),
    maxPerSource: number(b.maxPerSource, 'maxPerSource', 1, ILLUSTRATION_MAX_PER_SOURCE),
    maxAutoRetries: number(b.maxAutoRetries, 'maxAutoRetries', 0, ILLUSTRATION_MAX_AUTO_RETRIES),
    styleGuidance: text(b.styleGuidance, 'style guidance', 2000, true),
    codex: {
      model: modelRef(codex.model, 'Codex illustration model'),
      useReferences: boolean(codex.useReferences, 'useReferences'),
    },
    comfyui: {
      baseUrl: baseUrl
        ? (() => {
            try {
              return validateComfyBaseUrl(baseUrl);
            } catch (error) {
              return httpFromIllustration(error);
            }
          })()
        : '',
      authorizationEnv,
      workflow,
      timeoutMs: number(comfyui.timeoutMs, 'ComfyUI timeout', 10_000, 1_800_000),
      pollIntervalMs: number(comfyui.pollIntervalMs, 'ComfyUI poll interval', 250, 10_000),
      promptModel: modelRef(comfyui.promptModel, 'illustration prompt model'),
      negativeGuidance: text(comfyui.negativeGuidance, 'negative guidance', 1000, true),
    },
  };
}
export function illustrationSettings(store: Store): IllustrationSettings {
  const row = store.db.prepare('SELECT body FROM illustration_settings WHERE id=1').get() as
    | Row
    | undefined;
  const saved = row ? (parse(row.body) as Partial<IllustrationSettings>) : {};
  const defaults = defaultIllustrationSettings();
  return {
    ...defaults,
    ...saved,
    codex: { ...defaults.codex, ...(saved.codex ?? {}) },
    comfyui: { ...defaults.comfyui, ...(saved.comfyui ?? {}) },
  };
}
function assertCodexModel(store: Store, ref: ModelRef | null) {
  if (!ref) return;
  const model = store.product.get<ModelPreset>('model', ref.id);
  const connection = store.product.get<Connection>('connection', model.connectionId);
  if (connection.protocol !== 'codex-app-server-v1')
    throw new HttpError(400, 'Codex 삽화 모델은 Codex 연결의 모델 프리셋이어야 해요.');
}
export function updateIllustrationSettings(
  store: Store,
  value: unknown,
  testMode = false
): IllustrationSettings {
  const b = record(value);
  const { expectedRevision, ...rest } = b;
  return store.transaction(() => {
    const prior = illustrationSettings(store);
    if (prior.revision !== number(expectedRevision, 'illustration settings revision'))
      throw new HttpError(409, '삽화 설정이 변경됐어요. 새로고침한 뒤 저장해 주세요.');
    const next = validateIllustrationSettings(rest, { revision: prior.revision + 1, testMode });
    assertModelSelection(store.product, next.codex.model, prior.codex.model);
    assertCodexModel(store, next.codex.model);
    assertModelSelection(store.product, next.comfyui.promptModel, prior.comfyui.promptModel);
    store.db.prepare('UPDATE illustration_settings SET body=? WHERE id=1').run(json(next));
    return next;
  });
}

// ---------------------------------------------------------------------------
// Per-chat reference images (character design / art style)
// ---------------------------------------------------------------------------
export function illustrationReferenceCandidates(store: Store, chatId: string): Asset[] {
  store.chat(chatId);
  // Image candidates depend on attached packages, not on an available writing prompt/model.
  const profile = {
    chatId,
    ...resolvePackageProfile(store.product, store.product.profile(chatId)),
  };
  return [...store.product.assets(chatId), ...packageImages(profile)];
}
export function illustrationReferences(store: Store, chatId: string): IllustrationReferences {
  store.chat(chatId);
  const row = store.db
    .prepare('SELECT revision,body FROM illustration_references WHERE chat_id=?')
    .get(chatId) as Row | undefined;
  return {
    chatId,
    revision: row ? Number(row.revision) : 0,
    references: row ? (parse(row.body) as IllustrationReference[]) : [],
  };
}
export function updateIllustrationReferences(
  store: Store,
  chatId: string,
  value: unknown
): IllustrationReferences {
  const b = record(value);
  fields(b, ['expectedRevision', 'references']);
  if (!Array.isArray(b.references) || b.references.length > 8)
    throw new HttpError(400, 'Invalid illustration references');
  const references: IllustrationReference[] = b.references.map((entry) => {
    const item = record(entry);
    fields(item, ['ref', 'role']);
    if (!ILLUSTRATION_REFERENCE_ROLES.includes(item.role))
      throw new HttpError(400, 'Invalid illustration reference role');
    return { ref: text(item.ref, 'reference', 300), role: item.role };
  });
  if (new Set(references.map((item) => item.ref)).size !== references.length)
    throw new HttpError(400, 'Duplicate illustration reference');
  return store.transaction(() => {
    const prior = illustrationReferences(store, chatId);
    if (prior.revision !== number(b.expectedRevision, 'reference revision', 0))
      throw new HttpError(409, '삽화 참조 이미지가 변경됐어요. 새로고침한 뒤 저장해 주세요.');
    const candidates = new Set(
      illustrationReferenceCandidates(store, chatId).map((asset) => asset.id)
    );
    for (const item of references)
      if (!candidates.has(item.ref))
        throw new HttpError(400, '이 채팅에서 사용할 수 없는 이미지 참조예요.');
    store.db
      .prepare(
        'INSERT INTO illustration_references(chat_id,revision,body) VALUES(?,?,?) ON CONFLICT(chat_id) DO UPDATE SET revision=excluded.revision,body=excluded.body'
      )
      .run(chatId, prior.revision + 1, json(references));
    store.event(chatId, 'illustration-references.updated', chatId);
    return illustrationReferences(store, chatId);
  });
}
/** Resolved once at reservation; missing images are dropped rather than blocking the job. */
export function frozenIllustrationReferences(
  store: Store,
  chatId: string
): FrozenIllustrationReference[] {
  const candidates = new Map(
    illustrationReferenceCandidates(store, chatId).map((asset) => [asset.id, asset])
  );
  return illustrationReferences(store, chatId).references.flatMap((item) => {
    const asset = candidates.get(item.ref);
    if (!asset) return [];
    return [{ ...item, title: asset.title, mime: asset.mime, hash: asset.hash, url: asset.url }];
  });
}
export function loadIllustrationReference(
  store: Store,
  reference: FrozenIllustrationReference
): { mime: string; bytes: Buffer } | undefined {
  try {
    if (reference.ref.startsWith('package:')) {
      const hash = /^\/api\/package-image-blobs\/([a-f0-9]{64})$/u.exec(reference.url)?.[1];
      if (!hash || hash !== reference.hash) return undefined;
      const blob = store.product.get<PackageImageBlob>('package-image', hash, 1);
      return { mime: blob.mime, bytes: Buffer.from(blob.base64, 'base64') };
    }
    const { asset, bytes } = store.product.asset(reference.ref);
    if (asset.hash !== reference.hash) return undefined;
    return { mime: asset.mime, bytes };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------
export type IllustrationJobRow = {
  id: string;
  chatId: string;
  sourceRevision: string;
  sourceHash: string;
  origin: 'automatic' | 'manual';
  status: IllustrationStatus;
  generation: number;
  owner: string | null;
  attempt: number;
  input: IllustrationJobInput;
  diagnostic: IllustrationDiagnostic | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};
const mapRow = (row: Row): IllustrationJobRow => ({
  id: row.id,
  chatId: row.chat_id,
  sourceRevision: row.source_revision,
  sourceHash: row.source_hash,
  origin: row.origin,
  status: row.status,
  generation: Number(row.generation),
  owner: row.owner ?? null,
  attempt: Number(row.attempt),
  input: parse(row.input),
  diagnostic: parse(row.diagnostic),
  error: row.error ?? null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
export function illustrationJob(store: Store, id: string): IllustrationJobRow {
  const row = store.db.prepare('SELECT * FROM illustration_jobs WHERE id=?').get(id) as
    | Row
    | undefined;
  if (!row) throw new HttpError(404, 'Illustration not found');
  return mapRow(row);
}
function images(store: Store, jobId: string): IllustrationImage[] {
  return (
    store.db
      .prepare(
        'SELECT id,mime,hash,position,body FROM illustration_images WHERE job_id=? ORDER BY position'
      )
      .all(jobId) as Row[]
  ).map((row) => {
    const body = parse(row.body) ?? {};
    return {
      id: row.id,
      url: `/api/illustration-images/${row.id}`,
      mime: row.mime,
      hash: row.hash,
      position: Number(row.position),
      caption: typeof body.caption === 'string' ? body.caption : '',
      ...(typeof body.prompt === 'string' ? { prompt: body.prompt } : {}),
      ...(typeof body.revisedPrompt === 'string' ? { revisedPrompt: body.revisedPrompt } : {}),
    };
  });
}
export function projectIllustration(store: Store, row: IllustrationJobRow): Illustration {
  return {
    id: row.id,
    chatId: row.chatId,
    sourceRevision: row.sourceRevision,
    sourceHash: row.sourceHash,
    origin: row.origin,
    generator: row.input.generator,
    status: row.status,
    attempt: row.attempt,
    maxAutoRetries: row.input.maxAutoRetries,
    error: row.error,
    ...(row.diagnostic ? { diagnostic: row.diagnostic } : {}),
    images: images(store, row.id),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
export function illustrationsForSources(store: Store, sourceIds: string[]): Illustration[] {
  if (!sourceIds.length) return [];
  return (
    store.db
      .prepare(
        `SELECT * FROM illustration_jobs WHERE source_revision IN (SELECT value FROM json_each(?)) ORDER BY created_at,id`
      )
      .all(json(sourceIds)) as Row[]
  ).map((row) => projectIllustration(store, mapRow(row)));
}
export function illustrationsForChat(store: Store, chatId: string): Illustration[] {
  store.chat(chatId);
  return (
    store.db
      .prepare('SELECT * FROM illustration_jobs WHERE chat_id=? ORDER BY created_at,id')
      .all(chatId) as Row[]
  ).map((row) => projectIllustration(store, mapRow(row)));
}
/** Skipped automatic runs hold no image and do not consume a slot. */
export function illustrationSlots(
  store: Store,
  sourceId: string
): { total: number; active: number } {
  const row = store.db
    .prepare(
      "SELECT SUM(status IN ('queued','running')) AS active,SUM(status='completed' AND EXISTS(SELECT 1 FROM illustration_images i WHERE i.job_id=illustration_jobs.id)) AS finished FROM illustration_jobs WHERE source_revision=?"
    )
    .get(sourceId) as Row;
  const active = Number(row.active ?? 0);
  return { total: active + Number(row.finished ?? 0), active };
}
export type ReserveOptions = {
  testMode?: boolean;
  settings?: IllustrationSettings;
  fixture?: { failures?: number; delayMs?: number };
};
function frozenInput(
  store: Store,
  source: Source,
  settings: IllustrationSettings,
  options: ReserveOptions
): IllustrationJobInput {
  const base = {
    version: 1 as const,
    settingsRevision: settings.revision,
    styleGuidance: settings.styleGuidance,
    maxAutoRetries: settings.maxAutoRetries,
  };
  if (settings.generator === 'codex') {
    if (!settings.codex.model) throw new HttpError(409, 'ILLUSTRATION_MODEL_REQUIRED');
    const model = store.product.modelSnapshot(settings.codex.model.id, 'illustration');
    if (model.connection.protocol !== 'codex-app-server-v1')
      throw new HttpError(409, 'ILLUSTRATION_CODEX_CONNECTION_REQUIRED');
    return {
      ...base,
      generator: 'codex',
      codex: {
        model,
        references: settings.codex.useReferences
          ? frozenIllustrationReferences(store, source.chatId)
          : [],
      },
    };
  }
  if (settings.generator === 'comfyui') {
    if (!settings.comfyui.baseUrl) throw new HttpError(409, 'COMFYUI_UNCONFIGURED');
    if (!settings.comfyui.workflow.trim()) throw new HttpError(409, 'COMFYUI_WORKFLOW_MISSING');
    try {
      parseComfyWorkflow(settings.comfyui.workflow);
    } catch (error) {
      httpFromIllustration(error, 409);
    }
    if (!settings.comfyui.promptModel)
      throw new HttpError(409, 'ILLUSTRATION_PROMPT_MODEL_REQUIRED');
    const promptModel = store.product.modelSnapshot(
      settings.comfyui.promptModel.id,
      'illustration'
    );
    return {
      ...base,
      generator: 'comfyui',
      comfyui: {
        baseUrl: settings.comfyui.baseUrl,
        authorizationEnv: settings.comfyui.authorizationEnv,
        workflow: settings.comfyui.workflow,
        timeoutMs: settings.comfyui.timeoutMs,
        pollIntervalMs: settings.comfyui.pollIntervalMs,
        negativeGuidance: settings.comfyui.negativeGuidance,
        promptModel,
      },
    };
  }
  if (settings.generator === 'fixture' && options.testMode)
    return {
      ...base,
      generator: 'fixture',
      fixture: {
        failures: Math.max(0, Math.min(10, options.fixture?.failures ?? 0)),
        delayMs: Math.max(0, Math.min(10_000, options.fixture?.delayMs ?? 0)),
      },
    };
  throw new HttpError(409, 'ILLUSTRATION_GENERATOR_UNCONFIGURED');
}
/** One active job per response; completed plus active jobs are bounded by the settings. */
export function reserveIllustration(
  store: Store,
  source: Source,
  origin: 'automatic' | 'manual',
  options: ReserveOptions = {}
): IllustrationJobRow {
  return store.transaction(() => {
    const settings = options.settings ?? illustrationSettings(store);
    if (settings.generator === 'none')
      throw new HttpError(409, 'ILLUSTRATION_GENERATOR_UNCONFIGURED');
    const slots = illustrationSlots(store, source.id);
    if (slots.active > 0) throw new HttpError(409, 'ILLUSTRATION_ACTIVE');
    if (slots.total >= settings.maxPerSource)
      throw new HttpError(409, 'ILLUSTRATION_LIMIT_REACHED');
    const input = frozenInput(store, source, settings, options);
    const id = randomUUID(),
      time = now();
    store.db
      .prepare(
        "INSERT INTO illustration_jobs(id,chat_id,source_revision,source_hash,origin,status,generation,owner,attempt,input,diagnostic,error,created_at,updated_at) VALUES(?,?,?,?,?,'queued',0,NULL,1,?,NULL,NULL,?,?)"
      )
      .run(id, source.chatId, source.id, source.hash, origin, json(input), time, time);
    store.event(source.chatId, 'illustration.queued', id);
    return illustrationJob(store, id);
  });
}
const reservationFailureCode = (error: unknown): string => {
  if (error instanceof HttpError) {
    if (error.message.startsWith('MODEL_UNAVAILABLE:')) return 'ILLUSTRATION_MODEL_UNAVAILABLE';
    if (/^[A-Z][A-Z0-9_]*$/u.test(error.message)) return error.message;
  }
  return 'ILLUSTRATION_RESERVATION_FAILED';
};
/** Called inside the source commit transaction. Limits are silent; configuration errors are visible. */
export function scheduleAutomaticIllustration(store: Store, source: Source): void {
  const settings = illustrationSettings(store);
  if (!settings.automatic || settings.generator === 'none') return;
  try {
    reserveIllustration(store, source, 'automatic', { settings, testMode: true });
  } catch (error) {
    const code = reservationFailureCode(error);
    if (code === 'ILLUSTRATION_LIMIT_REACHED' || code === 'ILLUSTRATION_ACTIVE') return;
    const id = randomUUID(),
      time = now();
    const input: IllustrationJobInput = {
      version: 1,
      generator: settings.generator,
      settingsRevision: settings.revision,
      styleGuidance: settings.styleGuidance,
      maxAutoRetries: settings.maxAutoRetries,
    };
    store.db
      .prepare(
        "INSERT INTO illustration_jobs(id,chat_id,source_revision,source_hash,origin,status,generation,owner,attempt,input,diagnostic,error,created_at,updated_at) VALUES(?,?,?,?,'automatic','failed',0,NULL,1,?,?,?,?,?)"
      )
      .run(
        id,
        source.chatId,
        source.id,
        source.hash,
        json(input),
        json({ stage: 'preparation', code, attempts: [], retries: [] }),
        code,
        time,
        time
      );
    store.event(source.chatId, 'illustration.failed', id);
  }
}
export function queuedIllustrations(store: Store): string[] {
  return (
    store.db
      .prepare("SELECT id FROM illustration_jobs WHERE status='queued' ORDER BY created_at,id")
      .all() as Row[]
  ).map((row) => row.id);
}
export function claimIllustration(
  store: Store,
  id: string,
  owner: string
): { job: IllustrationJobRow; source: Source } | null {
  return store.transaction(() => {
    const pending = illustrationJob(store, id);
    if (pending.status !== 'queued') return null;
    const source = store.sourceAtHash(pending.sourceRevision, pending.sourceHash);
    const changed = store.db
      .prepare(
        "UPDATE illustration_jobs SET status='running',generation=generation+1,owner=?,error=NULL,updated_at=? WHERE id=? AND status='queued'"
      )
      .run(owner, now(), id);
    if (!changed.changes) return null;
    store.event(pending.chatId, 'illustration.running', id);
    return { job: illustrationJob(store, id), source };
  });
}
const owned = (store: Store, id: string, generation: number, owner: string): Row | undefined =>
  store.db
    .prepare(
      "SELECT * FROM illustration_jobs WHERE id=? AND generation=? AND owner=? AND status='running'"
    )
    .get(id, generation, owner) as Row | undefined;
export function updateIllustrationDiagnostic(
  store: Store,
  id: string,
  generation: number,
  owner: string,
  diagnostic: IllustrationDiagnostic
): boolean {
  const changed = store.db
    .prepare(
      "UPDATE illustration_jobs SET diagnostic=?,updated_at=? WHERE id=? AND generation=? AND owner=? AND status='running'"
    )
    .run(json(diagnostic), now(), id, generation, owner);
  return changed.changes > 0;
}
export type GeneratedIllustration = {
  mime: IllustrationImageMime;
  bytes: Buffer;
  caption: string;
  prompt?: string;
  revisedPrompt?: string;
};
export function completeIllustration(
  store: Store,
  id: string,
  generation: number,
  owner: string,
  generated: GeneratedIllustration[],
  diagnostic: IllustrationDiagnostic
): boolean {
  return store.transaction(() => {
    const row = owned(store, id, generation, owner);
    if (!row || (!generated.length && typeof diagnostic.skipped !== 'string')) return false;
    if (generated.some((image) => !isValidIllustrationImage(image.bytes, image.mime)))
      throw new IllustrationError('ILLUSTRATION_IMAGE_INVALID');
    const time = now();
    generated.forEach((image, position) => {
      store.db
        .prepare(
          'INSERT INTO illustration_images(id,job_id,chat_id,position,mime,hash,body,bytes,created_at) VALUES(?,?,?,?,?,?,?,?,?)'
        )
        .run(
          randomUUID(),
          id,
          row.chat_id,
          position,
          image.mime,
          createHash('sha256').update(image.bytes).digest('hex'),
          json({
            caption: image.caption,
            ...(image.prompt ? { prompt: image.prompt } : {}),
            ...(image.revisedPrompt ? { revisedPrompt: image.revisedPrompt } : {}),
          }),
          image.bytes,
          time
        );
    });
    store.db
      .prepare(
        "UPDATE illustration_jobs SET status='completed',owner=NULL,error=NULL,diagnostic=?,updated_at=? WHERE id=?"
      )
      .run(json(diagnostic), time, id);
    store.event(row.chat_id, 'illustration.completed', id);
    return true;
  });
}
export function failIllustration(
  store: Store,
  id: string,
  generation: number,
  owner: string,
  status: 'failed' | 'cancelled' | 'interrupted',
  code: string,
  diagnostic: IllustrationDiagnostic
): boolean {
  return store.transaction(() => {
    const row = owned(store, id, generation, owner);
    if (!row) return false;
    store.db
      .prepare(
        'UPDATE illustration_jobs SET status=?,owner=NULL,error=?,diagnostic=?,updated_at=? WHERE id=?'
      )
      .run(status, code, json(diagnostic), now(), id);
    store.event(row.chat_id, `illustration.${status}`, id);
    return true;
  });
}
/** Automatic re-queue keeps the frozen input; the failure stays visible in the diagnostic. */
export function requeueIllustration(
  store: Store,
  id: string,
  generation: number,
  owner: string,
  code: string,
  diagnostic: IllustrationDiagnostic
): boolean {
  return store.transaction(() => {
    const row = owned(store, id, generation, owner);
    if (!row) return false;
    const next: IllustrationDiagnostic = {
      ...diagnostic,
      code,
      retries: [...diagnostic.retries, { attempt: Number(row.attempt), code, at: now() }],
    };
    store.db
      .prepare(
        "UPDATE illustration_jobs SET status='queued',owner=NULL,error=NULL,attempt=attempt+1,diagnostic=?,updated_at=? WHERE id=?"
      )
      .run(json(next), now(), id);
    store.event(row.chat_id, 'illustration.queued', id);
    return true;
  });
}
export function retryIllustration(store: Store, id: string): Illustration {
  return store.transaction(() => {
    const job = illustrationJob(store, id);
    if (!RETRYABLE_STATUSES.includes(job.status))
      throw new HttpError(409, 'ILLUSTRATION_NOT_RETRYABLE');
    if (job.error === 'ILLUSTRATION_GENERATOR_UNCONFIGURED' || !job.input.generator)
      throw new HttpError(409, 'ILLUSTRATION_GENERATOR_UNCONFIGURED');
    if (!job.input.codex && !job.input.comfyui && !job.input.fixture)
      throw new HttpError(409, job.error ?? 'ILLUSTRATION_GENERATOR_UNCONFIGURED');
    store.sourceAtHash(job.sourceRevision, job.sourceHash);
    assertIllustrationSlot(store, job.sourceRevision);
    if (job.input.comfyui?.disabled) throw new HttpError(409, 'CONNECTION_NOT_AUTHORIZED');
    if (
      job.input.generator === 'comfyui' &&
      job.diagnostic?.comfyui &&
      !['finished', 'rejected', 'not-sent'].includes(job.diagnostic.comfyui.submission ?? '') &&
      !['COMFYUI_EXECUTION_FAILED', 'COMFYUI_NO_IMAGE'].includes(job.error ?? '') &&
      (job.diagnostic.comfyui.promptId || job.diagnostic.comfyui.submission === 'uncertain')
    )
      throw new HttpError(409, 'COMFYUI_RESULT_UNAVAILABLE');
    const diagnostic: IllustrationDiagnostic = {
      stage: 'preparation',
      attempts: job.diagnostic?.attempts ?? [],
      retries: [
        ...(job.diagnostic?.retries ?? []),
        { attempt: job.attempt, code: job.error ?? job.status.toUpperCase(), at: now() },
      ],
    };
    store.db
      .prepare(
        "UPDATE illustration_jobs SET status='queued',owner=NULL,error=NULL,attempt=attempt+1,diagnostic=?,updated_at=? WHERE id=?"
      )
      .run(json(diagnostic), now(), id);
    store.event(job.chatId, 'illustration.queued', id);
    return projectIllustration(store, illustrationJob(store, id));
  });
}
/** Re-reading an accepted remote prompt is not a new render; the job briefly runs under the caller. */
export function claimIllustrationForReconcile(
  store: Store,
  id: string,
  owner: string
): {
  job: IllustrationJobRow;
  promptId: string;
  previous: { status: 'failed' | 'cancelled' | 'interrupted'; error: string | null };
} {
  return store.transaction(() => {
    const job = illustrationJob(store, id);
    const promptId = job.diagnostic?.comfyui?.promptId;
    if (job.input.generator !== 'comfyui' || !job.input.comfyui || !promptId)
      throw new HttpError(409, 'ILLUSTRATION_NOT_RECONCILABLE');
    if (!RETRYABLE_STATUSES.includes(job.status))
      throw new HttpError(409, 'ILLUSTRATION_NOT_RECONCILABLE');
    if (job.input.comfyui.disabled) throw new HttpError(409, 'CONNECTION_NOT_AUTHORIZED');
    assertIllustrationSlot(store, job.sourceRevision);
    store.sourceAtHash(job.sourceRevision, job.sourceHash);
    store.db
      .prepare(
        "UPDATE illustration_jobs SET status='running',generation=generation+1,owner=?,updated_at=? WHERE id=?"
      )
      .run(owner, now(), id);
    store.event(job.chatId, 'illustration.running', id);
    return {
      job: illustrationJob(store, id),
      promptId,
      previous: {
        status: job.status as 'failed' | 'cancelled' | 'interrupted',
        error: job.error,
      },
    };
  });
}
function assertIllustrationSlot(store: Store, sourceId: string) {
  const slots = illustrationSlots(store, sourceId);
  if (slots.active > 0) throw new HttpError(409, 'ILLUSTRATION_ACTIVE');
  if (slots.total >= illustrationSettings(store).maxPerSource)
    throw new HttpError(409, 'ILLUSTRATION_LIMIT_REACHED');
}
function deleteIllustrationAttempts(store: Store, jobs: Row[]) {
  for (const job of jobs) {
    const ids = parse(job.diagnostic)?.attempts ?? [];
    store.db
      .prepare(
        "DELETE FROM attempts WHERE chat_id=? AND role='illustration' AND run_id IS NULL AND job_id IS NULL AND story_job_id IS NULL AND id IN (SELECT value FROM json_each(?))"
      )
      .run(job.chat_id, json(ids));
  }
}
/** Bumping the generation makes a late worker result fall through owner checks. */
export function cancelIllustration(store: Store, id: string): Illustration {
  return store.transaction(() => {
    const job = illustrationJob(store, id);
    if (ACTIVE.includes(job.status)) {
      store.db
        .prepare(
          "UPDATE illustration_jobs SET status='cancelled',owner=NULL,generation=generation+1,error='ILLUSTRATION_CANCELLED',updated_at=? WHERE id=?"
        )
        .run(now(), id);
      store.event(job.chatId, 'illustration.cancelled', id);
    }
    return projectIllustration(store, illustrationJob(store, id));
  });
}
export function removeIllustration(
  store: Store,
  id: string
): { chatId: string; sourceRevision: string } {
  return store.transaction(() => {
    const job = illustrationJob(store, id);
    if (ACTIVE.includes(job.status)) throw new HttpError(409, 'ILLUSTRATION_ACTIVE');
    deleteIllustrationAttempts(store, [{ chat_id: job.chatId, diagnostic: json(job.diagnostic) }]);
    store.db.prepare('DELETE FROM illustration_images WHERE job_id=?').run(id);
    store.db.prepare('DELETE FROM illustration_jobs WHERE id=?').run(id);
    store.event(job.chatId, 'source.illustrations', job.sourceRevision);
    return { chatId: job.chatId, sourceRevision: job.sourceRevision };
  });
}
/** Server restart: running work is uncertain and is never replayed; queued work resumes. */
export function recoverIllustrations(store: Store): void {
  store.transaction(() => {
    for (const row of store.db
      .prepare("SELECT id,chat_id FROM illustration_jobs WHERE status='running'")
      .all() as Row[]) {
      store.db
        .prepare(
          "UPDATE illustration_jobs SET status='interrupted',owner=NULL,generation=generation+1,error='ILLUSTRATION_INTERRUPTED',updated_at=? WHERE id=?"
        )
        .run(now(), row.id);
      store.event(row.chat_id, 'illustration.interrupted', row.id);
    }
  });
}
export function deleteIllustrationsForSources(store: Store, sourceIds: string[]): void {
  if (!sourceIds.length) return;
  deleteIllustrationAttempts(
    store,
    store.db
      .prepare(
        'SELECT chat_id,diagnostic FROM illustration_jobs WHERE source_revision IN (SELECT value FROM json_each(?))'
      )
      .all(json(sourceIds)) as Row[]
  );
  store.db
    .prepare(
      'DELETE FROM illustration_images WHERE job_id IN (SELECT id FROM illustration_jobs WHERE source_revision IN (SELECT value FROM json_each(?)))'
    )
    .run(json(sourceIds));
  store.db
    .prepare(
      'DELETE FROM illustration_jobs WHERE source_revision IN (SELECT value FROM json_each(?))'
    )
    .run(json(sourceIds));
}
/** Completed illustrations of the exact copied text travel with a fork; active work does not. */
export function copyIllustrationsForFork(
  store: Store,
  newChatId: string,
  sources: { oldId: string; newId: string; hash: string }[]
): void {
  for (const source of sources) {
    const jobs = store.db
      .prepare(
        "SELECT * FROM illustration_jobs WHERE source_revision=? AND source_hash=? AND status='completed' ORDER BY created_at,id"
      )
      .all(source.oldId, source.hash) as Row[];
    for (const job of jobs) {
      const jobId = randomUUID();
      const originalDiagnostic = parse(job.diagnostic);
      const copiedDiagnostic = originalDiagnostic
        ? {
            ...originalDiagnostic,
            attempts: [],
            copiedFrom: { jobId: job.id, attemptIds: originalDiagnostic.attempts ?? [] },
          }
        : null;
      store.db
        .prepare(
          "INSERT INTO illustration_jobs(id,chat_id,source_revision,source_hash,origin,status,generation,owner,attempt,input,diagnostic,error,created_at,updated_at) VALUES(?,?,?,?,?,'completed',?,NULL,?,?,?,NULL,?,?)"
        )
        .run(
          jobId,
          newChatId,
          source.newId,
          job.source_hash,
          job.origin,
          job.generation,
          job.attempt,
          job.input,
          copiedDiagnostic === null ? null : json(copiedDiagnostic),
          job.created_at,
          job.updated_at
        );
      for (const image of store.db
        .prepare('SELECT * FROM illustration_images WHERE job_id=? ORDER BY position')
        .all(job.id) as Row[])
        store.db
          .prepare(
            'INSERT INTO illustration_images(id,job_id,chat_id,position,mime,hash,body,bytes,created_at) VALUES(?,?,?,?,?,?,?,?,?)'
          )
          .run(
            randomUUID(),
            jobId,
            newChatId,
            image.position,
            image.mime,
            image.hash,
            image.body,
            image.bytes,
            image.created_at
          );
    }
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
export function illustrationRoutes(
  app: FastifyInstance,
  store: Store,
  hooks: {
    publish: (chatId: string) => void;
    pump: () => void;
    abort: (id: string) => void;
    testMode: boolean;
    /** Reads an accepted remote result without rendering again; provided by the app runner. */
    reconcile: (id: string) => Promise<Illustration>;
    resolveCredential?: (
      envReference: string,
      connection?: undefined,
      signal?: AbortSignal
    ) => string | undefined | Promise<string | undefined>;
  }
) {
  app.get('/api/illustration-settings', async (_request, reply) =>
    reply.header('Cache-Control', 'no-store').send(illustrationSettings(store))
  );
  app.put('/api/illustration-settings', { bodyLimit: 2_000_000 }, async (request) => {
    const settings = updateIllustrationSettings(store, request.body, hooks.testMode);
    for (const chat of store.chats())
      store.event(chat.id, 'illustration-settings.updated', chat.id);
    for (const chat of store.chats()) hooks.publish(chat.id);
    return settings;
  });
  app.post('/api/illustration-settings/comfyui/test', async (request, reply) => {
    const b = record(request.body);
    fields(b, ['baseUrl', 'authorizationEnv']);
    const authorizationEnv = text(b.authorizationEnv ?? '', 'ComfyUI credential env', 128, true);
    reply.header('Cache-Control', 'no-store');
    try {
      const baseUrl = validateComfyBaseUrl(text(b.baseUrl, 'ComfyUI address', 2000));
      return await comfyUISystemStats(
        { baseUrl, authorizationEnv },
        { signal: AbortSignal.timeout(10_000), resolveCredential: hooks.resolveCredential }
      );
    } catch (error) {
      if (error instanceof IllustrationError)
        throw new HttpError(
          error.code === 'COMFYUI_BASE_URL_INVALID' ? 400 : 502,
          JSON.stringify({ code: error.code, comfyui: error.diagnostic.comfyui ?? {} })
        );
      throw error;
    }
  });
  app.get<{ Params: { id: string } }>(
    '/api/chats/:id/illustration-references',
    async (request, reply) => {
      const chatId = request.params.id;
      const current = illustrationReferences(store, chatId);
      const roles = new Map(current.references.map((item) => [item.ref, item.role]));
      return reply.header('Cache-Control', 'no-store').send({
        ...current,
        candidates: illustrationReferenceCandidates(store, chatId).map((asset) => ({
          ref: asset.id,
          title: asset.title,
          url: asset.url,
          mime: asset.mime,
          role: roles.get(asset.id) ?? null,
        })),
      });
    }
  );
  app.put<{ Params: { id: string } }>('/api/chats/:id/illustration-references', async (request) => {
    const saved = updateIllustrationReferences(store, request.params.id, request.body);
    hooks.publish(saved.chatId);
    return saved;
  });
  app.get<{ Params: { id: string } }>('/api/chats/:id/illustrations', async (request) =>
    illustrationsForChat(store, request.params.id)
  );
  app.post<{ Params: { id: string } }>('/api/sources/:id/illustrations', async (request) => {
    const b = record(request.body ?? {});
    fields(b, ['expectedSourceHash', 'fixture']);
    const source = store.source(request.params.id);
    if (
      b.expectedSourceHash !== undefined &&
      text(b.expectedSourceHash, 'source hash', 64) !== source.hash
    )
      throw new HttpError(409, 'ILLUSTRATION_SOURCE_CHANGED');
    let fixture: ReserveOptions['fixture'];
    if (b.fixture !== undefined) {
      if (!hooks.testMode) throw new HttpError(400, 'Unknown request field');
      const f = record(b.fixture);
      fields(f, ['failures', 'delayMs']);
      fixture = {
        ...(f.failures !== undefined ? { failures: number(f.failures, 'failures', 0, 10) } : {}),
        ...(f.delayMs !== undefined ? { delayMs: number(f.delayMs, 'delayMs', 0, 10_000) } : {}),
      };
    }
    const job = reserveIllustration(store, source, 'manual', { testMode: hooks.testMode, fixture });
    hooks.publish(job.chatId);
    hooks.pump();
    return projectIllustration(store, job);
  });
  app.get<{ Params: { id: string } }>('/api/illustrations/:id', async (request) => {
    const job = illustrationJob(store, request.params.id);
    return { ...projectIllustration(store, job), input: job.input };
  });
  app.post<{ Params: { id: string } }>('/api/illustrations/:id/retry', async (request) => {
    fields(record(request.body ?? {}), []);
    const job = retryIllustration(store, request.params.id);
    hooks.publish(job.chatId);
    hooks.pump();
    return job;
  });
  app.post<{ Params: { id: string } }>('/api/illustrations/:id/reconcile', async (request) => {
    fields(record(request.body ?? {}), []);
    const job = await hooks.reconcile(request.params.id);
    hooks.publish(job.chatId);
    return job;
  });
  app.post<{ Params: { id: string } }>('/api/illustrations/:id/cancel', async (request) => {
    fields(record(request.body ?? {}), []);
    const job = cancelIllustration(store, request.params.id);
    hooks.abort(job.id);
    hooks.publish(job.chatId);
    return job;
  });
  app.delete<{ Params: { id: string } }>('/api/illustrations/:id', async (request) => {
    const removed = removeIllustration(store, request.params.id);
    hooks.publish(removed.chatId);
    return { deleted: true };
  });
  app.get<{ Params: { id: string } }>('/api/illustration-images/:id', async (request, reply) => {
    const row = store.db
      .prepare('SELECT mime,bytes FROM illustration_images WHERE id=?')
      .get(request.params.id) as Row | undefined;
    if (!row) throw new HttpError(404, 'Illustration image not found');
    return reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'private, max-age=31536000, immutable')
      .type(row.mime)
      .send(Buffer.from(row.bytes));
  });
}
