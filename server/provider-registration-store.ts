import { HttpError, fields, number, record, text } from './request-validation.js';
import {
  GENERATION_KEYS,
  generationFromModel,
  modelCapability,
  validateGenerationShape,
} from '../core/model-capabilities.js';
import { validCredentialEnv } from '../core/credential-reference.js';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  PROVIDER_PROTOCOLS,
  validateProviderEndpoint,
  type Connection,
  type ContentRef,
  type ModelPreset,
  type ModelSnapshot,
} from '../core/product.js';
import { validateEvaluationToolOptions } from '../core/evaluation-tool-config.js';
import type { ProviderResult, WireRecord } from '../core/transport.js';
import {
  REGISTRATION_LIMITS,
  type RegistrationConnectionDraft,
  type RegistrationPlan,
  type RegistrationRun,
  type RegistrationView,
} from '../core/provider-registration.js';
import type { ProductStore } from './product-store.js';
import { validateModelSnapshot } from './product-store.js';

const kind = 'registration-run';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ref = (value: unknown): ContentRef => {
  const b = record(value);
  fields(b, ['id', 'revision']);
  return { id: text(b.id, 'reference', 100), revision: number(b.revision, 'revision') };
};
const connectionFields = ['title', 'protocol', 'endpoint', 'credentialEnv', 'enabled'];
const modelFields = [
  'title',
  'modelId',
  ...GENERATION_KEYS,
  'timeoutMs',
  'evaluationTools',
  'enabled',
];
const pick = (value: Record<string, unknown>, keys: string[]) =>
  Object.fromEntries(
    keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]])
  );

/** No settings write. New-connection previews validate a synthetic reference through the same model validator. */
export function normalizeRegistrationPlan(
  product: ProductStore,
  value: unknown,
  options: { connectionSnapshot?: Connection } = {}
): RegistrationPlan {
  const b = record(value);
  fields(b, ['connection', 'model']);
  const selection = record(b.connection);
  let connection: Connection;
  let normalized: RegistrationPlan['connection'];
  if (selection.kind === 'existing') {
    fields(selection, ['kind', 'id', 'revision']);
    const requested = ref({ id: selection.id, revision: selection.revision });
    connection = options.connectionSnapshot ?? product.get<Connection>('connection', requested.id);
    if (connection.id !== requested.id || connection.revision !== requested.revision)
      throw new HttpError(409, 'Connection changed; review a new proposal');
    normalized = { kind: 'existing', ...requested };
  } else if (selection.kind === 'new') {
    fields(selection, ['kind', 'draft']);
    const draft = record(selection.draft);
    fields(draft, connectionFields);
    if (draft.enabled !== false)
      throw new HttpError(400, 'New proposed connections must start disabled');
    const prepared = product.prepareConnection(draft).value;
    connection = { ...prepared, id: 'pending-connection', revision: 1 };
    normalized = {
      kind: 'new',
      draft: pick(prepared, connectionFields) as RegistrationConnectionDraft,
    };
  } else throw new HttpError(400, 'Unsupported registration connection');
  const model = record(b.model);
  fields(model, modelFields);
  const prepared = product.prepareModel(
    { ...model, connectionId: connection.id },
    undefined,
    connection
  ).value;
  return {
    connection: normalized,
    model: pick(prepared, modelFields) as RegistrationPlan['model'],
  };
}

/** Registration decisions retain their own immutable snapshots; provider settings have only one current row. */
export class RegistrationStore {
  constructor(readonly product: ProductStore) {}
  get db() {
    return this.product.db;
  }
  get(id: string): RegistrationRun {
    return this.product.get<RegistrationRun>(kind, id);
  }
  byKey(key: string): RegistrationView {
    if (!/^[A-Za-z0-9-]{8,120}$/u.test(key)) throw new HttpError(400, 'Invalid request key');
    return this.view('registration-' + hash(key).slice(0, 48));
  }
  private persist(body: RegistrationRun, expected?: number): RegistrationRun {
    const row = this.db
      .prepare('SELECT revision,body FROM versions WHERE kind=? AND id=?')
      .get(kind, body.id) as { revision: number; body: string } | undefined;
    if ((row?.revision ?? 0) !== (expected ?? 0))
      throw new HttpError(409, 'Registration revision conflict');
    const next = { ...body, revision: (row?.revision ?? 0) + 1 };
    validateRegistrationTransition(
      next,
      row ? (JSON.parse(row.body) as RegistrationRun) : undefined
    );
    validateRegistrationArchive(next);
    if (row) {
      const updated = this.db
        .prepare('UPDATE versions SET revision=?,body=? WHERE kind=? AND id=? AND revision=?')
        .run(next.revision, JSON.stringify(next), kind, next.id, row.revision);
      if (updated.changes !== 1) throw new HttpError(409, 'Registration revision conflict');
    } else {
      this.db
        .prepare('INSERT INTO versions VALUES(?,?,?,?)')
        .run(kind, next.id, next.revision, JSON.stringify(next));
    }
    return next;
  }
  create(value: unknown): { run: RegistrationRun; created: boolean; target: ModelSnapshot } {
    const b = record(value);
    fields(b, ['key', 'request', 'target']);
    const key = text(b.key, 'request key', 120);
    if (!/^[A-Za-z0-9-]{8,120}$/u.test(key)) throw new HttpError(400, 'Invalid request key');
    const request = text(b.request, 'registration request', REGISTRATION_LIMITS.requestCharacters);
    if (
      /\bsk-[A-Za-z0-9_-]{12,}|\bAIza[\w-]{20,}|\bBearer\s+\S{12,}|-----BEGIN [^-]*PRIVATE KEY/u.test(
        request
      )
    )
      throw new HttpError(400, 'Do not include credentials in the registration request');
    const targetRef = ref(b.target);
    const id = 'registration-' + hash(key).slice(0, 48),
      intentHash = hash({ request, target: targetRef });
    const previous = this.db
      .prepare('SELECT body FROM versions WHERE kind=? AND id=?')
      .get(kind, id) as { body: string } | undefined;
    if (previous) {
      const run = JSON.parse(previous.body) as RegistrationRun;
      if (run.intentHash !== intentHash)
        throw new HttpError(409, 'Request key reused with different input');
      return { run, created: false, target: structuredClone(run.targetSnapshot) };
    }
    const current = this.product.get<ModelPreset>('model', targetRef.id);
    if (current.enabled === false)
      throw new HttpError(409, 'Registration assistant model is disabled');
    if (current.revision !== targetRef.revision)
      throw new HttpError(409, 'Registration assistant model changed');
    const model = current;
    const connection = this.product.authorize(
      this.product.get<Connection>('connection', model.connectionId)
    );
    const secret = connection.credentialEnv ? process.env[connection.credentialEnv] : undefined;
    if (secret && request.includes(secret))
      throw new HttpError(400, 'Do not include credentials in the registration request');
    const targetSnapshot: ModelSnapshot = structuredClone({ ...model, connection });
    const run: RegistrationRun = {
      id,
      revision: 0,
      intentHash,
      createdAt: new Date().toISOString(),
      finishedAt: null,
      status: 'running',
      request,
      target: targetRef,
      connection: { id: connection.id, revision: connection.revision },
      targetSnapshot,
      attempts: [],
      plan: null,
      planHash: null,
      planConnectionSnapshot: null,
      error: null,
      applied: null,
      appliedSnapshot: null,
    };
    return { run: this.persist(run), created: true, target: structuredClone(targetSnapshot) };
  }
  startAttempt(id: string, wire: WireRecord): string {
    const run = this.get(id);
    if (run.status !== 'running' || run.attempts.length >= REGISTRATION_LIMITS.maxCalls)
      throw new HttpError(409, 'Registration request is no longer admitted');
    const safe = structuredClone(wire);
    // The same redacted diagnostic wire as narrative attempts; opaque state is never retained.
    if (
      safe.body &&
      typeof safe.body === 'object' &&
      !Array.isArray(safe.body) &&
      'opaqueState' in safe.body
    )
      safe.body.opaqueState = '[provider continuation withheld]';
    const attempt = {
      id: randomUUID(),
      request: safe,
      status: 'running',
      usage: null,
      error: null,
    };
    this.persist({ ...run, attempts: [...run.attempts, attempt] }, run.revision);
    return attempt.id;
  }
  finishAttempt(id: string, attemptId: string, result: ProviderResult) {
    const run = this.get(id);
    const attempt = run.attempts.find((item) => item.id === attemptId);
    if (!attempt || attempt.status !== 'running')
      throw new HttpError(409, 'Attempt already finished');
    // Store only usage and safe error codes, never model text, arbitrary fields or opaque results.
    const usage = {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      costUsd: result.usage.costUsd,
      raw: null,
      priceRevision: result.usage.priceRevision,
    };
    const attempts = run.attempts.map((item) =>
      item.id === attemptId
        ? { ...item, status: result.status, usage, error: result.error?.code ?? null }
        : item
    );
    this.persist({ ...run, attempts }, run.revision);
  }
  finish(
    id: string,
    status: 'ready' | 'failed' | 'cancelled',
    proposal?: unknown,
    error: string | null = null
  ) {
    const run = this.get(id);
    if (run.status !== 'running') return run;
    const plan = status === 'ready' ? normalizeRegistrationPlan(this.product, proposal) : null;
    const planConnectionSnapshot =
      plan?.connection.kind === 'existing'
        ? this.product.get<Connection>('connection', plan.connection.id, plan.connection.revision)
        : null;
    return this.persist(
      {
        ...run,
        status,
        plan,
        planHash: plan ? hash(plan) : null,
        planConnectionSnapshot,
        error,
        finishedAt: new Date().toISOString(),
      },
      run.revision
    );
  }
  recover() {
    for (const run of this.product.all(kind) as RegistrationRun[])
      if (run.status === 'running')
        this.persist(
          {
            ...run,
            status: 'interrupted',
            error: 'SERVER_INTERRUPTED_NO_AUTOMATIC_REPLAY',
            finishedAt: new Date().toISOString(),
          },
          run.revision
        );
  }
  view(id: string): RegistrationView {
    const {
      intentHash: _intent,
      attempts,
      targetSnapshot: _target,
      planConnectionSnapshot: _planConnection,
      appliedSnapshot: _applied,
      ...run
    } = this.get(id);
    return { ...run, modelCalls: attempts.length, usage: attempts.at(-1)?.usage ?? null };
  }
  apply(id: string, value: unknown): RegistrationRun {
    const b = record(value);
    fields(b, ['expectedRevision', 'planHash']);
    const expected = number(b.expectedRevision, 'registration revision');
    const planHash = text(b.planHash, 'plan hash', 64);
    return this.product.store.transaction(() => {
      const run = this.get(id);
      // Idempotent replay returns the exact original result, never another registration.
      if (run.status === 'applied' && run.planHash === planHash) return run;
      if (
        run.revision !== expected ||
        run.status !== 'ready' ||
        run.planHash !== planHash ||
        !run.plan
      )
        throw new HttpError(409, 'Registration proposal changed');
      const plan = normalizeRegistrationPlan(this.product, run.plan);
      if (!isDeepStrictEqual(plan, run.plan))
        throw new HttpError(409, 'Registration validation changed; review a new proposal');
      let connection: Connection;
      if (plan.connection.kind === 'existing')
        connection = this.product.get<Connection>(
          'connection',
          plan.connection.id,
          plan.connection.revision
        );
      else {
        const prepared = this.product.prepareConnection(plan.connection.draft).value;
        connection = this.product.saveInTransaction('connection', prepared) as Connection;
      }
      const prepared = this.product.prepareModel({
        ...plan.model,
        connectionId: connection.id,
      }).value;
      const model = this.product.saveInTransaction('model', prepared) as ModelPreset;
      return this.persist(
        {
          ...run,
          status: 'applied',
          applied: {
            connection: { id: connection.id, revision: connection.revision },
            model: { id: model.id, revision: model.revision },
          },
          appliedSnapshot: structuredClone({ connection, model }),
        },
        run.revision
      );
    });
  }
}

const validHash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
function date(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new HttpError(400, 'Invalid registration date');
}
function code(value: unknown) {
  if (value !== null && (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]{0,199}$/u.test(value)))
    throw new HttpError(400, 'Invalid registration error');
}
const attemptStatuses = [
  'running',
  'completed',
  'tool_calls',
  'refused',
  'partial',
  'error',
  'cancelled',
];
function validateWire(value: unknown) {
  const wire = record(value);
  fields(wire, [
    'connectionId',
    'protocol',
    'role',
    'modelId',
    'method',
    'url',
    'headers',
    'body',
    'bodySha256',
    'stablePrefixSha256',
  ]);
  text(wire.connectionId, 'wire connection', 100);
  text(wire.modelId, 'wire model', 300);
  if (
    !PROVIDER_PROTOCOLS.includes(wire.protocol) ||
    wire.role !== 'main' ||
    (wire.protocol === 'codex-app-server-v1'
      ? wire.method !== 'RPC' || wire.url !== 'codex://local'
      : wire.method !== 'POST') ||
    !validHash(wire.bodySha256) ||
    !validHash(wire.stablePrefixSha256)
  )
    throw new HttpError(400, 'Invalid registration wire');
  const url = new URL(text(wire.url, 'wire URL', 2200));
  if (url.username || url.password || url.hash)
    throw new HttpError(400, 'Invalid registration URL');
  const headers = record(wire.headers);
  for (const [key, value] of Object.entries(headers)) {
    text(value, 'wire header', 2000);
    if (
      /[\r\n]/u.test(value as string) ||
      (/^(authorization|x-api-key|api[_-]?key|credential|secret|password|access[_-]?token)$/iu.test(
        key
      ) &&
        value !== '[REDACTED]')
    )
      throw new HttpError(400, 'Unsafe registration header');
  }
  const inspect = (value: unknown, depth = 0): void => {
    if (depth > 100) throw new HttpError(400, 'Invalid registration diagnostic');
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    )
      return;
    if (Array.isArray(value)) {
      value.forEach((item) => {
        inspect(item, depth + 1);
      });
      return;
    }
    const b = record(value);
    for (const [key, item] of Object.entries(b)) {
      if (
        /^(opaqueState|opaque_state|encrypted_content|encrypted_data|signature|thoughtSignature|authorization|x-api-key|api[_-]?key|credential|secret|password|access[_-]?token)$/iu.test(
          key
        ) &&
        item !== null &&
        !(typeof item === 'string' && /^\[(?:REDACTED|provider .+ withheld)\]$/u.test(item))
      )
        throw new HttpError(400, 'Unsafe registration diagnostic');
      inspect(item, depth + 1);
    }
  };
  inspect(wire.body);
}

/** Strict local schema; execution and review snapshots are independent of current settings. */
export function validateRegistrationArchive(value: unknown) {
  const b = record(value);
  fields(b, [
    'id',
    'revision',
    'intentHash',
    'createdAt',
    'finishedAt',
    'status',
    'request',
    'target',
    'connection',
    'targetSnapshot',
    'attempts',
    'plan',
    'planHash',
    'planConnectionSnapshot',
    'error',
    'applied',
    'appliedSnapshot',
  ]);
  if (typeof b.id !== 'string' || !/^registration-[a-f0-9]{48}$/u.test(b.id))
    throw new HttpError(400, 'Invalid registration ID');
  number(b.revision, 'revision');
  ref(b.target);
  ref(b.connection);
  const target = validateModelSnapshot(b.targetSnapshot);
  if (
    !isDeepStrictEqual({ id: target.id, revision: target.revision }, b.target) ||
    !isDeepStrictEqual(
      { id: target.connection.id, revision: target.connection.revision },
      b.connection
    )
  )
    throw new HttpError(400, 'Registration target snapshot mismatch');
  if (!validHash(b.intentHash) || b.intentHash !== hash({ request: b.request, target: b.target }))
    throw new HttpError(400, 'Invalid registration hash');
  text(b.request, 'registration request', REGISTRATION_LIMITS.requestCharacters);
  date(b.createdAt);
  if (b.finishedAt !== null) date(b.finishedAt);
  if (
    !['running', 'ready', 'failed', 'cancelled', 'interrupted', 'applied'].includes(b.status) ||
    (b.status === 'running') !== (b.finishedAt === null)
  )
    throw new HttpError(400, 'Invalid registration status');
  code(b.error);
  if (!Array.isArray(b.attempts) || b.attempts.length > REGISTRATION_LIMITS.maxCalls)
    throw new HttpError(400, 'Invalid registration attempts');
  const attemptIds = new Set<string>();
  for (const attempt of b.attempts) {
    const a = record(attempt);
    fields(a, ['id', 'request', 'status', 'usage', 'error']);
    text(a.id, 'attempt ID', 100);
    if (attemptIds.has(a.id)) throw new HttpError(400, 'Duplicate registration attempt');
    attemptIds.add(a.id);
    validateWire(a.request);
    if (!attemptStatuses.includes(a.status)) throw new HttpError(400, 'Invalid attempt status');
    code(a.error);
    if (a.usage !== null) {
      const usage = record(a.usage);
      fields(usage, ['inputTokens', 'outputTokens', 'costUsd', 'raw', 'priceRevision']);
      for (const key of ['inputTokens', 'outputTokens'])
        if (usage[key] !== null) number(usage[key], 'token usage', 0, Number.MAX_SAFE_INTEGER);
      if (
        usage.costUsd !== null &&
        (typeof usage.costUsd !== 'number' || !Number.isFinite(usage.costUsd) || usage.costUsd < 0)
      )
        throw new HttpError(400, 'Invalid registration cost');
      if (usage.raw !== null) throw new HttpError(400, 'Registration raw usage is not retained');
      if (usage.priceRevision !== null) text(usage.priceRevision, 'price revision', 200);
    }
    if (
      (a.status === 'running') !== (a.usage === null) ||
      (a.status === 'running' && a.error !== null)
    )
      throw new HttpError(400, 'Invalid attempt state');
  }
  if (
    ['ready', 'applied'].includes(b.status) &&
    (b.attempts.length !== 1 || !['completed', 'tool_calls'].includes(b.attempts[0].status))
  )
    throw new HttpError(400, 'Registration proposal lacks completed attempt');
  if (b.plan === null) {
    if (
      b.planHash !== null ||
      b.planConnectionSnapshot !== null ||
      b.applied !== null ||
      b.appliedSnapshot !== null ||
      ['ready', 'applied'].includes(b.status)
    )
      throw new HttpError(400, 'Invalid registration plan');
  } else {
    if (!['ready', 'applied'].includes(b.status))
      throw new HttpError(400, 'Unexpected registration plan');
    const plan = record(b.plan);
    fields(plan, ['connection', 'model']);
    const c = record(plan.connection);
    if (c.kind === 'existing') {
      fields(c, ['kind', 'id', 'revision']);
      ref({ id: c.id, revision: c.revision });
      const captured = record(b.planConnectionSnapshot),
        draft = record(plan.model);
      if (captured.id !== c.id || captured.revision !== c.revision)
        throw new HttpError(400, 'Registration review connection mismatch');
      validateModelSnapshot({
        ...draft,
        id: 'registration-plan-preview',
        revision: 1,
        connectionId: captured.id,
        capabilityRevision: modelCapability(captured.protocol, draft.modelId)?.revision,
        connection: captured,
      });
    } else if (c.kind === 'new') {
      fields(c, ['kind', 'draft']);
      if (b.planConnectionSnapshot !== null)
        throw new HttpError(400, 'Unexpected registration review connection');
      const draft = record(c.draft);
      fields(draft, connectionFields);
      if (draft.enabled !== false || !PROVIDER_PROTOCOLS.includes(draft.protocol))
        throw new HttpError(400, 'Invalid proposed authority');
      text(draft.title, 'connection title', 200);
      validateProviderEndpoint(draft.protocol, text(draft.endpoint, 'endpoint', 2000));
      if (draft.credentialEnv !== undefined && !validCredentialEnv(draft.credentialEnv))
        throw new HttpError(400, 'Invalid credential reference');
    } else throw new HttpError(400, 'Invalid proposed connection');
    const model = record(plan.model);
    fields(model, modelFields);
    text(model.title, 'model title', 200);
    text(model.modelId, 'model ID', 300);
    number(model.maxOutputTokens, 'output limit', 1, 500000);
    if (
      model.temperature !== null &&
      (typeof model.temperature !== 'number' ||
        !Number.isFinite(model.temperature) ||
        model.temperature < 0 ||
        model.temperature > 2)
    )
      throw new HttpError(400, 'Invalid temperature');
    if (model.timeoutMs !== undefined) number(model.timeoutMs, 'timeout', 1, 1800000);
    for (const key of ['enabled', 'structuredOutput'])
      if (model[key] !== undefined && typeof model[key] !== 'boolean')
        throw new HttpError(400, 'Invalid model boolean');
    try {
      validateGenerationShape(generationFromModel(model as ModelPreset));
    } catch {
      throw new HttpError(400, 'Invalid model option');
    }
    if (model.thinkingBudgetTokens !== undefined)
      number(model.thinkingBudgetTokens, 'thinking budget', 1024, model.maxOutputTokens - 1);
    if (model.evaluationTools !== undefined) validateEvaluationToolOptions(model.evaluationTools);
    if (!validHash(b.planHash) || b.planHash !== hash(b.plan))
      throw new HttpError(400, 'Registration plan hash mismatch');
  }
  if (b.applied !== null) {
    const applied = record(b.applied);
    fields(applied, ['connection', 'model']);
    ref(applied.connection);
    ref(applied.model);
    if (b.status !== 'applied') throw new HttpError(400, 'Invalid applied registration');
    const snapshot = record(b.appliedSnapshot);
    fields(snapshot, ['connection', 'model']);
    const model = validateModelSnapshot({
      ...record(snapshot.model),
      connection: snapshot.connection,
    });
    if (
      !isDeepStrictEqual(applied.model, { id: model.id, revision: model.revision }) ||
      !isDeepStrictEqual(applied.connection, {
        id: model.connection.id,
        revision: model.connection.revision,
      })
    )
      throw new HttpError(400, 'Registration applied snapshot mismatch');
  } else if (b.status === 'applied' || b.appliedSnapshot !== null)
    throw new HttpError(400, 'Missing applied registration');
}

/** Strip restored/exported connection authority without changing proposal hashes or human-authored text. */
export function normalizeRegistrationArchiveRow(row: Record<string, any>): void {
  if (row.kind !== kind) return;
  const run = JSON.parse(String(row.body)) as RegistrationRun;
  for (const connection of [
    run.targetSnapshot?.connection,
    run.planConnectionSnapshot,
    run.appliedSnapshot?.connection,
  ])
    if (connection) {
      delete connection.credentialEnv;
      connection.enabled = false;
    }
  row.body = JSON.stringify(run);
}

/** Validate historical plans against their captured review and application, never current settings. */
export function validateRegistrationGraph(product: ProductStore) {
  const rows = product.db
    .prepare("SELECT body FROM versions WHERE kind='registration-run' ORDER BY id")
    .all() as { body: string }[];
  const seen = new Set<string>();
  const applications = new Map<string, string>();
  for (const row of rows) {
    const run = JSON.parse(row.body) as RegistrationRun;
    validateRegistrationArchive(run);
    if (seen.has(run.id)) throw new HttpError(400, 'Duplicate current registration');
    seen.add(run.id);
    const target = run.targetSnapshot,
      connection = target.connection;
    for (const attempt of run.attempts) {
      const wire = attempt.request;
      const suffix =
        connection.protocol === 'vertex-gemini-v1'
          ? `/${target.modelId}:streamGenerateContent?alt=sse`
          : connection.protocol === 'anthropic-messages-v1'
            ? '/messages'
            : connection.protocol === 'openai-responses-v1'
              ? '/responses'
              : '/chat/completions';
      const url =
        connection.protocol === 'codex-app-server-v1'
          ? 'codex://local'
          : connection.protocol === 'fixture-sse-v1'
            ? new URL(connection.endpoint).href
            : connection.endpoint.replace(/\/$/u, '') + suffix;
      if (
        wire.connectionId !== connection.id ||
        wire.protocol !== connection.protocol ||
        wire.modelId !== target.modelId ||
        wire.url !== url
      )
        throw new HttpError(400, 'Registration attempt target mismatch');
    }
    if (run.plan) {
      const normalized = normalizeRegistrationPlan(product, run.plan, {
        connectionSnapshot: run.planConnectionSnapshot ?? undefined,
      });
      if (!isDeepStrictEqual(normalized, run.plan))
        throw new HttpError(400, 'Registration plan normalization mismatch');
    }
    if (run.applied) {
      const c = run.appliedSnapshot!.connection,
        m = run.appliedSnapshot!.model;
      if (!run.plan || m.connectionId !== c.id || m.revision !== 1)
        throw new HttpError(400, 'Registration applied reference mismatch');
      if (run.plan.connection.kind === 'existing') {
        if (
          c.id !== run.plan.connection.id ||
          c.revision !== run.plan.connection.revision ||
          !isDeepStrictEqual(c, run.planConnectionSnapshot)
        )
          throw new HttpError(400, 'Registration applied connection mismatch');
      } else {
        const proposed = product.prepareConnection(run.plan.connection.draft).value;
        const { credentialEnv: _secret, ...safe } = proposed;
        const { id: _id, revision: _revision, credentialEnv: _stored, ...actual } = c;
        if (
          c.revision !== 1 ||
          !isDeepStrictEqual({ ...safe, enabled: false }, { ...actual, enabled: false })
        )
          throw new HttpError(400, 'Registration applied connection mismatch');
      }
      const expected = product.prepareModel(
        { ...run.plan.model, connectionId: c.id },
        undefined,
        c
      ).value;
      const { id: _modelId, revision: _modelRevision, ...actualModel } = m;
      if (!isDeepStrictEqual(expected, actualModel))
        throw new HttpError(400, 'Registration applied model mismatch');
      const owner = applications.get(m.id);
      if (owner && owner !== run.id) throw new HttpError(400, 'Duplicate registration application');
      applications.set(m.id, run.id);
    }
  }
}

/** Check immutable receipts before replacing the current row. */
function validateRegistrationTransition(run: RegistrationRun, old?: RegistrationRun) {
  if (!old) {
    if (run.revision !== 1 || run.status !== 'running' || run.attempts.length !== 0)
      throw new HttpError(400, 'Missing initial registration revision');
  } else {
    if (
      run.revision !== old.revision + 1 ||
      !isDeepStrictEqual(
        [
          run.intentHash,
          run.request,
          run.target,
          run.connection,
          run.targetSnapshot,
          run.createdAt,
        ],
        [old.intentHash, old.request, old.target, old.connection, old.targetSnapshot, old.createdAt]
      ) ||
      run.attempts.length < old.attempts.length
    )
      throw new HttpError(400, 'Registration history mismatch');
    for (let i = 0; i < old.attempts.length; i++) {
      const a = old.attempts[i],
        b = run.attempts[i];
      if (
        a.id !== b.id ||
        !isDeepStrictEqual(a.request, b.request) ||
        (a.status !== 'running' && !isDeepStrictEqual(a, b))
      )
        throw new HttpError(400, 'Registration attempt history mismatch');
    }
    if (
      old.status !== 'running' &&
      !(old.status === 'ready' && run.status === 'applied') &&
      !isDeepStrictEqual(
        [
          old.status,
          old.plan,
          old.planHash,
          old.planConnectionSnapshot,
          old.applied,
          old.appliedSnapshot,
          old.error,
          old.finishedAt,
        ],
        [
          run.status,
          run.plan,
          run.planHash,
          run.planConnectionSnapshot,
          run.applied,
          run.appliedSnapshot,
          run.error,
          run.finishedAt,
        ]
      )
    )
      throw new HttpError(400, 'Registration terminal history mismatch');
    if (
      old.status === 'ready' &&
      run.status === 'applied' &&
      !isDeepStrictEqual(
        [old.plan, old.planHash, old.planConnectionSnapshot, old.finishedAt],
        [run.plan, run.planHash, run.planConnectionSnapshot, run.finishedAt]
      )
    )
      throw new HttpError(400, 'Registration review changed');
  }
}
