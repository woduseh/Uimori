import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Json } from '../core/transport.js';
import type { ToolEvent, ToolEventTiming } from '../core/types.js';
import { toolResultChars } from '../core/tool-outcome.js';
import { helperArgumentDiagnostic, helperResultDiagnostic } from './helper-diagnostics.js';

export type ToolDiagnosticOwner =
  | { kind: 'run'; id: string; origin: 'writer' | 'advisor' | 'story-guide' }
  | { kind: 'job'; id: string; generation: number; owner: string; origin: 'translation' }
  | { kind: 'illustration'; id: string; generation: number; owner: string; origin: 'illustration' };

/** Small diagnostic records are separate from receipts used to resume provider execution. */
export function initExecutionDiagnostics(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS execution_tool_diagnostics (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
    job_id TEXT REFERENCES jobs(id) ON DELETE CASCADE,
    illustration_job_id TEXT REFERENCES illustration_jobs(id) ON DELETE CASCADE,
    generation INTEGER,worker TEXT,origin TEXT NOT NULL,data TEXT NOT NULL,
    CHECK ((run_id IS NOT NULL) + (job_id IS NOT NULL) + (illustration_job_id IS NOT NULL) = 1)
  );
  CREATE INDEX IF NOT EXISTS execution_diagnostics_run ON execution_tool_diagnostics(run_id,seq);
  CREATE INDEX IF NOT EXISTS execution_diagnostics_job ON execution_tool_diagnostics(job_id,seq);
  CREATE INDEX IF NOT EXISTS execution_diagnostics_illustration ON execution_tool_diagnostics(illustration_job_id,seq);`);
}

type ToolStart = Pick<ToolEvent, 'callId' | 'name' | 'args'>;

function callHash(callId: string) {
  return createHash('sha256').update(callId).digest('hex');
}

/** Begin before host execution. A start without a finish never implies an effect. */
export function startToolDiagnostic(
  db: DatabaseSync,
  owner: ToolDiagnosticOwner,
  event: ToolStart
) {
  const data = JSON.stringify({
    state: 'started',
    effect: 'unknown',
    name: /^[a-z0-9_.-]{1,80}$/iu.test(event.name) ? event.name : 'unknown',
    callIdSha256: callHash(event.callId),
    ...argumentDiagnostic(event.name, event.args),
    startedAt: new Date().toISOString(),
  });
  if (owner.kind === 'run')
    db.prepare(`INSERT INTO execution_tool_diagnostics(run_id,origin,data)
      SELECT id,?,? FROM runs WHERE id=? AND status='running'`).run(owner.origin, data, owner.id);
  else if (owner.kind === 'job')
    db.prepare(`INSERT INTO execution_tool_diagnostics(job_id,generation,worker,origin,data)
      SELECT id,generation,owner,?,? FROM jobs WHERE id=? AND generation=? AND owner=? AND status='running'`).run(
      owner.origin,
      data,
      owner.id,
      owner.generation,
      owner.owner
    );
  else
    db.prepare(`INSERT INTO execution_tool_diagnostics(illustration_job_id,generation,worker,origin,data)
      SELECT id,generation,owner,?,? FROM illustration_jobs WHERE id=? AND generation=? AND owner=? AND status='running'`).run(
      owner.origin,
      data,
      owner.id,
      owner.generation,
      owner.owner
    );
}

function argumentDiagnostic(name: string, args: Record<string, unknown>) {
  const original = helperArgumentDiagnostic(args as Json);
  // A complete authored submission or draft belongs in its owning artifact, not a second log.
  if (name === 'story.submit' || name === 'eval_submit_artifact')
    return { ...original, argsPreview: '[authored submission withheld]', argsRedacted: true };
  if (name === 'agents.consult' && ('draft' in args || 'question' in args)) {
    const preview = helperArgumentDiagnostic({
      ...args,
      ...('draft' in args ? { draft: '[draft withheld]' } : {}),
      ...('question' in args ? { question: '[question withheld]' } : {}),
    } as Json);
    return { ...original, argsPreview: preview.argsPreview, argsRedacted: true };
  }
  return original;
}

/** Persist only bounded/redacted arguments and numeric output metadata, never output text. */
export function recordToolDiagnostic(
  db: DatabaseSync,
  owner: ToolDiagnosticOwner,
  event: ToolEvent,
  timing: ToolEventTiming = {}
) {
  const result = helperResultDiagnostic(event.name, event.result);
  const output =
    event.result && typeof event.result === 'object' && !Array.isArray(event.result)
      ? (event.result as Record<string, unknown>)
      : {};
  // A context-limited shell result keeps execution metadata under `execution` while
  // withholding stdout. Preserve that metadata without copying its output or guidance.
  const nestedShell =
    event.name === 'data.exec'
      ? helperResultDiagnostic(event.name, output.execution).shell
      : undefined;
  const measurements = Object.fromEntries(
    [
      'accepted',
      'returned',
      'applied',
      'beforeTokens',
      'afterTokens',
      'compactedReads',
      'characters',
      'utf8Bytes',
      'correctionCount',
    ]
      .filter(
        (key) =>
          typeof output[key] === 'boolean' ||
          (typeof output[key] === 'number' &&
            Number.isSafeInteger(output[key]) &&
            Number(output[key]) >= 0)
      )
      .map((key) => [key, output[key]])
  );
  const data = {
    state: 'finished',
    name: /^[a-z0-9_.-]{1,80}$/iu.test(event.name) ? event.name : 'unknown',
    callIdSha256: callHash(event.callId),
    ...argumentDiagnostic(event.name, timing.diagnosticArgs ?? event.args),
    denied: event.denied,
    ...(event.errorKind ? { errorKind: event.errorKind } : {}),
    ...result,
    ...(!result.shell && nestedShell ? { shell: nestedShell } : {}),
    ...(Object.keys(measurements).length ? { output: measurements } : {}),
    originalResultChars:
      timing.originalResultChars === undefined
        ? toolResultChars(event.result)
        : timing.originalResultChars,
    providedResultChars: toolResultChars(event.result),
    elapsedMs:
      typeof timing.elapsedMs === 'number' &&
      Number.isFinite(timing.elapsedMs) &&
      timing.elapsedMs >= 0
        ? Math.round(timing.elapsedMs)
        : null,
    finishedAt: timing.finishedAt ?? new Date().toISOString(),
  };
  const ownerWhere =
    owner.kind === 'run'
      ? 'run_id=? AND origin=?'
      : `${owner.kind === 'job' ? 'job_id' : 'illustration_job_id'}=? AND origin=? AND generation=? AND worker=?`;
  const ownerArgs =
    owner.kind === 'run'
      ? [owner.id, owner.origin]
      : [owner.id, owner.origin, owner.generation, owner.owner];
  const started = db
    .prepare(`SELECT seq,data FROM execution_tool_diagnostics WHERE ${ownerWhere}
    AND json_extract(data,'$.state')='started' AND json_extract(data,'$.callIdSha256')=? ORDER BY seq DESC LIMIT 1`)
    .get(...ownerArgs, data.callIdSha256);
  if (started) {
    const { effect: _unknown, ...initial } = JSON.parse(String(started.data));
    db.prepare('UPDATE execution_tool_diagnostics SET data=? WHERE seq=?').run(
      JSON.stringify({ ...initial, ...data }),
      started.seq
    );
    return;
  }
  if (owner.kind === 'run')
    db.prepare('INSERT INTO execution_tool_diagnostics(run_id,origin,data) VALUES(?,?,?)').run(
      owner.id,
      owner.origin,
      JSON.stringify(data)
    );
  else if (owner.kind === 'job')
    db.prepare(`INSERT INTO execution_tool_diagnostics(job_id,generation,worker,origin,data)
      SELECT id,generation,owner,?,? FROM jobs WHERE id=? AND generation=? AND owner=? AND status='running'`).run(
      owner.origin,
      JSON.stringify(data),
      owner.id,
      owner.generation,
      owner.owner
    );
  else
    db.prepare(`INSERT INTO execution_tool_diagnostics(illustration_job_id,generation,worker,origin,data)
      SELECT id,generation,owner,?,? FROM illustration_jobs WHERE id=? AND generation=? AND owner=? AND status='running'`).run(
      owner.origin,
      JSON.stringify(data),
      owner.id,
      owner.generation,
      owner.owner
    );
}
