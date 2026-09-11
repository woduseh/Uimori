import { historicalPersonaExcluded } from '../core/persona-scope.js';
import { HttpError } from './request-validation.js';
import { createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  BehaviorError,
  behaviorActionAllowed,
  behaviorActionTriggers,
  evaluateBehaviorAction,
  validatePackageBehavior,
  type BehaviorAction,
} from '../core/package-behavior.js';
import {
  executionContext,
  packageInstanceId,
  type PackageExecutionState,
} from '../core/execution-context.js';
import { assertBehaviorToolCapability, listBehaviorTools } from '../core/package-behavior-tools.js';
import type { PackageAttachment } from '../core/content-package.js';
import type { RuntimeValue } from '../core/prompt-program.js';
import type { ToolAction } from '../core/provider.js';
import type { RunSnapshot, ToolEvent } from '../core/types.js';
import { behaviorPayloadHash, recordDraws } from './package-behavior-store.js';
import type { Run, Store } from './store.js';

export type RunBehaviorEntry = {
  instanceId: string;
  actionId: string;
  trigger: 'before-turn' | 'model';
  input: RuntimeValue;
  before: PackageExecutionState;
  after: PackageExecutionState;
  result: RuntimeValue;
  draws: Record<string, RuntimeValue>;
  drawSeed: string | null;
  hostRuntime: Record<string, RuntimeValue>;
};
export type RunBehaviorProgress = {
  version: 1;
  opportunityId: string;
  entries: RunBehaviorEntry[];
  states: PackageExecutionState[];
};
export type OpportunityEntropy = { opportunityId: string; seed: string };
type Opportunity = {
  seed: string;
  entries: RunBehaviorEntry[];
  originEntropy?: OpportunityEntropy;
};
type Row = Record<string, any>;
export const MAX_RUN_BEHAVIOR_ACTIONS = 100;
const MAX_JOURNAL_CHARS = 4_000_000;
const hash = behaviorPayloadHash;
const entryKey = (entry: { instanceId: string; actionId: string }) =>
  JSON.stringify([entry.instanceId, entry.actionId]);
const fail = (code: string): never => {
  throw new BehaviorError(409, code);
};

export function initRunBehavior(store: Store) {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS package_behavior_entropy(id INTEGER PRIMARY KEY CHECK(id=1),seed TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS package_behavior_opportunities(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL,branch_id TEXT NOT NULL,body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS package_behavior_runs(run_id TEXT PRIMARY KEY,body TEXT NOT NULL);
  `);
  // Persist once, outside admission. A rejected admission cannot obtain new dice by retrying.
  if (!store.db.prepare('SELECT 1 FROM package_behavior_entropy WHERE id=1').get())
    store.db
      .prepare('INSERT INTO package_behavior_entropy VALUES(1,?)')
      .run(randomBytes(32).toString('hex'));
}
function encode(value: unknown) {
  const text = JSON.stringify(value);
  if (text.length > MAX_JOURNAL_CHARS) fail('BEHAVIOR_RUN_JOURNAL_LIMIT');
  return text;
}
function definitions(snapshot: RunSnapshot) {
  return (snapshot.profile?.packageAttachments ?? [])
    .filter((ref) => !historicalPersonaExcluded(snapshot.profile, ref.role))
    .flatMap((ref) => {
      const pkg = snapshot.profile?.packages?.find(
        (p) => p.id === ref.id && p.revision === ref.revision
      );
      if (!pkg?.behavior) return [];
      return [
        {
          ref,
          behavior: validatePackageBehavior(pkg.behavior),
          instanceId: packageInstanceId(ref),
        },
      ];
    });
}
export function runBehaviorProgress(store: Store, runId: string): RunBehaviorProgress | undefined {
  const row = store.db
    .prepare('SELECT body FROM package_behavior_runs WHERE run_id=?')
    .get(runId) as Row | undefined;
  return row ? JSON.parse(row.body) : undefined;
}
function saveProgress(store: Store, runId: string, progress: RunBehaviorProgress) {
  store.db
    .prepare(
      'INSERT INTO package_behavior_runs VALUES(?,?) ON CONFLICT(run_id) DO UPDATE SET body=excluded.body'
    )
    .run(runId, encode(progress));
}
function opportunity(store: Store, id: string): Opportunity {
  const row = store.db
    .prepare('SELECT body FROM package_behavior_opportunities WHERE id=?')
    .get(id) as Row | undefined;
  if (!row) fail('BEHAVIOR_OPPORTUNITY_MISSING');
  return JSON.parse(row!.body);
}
/** Portable evidence binds the recorded opportunity seed to its original entropy input. */
export function exportOpportunityEntropy(store: Store, opportunityId: string): OpportunityEntropy {
  const active = new Set<string>(),
    found = new Map<string, OpportunityEntropy>();
  const derived = (proof: OpportunityEntropy) =>
    createHash('sha256').update(`${proof.seed}:${proof.opportunityId}`).digest('hex');
  const read = (id: string): OpportunityEntropy => {
    const cached = found.get(id);
    if (cached) return cached;
    if (active.has(id)) fail('BEHAVIOR_OPPORTUNITY_ENTROPY_INVALID');
    active.add(id);
    const saved = opportunity(store, id);
    let proof: OpportunityEntropy;
    if (Object.hasOwn(saved, 'originEntropy')) {
      const origin = saved.originEntropy;
      if (
        !origin ||
        typeof origin !== 'object' ||
        Array.isArray(origin) ||
        Object.keys(origin).length !== 2 ||
        !Object.hasOwn(origin, 'opportunityId') ||
        !Object.hasOwn(origin, 'seed') ||
        typeof origin.opportunityId !== 'string' ||
        typeof origin.seed !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(origin.opportunityId) ||
        !/^[a-f0-9]{64}$/u.test(origin.seed) ||
        derived(origin) !== saved.seed
      )
        fail('BEHAVIOR_OPPORTUNITY_ENTROPY_INVALID');
      proof = { opportunityId: origin!.opportunityId, seed: origin!.seed };
    } else {
      const master = store.db
        .prepare('SELECT seed FROM package_behavior_entropy WHERE id=1')
        .get() as Row | undefined;
      const local = { opportunityId: id, seed: master?.seed };
      if (typeof local.seed === 'string' && derived(local) === saved.seed) proof = local;
      else {
        const owners = store.db
          .prepare(
            "SELECT snapshot FROM runs WHERE json_extract(snapshot,'$.behaviorExecution.opportunityId')=?"
          )
          .all(id) as Row[];
        if (!owners.length) fail('BEHAVIOR_OPPORTUNITY_ENTROPY_INVALID');
        let root: OpportunityEntropy | undefined;
        for (const row of owners) {
          const snapshot = JSON.parse(row.snapshot) as RunSnapshot;
          if (!snapshot.forkedFrom) fail('BEHAVIOR_OPPORTUNITY_ENTROPY_INVALID');
          const source = store.db
            .prepare('SELECT snapshot FROM runs WHERE id=?')
            .get(snapshot.forkedFrom!.runId) as Row | undefined;
          const sourceId = source
            ? (JSON.parse(source.snapshot) as RunSnapshot).behaviorExecution?.opportunityId
            : undefined;
          if (!sourceId) fail('BEHAVIOR_OPPORTUNITY_ENTROPY_INVALID');
          const candidate = read(sourceId!);
          if (derived(candidate) !== saved.seed || (root && !isDeepStrictEqual(root, candidate)))
            fail('BEHAVIOR_OPPORTUNITY_ENTROPY_INVALID');
          root = candidate;
        }
        proof = root!;
      }
    }
    active.delete(id);
    found.set(id, proof);
    return proof;
  };
  return structuredClone(read(opportunityId));
}
function setOpportunity(store: Store, id: string, value: Opportunity) {
  store.db
    .prepare('UPDATE package_behavior_opportunities SET body=? WHERE id=?')
    .run(encode(value), id);
}
function applyEntry(progress: RunBehaviorProgress, entry: RunBehaviorEntry) {
  const index = progress.states.findIndex((s) => s.instanceId === entry.instanceId);
  if (index < 0 || !isDeepStrictEqual(progress.states[index], entry.before))
    fail('BEHAVIOR_OPPORTUNITY_STATE_CHANGED');
  progress.states[index] = structuredClone(entry.after);
  progress.entries.push(structuredClone(entry));
}
function resolveAction(
  store: Store,
  snapshot: RunSnapshot,
  progress: RunBehaviorProgress,
  ref: PackageAttachment,
  action: BehaviorAction,
  input: RuntimeValue,
  trigger: RunBehaviorEntry['trigger']
): RunBehaviorEntry {
  const instanceId = packageInstanceId(ref),
    key = entryKey({ instanceId, actionId: action.id });
  const prior = progress.entries.find((e) => entryKey(e) === key);
  if (prior) {
    if (!isDeepStrictEqual(prior.input, input)) fail('BEHAVIOR_OPPORTUNITY_INPUT_CHANGED');
    return prior;
  }
  if (progress.entries.length >= MAX_RUN_BEHAVIOR_ACTIONS) fail('BEHAVIOR_RUN_ACTION_LIMIT');
  const before = progress.states.find((s) => s.instanceId === instanceId);
  if (!before) fail('BEHAVIOR_STATE_MISSING');
  const hostRuntime = executionContext(
    { ...snapshot, packageStates: progress.states },
    'main',
    ref
  );
  const saved = opportunity(store, progress.opportunityId),
    cached = saved.entries.find((e) => entryKey(e) === key);
  if (cached) {
    if (!isDeepStrictEqual(cached.input, input)) fail('BEHAVIOR_OPPORTUNITY_INPUT_CHANGED');
    if (!isDeepStrictEqual(cached.hostRuntime.packages, hostRuntime.packages))
      fail('BEHAVIOR_OPPORTUNITY_DEPENDENCY_CHANGED');
    const replay = { ...structuredClone(cached), trigger };
    applyEntry(progress, replay);
    return replay;
  }
  const behavior = snapshot.profile!.packages!.find(
    (p) => p.id === ref.id && p.revision === ref.revision
  )!.behavior!;
  if (!behaviorActionAllowed(action, before!.state, input, hostRuntime))
    fail('BEHAVIOR_ACTION_DISABLED');
  const drawSeed = action.draws?.length
    ? createHash('sha256').update(`${saved.seed}:${key}`).digest('hex')
    : null;
  const draws = drawSeed ? recordDraws(action.draws!, drawSeed) : {};
  const evaluated = evaluateBehaviorAction(
    behavior,
    action,
    before!.state,
    input,
    draws,
    hostRuntime
  );
  const after: PackageExecutionState = {
    ...structuredClone(before!),
    stateRevision: before!.stateRevision + 1,
    state: evaluated.state,
    draws: Object.keys(draws).length ? draws : before!.draws,
  };
  const entry: RunBehaviorEntry = {
    instanceId,
    actionId: action.id,
    trigger,
    input: structuredClone(input),
    before: structuredClone(before!),
    after,
    result: evaluated.result,
    draws,
    drawSeed,
    hostRuntime,
  };
  saved.entries.push(entry);
  setOpportunity(store, progress.opportunityId, saved);
  applyEntry(progress, entry);
  return entry;
}

/** Admission only. Preview paths never call this function. No current state is mutated. */
export function prepareRunBehavior(
  store: Store,
  runId: string,
  snapshot: RunSnapshot
): RunSnapshot {
  const defs = definitions(snapshot),
    automatic = defs.flatMap((d) =>
      d.behavior.actions
        .filter((a) => behaviorActionTriggers(a).includes('before-turn'))
        .map((action) => ({ ...d, action }))
    );
  const modelTools = listBehaviorTools(snapshot);
  assertBehaviorToolCapability(snapshot, modelTools);
  if (!automatic.length && !modelTools.length) return snapshot;
  if (automatic.length > MAX_RUN_BEHAVIOR_ACTIONS) fail('BEHAVIOR_RUN_ACTION_LIMIT');
  const baseStates = structuredClone(snapshot.packageStates ?? []);
  // A cancelled run and a fresh request at this unchanged source/state share one opportunity.
  // Model-supplied call IDs, request text and wall-clock time cannot request a reroll.
  const opportunityId = hash({
    chatId: snapshot.chatId,
    branchId: snapshot.branchId,
    parentRevision: snapshot.parentRevision,
    history: snapshot.history.map((s) => [s.revision, s.contentHash]),
    baseStates,
    attachments: snapshot.profile?.packageAttachments,
    values: snapshot.profile?.packageValues,
  });
  if (
    !store.db.prepare('SELECT 1 FROM package_behavior_opportunities WHERE id=?').get(opportunityId)
  ) {
    const master = store.db
      .prepare('SELECT seed FROM package_behavior_entropy WHERE id=1')
      .get() as Row;
    const seed = createHash('sha256').update(`${master.seed}:${opportunityId}`).digest('hex');
    store.db
      .prepare('INSERT INTO package_behavior_opportunities VALUES(?,?,?,?)')
      .run(
        opportunityId,
        snapshot.chatId,
        snapshot.branchId ?? `main:${snapshot.chatId}`,
        encode({ seed, entries: [] })
      );
  }
  const progress: RunBehaviorProgress = {
    version: 1,
    opportunityId,
    entries: [],
    states: structuredClone(baseStates),
  };
  const automaticResults: { instanceId: string; actionId: string; result: RuntimeValue }[] = [];
  for (const d of automatic) {
    const input = d.action.automaticInput ?? {};
    const before = progress.states.find((s) => s.instanceId === d.instanceId)!;
    if (
      !behaviorActionAllowed(
        d.action,
        before.state,
        input,
        executionContext({ ...snapshot, packageStates: progress.states }, 'main', d.ref)
      )
    )
      continue;
    const entry = resolveAction(store, snapshot, progress, d.ref, d.action, input, 'before-turn');
    automaticResults.push({
      instanceId: d.instanceId,
      actionId: d.action.id,
      result: entry.result,
    });
  }
  saveProgress(store, runId, progress);
  return {
    ...snapshot,
    packageStates: structuredClone(progress.states),
    behaviorExecution: { version: 1, opportunityId, baseStates, automaticResults },
  };
}

export function copyCandidateBehavior(
  store: Store,
  original: Run,
  newRunId: string,
  snapshot: RunSnapshot
) {
  if (!snapshot.behaviorExecution) return;
  const previous = runBehaviorProgress(store, original.id);
  if (!previous) fail('BEHAVIOR_RUN_JOURNAL_MISSING');
  saveProgress(store, newRunId, {
    version: 1,
    opportunityId: previous!.opportunityId,
    entries: previous!.entries.filter((e) => e.trigger === 'before-turn'),
    states: structuredClone(snapshot.packageStates ?? []),
  });
}
function validateOwner(store: Store, run: Run) {
  if (run.status !== 'running') fail('BEHAVIOR_RUN_NOT_RUNNING');
  const branch = store.product.branch(run.chatId, run.snapshot.branchId);
  if (branch.headRevision !== run.parentRevision) fail('BEHAVIOR_SOURCE_STALE');
  if (
    run.snapshot.history.some(
      (s) =>
        store.source(s.revision).hash !== (s.contentHash ?? store.sourceOriginal(s.revision).hash)
    )
  )
    fail('BEHAVIOR_SOURCE_DEPENDENCY_CHANGED');
  for (const state of run.snapshot.behaviorExecution?.baseStates ?? []) {
    const scope = {
      chatId: run.chatId,
      branchId: branch.id,
      attachmentInstanceId: state.instanceId,
      packageId: state.packageId,
      packageRevision: state.packageRevision,
      behaviorRevision: state.behaviorRevision,
      schemaVersion: state.schemaVersion,
    };
    const behavior = run.snapshot.profile!.packages!.find(
      (p) => p.id === state.packageId && p.revision === state.packageRevision
    )!.behavior!;
    const current = store.behavior.read(scope, behavior);
    if (
      current.stateRevision !== state.stateRevision ||
      !isDeepStrictEqual(current.state, state.state)
    )
      fail('BEHAVIOR_STATE_STALE');
  }
}
export function executeRunBehaviorTool(
  store: Store,
  runId: string,
  binding: { instanceId: string; actionId: string },
  call: ToolAction,
  signal?: AbortSignal
): ToolEvent {
  try {
    return store.transaction(() => {
      if (signal?.aborted) fail('BEHAVIOR_RUN_CANCELLED');
      const run = store.run(runId);
      validateOwner(store, run);
      const permitted = listBehaviorTools(run.snapshot).find(
        (b) =>
          b.tool.name === call.name &&
          b.instanceId === binding.instanceId &&
          b.actionId === binding.actionId
      );
      if (!permitted) fail('BEHAVIOR_TOOL_NOT_ALLOWED');
      const definition = definitions(run.snapshot).find((d) => d.instanceId === binding.instanceId);
      const action = definition?.behavior.actions.find(
        (a) => a.id === binding.actionId && behaviorActionTriggers(a).includes('model')
      );
      if (!definition || !action) fail('BEHAVIOR_TOOL_NOT_ALLOWED');
      const progress = runBehaviorProgress(store, runId);
      if (!progress) fail('BEHAVIOR_RUN_JOURNAL_MISSING');
      const entry = resolveAction(
        store,
        run.snapshot,
        progress!,
        definition!.ref,
        action!,
        call.args as RuntimeValue,
        'model'
      );
      if (signal?.aborted) fail('BEHAVIOR_RUN_CANCELLED');
      saveProgress(store, runId, progress!);
      return {
        callId: call.callId,
        name: call.name,
        args: structuredClone(call.args),
        denied: false,
        result: structuredClone(entry.result),
      };
    });
  } catch (error) {
    const code =
      error instanceof BehaviorError || error instanceof HttpError
        ? error.message
        : 'BEHAVIOR_ACTION_FAILED';
    return { callId: call.callId, name: call.name, args: {}, denied: true, result: { code } };
  }
}

/** Called inside source completion's per-package savepoint, before output parsing. */
export function commitRunBehaviorInstance(
  store: Store,
  run: Run,
  instanceId: string,
  sourceHash: string
) {
  const progress = runBehaviorProgress(store, run.id);
  if (!run.snapshot.behaviorExecution) return;
  if (!progress) fail('BEHAVIOR_RUN_JOURNAL_MISSING');
  const definition = definitions(run.snapshot).find((d) => d.instanceId === instanceId);
  if (!definition) return;
  const scope = {
    chatId: run.chatId,
    branchId: run.snapshot.branchId ?? `main:${run.chatId}`,
    attachmentInstanceId: instanceId,
    packageId: definition.ref.id,
    packageRevision: definition.ref.revision,
    behaviorRevision: definition.behavior.revision,
    schemaVersion: definition.behavior.schemaVersion,
  };
  const base = run.snapshot.behaviorExecution.baseStates.find((s) => s.instanceId === instanceId)!;
  const current = store.behavior.read(scope, definition.behavior);
  if (current.stateRevision !== base.stateRevision || !isDeepStrictEqual(current.state, base.state))
    fail('BEHAVIOR_STATE_STALE');
  for (const entry of progress!.entries.filter((e) => e.instanceId === instanceId))
    store.behavior.commitRunActionInTransaction(
      scope,
      definition.behavior,
      entry,
      sourceHash,
      `run:${run.id}:${hash(entryKey(entry))}`
    );
}
export function completedRunBehaviorView(store: Store, run: Run): RunSnapshot {
  const progress = runBehaviorProgress(store, run.id);
  return progress
    ? { ...run.snapshot, packageStates: structuredClone(progress.states) }
    : run.snapshot;
}

/** A fork keeps recorded facts; subsequent turns obtain the new branch's independent opportunity. */
export function copyForkRunBehaviors(
  store: Store,
  chatId: string,
  branchId: string,
  sourceIds: Map<string, string>
) {
  const copied = new Map<string, string>();
  for (const [oldSourceId, newSourceId] of sourceIds) {
    const oldRunId = store.source(oldSourceId).runId,
      newRunId = store.source(newSourceId).runId;
    const snapshot = store.run(newRunId).snapshot,
      progress = runBehaviorProgress(store, oldRunId);
    if (!snapshot.behaviorExecution || !progress) continue;
    const oldId = progress.opportunityId,
      newId = copied.get(oldId) ?? hash({ chatId, branchId, oldId });
    if (!copied.has(oldId)) {
      store.db.prepare('INSERT INTO package_behavior_opportunities VALUES(?,?,?,?)').run(
        newId,
        chatId,
        branchId,
        encode({
          ...opportunity(store, oldId),
          originEntropy: exportOpportunityEntropy(store, oldId),
        })
      );
      copied.set(oldId, newId);
    }
    snapshot.behaviorExecution.opportunityId = newId;
    store.db
      .prepare('UPDATE runs SET snapshot=? WHERE id=?')
      .run(JSON.stringify(snapshot), newRunId);
    saveProgress(store, newRunId, { ...structuredClone(progress), opportunityId: newId });
  }
}
