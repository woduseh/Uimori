import { arch, platform } from 'node:os';
import type { FastifyInstance } from 'fastify';
import {
  DIAGNOSTIC_LIMITS,
  DIAGNOSTIC_REPORT_VERSION,
  diagnosticError,
  diagnosticField,
  diagnosticNumber,
  diagnosticProtocol,
  diagnosticRole,
  diagnosticStatus,
  type DiagnosticReport,
  type DiagnosticScope,
} from '../core/diagnostic-report.js';
import { HttpError, fields, record, text } from './request-validation.js';
import type { Store } from './store.js';
import { DATABASE_SCHEMA_VERSION } from './schema-migrations.js';

type Environment = { buildId: string; testMode?: boolean };
type Row = Record<string, unknown>;
export function parseDiagnosticScope(value: unknown): DiagnosticScope {
  const body = record(value);
  if (body.scope === 'system') {
    fields(body, ['scope']);
    return { scope: 'system' };
  }
  if (body.scope !== 'chat') throw new HttpError(400, 'Invalid diagnostic scope');
  fields(body, ['scope', 'chatId', 'runId']);
  return {
    scope: 'chat',
    chatId: text(body.chatId, 'chatId', 200),
    ...(body.runId === undefined ? {} : { runId: text(body.runId, 'runId', 200) }),
  };
}

/** Read-only, bounded SQL projections. No full Run, archive, input or provider body is loaded. */
export function createDiagnosticReport(
  store: Store,
  scope: DiagnosticScope,
  environment: Environment
): DiagnosticReport {
  let runs: Row[] = [],
    attempts: Row[] = [];
  if (scope.scope === 'chat') {
    if (!store.db.prepare('SELECT 1 FROM chats WHERE id=?').get(scope.chatId))
      throw new HttpError(404, 'Diagnostic scope not found');
    if (
      scope.runId &&
      !store.db
        .prepare('SELECT 1 FROM runs WHERE id=? AND chat_id=?')
        .get(scope.runId, scope.chatId)
    )
      throw new HttpError(404, 'Diagnostic scope not found');
    const params = [scope.chatId, ...(scope.runId ? [scope.runId] : [])];
    runs = store.db
      .prepare(`SELECT id,substr(status,1,40) AS status,substr(error,1,120) AS error,
      (SELECT count(*) FROM model_inputs WHERE run_id=r.id) AS inputCount,
      (SELECT count(*) FROM tool_events WHERE run_id=r.id) AS toolCount,
      (SELECT count(*) FROM tool_events WHERE run_id=r.id AND CASE WHEN json_valid(event) THEN json_extract(event,'$.denied')=1 ELSE 0 END) AS deniedToolCount,
      source_revision IS NOT NULL AS sourceCommitted,COALESCE(length(partial_text),0)>0 AS hasPartialOutput,
      CASE WHEN json_valid(snapshot) THEN substr(json_extract(snapshot,'$.story.preparation.status'),1,40) END AS preparationStatus,
      CASE WHEN json_valid(usage) THEN CASE WHEN json_type(usage,'$.modelCalls') IN ('integer','real') THEN json_extract(usage,'$.modelCalls') END END AS modelCalls,
      CASE WHEN json_valid(usage) THEN CASE WHEN json_type(usage,'$.inputTokens') IN ('integer','real') THEN json_extract(usage,'$.inputTokens') END END AS inputTokens,
      CASE WHEN json_valid(usage) THEN CASE WHEN json_type(usage,'$.outputTokens') IN ('integer','real') THEN json_extract(usage,'$.outputTokens') END END AS outputTokens,
      CASE WHEN json_valid(usage) THEN CASE WHEN json_type(usage,'$.costUsd') IN ('integer','real') THEN json_extract(usage,'$.costUsd') END END AS costUsd,
      round((julianday(updated_at)-julianday(created_at))*86400000) AS elapsedToLastUpdateMs
      FROM runs r WHERE chat_id=? ${scope.runId ? 'AND id=?' : ''} ORDER BY rowid DESC LIMIT ?`)
      .all(...params, DIAGNOSTIC_LIMITS.runs + 1);
    attempts = store.db
      .prepare(`SELECT id,run_id,connection_id,model_id,substr(role,1,40) AS role,substr(status,1,40) AS status,
      substr(error,1,120) AS error,input_tokens,output_tokens,cost_usd,
      CASE WHEN json_valid(request) THEN substr(json_extract(request,'$.protocol'),1,60) ELSE NULL END AS protocol,
      CASE WHEN json_valid(request) THEN julianday(substr(json_extract(request,'$.pricingStartedAt'),1,30)) END AS preparedDay,
      CASE WHEN json_valid(response) THEN CASE WHEN json_type(response,'$.error.diagnostic.httpStatus')='integer' THEN json_extract(response,'$.error.diagnostic.httpStatus') END END AS httpStatus,
      ${Array.from({ length: 8 }, (_, i) => `CASE WHEN json_valid(response) THEN substr(json_extract(response,'$.error.diagnostic.fields[${i}]'),1,129) END AS field${i}`).join(',')}
      FROM attempts WHERE chat_id=? ${scope.runId ? 'AND run_id=?' : ''} ORDER BY rowid DESC LIMIT ?`)
      .all(...params, DIAGNOSTIC_LIMITS.attempts + 1);
  }
  const aliases = new Map<string, string>();
  const alias = (kind: string, id: unknown) => {
    const key = `${kind}:${String(id)}`;
    if (!aliases.has(key)) aliases.set(key, `${kind}-${aliases.size + 1}`);
    return aliases.get(key)!;
  };
  const selectedRuns = runs.slice(0, DIAGNOSTIC_LIMITS.runs);
  const runIds = new Set(selectedRuns.map((row) => row.id));
  const selectedAttempts = attempts.slice(0, DIAGNOSTIC_LIMITS.attempts);
  const days = selectedAttempts
    .map((row) => diagnosticNumber(row.preparedDay))
    .filter((n): n is number => n !== null);
  const firstPreparedDay = days.length ? Math.min(...days) : null;
  const report: DiagnosticReport = {
    format: 'uimori-diagnostic-report',
    version: DIAGNOSTIC_REPORT_VERSION,
    generatedAt: new Date().toISOString(),
    environment: {
      buildId: /^[a-f0-9]{64}$/u.test(environment.buildId) ? environment.buildId : null,
      schemaVersion: Number(store.db.prepare('PRAGMA user_version').get()!.user_version),
      supportedSchemaVersion: DATABASE_SCHEMA_VERSION,
      node: process.versions.node,
      platform: platform(),
      architecture: arch(),
      testMode: environment.testMode === true,
    },
    scope: scope.scope === 'system' ? 'system' : scope.runId ? 'run' : 'chat',
    coverage: {
      runs: { included: selectedRuns.length, truncated: runs.length > DIAGNOSTIC_LIMITS.runs },
      attempts: {
        included: Math.min(attempts.length, DIAGNOSTIC_LIMITS.attempts),
        truncated: attempts.length > DIAGNOSTIC_LIMITS.attempts,
      },
      order: 'newest-first',
      limits: DIAGNOSTIC_LIMITS,
      omitted: [
        'content-and-secrets',
        'raw-identifiers-and-text-hashes',
        'free-form-errors',
        'independent-job-lifecycles',
        'server-and-browser-logs',
        'detailed-tracing',
        'attempt-durations-not-recorded',
        ...(scope.scope === 'system'
          ? ['all-chat-data']
          : scope.runId
            ? ['attempts-not-directly-owned-by-run']
            : []),
        'missing-or-truncated-run-links',
      ],
    },
    runs: selectedRuns.map((row) => ({
      ref: alias('run', row.id),
      status: diagnosticStatus(row.status),
      errorCode: diagnosticError(row.error),
      inputCount: diagnosticNumber(row.inputCount),
      toolCount: diagnosticNumber(row.toolCount),
      deniedToolCount: diagnosticNumber(row.deniedToolCount),
      sourceCommitted: row.sourceCommitted === 1,
      hasPartialOutput: row.hasPartialOutput === 1,
      preparationStatus:
        row.preparationStatus == null ? null : diagnosticStatus(row.preparationStatus),
      modelCalls: diagnosticNumber(row.modelCalls),
      inputTokens: diagnosticNumber(row.inputTokens),
      outputTokens: diagnosticNumber(row.outputTokens),
      costUsd: diagnosticNumber(row.costUsd),
      elapsedToLastUpdateMs: diagnosticNumber(row.elapsedToLastUpdateMs),
    })),
    attempts: selectedAttempts.map((row, index) => ({
      ref: alias('attempt', row.id),
      runRef: runIds.has(row.run_id) ? alias('run', row.run_id) : null,
      connectionRef: alias('connection', row.connection_id),
      modelRef: alias('model', row.model_id),
      role: diagnosticRole(row.role),
      status: diagnosticStatus(row.status),
      protocol: diagnosticProtocol(row.protocol),
      errorCode: diagnosticError(row.error),
      inputTokens: diagnosticNumber(row.input_tokens),
      outputTokens: diagnosticNumber(row.output_tokens),
      costUsd: diagnosticNumber(row.cost_usd),
      sequence: selectedAttempts.length - index,
      preparedOffsetMs:
        firstPreparedDay !== null && diagnosticNumber(row.preparedDay) !== null
          ? diagnosticNumber(Math.round((Number(row.preparedDay) - firstPreparedDay) * 86400000))
          : null,
      durationMs: null,
      httpStatus:
        typeof row.httpStatus === 'number' && row.httpStatus >= 400 && row.httpStatus <= 599
          ? row.httpStatus
          : null,
      rejectedFields: [
        ...new Set(
          Array.from({ length: 8 }, (_, i) => diagnosticField(row[`field${i}`])).filter(
            (field): field is string => field !== null
          )
        ),
      ],
    })),
  };
  if (Buffer.byteLength(JSON.stringify(report)) > DIAGNOSTIC_LIMITS.bytes)
    throw new HttpError(413, 'Diagnostic report limit exceeded');
  return report;
}

/** Register on the app covered by its existing API access and browser-origin hooks. */
export function diagnosticReportRoutes(
  app: FastifyInstance,
  store: Store,
  environment: Environment
) {
  app.post('/api/diagnostics/report', { bodyLimit: 1024 }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return createDiagnosticReport(store, parseDiagnosticScope(request.body), environment);
  });
}
