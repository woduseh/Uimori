import { successfulTranslation } from './translation-artifacts.js';
import type {
  IllustrationStoryboard,
  IllustrationTarget,
  IllustrationMoment,
} from '../core/illustration-storyboard.js';
import {
  illustrationPresentation,
  newIllustrationPresentation,
  saveIllustrationPresentation,
  illustrationDisplay,
  selectCompletedIllustration,
  selectRequestedIllustration,
  forgetIllustrationJob,
  changeIllustrationHero,
} from './illustration-presentation.js';
import { detachAttemptUsage } from './usage-accounting.js';
import { effectiveIllustrationPreset } from './illustration-presets.js';
import { illustrationPresetStamp } from '../core/illustration-presets.js';
import { storeImage } from './image-storage.js';
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

/** Create current tables during fresh database initialization. */
export function initIllustrations(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS illustration_settings (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS illustration_references (chat_id TEXT PRIMARY KEY REFERENCES chats(id), revision INTEGER NOT NULL, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS illustration_jobs (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id), source_revision TEXT NOT NULL REFERENCES sources(id), source_hash TEXT NOT NULL, origin TEXT NOT NULL CHECK(origin IN ('automatic','manual')), status TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0, owner TEXT, attempt INTEGER NOT NULL DEFAULT 1, input TEXT NOT NULL, diagnostic TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS illustration_jobs_source ON illustration_jobs(source_revision,created_at);
    CREATE INDEX IF NOT EXISTS illustration_jobs_chat ON illustration_jobs(chat_id,created_at);
    CREATE TABLE IF NOT EXISTS illustration_images (id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES illustration_jobs(id), chat_id TEXT NOT NULL REFERENCES chats(id), position INTEGER NOT NULL, mime TEXT NOT NULL, hash TEXT NOT NULL REFERENCES image_blobs(hash), body TEXT NOT NULL, created_at TEXT NOT NULL);
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
    'automaticMaxTargets',
    'maxAutoRetries',
    'codex',
    'comfyui',
  ]);
  if (!ILLUSTRATION_GENERATORS.includes(b.generator)) throw new HttpError(400, 'Invalid generator');
  if (b.generator === 'fixture' && !options.testMode)
    throw new HttpError(400, 'Fixture generator requires test mode');
  const codex = record(b.codex);
  fields(codex, ['model', 'useReferences']);
  const comfyui = record(b.comfyui);
  fields(comfyui, ['baseUrl', 'authorizationEnv', 'timeoutMs', 'pollIntervalMs', 'promptModel']);
  const baseUrl = text(comfyui.baseUrl, 'ComfyUI address', 2000, true).trim();
  const authorizationEnv = text(comfyui.authorizationEnv, 'ComfyUI credential env', 128, true);
  if (authorizationEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(authorizationEnv))
    throw new HttpError(400, 'Invalid ComfyUI credential env');
  return {
    revision: options.revision,
    generator: b.generator,
    automatic: boolean(b.automatic, 'automatic'),
    automaticMaxTargets: number(
      b.automaticMaxTargets ?? 1,
      'automaticMaxTargets',
      1,
      ILLUSTRATION_MAX_PER_SOURCE
    ),
    maxPerSource: number(b.maxPerSource, 'maxPerSource', 1, ILLUSTRATION_MAX_PER_SOURCE),
    maxAutoRetries: number(b.maxAutoRetries, 'maxAutoRetries', 0, ILLUSTRATION_MAX_AUTO_RETRIES),
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
      timeoutMs: number(comfyui.timeoutMs, 'ComfyUI timeout', 10_000, 1_800_000),
      pollIntervalMs: number(comfyui.pollIntervalMs, 'ComfyUI poll interval', 250, 10_000),
      promptModel: modelRef(comfyui.promptModel, 'illustration prompt model'),
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
      ...(typeof body.width === 'number' && typeof body.height === 'number'
        ? { width: body.width, height: body.height }
        : {}),
      ...(typeof body.prompt === 'string' ? { prompt: body.prompt } : {}),
      ...(typeof body.revisedPrompt === 'string' ? { revisedPrompt: body.revisedPrompt } : {}),
    };
  });
}
export function projectIllustration(
  store: Store,
  row: IllustrationJobRow,
  presentation = illustrationPresentation(store, row.sourceRevision, row.sourceHash)
): Illustration {
  const target = row.input.target;
  return {
    id: row.id,
    task: row.input.task ?? 'render',
    ...(target
      ? {
          target: {
            id: target.id,
            planId: target.planId,
            order: target.order,
            startAnchor: target.startAnchor,
            endAnchor: target.endAnchor,
            focus: target.focus,
          },
        }
      : {}),
    ...(target && presentation ? { display: illustrationDisplay(presentation, row.input) } : {}),
    chatId: row.chatId,
    sourceRevision: row.sourceRevision,
    sourceHash: row.sourceHash,
    origin: row.origin,
    generator: row.input.generator,
    ...(row.input.preset ? { preset: row.input.preset } : {}),
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
  const presentations = new Map(sourceIds.map((id) => [id, illustrationPresentation(store, id)]));
  return (
    store.db
      .prepare(
        `SELECT * FROM illustration_jobs WHERE source_revision IN (SELECT value FROM json_each(?)) ORDER BY created_at,id`
      )
      .all(json(sourceIds)) as Row[]
  ).map((row) => {
    const presentation = presentations.get(row.source_revision);
    const item = projectIllustration(
      store,
      mapRow(row),
      presentation?.sourceHash === row.source_hash ? presentation : null
    );
    if (item.diagnostic) {
      const {
        prompt: _prompt,
        promptRequestHash: _hash,
        revisedPrompt: _revised,
        storyboard: _board,
        afterByTarget: _mapping,
        ...small
      } = item.diagnostic;
      item.diagnostic = small;
    }
    item.images = item.images.map(
      ({ prompt: _prompt, revisedPrompt: _revised, ...image }) => image
    );
    return item;
  });
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
  const sourceHash = store.source(sourceId).hash;
  const rows = store.db
    .prepare(`SELECT id,status,input,EXISTS(SELECT 1 FROM illustration_images i WHERE i.job_id=j.id) AS hasImage
    FROM illustration_jobs j WHERE source_revision=? AND source_hash=?`)
    .all(sourceId, sourceHash);
  const targets = new Set<string>();
  let active = 0,
    planned = 0;
  for (const row of rows) {
    const input = parse(row.input) as IllustrationJobInput;
    const running = ACTIVE.includes(row.status as IllustrationStatus);
    if (input.task === 'placement') continue;
    if (running) active++;
    if (input.task === 'plan') {
      if (running) planned += input.plan?.maxTargets ?? 1;
    } else if (running || (row.status === 'completed' && row.hasImage))
      targets.add(input.target?.id ?? String(row.id));
  }
  return { total: planned + targets.size, active };
}
export type ReserveOptions = {
  testMode?: boolean;
  settings?: IllustrationSettings;
  fixture?: { failures?: number; delayMs?: number };
  maxTargets?: number;
  requestKey?: string;
};
function frozenInput(
  store: Store,
  source: Source,
  settings: IllustrationSettings,
  options: ReserveOptions
): IllustrationJobInput {
  const preset = effectiveIllustrationPreset(store, source.chatId);
  const base = {
    preset: illustrationPresetStamp(preset),
    version: 1 as const,
    settingsRevision: settings.revision,
    styleGuidance: preset.styleGuidance,
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
    if (!preset.comfyui.workflow.trim()) throw new HttpError(409, 'COMFYUI_WORKFLOW_MISSING');
    try {
      parseComfyWorkflow(preset.comfyui.workflow);
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
        workflow: preset.comfyui.workflow,
        timeoutMs: settings.comfyui.timeoutMs,
        pollIntervalMs: settings.comfyui.pollIntervalMs,
        negativeGuidance: preset.comfyui.negativeGuidance,
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

/** The plan reserves its cut budget before any model call. Existing single renders remain readable. */
export function reserveIllustrationPlan(
  store: Store,
  source: Source,
  origin: 'automatic' | 'manual',
  options: ReserveOptions = {}
): IllustrationJobRow {
  return store.transaction(() => {
    const settings = options.settings ?? illustrationSettings(store);
    if (options.requestKey) {
      const previous = store.db
        .prepare(
          "SELECT * FROM illustration_jobs WHERE source_revision=? AND json_extract(input,'$.plan.requestKey')=?"
        )
        .get(source.id, options.requestKey) as Row | undefined;
      if (previous) {
        const job = mapRow(previous);
        if (job.sourceHash !== source.hash) throw new HttpError(409, 'ILLUSTRATION_SOURCE_CHANGED');
        return job;
      }
    }
    if (
      store.db
        .prepare(
          "SELECT 1 FROM illustration_jobs WHERE source_revision=? AND source_hash=? AND status IN ('queued','running') AND json_extract(input,'$.task')='plan'"
        )
        .get(source.id, source.hash)
    )
      throw new HttpError(409, 'ILLUSTRATION_PLAN_ACTIVE');
    const available = settings.maxPerSource - illustrationSlots(store, source.id).total;
    if (available <= 0) throw new HttpError(409, 'ILLUSTRATION_LIMIT_REACHED');
    const maxTargets = Math.min(available, options.maxTargets ?? 1);
    const input: IllustrationJobInput = {
      ...frozenInput(store, source, settings, options),
      task: 'plan',
      plan: {
        maxTargets,
        existingTargets: illustrationTargets(store, source).map(
          ({ startAnchor, endAnchor, focus }) => ({ startAnchor, endAnchor, focus })
        ),
        ...(options.requestKey ? { requestKey: options.requestKey } : {}),
      },
    };
    return insertIllustrationJob(store, source, origin, input);
  });
}
function insertIllustrationJob(
  store: Store,
  source: Source,
  origin: 'automatic' | 'manual',
  input: IllustrationJobInput,
  time = now()
): IllustrationJobRow {
  const id = randomUUID();
  store.db
    .prepare(
      "INSERT INTO illustration_jobs(id,chat_id,source_revision,source_hash,origin,status,input,created_at,updated_at) VALUES(?,?,?,?,?,'queued',?,?,?)"
    )
    .run(id, source.chatId, source.id, source.hash, origin, json(input), time, time);
  store.event(source.chatId, 'illustration.queued', id);
  return illustrationJob(store, id);
}
export function illustrationTargets(
  store: Store,
  source: Pick<Source, 'id' | 'hash'>
): IllustrationTarget[] {
  const presentation = illustrationPresentation(store, source.id, source.hash);
  if (!presentation) return [];
  const ids = Object.values(presentation.targets).map((target) => target.latestRequestedJobId);
  return store.db
    .prepare(
      'SELECT input FROM illustration_jobs WHERE id IN (SELECT value FROM json_each(?)) ORDER BY created_at,id'
    )
    .all(json(ids))
    .map((row) => (parse(row.input) as IllustrationJobInput).target)
    .filter((target): target is IllustrationTarget => !!target);
}
/** This short transaction is the only place a completed plan can create render jobs. */
export function completeIllustrationStoryboard(
  store: Store,
  job: IllustrationJobRow,
  owner: string,
  storyboard: IllustrationStoryboard,
  diagnostic: IllustrationDiagnostic
): boolean {
  return store.transaction(() => {
    if (!owned(store, job.id, job.generation, owner)) return false;
    const source = store.sourceAtHash(job.sourceRevision, job.sourceHash);
    const existingAnchors = new Set(
      illustrationTargets(store, source).map((target) => target.endAnchor)
    );
    if (storyboard.targets.some((target) => existingAnchors.has(target.endAnchor)))
      throw new IllustrationError('ILLUSTRATION_TARGET_CONFLICT');
    const previous = illustrationPresentation(store, source.id);
    const current =
      previous?.sourceHash === source.hash ? previous : newIllustrationPresentation(source.hash);
    if (previous && previous.sourceHash !== source.hash) current.revision = previous.revision;
    const queuedAt = now();
    for (const [index, planned] of storyboard.targets.entries()) {
      const target: IllustrationTarget = {
        ...planned,
        id: randomUUID(),
        planId: job.id,
        order: index === storyboard.heroIndex ? 0 : index + 1,
      };
      const { plan: _plan, ...recipe } = job.input;
      const child = insertIllustrationJob(
        store,
        source,
        job.origin,
        { ...recipe, task: 'render', target },
        queuedAt
      );
      current.targets[target.id] = { latestRequestedJobId: child.id, displayedJobId: null };
      if (!current.heroTargetId && index === storyboard.heroIndex) current.heroTargetId = target.id;
    }
    // An old plan may finish after an edit; retain its images without replacing a newer layout.
    if (store.source(source.id).hash === source.hash || previous?.sourceHash === source.hash)
      saveIllustrationPresentation(store, source.id, current);
    const result = {
      ...diagnostic,
      storyboard,
      ...(storyboard.skipReason ? { skipped: storyboard.skipReason } : {}),
    };
    completeIllustrationTextJob(store, job, owner, result);
    scheduleIllustrationPlacement(store, source.id);
    return true;
  });
}
function completeIllustrationTextJob(
  store: Store,
  job: IllustrationJobRow,
  owner: string,
  diagnostic: IllustrationDiagnostic
): boolean {
  if (!owned(store, job.id, job.generation, owner)) return false;
  store.db
    .prepare(
      "UPDATE illustration_jobs SET status='completed',owner=NULL,error=NULL,diagnostic=?,updated_at=? WHERE id=?"
    )
    .run(json(diagnostic), now(), job.id);
  store.event(job.chatId, 'illustration.completed', job.id);
  return true;
}
export function illustrationTargetSet(targets: IllustrationTarget[]): {
  moments: (IllustrationMoment & { id: string })[];
  hash: string;
} {
  const moments = targets
    .map(({ id, startAnchor, endAnchor, focus }) => ({ id, startAnchor, endAnchor, focus }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { moments, hash: createHash('sha256').update(json(moments)).digest('hex') };
}
/** Called at either completion edge, never by Reader GET. Maps all targets in one text call. */
export function scheduleIllustrationPlacement(store: Store, sourceId: string): void {
  const source = store.source(sourceId);
  const presentation = illustrationPresentation(store, source.id, source.hash);
  const translation = successfulTranslation(store, source);
  if (!presentation || !translation?.translationLayout) return;
  const targets = illustrationTargets(store, source);
  if (!targets.length) return;
  const set = illustrationTargetSet(targets);
  const target = {
    mode: 'translation' as const,
    textHash: translation.translationLayout.textHash,
    translationJobId: translation.id,
    translationRevision: translation.revision ?? 1,
  };
  if (
    presentation.translation?.targetSetHash === set.hash &&
    presentation.translation.target.textHash === target.textHash
  )
    return;
  const existing = store.db
    .prepare(`SELECT * FROM illustration_jobs WHERE source_revision=? AND source_hash=? AND json_extract(input,'$.task')='placement'
    AND json_extract(input,'$.placement.targetSetHash')=? AND json_extract(input,'$.placement.target.textHash')=? ORDER BY created_at DESC LIMIT 1`)
    .get(source.id, source.hash, set.hash, target.textHash) as Row | undefined;
  if (existing) {
    const saved = mapRow(existing);
    if (saved.status === 'completed' && saved.diagnostic?.afterByTarget) {
      presentation.translation = {
        target,
        targetSetHash: set.hash,
        afterByTarget: saved.diagnostic.afterByTarget,
      };
      saveIllustrationPresentation(store, source.id, presentation);
    }
    return;
  }
  const first = presentation.targets[targets[0].id];
  const recipe = illustrationJob(store, first.latestRequestedJobId).input;
  // A restored chat contains results, not credentials or runnable recipes.
  if (!recipe.codex && !recipe.comfyui && !recipe.fixture) return;
  const { plan: _plan, target: _target, placement: _placement, ...base } = recipe;
  insertIllustrationJob(store, source, 'automatic', {
    ...base,
    task: 'placement',
    placement: { target, targetSetHash: set.hash, targets: set.moments },
  });
}
export function completeIllustrationPlacement(
  store: Store,
  job: IllustrationJobRow,
  owner: string,
  afterByTarget: Record<string, string | null>,
  diagnostic: IllustrationDiagnostic
): boolean {
  return store.transaction(() => {
    if (!completeIllustrationTextJob(store, job, owner, { ...diagnostic, afterByTarget }))
      return false;
    const source = store.source(job.sourceRevision);
    const input = job.input.placement!;
    const presentation = illustrationPresentation(store, source.id, job.sourceHash);
    const translation = successfulTranslation(store, source);
    if (
      presentation &&
      source.hash === job.sourceHash &&
      translation?.translationLayout?.textHash === input.target.textHash &&
      illustrationTargetSet(illustrationTargets(store, source)).hash === input.targetSetHash
    ) {
      presentation.translation = {
        target: input.target,
        targetSetHash: input.targetSetHash,
        afterByTarget,
      };
      saveIllustrationPresentation(store, source.id, presentation);
    }
    return true;
  });
}
export function regenerateIllustration(
  store: Store,
  id: string,
  testMode = false
): IllustrationJobRow {
  return store.transaction(() => {
    const job = illustrationJob(store, id);
    const source = store.source(job.sourceRevision);
    if (source.hash !== job.sourceHash) throw new HttpError(409, 'ILLUSTRATION_SOURCE_CHANGED');
    if (!job.input.target) throw new HttpError(409, 'ILLUSTRATION_TARGET_UNAVAILABLE');
    if (ACTIVE.includes(job.status)) throw new HttpError(409, 'ILLUSTRATION_ACTIVE');
    assertIllustrationSlot(store, source.id, job);
    const { prompt: _prompt, ...target } = job.input.target;
    const input = {
      ...frozenInput(store, source, illustrationSettings(store), { testMode }),
      task: 'render' as const,
      target,
    };
    const next = insertIllustrationJob(store, source, 'manual', input);
    selectRequestedIllustration(store, source.id, source.hash, input, next.id);
    return next;
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
    reserveIllustrationPlan(store, source, 'automatic', {
      settings,
      testMode: true,
      maxTargets: settings.automaticMaxTargets ?? 1,
      requestKey: `automatic:${source.hash}`,
    });
  } catch (error) {
    const code = reservationFailureCode(error);
    if (
      code === 'ILLUSTRATION_LIMIT_REACHED' ||
      code === 'ILLUSTRATION_ACTIVE' ||
      code === 'ILLUSTRATION_PLAN_ACTIVE'
    )
      return;
    const id = randomUUID(),
      time = now();
    const preset = effectiveIllustrationPreset(store, source.chatId);
    const input: IllustrationJobInput = {
      preset: illustrationPresetStamp(preset),
      version: 1,
      task: 'plan',
      generator: settings.generator,
      settingsRevision: settings.revision,
      styleGuidance: preset.styleGuidance,
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
      .prepare(
        "SELECT id FROM illustration_jobs WHERE status='queued' ORDER BY created_at,COALESCE(json_extract(input,'$.target.order'),0),id"
      )
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
  width?: number;
  height?: number;
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
      const hash = createHash('sha256').update(image.bytes).digest('hex');
      storeImage(store.db, { hash, mime: image.mime, bytes: Buffer.from(image.bytes) });
      store.db
        .prepare(
          'INSERT INTO illustration_images(id,job_id,chat_id,position,mime,hash,body,created_at) VALUES(?,?,?,?,?,?,?,?)'
        )
        .run(
          randomUUID(),
          id,
          row.chat_id,
          position,
          image.mime,
          hash,
          json({
            caption: image.caption,
            ...(image.width && image.height ? { width: image.width, height: image.height } : {}),
            ...(image.prompt ? { prompt: image.prompt } : {}),
            ...(image.revisedPrompt ? { revisedPrompt: image.revisedPrompt } : {}),
          }),
          time
        );
    });
    store.db
      .prepare(
        "UPDATE illustration_jobs SET status='completed',owner=NULL,error=NULL,diagnostic=?,updated_at=? WHERE id=?"
      )
      .run(json(diagnostic), time, id);
    if (generated.length)
      selectCompletedIllustration(
        store,
        row.source_revision,
        row.source_hash,
        parse(row.input),
        id
      );
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
    assertIllustrationSlot(store, job.sourceRevision, job);
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
      prompt: job.diagnostic?.prompt,
      promptRequestHash: job.diagnostic?.promptRequestHash,
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
    selectRequestedIllustration(store, job.sourceRevision, job.sourceHash, job.input, id);
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
    assertNoActiveIllustrationTarget(store, job);
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
function assertNoActiveIllustrationTarget(store: Store, job: IllustrationJobRow) {
  const target = job.input.target?.id;
  const collision = store.db
    .prepare(`SELECT 1 FROM illustration_jobs WHERE source_revision=? AND source_hash=? AND status IN ('queued','running')
    AND id!=? AND ${target ? "json_extract(input,'$.target.id')=?" : "COALESCE(json_extract(input,'$.task'),'render')!='placement'"} LIMIT 1`)
    .get(job.sourceRevision, job.sourceHash, job.id, ...(target ? [target] : []));
  if (collision) throw new HttpError(409, 'ILLUSTRATION_ACTIVE');
}
function assertIllustrationSlot(store: Store, sourceId: string, job: IllustrationJobRow) {
  if (job.input.task === 'placement') return;
  if (job.input.task === 'plan') {
    if (
      store.db
        .prepare(
          "SELECT 1 FROM illustration_jobs WHERE source_revision=? AND source_hash=? AND status IN ('queued','running') AND json_extract(input,'$.task')='plan' AND id!=?"
        )
        .get(sourceId, job.sourceHash, job.id)
    )
      throw new HttpError(409, 'ILLUSTRATION_PLAN_ACTIVE');
    if (
      illustrationSlots(store, sourceId).total + (job.input.plan?.maxTargets ?? 1) >
      illustrationSettings(store).maxPerSource
    )
      throw new HttpError(409, 'ILLUSTRATION_LIMIT_REACHED');
    return;
  }
  assertNoActiveIllustrationTarget(store, job);
  const target = job.input.target?.id;
  const alreadyCounted =
    target &&
    store.db
      .prepare(`SELECT 1 FROM illustration_jobs j WHERE source_revision=? AND source_hash=? AND json_extract(input,'$.target.id')=?
    AND status='completed' AND EXISTS(SELECT 1 FROM illustration_images i WHERE i.job_id=j.id) LIMIT 1`)
      .get(sourceId, job.sourceHash, target);
  if (
    !alreadyCounted &&
    illustrationSlots(store, sourceId).total >= illustrationSettings(store).maxPerSource
  )
    throw new HttpError(409, 'ILLUSTRATION_LIMIT_REACHED');
}
function deleteIllustrationAttempts(store: Store, jobs: Row[]) {
  for (const job of jobs) {
    const ids = parse(job.diagnostic)?.attempts ?? [];
    const existing = store.db
      .prepare(
        "SELECT id FROM attempts WHERE chat_id=? AND role='illustration' AND run_id IS NULL AND job_id IS NULL AND id IN (SELECT value FROM json_each(?))"
      )
      .all(job.chat_id, json(ids));
    detachAttemptUsage(
      store.db,
      existing.map((row) => String(row.id))
    );
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
    const targetId = job.input.target?.id;
    const rows = targetId
      ? (store.db
          .prepare(
            "SELECT * FROM illustration_jobs WHERE source_revision=? AND source_hash=? AND json_extract(input,'$.target.id')=?"
          )
          .all(job.sourceRevision, job.sourceHash, targetId) as Row[])
      : [{ id, chat_id: job.chatId, diagnostic: json(job.diagnostic), status: job.status }];
    if (rows.some((row) => ACTIVE.includes(row.status)))
      throw new HttpError(409, 'ILLUSTRATION_ACTIVE');
    deleteIllustrationAttempts(store, rows);
    for (const row of rows) {
      store.db.prepare('DELETE FROM illustration_images WHERE job_id=?').run(row.id);
      store.db.prepare('DELETE FROM illustration_jobs WHERE id=?').run(row.id);
    }
    forgetIllustrationJob(store, job.sourceRevision, job.sourceHash, job.input, id);
    scheduleIllustrationPlacement(store, job.sourceRevision);
    store.event(job.chatId, 'illustration-layout.updated', job.sourceRevision);
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
  app.put('/api/illustration-settings', { bodyLimit: 32 * 1024 * 1024 }, async (request) => {
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
    fields(b, ['expectedSourceHash', 'fixture', 'maxTargets', 'idempotencyKey']);
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
    const job = reserveIllustrationPlan(store, source, 'manual', {
      testMode: hooks.testMode,
      fixture,
      maxTargets:
        b.maxTargets === undefined
          ? 1
          : number(b.maxTargets, 'maxTargets', 1, ILLUSTRATION_MAX_PER_SOURCE),
      requestKey:
        b.idempotencyKey === undefined ? undefined : text(b.idempotencyKey, 'idempotencyKey', 200),
    });
    hooks.publish(job.chatId);
    hooks.pump();
    return projectIllustration(store, job);
  });
  app.patch<{ Params: { id: string } }>(
    '/api/sources/:id/illustration-presentation',
    async (request) => {
      const b = record(request.body);
      fields(b, ['expectedSourceHash', 'expectedRevision', 'heroTargetId']);
      const value = changeIllustrationHero(
        store,
        request.params.id,
        text(b.expectedSourceHash, 'source hash', 64),
        number(b.expectedRevision, 'revision', 0),
        b.heroTargetId === null ? null : text(b.heroTargetId, 'target', 100)
      );
      hooks.publish(store.source(request.params.id).chatId);
      return value;
    }
  );
  app.post<{ Params: { id: string } }>('/api/illustrations/:id/regenerate', async (request) => {
    fields(record(request.body ?? {}), []);
    const job = regenerateIllustration(store, request.params.id, hooks.testMode);
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
    hooks.pump();
    return { deleted: true };
  });
  app.get<{ Params: { id: string } }>('/api/illustration-images/:id', async (request, reply) => {
    const row = store.db
      .prepare(
        'SELECT b.mime,b.bytes FROM illustration_images i JOIN image_blobs b ON b.hash=i.hash WHERE i.id=?'
      )
      .get(request.params.id) as Row | undefined;
    if (!row) throw new HttpError(404, 'Illustration image not found');
    return reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'private, max-age=31536000, immutable')
      .type(row.mime)
      .send(Buffer.from(row.bytes));
  });
}
