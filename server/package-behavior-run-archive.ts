import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  behaviorActionTriggers,
  behaviorRecord,
  evaluateBehaviorAction,
  validatePackageBehavior,
} from '../core/package-behavior.js';
import { inspectRuntimeValue } from '../core/prompt-values.js';
import { executionContext, type PackageExecutionState } from '../core/execution-context.js';
import type { RunSnapshot } from '../core/types.js';
import { behaviorPayloadHash, recordDraws } from './package-behavior-store.js';
import type { RunBehaviorEntry, RunBehaviorProgress } from './package-behavior-run.js';
import { HttpError, type Store } from './store.js';

export const packageBehaviorRunTables = [
  'package_behavior_entropy',
  'package_behavior_opportunities',
  'package_behavior_runs',
];
type Row = Record<string, any>;
type CheckState = (
  value: unknown,
  chatId: string,
  branchId: string,
  profile?: RunSnapshot['profile']
) => PackageExecutionState;
function reject(message: string): never {
  throw new HttpError(400, `Invalid run behavior archive: ${message}`);
}
function object(value: unknown, fields: string[]): Row {
  const record = behaviorRecord(value);
  if (
    Object.keys(record).some((key) => !fields.includes(key)) ||
    fields.some((key) => !Object.hasOwn(record, key))
  )
    reject('fields');
  return record;
}
function digest(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) reject('hash');
}
function text(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.length || value.length > 200) reject('identity');
}
function list(value: unknown, max = 100): asserts value is any[] {
  if (!Array.isArray(value) || value.length > max) reject('list');
}
const same = (a: unknown, b: unknown, message: string) => {
  if (!isDeepStrictEqual(a, b)) reject(message);
};
function body(row: Row): Row {
  if (typeof row.body !== 'string' || row.body.length > 4_000_000) reject('body size');
  return behaviorRecord(JSON.parse(row.body));
}
const key = (entry: Pick<RunBehaviorEntry, 'instanceId' | 'actionId'>) =>
  JSON.stringify([entry.instanceId, entry.actionId]);

/** Receipt validation replays deterministic calculations over recorded host facts, including copied fork facts. */
export function validateRunBehaviorArchive(store: Store, checkState: CheckState): void {
  const rows = (table: string) => store.db.prepare(`SELECT * FROM ${table}`).all() as Row[];
  const entropy = rows('package_behavior_entropy');
  if (entropy.length !== 1 || entropy[0].id !== 1) reject('entropy');
  digest(entropy[0].seed);
  const opportunities = new Map<string, { row: Row; seed: string; entries: RunBehaviorEntry[] }>();
  for (const row of rows('package_behavior_opportunities')) {
    digest(row.id);
    text(row.chat_id);
    text(row.branch_id);
    store.chat(row.chat_id);
    store.product.branch(row.chat_id, row.branch_id);
    const value = object(body(row), ['seed', 'entries']);
    digest(value.seed);
    list(value.entries);
    const seen = new Set<string>();
    for (const raw of value.entries) {
      const entry = object(raw, [
        'instanceId',
        'actionId',
        'trigger',
        'input',
        'before',
        'after',
        'result',
        'draws',
        'drawSeed',
        'hostRuntime',
      ]) as RunBehaviorEntry;
      text(entry.instanceId);
      text(entry.actionId);
      if (!['before-turn', 'model'].includes(entry.trigger)) reject('trigger');
      if (seen.has(key(entry))) reject('duplicate opportunity action');
      seen.add(key(entry));
      const before = checkState(entry.before, row.chat_id, row.branch_id),
        after = checkState(entry.after, row.chat_id, row.branch_id);
      if (
        entry.instanceId !== before.instanceId ||
        after.instanceId !== before.instanceId ||
        after.stateRevision !== before.stateRevision + 1
      )
        reject('entry state revision');
      same(
        { ...before, state: after.state, stateRevision: after.stateRevision, draws: after.draws },
        after,
        'entry definition'
      );
      const pkg = store.product.get<any>(
          'content',
          before.packageId,
          before.packageRevision
        ).package,
        behavior = validatePackageBehavior(pkg?.behavior);
      const action = behavior.actions.find((candidate) => candidate.id === entry.actionId);
      if (!action || !behaviorActionTriggers(action).includes(entry.trigger))
        reject('action permission');
      behaviorRecord(entry.hostRuntime);
      inspectRuntimeValue(entry.hostRuntime);
      behaviorRecord(entry.draws);
      same(entry.hostRuntime.state, before.state, 'host state');
      same(entry.hostRuntime.draws, before.draws, 'host draws');
      if (action.draws?.length) {
        digest(entry.drawSeed);
        same(
          entry.drawSeed,
          createHash('sha256')
            .update(`${value.seed}:${key(entry)}`)
            .digest('hex'),
          'opportunity draw seed'
        );
        same(entry.draws, recordDraws(action.draws, entry.drawSeed), 'recorded draws');
      } else if (entry.drawSeed !== null || Object.keys(entry.draws).length)
        reject('unexpected draws');
      same(
        after.draws,
        Object.keys(entry.draws).length ? entry.draws : before.draws,
        'projected draws'
      );
      const evaluated = evaluateBehaviorAction(
        behavior,
        action,
        before.state,
        entry.input,
        entry.draws,
        entry.hostRuntime
      );
      same(evaluated.state, after.state, 'calculated state');
      same(evaluated.result, entry.result, 'calculated result');
    }
    opportunities.set(row.id, { row, seed: value.seed, entries: value.entries });
  }
  const progresses = new Map<string, RunBehaviorProgress>();
  for (const row of rows('package_behavior_runs')) {
    text(row.run_id);
    const run = store.run(row.run_id),
      snapshot = run.snapshot,
      execution = snapshot.behaviorExecution;
    if (!execution) reject('unexpected progress');
    const value = object(body(row), ['version', 'opportunityId', 'entries', 'states']);
    if (value.version !== 1 || execution.version !== 1) reject('version');
    digest(value.opportunityId);
    if (value.opportunityId !== execution.opportunityId) reject('opportunity binding');
    const opportunity = opportunities.get(value.opportunityId);
    if (!opportunity || opportunity.row.chat_id !== run.chatId) reject('opportunity owner');
    if (
      opportunity.row.branch_id !== (snapshot.branchId ?? `main:${run.chatId}`) &&
      !snapshot.candidateOf
    )
      reject('opportunity branch');
    list(value.entries);
    list(value.states);
    list(execution.baseStates);
    list(execution.automaticResults);
    const base = execution.baseStates.map((state) =>
      checkState(state, run.chatId, snapshot.branchId ?? `main:${run.chatId}`, snapshot.profile)
    );
    const states = structuredClone(base),
      seen = new Set<string>(),
      automatic: RunBehaviorEntry[] = [];
    if (new Set(base.map((state) => state.instanceId)).size !== base.length)
      reject('duplicate base state');
    let modelSeen = false;
    for (const raw of value.entries) {
      const entry = object(raw, [
        'instanceId',
        'actionId',
        'trigger',
        'input',
        'before',
        'after',
        'result',
        'draws',
        'drawSeed',
        'hostRuntime',
      ]) as RunBehaviorEntry;
      if (!['before-turn', 'model'].includes(entry.trigger)) reject('progress trigger');
      if (seen.has(key(entry))) reject('duplicate run action');
      seen.add(key(entry));
      const cached = opportunity.entries.find((item) => key(item) === key(entry));
      if (!cached) reject('missing opportunity receipt');
      same({ ...cached, trigger: entry.trigger }, entry, 'run receipt');
      const ref = snapshot.profile?.packageAttachments?.find(
        (ref) => `${ref.id}:${ref.role}` === entry.instanceId
      );
      const pkg = snapshot.profile?.packages?.find(
          (pkg) => pkg.id === ref?.id && pkg.revision === ref?.revision
        ),
        action = pkg?.behavior?.actions.find((action) => action.id === entry.actionId);
      if (
        !ref ||
        (ref.role === 'persona' && snapshot.profile?.personaReference === false) ||
        !action ||
        !behaviorActionTriggers(action).includes(entry.trigger)
      )
        reject('frozen permission');
      const index = states.findIndex((state) => state.instanceId === entry.instanceId);
      if (index < 0) reject('state missing');
      const runtime = executionContext({ ...snapshot, packageStates: states }, 'main', ref);
      same(entry.hostRuntime.packages, runtime.packages, 'package dependency projection');
      same(entry.hostRuntime.package, runtime.package, 'selected package projection');
      same(entry.hostRuntime.options, runtime.options, 'selected options');
      same(states[index], entry.before, 'progress state chain');
      states[index] = structuredClone(entry.after);
      if (entry.trigger === 'before-turn') {
        if (modelSeen) reject('automatic order');
        automatic.push(entry);
      } else modelSeen = true;
    }
    same(states, value.states, 'progress states');
    const autoStates = structuredClone(base);
    for (const entry of automatic)
      autoStates[autoStates.findIndex((state) => state.instanceId === entry.instanceId)] =
        structuredClone(entry.after);
    same(autoStates, snapshot.packageStates, 'frozen automatic states');
    same(
      automatic.map(({ instanceId, actionId, result }) => ({ instanceId, actionId, result })),
      execution.automaticResults,
      'automatic results'
    );
    if (run.status === 'completed' && !snapshot.forkedFrom) {
      for (const entry of value.entries as RunBehaviorEntry[]) {
        const output = store.db
          .prepare('SELECT body FROM package_behavior_outputs WHERE source_id=? AND instance_id=?')
          .get(run.sourceRevision!, entry.instanceId) as Row | undefined;
        if (!output) reject('missing committed output');
        const out = JSON.parse(output.body),
          published = out.status === 'ready' || out.after.stateRevision > out.before.stateRevision;
        if (
          published &&
          !store.db
            .prepare(
              'SELECT 1 FROM package_behavior_journal WHERE chat_id=? AND branch_id=? AND instance_id=? AND idempotency_key=?'
            )
            .get(
              run.chatId,
              snapshot.branchId ?? `main:${run.chatId}`,
              entry.instanceId,
              `run:${run.id}:${behaviorPayloadHash(key(entry))}`
            )
        )
          reject('missing committed action');
      }
    }
    progresses.set(row.run_id, value as RunBehaviorProgress);
  }
  const runs = rows('runs'),
    snapshotsById = new Map<string, RunSnapshot>(),
    ownersByOpportunity = new Map<string, RunSnapshot[]>();
  for (const row of runs) {
    const snapshot = JSON.parse(row.snapshot) as RunSnapshot;
    snapshotsById.set(row.id, snapshot);
    if (snapshot.behaviorExecution) {
      const id = snapshot.behaviorExecution.opportunityId,
        owners = ownersByOpportunity.get(id) ?? [];
      owners.push(snapshot);
      ownersByOpportunity.set(id, owners);
    }
    if (snapshot.behaviorExecution && !progresses.has(row.id)) reject('missing run progress');
  }
  for (const [id, opportunity] of opportunities) {
    const owners = ownersByOpportunity.get(id) ?? [];
    if (!owners.length) reject('orphan opportunity');
    if (owners.some((snapshot) => !snapshot.forkedFrom))
      same(
        opportunity.seed,
        createHash('sha256').update(`${entropy[0].seed}:${id}`).digest('hex'),
        'opportunity entropy'
      );
    else
      for (const snapshot of owners) {
        const original = snapshotsById.get(snapshot.forkedFrom!.runId)?.behaviorExecution,
          source = original && opportunities.get(original.opportunityId);
        if (!source) reject('fork opportunity source');
        same(source.seed, opportunity.seed, 'fork opportunity entropy');
      }
  }
}
