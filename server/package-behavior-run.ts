import { historicalPersonaExcluded } from '../core/persona-scope.js';
import { createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  BehaviorError,
  BehaviorEvaluationError,
  behaviorActionAllowed,
  behaviorActionTriggers,
  behaviorEditResultMessages,
  behaviorEditResultText,
  behaviorHookBeforeRequest,
  behaviorHookOrder,
  evaluateBehaviorAction,
  validatePackageBehavior,
  validateBehaviorValue,
  type BehaviorAction,
} from '../core/package-behavior.js';
import {
  executionContext,
  packageInstanceId,
  type PackageExecutionState,
} from '../core/execution-context.js';
import {
  admitBehaviorTools,
  assertBehaviorToolCapability,
  listBehaviorTools,
  withoutPackageBehavior,
} from '../core/package-behavior-tools.js';
import type { PackageAttachment } from '../core/content-package.js';
import type { PromptHistoryMessage, RuntimeValue } from '../core/prompt-program.js';
import {
  EXTENSION_PROGRAM_MAX_EDIT_RESULT_CHARS,
  ExtensionProgramError,
  type ExtensionProgramReceipt,
  type ResolvedExtensionProgram,
} from '../core/extension-program.js';
import {
  buildExtensionMessageEdit,
  buildExtensionRequestEdit,
  extensionEditHookInput,
  extensionEditRequestInput,
  requestEditMessages,
} from './extension-request-edit.js';
import { assertExtensionConversationReadAccess } from './extension-conversation-access.js';
import type { ExtensionModelBinding } from '../core/extension-model.js';
import { createExtensionProgramReceipt } from './extension-program-receipt.js';
import type { AfterResponseProgress } from '../core/after-response.js';
import {
  executePackageExtensionProgram,
  type PackageExtensionModelServices,
} from './package-extension-execution.js';
import type { ToolAction } from '../core/provider.js';
import type { RunSnapshot, ToolEvent } from '../core/types.js';
import { behaviorPayloadHash, recordDraws } from './package-behavior-store.js';
import type { Run, Store } from './store.js';
import { fields, record, text, HttpError } from './request-validation.js';
import {
  packageConversationExecution,
  assertRunConversationReceipt,
} from './package-conversation.js';
import type { ChatVariableState } from '../core/chat-variables.js';
import {
  adoptExtensionVariableMutation,
  assertExtensionVariableWriteAccess,
  profileWithExtensionVariables,
  projectExtensionVariableMutation,
  variableStateFromProfile,
} from './extension-variables.js';
import { readChatVariables } from './chat-variables.js';
import type { Source } from './store.js';

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
  program?: ExtensionProgramReceipt;
};
export type RunBehaviorProgress = {
  version: 1;
  opportunityId: string;
  entries: RunBehaviorEntry[];
  states: PackageExecutionState[];
  variableState?: ChatVariableState;
  /** Response-bound receipts never enter the reusable before/model opportunity. */
  afterResponse?: AfterResponseProgress;
  preparation?: {
    status: 'pending' | 'running' | 'ready' | 'failed' | 'skipped';
    completed: number;
    total: number;
    code?: string;
    skipKey?: string;
  };
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
    .filter(
      (ref) =>
        !snapshot.packageBehaviorUnavailable?.some(
          (item) => item.instanceId === packageInstanceId(ref)
        )
    )
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
function automaticActions(snapshot: RunSnapshot) {
  return definitions(snapshot)
    .flatMap((d) =>
      d.behavior.actions
        .filter((action) => behaviorActionTriggers(action).includes('before-turn'))
        .map((action) => ({ ...d, action }))
    )
    .sort((a, b) => behaviorHookOrder(a.action) - behaviorHookOrder(b.action));
}
/** Host-owned edit phases receive the running text; other automatic actions keep their declaration. */
function automaticInput(
  action: BehaviorAction,
  edited: { request: string; messages: PromptHistoryMessage[] }
): RuntimeValue | undefined {
  if (action.hook === 'edit-input') return extensionEditHookInput(edited.request);
  if (action.hook === 'edit-request') return extensionEditRequestInput(edited.messages);
  return action.automaticInput ?? {};
}
const editResultLimit = (action: BehaviorAction) =>
  action.hook === undefined ? {} : { maxResultChars: EXTENSION_PROGRAM_MAX_EDIT_RESULT_CHARS };
/** The transmitted copy a request hook edits: the frozen conversation plus the edited request. */
function editedMessages(snapshot: RunSnapshot, request: string, chain: string[][]) {
  const base = requestEditMessages(snapshot, request);
  const texts = chain.at(-1);
  return texts ? base.map((message, index) => ({ ...message, text: texts[index] })) : base;
}
export function runBehaviorProgress(store: Store, runId: string): RunBehaviorProgress | undefined {
  const row = store.db
    .prepare('SELECT body FROM package_behavior_runs WHERE run_id=?')
    .get(runId) as Row | undefined;
  return row ? JSON.parse(row.body) : undefined;
}
export function saveProgress(store: Store, runId: string, progress: RunBehaviorProgress) {
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
function progressSnapshot(snapshot: RunSnapshot, progress: RunBehaviorProgress): RunSnapshot {
  return {
    ...snapshot,
    packageStates: progress.states,
    ...(progress.variableState
      ? { profile: profileWithExtensionVariables(snapshot.profile, progress.variableState) }
      : {}),
  };
}
function applyEntry(progress: RunBehaviorProgress, entry: RunBehaviorEntry) {
  const index = progress.states.findIndex((s) => s.instanceId === entry.instanceId);
  if (index < 0 || !isDeepStrictEqual(progress.states[index], entry.before))
    fail('BEHAVIOR_OPPORTUNITY_STATE_CHANGED');
  if (entry.program?.variables)
    progress.variableState = projectExtensionVariableMutation(
      progress.variableState ?? { revision: 0, values: {} },
      entry.program.variables
    );
  progress.states[index] = structuredClone(entry.after);
  progress.entries.push(structuredClone(entry));
}
function actionResolution(
  store: Store,
  snapshot: RunSnapshot,
  progress: RunBehaviorProgress,
  ref: PackageAttachment,
  action: BehaviorAction,
  input: RuntimeValue,
  trigger: RunBehaviorEntry['trigger']
) {
  const instanceId = packageInstanceId(ref),
    key = entryKey({ instanceId, actionId: action.id });
  const prior = progress.entries.find((e) => entryKey(e) === key);
  if (prior) {
    if (!isDeepStrictEqual(prior.input, input)) fail('BEHAVIOR_OPPORTUNITY_INPUT_CHANGED');
    if (prior.program?.variables && Object.keys(prior.program.variables.changes).length)
      assertExtensionVariableWriteAccess(store, snapshot.profile, ref, action.program!);
    if (prior.program?.conversation)
      assertRunConversationReceipt(
        store,
        snapshot,
        ref,
        action.program!,
        prior.program.conversation,
        undefined,
        !behaviorHookBeforeRequest(action)
      );
    return { entry: prior };
  }
  if (progress.entries.length >= MAX_RUN_BEHAVIOR_ACTIONS) fail('BEHAVIOR_RUN_ACTION_LIMIT');
  const before = progress.states.find((s) => s.instanceId === instanceId);
  if (!before) fail('BEHAVIOR_STATE_MISSING');
  const hostRuntime = executionContext(progressSnapshot(snapshot, progress), 'main', ref);
  const saved = opportunity(store, progress.opportunityId),
    cached = saved.entries.find((e) => entryKey(e) === key);
  if (cached) {
    if (!isDeepStrictEqual(cached.input, input)) fail('BEHAVIOR_OPPORTUNITY_INPUT_CHANGED');
    if (!isDeepStrictEqual(cached.hostRuntime.packages, hostRuntime.packages))
      fail('BEHAVIOR_OPPORTUNITY_DEPENDENCY_CHANGED');
    for (const field of ['variables', 'variableStateRevision', 'variableDefaultsError'])
      if (!isDeepStrictEqual(cached.hostRuntime[field], hostRuntime[field]))
        fail('BEHAVIOR_OPPORTUNITY_DEPENDENCY_CHANGED');
    if (cached.program?.variables && Object.keys(cached.program.variables.changes).length)
      assertExtensionVariableWriteAccess(store, snapshot.profile, ref, action.program!);
    if (cached.program?.conversation)
      assertRunConversationReceipt(
        store,
        snapshot,
        ref,
        action.program!,
        cached.program.conversation,
        undefined,
        !behaviorHookBeforeRequest(action)
      );
    const replay = { ...structuredClone(cached), trigger };
    applyEntry(progress, replay);
    return { entry: replay };
  }
  const behavior = snapshot.profile!.packages!.find(
    (p) => p.id === ref.id && p.revision === ref.revision
  )!.behavior!;
  validateBehaviorValue(behavior.stateSchema, before!.state);
  if (!behaviorActionAllowed(action, before!.state, input, hostRuntime))
    fail('BEHAVIOR_ACTION_DISABLED');
  const drawSeed = action.draws?.length
    ? createHash('sha256').update(`${saved.seed}:${key}`).digest('hex')
    : null;
  const draws = drawSeed ? recordDraws(action.draws!, drawSeed) : {};
  return { instanceId, key, before: before!, hostRuntime, saved, behavior, drawSeed, draws };
}
function finishActionResolution(
  store: Store,
  progress: RunBehaviorProgress,
  action: BehaviorAction,
  input: RuntimeValue,
  trigger: RunBehaviorEntry['trigger'],
  resolution: ReturnType<typeof actionResolution>,
  resolvedProgram?: ResolvedExtensionProgram
): RunBehaviorEntry {
  if (resolution.entry) return resolution.entry;
  const { instanceId, before, hostRuntime, saved, behavior, drawSeed, draws } = resolution;
  let program: ExtensionProgramReceipt | undefined;
  if (action.program) {
    if (!resolvedProgram) fail('BEHAVIOR_PROGRAM_REQUIRES_HOST');
    try {
      program = createExtensionProgramReceipt(resolvedProgram!, {
        programHash: hash(action.program),
        stateSchema: behavior.stateSchema,
        ...editResultLimit(action),
      });
    } catch (error) {
      if (
        error instanceof BehaviorError &&
        error.message !== 'BEHAVIOR_PROGRAM_HASH_MISMATCH' &&
        error.message !== 'BEHAVIOR_PROGRAM_ENGINE'
      )
        throw new BehaviorEvaluationError(error.statusCode, error.message);
      throw error;
    }
  } else if (resolvedProgram) fail('BEHAVIOR_PROGRAM_RESULT_UNEXPECTED');
  const evaluated =
    program ?? evaluateBehaviorAction(behavior, action, before.state, input, draws, hostRuntime);
  const after: PackageExecutionState = {
    ...structuredClone(before),
    stateRevision: before.stateRevision + 1,
    state: evaluated.state,
    draws: Object.keys(draws).length ? draws : before.draws,
  };
  const entry: RunBehaviorEntry = {
    instanceId,
    actionId: action.id,
    trigger,
    input: structuredClone(input),
    before: structuredClone(before),
    after,
    result: evaluated.result,
    draws,
    drawSeed,
    hostRuntime,
    ...(program ? { program } : {}),
  };
  saved.entries.push(entry);
  setOpportunity(store, progress.opportunityId, saved);
  applyEntry(progress, entry);
  return entry;
}
function resolveAction(
  store: Store,
  snapshot: RunSnapshot,
  progress: RunBehaviorProgress,
  ref: PackageAttachment,
  action: BehaviorAction,
  input: RuntimeValue,
  trigger: RunBehaviorEntry['trigger'],
  program?: ResolvedExtensionProgram
): RunBehaviorEntry {
  const resolution = actionResolution(store, snapshot, progress, ref, action, input, trigger);
  return finishActionResolution(store, progress, action, input, trigger, resolution, program);
}

/** Admission only. Preview paths never call this function. No current state is mutated. */
export function prepareRunBehavior(
  store: Store,
  runId: string,
  snapshot: RunSnapshot
): RunSnapshot {
  const admitted = admitBehaviorTools(snapshot);
  store.db.exec('SAVEPOINT behavior_preparation');
  try {
    const prepared = prepareRunBehaviorInTransaction(store, runId, admitted);
    store.db.exec('RELEASE behavior_preparation');
    return prepared;
  } catch (error) {
    store.db.exec('ROLLBACK TO behavior_preparation; RELEASE behavior_preparation');
    if (!isRecoverableBehaviorExecutionError(error)) throw error;
    // Automatic actions form a dependency cohort. Do not publish a partial prefix or fake state.
    return withoutPackageBehavior(
      admitted,
      definitions(admitted).map((d) => d.ref),
      'preparation',
      error.message
    );
  }
}

/** Only add-on evaluation/eligibility errors are recoverable. Ownership and corrupt journals stay fatal. */
export function isRecoverableBehaviorExecutionError(error: unknown): error is Error {
  return (
    error instanceof BehaviorEvaluationError ||
    (error instanceof ExtensionProgramError &&
      ['BEHAVIOR_HOST_VARIABLES_DENIED', 'BEHAVIOR_HOST_VARIABLES_LIMIT'].includes(error.code)) ||
    (error instanceof BehaviorError &&
      [
        'BEHAVIOR_RUN_ACTION_LIMIT',
        'BEHAVIOR_RUN_JOURNAL_LIMIT',
        'BEHAVIOR_ACTION_DISABLED',
        'BEHAVIOR_OPPORTUNITY_INPUT_CHANGED',
        'BEHAVIOR_OPPORTUNITY_STATE_CHANGED',
        'BEHAVIOR_OPPORTUNITY_DEPENDENCY_CHANGED',
        'BEHAVIOR_STATE_STALE',
        'BEHAVIOR_VARIABLE_STATE_STALE',
        'BEHAVIOR_MIGRATION_REQUIRED',
      ].includes(error.message))
  );
}

function prepareRunBehaviorInTransaction(
  store: Store,
  runId: string,
  snapshot: RunSnapshot
): RunSnapshot {
  const automatic = automaticActions(snapshot);
  const modelTools = listBehaviorTools(snapshot);
  assertBehaviorToolCapability(snapshot, modelTools);
  const afterTurn = definitions(snapshot).some((d) =>
    d.behavior.actions.some((action) => behaviorActionTriggers(action).includes('after-turn'))
  );
  if (!automatic.length && !modelTools.length && !afterTurn) return snapshot;
  if (automatic.length > MAX_RUN_BEHAVIOR_ACTIONS) fail('BEHAVIOR_RUN_ACTION_LIMIT');
  const baseStates = structuredClone(snapshot.packageStates ?? []);
  // Source/state determines entropy. A different request cannot ask for new dice.
  const entropyOpportunityId = hash({
    chatId: snapshot.chatId,
    branchId: snapshot.branchId,
    parentRevision: snapshot.parentRevision,
    history: snapshot.history.map((s) => [s.revision, s.contentHash]),
    baseStates,
    attachments: snapshot.profile?.packageAttachments,
    values: snapshot.profile?.packageValues,
    ...(snapshot.profile?.variableState ? { variableState: snapshot.profile.variableState } : {}),
  });
  // Conversation-dependent calculations need their own receipt when visible input changes.
  // Keep the original entropy derivation so unrelated draws are not rerolled with that work.
  const readsConversation = definitions(snapshot).some((d) => {
    const grant = snapshot.profile?.extensionGrants?.[d.instanceId];
    return (
      grant?.packageRevision === d.ref.revision &&
      grant.capabilities.includes('conversation.read') &&
      d.behavior.actions.some(
        (action) =>
          action.program?.capabilities?.includes('conversation.read') &&
          behaviorActionTriggers(action).some(
            (trigger) => trigger === 'before-turn' || trigger === 'model'
          )
      )
    );
  });
  // An explicit input submission owns its callback even without a conversation-read grant.
  // Keep entropy tied to source/state so changing the request cannot reroll existing draws.
  const hasInputHooks = automatic.some((d) => behaviorHookBeforeRequest(d.action));
  const opportunityId =
    hasInputHooks || (readsConversation && snapshot.extensionConversation)
      ? hash({
          opportunityId: entropyOpportunityId,
          conversation: {
            messages: snapshot.extensionConversation?.messages.map(({ role, hash }) => ({
              role,
              hash,
            })),
            request: hash(snapshot.request),
          },
        })
      : entropyOpportunityId;
  if (
    !store.db.prepare('SELECT 1 FROM package_behavior_opportunities WHERE id=?').get(opportunityId)
  ) {
    const master = store.db
      .prepare('SELECT seed FROM package_behavior_entropy WHERE id=1')
      .get() as Row;
    const seed = createHash('sha256')
      .update(`${master.seed}:${entropyOpportunityId}`)
      .digest('hex');
    store.db.prepare('INSERT INTO package_behavior_opportunities VALUES(?,?,?,?)').run(
      opportunityId,
      snapshot.chatId,
      snapshot.branchId ?? `main:${snapshot.chatId}`,
      encode({
        seed,
        entries: [],
        ...(opportunityId !== entropyOpportunityId
          ? { originEntropy: { opportunityId: entropyOpportunityId, seed: master.seed } }
          : {}),
      })
    );
  }
  const progress: RunBehaviorProgress = {
    version: 1,
    opportunityId,
    entries: [],
    states: structuredClone(baseStates),
    ...(snapshot.profile?.variableState
      ? { variableState: variableStateFromProfile(snapshot.profile) }
      : {}),
  };
  const automaticResults: { instanceId: string; actionId: string; result: RuntimeValue }[] = [];
  if (automatic.some((d) => d.action.program)) {
    progress.preparation = { status: 'pending', completed: 0, total: automatic.length };
    saveProgress(store, runId, progress);
    return {
      ...snapshot,
      behaviorExecution: {
        version: 1,
        opportunityId,
        baseStates,
        automaticResults,
        deferredAutomatic: true,
      },
    };
  }
  for (const d of automatic) {
    const input = d.action.automaticInput ?? {};
    const before = progress.states.find((s) => s.instanceId === d.instanceId)!;
    if (
      !behaviorActionAllowed(
        d.action,
        before.state,
        input,
        executionContext(progressSnapshot(snapshot, progress), 'main', d.ref)
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
  const automaticEntries = previous!.entries.filter((e) => e.trigger === 'before-turn');
  const states = structuredClone(snapshot.behaviorExecution.baseStates);
  let variableState = variableStateFromProfile(snapshot.profile);
  for (const entry of automaticEntries) {
    states[states.findIndex((s) => s.instanceId === entry.instanceId)] = structuredClone(
      entry.after
    );
    if (entry.program?.variables)
      variableState = projectExtensionVariableMutation(variableState, entry.program.variables);
  }
  const preparation = previous!.preparation;
  // afterResponse belongs to the original text; a candidate runs its own response hooks.
  saveProgress(store, newRunId, {
    version: 1,
    opportunityId: previous!.opportunityId,
    entries: automaticEntries,
    states,
    ...(snapshot.profile?.variableState ||
    automaticEntries.some((entry) => entry.program?.variables)
      ? { variableState }
      : {}),
    ...(preparation
      ? {
          preparation: ['pending', 'running'].includes(preparation.status)
            ? { status: 'pending' as const, completed: 0, total: preparation.total }
            : structuredClone(preparation),
        }
      : {}),
  });
}
export function validateOwner(store: Store, run: Run) {
  if (run.status !== 'running') fail('BEHAVIOR_RUN_NOT_RUNNING');
  const branch = store.product.branch(run.chatId, run.snapshot.branchId);
  if (branch.headRevision !== run.parentRevision) fail('BEHAVIOR_SOURCE_STALE');
  const reserved = store.run(run.id).snapshot;
  if (
    !isDeepStrictEqual(
      readChatVariables(store, run.chatId, branch.id),
      variableStateFromProfile(reserved.profile)
    )
  )
    fail('BEHAVIOR_VARIABLE_STATE_STALE');
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
/** The reserved Run stays immutable; derived preparation is applied only to an execution view. */
export function preparedBehaviorSnapshot(
  store: Store,
  runId: string,
  base = store.run(runId).snapshot
): RunSnapshot {
  if (!base.behaviorExecution?.deferredAutomatic) return base;
  const progress = runBehaviorProgress(store, runId);
  if (!progress?.preparation) fail('BEHAVIOR_RUN_JOURNAL_MISSING');
  const preparation = progress!.preparation!;
  if (['pending', 'running'].includes(preparation.status)) fail('BEHAVIOR_PREPARATION_PENDING');
  if (preparation.status !== 'ready') {
    const refs = automaticActions(base).map((d) => d.ref);
    if (!refs.length) return base;
    return withoutPackageBehavior(
      base,
      refs,
      'preparation',
      preparation.code!,
      base.behaviorExecution.baseStates
    );
  }
  const entries = progress!.entries.filter((e) => e.trigger === 'before-turn');
  const states = structuredClone(base.behaviorExecution.baseStates);
  let variableState = variableStateFromProfile(base.profile);
  for (const entry of entries)
    if (entry.program?.variables)
      variableState = projectExtensionVariableMutation(variableState, entry.program.variables);
  for (const entry of entries)
    states[states.findIndex((s) => s.instanceId === entry.instanceId)] = structuredClone(
      entry.after
    );
  const hooks = new Map(
    definitions(base).flatMap((d) =>
      d.behavior.actions.map(
        (action) =>
          [entryKey({ instanceId: d.instanceId, actionId: action.id }), action.hook] as const
      )
    )
  );
  const edited = new Set(
    entries.filter((entry) => hooks.get(entryKey(entry))?.startsWith('edit-'))
  );
  // The reserved request stays the stored original; only its transmitted copy carries the edit.
  const extensionRequestEdit = buildExtensionRequestEdit(
    base.request,
    entries
      .filter((entry) => hooks.get(entryKey(entry)) === 'edit-input')
      .map((entry) => ({ id: entryKey(entry), text: behaviorEditResultText(entry.result) }))
  );
  const requestHooks = [...hooks].filter(([, hook]) => hook === 'edit-request');
  const requestEdits = entries.filter((entry) => hooks.get(entryKey(entry)) === 'edit-request');
  // A declared request hook without a recorded entry was skipped by grant, limit or condition.
  const skippedRequestHook = requestHooks.some(
    ([key]) => !entries.some((entry) => entryKey(entry) === key)
  );
  let chained = requestEdits.length
    ? requestEditMessages(base, extensionRequestEdit?.text ?? base.request)
    : [];
  const extensionMessageEdit = requestHooks.length
    ? buildExtensionMessageEdit(
        chained,
        requestEdits.map((entry) => {
          const texts = behaviorEditResultMessages(entry.result, chained);
          chained = chained.map((message, index) => ({ ...message, text: texts[index] }));
          return { id: entryKey(entry), texts };
        }),
        skippedRequestHook
      )
    : undefined;
  const automaticResults = entries
    .filter((entry) => !edited.has(entry))
    .map(({ instanceId, actionId, result }) => ({ instanceId, actionId, result }));
  if (
    isDeepStrictEqual(states, base.packageStates) &&
    isDeepStrictEqual(automaticResults, base.behaviorExecution.automaticResults) &&
    isDeepStrictEqual(variableState, variableStateFromProfile(base.profile)) &&
    isDeepStrictEqual(extensionRequestEdit, base.extensionRequestEdit) &&
    isDeepStrictEqual(extensionMessageEdit, base.extensionMessageEdit)
  )
    return base;
  const projected: RunSnapshot = {
    ...base,
    packageStates: states,
    profile: profileWithExtensionVariables(base.profile, variableState),
    behaviorExecution: { ...base.behaviorExecution, automaticResults },
    promptCompilation: undefined,
  };
  if (extensionRequestEdit) projected.extensionRequestEdit = extensionRequestEdit;
  else delete projected.extensionRequestEdit;
  if (extensionMessageEdit) projected.extensionMessageEdit = extensionMessageEdit;
  else delete projected.extensionMessageEdit;
  return projected;
}
const automaticWork = new WeakMap<
  Store,
  Map<string, { controller: AbortController; work: Promise<void> }>
>();
function preparationProgress(store: Store, runId: string) {
  const progress = runBehaviorProgress(store, runId);
  if (!progress?.preparation) fail('BEHAVIOR_RUN_JOURNAL_MISSING');
  return progress as RunBehaviorProgress & {
    preparation: NonNullable<RunBehaviorProgress['preparation']>;
  };
}
function notifyPreparation(store: Store, runId: string) {
  const run = store.run(runId);
  store.event(run.chatId, 'run.package-preparation', runId);
}
/** Close adoption promptly even if a future engine/host operation settles after cancellation. */
async function cancellablePreparation<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new BehaviorError(409, 'BEHAVIOR_RUN_CANCELLED'));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([work, cancelled]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
/** Sequential preparation of one dependency cohort. Successful prefixes are never published alone. */
export async function prepareAutomaticRunBehavior(
  store: Store,
  runId: string,
  signal?: AbortSignal,
  onProgress?: () => void,
  modelServices?: (binding: ExtensionModelBinding) => PackageExtensionModelServices
): Promise<void> {
  const reserved = store.run(runId).snapshot;
  if (!reserved.behaviorExecution?.deferredAutomatic) return;
  let active = automaticWork.get(store);
  if (!active) {
    active = new Map();
    automaticWork.set(store, active);
  }
  const existing = active.get(runId);
  if (existing) return existing.work;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const granted = (d: { ref: PackageAttachment; action: BehaviorAction }) => {
    try {
      assertExtensionConversationReadAccess(store, reserved.profile, d.ref, d.action.program!);
      return true;
    } catch (error) {
      if (error instanceof ExtensionProgramError) return false;
      throw error;
    }
  };
  const work = (async () => {
    const local = store.transaction(() => {
      const run = store.run(runId);
      const progress = preparationProgress(store, runId);
      if (!['pending', 'running'].includes(progress.preparation.status)) return null;
      validateOwner(store, run);
      if (signal?.aborted) fail('BEHAVIOR_RUN_CANCELLED');
      progress.preparation = { ...progress.preparation, status: 'running', completed: 0 };
      saveProgress(store, runId, progress);
      notifyPreparation(store, runId);
      return structuredClone(progress);
    });
    if (!local) return;
    onProgress?.();
    try {
      const actions = automaticActions(reserved);
      // Risu chains every edit callback over the running value in declaration order.
      let editedRequest = reserved.request;
      const messageChain: string[][] = [];
      for (const d of actions) {
        const messages = editedMessages(reserved, editedRequest, messageChain);
        const chain = (entry: RunBehaviorEntry) => {
          if (d.action.hook === 'edit-input') editedRequest = behaviorEditResultText(entry.result);
          if (d.action.hook === 'edit-request')
            messageChain.push(behaviorEditResultMessages(entry.result, messages));
        };
        const input = automaticInput(d.action, { request: editedRequest, messages });
        // A conversation copy needs the same grant as any conversation read, and a conversation
        // beyond the guest limit is skipped instead of being handed over in part.
        const unavailable =
          input === undefined || (d.action.hook === 'edit-request' && !granted(d));
        const step = unavailable
          ? { skipped: true as const }
          : store.transaction(() => {
              const value = input!;
              const current = preparationProgress(store, runId);
              if (current.preparation.status !== 'running') return null;
              if (controller.signal.aborted) fail('BEHAVIOR_RUN_CANCELLED');
              validateOwner(store, store.run(runId));
              const before = local.states.find((s) => s.instanceId === d.instanceId)!;
              if (
                !behaviorActionAllowed(
                  d.action,
                  before.state,
                  value,
                  executionContext(progressSnapshot(reserved, local), 'main', d.ref)
                )
              )
                return { skipped: true as const };
              const resolution = actionResolution(
                store,
                reserved,
                local,
                d.ref,
                d.action,
                value,
                'before-turn'
              );
              if (resolution.entry || !d.action.program) {
                const entry = finishActionResolution(
                  store,
                  local,
                  d.action,
                  value,
                  'before-turn',
                  resolution
                );
                return { skipped: true as const, entry };
              }
              return { program: d.action.program, state: resolution.before.state };
            });
        if (!step) return;
        if ('entry' in step) chain(step.entry!);
        if ('program' in step) {
          const usesModel = step.program!.capabilities?.includes('model.generate') === true;
          const binding = {
            instanceId: d.instanceId,
            actionId: d.action.id,
            trigger: 'before-turn',
          } satisfies ExtensionModelBinding;
          const services = usesModel ? modelServices?.(binding) : undefined;
          const assertCurrent = () => {
            validateOwner(store, store.run(runId));
            if (preparationProgress(store, runId).preparation.status !== 'running')
              fail('BEHAVIOR_RUN_CANCELLED');
          };
          const execution = executePackageExtensionProgram(
            step.program!,
            { state: step.state!, input: input! },
            controller.signal,
            {
              waitForSlot: true,
              ...editResultLimit(d.action),
              profile: progressSnapshot(reserved, local).profile,
              attachment: d.ref,
              conversation: packageConversationExecution(
                store,
                reserved,
                reserved.profile,
                d.ref,
                step.program!,
                behaviorHookBeforeRequest(d.action) ? {} : { request: reserved.request }
              ),
              assertCurrent,
              assertVariableWriteAccess: () =>
                assertExtensionVariableWriteAccess(store, reserved.profile, d.ref, step.program!),
              modelServices: services,
            }
          );
          // Paid host work owns durable attempt and usage settlement. Do not let a skip/cancel
          // return while that work may still be finalizing; pure guest code retains prompt skip.
          const output = usesModel
            ? await execution
            : await cancellablePreparation(execution, controller.signal);
          const adopted = store.transaction(() => {
            const current = preparationProgress(store, runId);
            if (current.preparation.status !== 'running') return false;
            if (controller.signal.aborted) fail('BEHAVIOR_RUN_CANCELLED');
            validateOwner(store, store.run(runId));
            if (output.variables && Object.keys(output.variables.changes).length)
              assertExtensionVariableWriteAccess(store, reserved.profile, d.ref, step.program!);
            chain(
              resolveAction(store, reserved, local, d.ref, d.action, input!, 'before-turn', {
                ...output,
                programHash: hash(step.program),
              })
            );
            return true;
          });
          if (!adopted) return;
        }
        store.transaction(() => {
          const current = preparationProgress(store, runId);
          if (current.preparation.status !== 'running') return;
          current.preparation.completed++;
          saveProgress(store, runId, current);
          notifyPreparation(store, runId);
        });
        onProgress?.();
      }
      store.transaction(() => {
        const current = preparationProgress(store, runId);
        if (current.preparation.status !== 'running') return;
        if (controller.signal.aborted) fail('BEHAVIOR_RUN_CANCELLED');
        validateOwner(store, store.run(runId));
        saveProgress(store, runId, {
          ...local,
          preparation: {
            status: 'ready',
            completed: current.preparation.total,
            total: current.preparation.total,
          },
        });
        notifyPreparation(store, runId);
      });
      onProgress?.();
    } catch (error) {
      const skipped = preparationProgress(store, runId).preparation.status === 'skipped';
      const recoverable =
        error instanceof ExtensionProgramError || isRecoverableBehaviorExecutionError(error);
      const expectedCancellation =
        controller.signal.aborted &&
        (error === controller.signal.reason ||
          (error instanceof Error && error.name === 'AbortError') ||
          (error instanceof ExtensionProgramError && error.code === 'BEHAVIOR_PROGRAM_ABORTED') ||
          (error instanceof BehaviorError && error.message === 'BEHAVIOR_RUN_CANCELLED'));
      // A user skip closes this optional cohort. Fatal owner/DB/settlement failures still escape.
      if (skipped) {
        if (recoverable || expectedCancellation) return;
        throw error;
      }
      if (!recoverable && !expectedCancellation) throw error;
      store.transaction(() => {
        const current = preparationProgress(store, runId);
        if (current.preparation.status !== 'running') return;
        current.preparation = {
          ...current.preparation,
          status: 'failed',
          code:
            signal?.aborted || expectedCancellation
              ? 'BEHAVIOR_RUN_CANCELLED'
              : (error as Error).message,
        };
        saveProgress(store, runId, current);
        notifyPreparation(store, runId);
      });
      onProgress?.();
      if (signal?.aborted || expectedCancellation) fail('BEHAVIOR_RUN_CANCELLED');
    }
  })();
  active.set(runId, { controller, work });
  try {
    await work;
  } finally {
    signal?.removeEventListener('abort', abort);
    if (active.get(runId)?.work === work) active.delete(runId);
  }
}
export function skipAutomaticRunBehavior(store: Store, runId: string, value: unknown) {
  const result = store.transaction(() => {
    const body = record(value);
    fields(body, ['chatId', 'branchId', 'expectedRevision', 'idempotencyKey']);
    const run = store.run(runId);
    const chatId = text(body.chatId, 'chat ID', 200),
      branchId = text(body.branchId, 'branch ID', 200),
      key = text(body.idempotencyKey, 'idempotency key', 200);
    if (
      chatId !== run.chatId ||
      branchId !== (run.snapshot.branchId ?? `main:${run.chatId}`) ||
      body.expectedRevision !== run.parentRevision
    )
      throw new HttpError(409, 'BEHAVIOR_PREPARATION_OWNER_MISMATCH');
    const progress = preparationProgress(store, runId);
    if (progress.preparation.skipKey === key)
      return { skipped: true, preparation: progress.preparation };
    if (!['pending', 'running'].includes(progress.preparation.status))
      return { skipped: false, preparation: progress.preparation };
    if (!['queued', 'running', 'waiting_for_state'].includes(run.status))
      throw new HttpError(409, 'BEHAVIOR_PREPARATION_FINISHED');
    progress.preparation = {
      ...progress.preparation,
      status: 'skipped',
      code: 'BEHAVIOR_PREPARATION_SKIPPED',
      skipKey: key,
    };
    saveProgress(store, runId, progress);
    notifyPreparation(store, runId);
    return { skipped: true, preparation: progress.preparation };
  });
  if (result.skipped) automaticWork.get(store)?.get(runId)?.controller.abort();
  return result;
}
type ToolBinding = { instanceId: string; actionId: string };
function behaviorToolContext(
  store: Store,
  runId: string,
  binding: ToolBinding,
  call: ToolAction,
  signal?: AbortSignal
) {
  if (signal?.aborted) fail('BEHAVIOR_RUN_CANCELLED');
  const reserved = store.run(runId);
  const run = { ...reserved, snapshot: preparedBehaviorSnapshot(store, runId, reserved.snapshot) };
  validateOwner(store, run);
  const permitted = listBehaviorTools(run.snapshot).find(
    (item) =>
      item.tool.name === call.name &&
      item.instanceId === binding.instanceId &&
      item.actionId === binding.actionId
  );
  if (!permitted) fail('BEHAVIOR_TOOL_NOT_ALLOWED');
  const definition = definitions(run.snapshot).find((d) => d.instanceId === binding.instanceId);
  const action = definition?.behavior.actions.find(
    (a) => a.id === binding.actionId && behaviorActionTriggers(a).includes('model')
  );
  if (!definition || !action) fail('BEHAVIOR_TOOL_NOT_ALLOWED');
  const progress = runBehaviorProgress(store, runId);
  if (!progress) fail('BEHAVIOR_RUN_JOURNAL_MISSING');
  return { run, definition: definition!, action: action!, progress: progress! };
}
const activeProgramTools = new WeakMap<
  Store,
  Map<string, { inputHash: string; work: Promise<RunBehaviorEntry> }>
>();

/** Both declarative and code actions use one async host entry point. No guest work holds a DB transaction. */
export async function executeRunBehaviorTool(
  store: Store,
  runId: string,
  binding: ToolBinding,
  call: ToolAction,
  signal?: AbortSignal,
  services?: PackageExtensionModelServices
): Promise<ToolEvent> {
  try {
    const prepared = store.transaction(() => {
      const { run, definition, action, progress } = behaviorToolContext(
        store,
        runId,
        binding,
        call,
        signal
      );
      const resolution = actionResolution(
        store,
        run.snapshot,
        progress,
        definition.ref,
        action,
        call.args as RuntimeValue,
        'model'
      );
      if (resolution.entry || !action.program) {
        const entry = finishActionResolution(
          store,
          progress,
          action,
          call.args as RuntimeValue,
          'model',
          resolution
        );
        saveProgress(store, runId, progress);
        return { entry };
      }
      return {
        program: action.program,
        input: { state: resolution.before.state, input: call.args as RuntimeValue },
        progressHash: hash(progress),
        profile: progressSnapshot(run.snapshot, progress).profile,
        attachment: definition.ref,
        snapshot: run.snapshot,
      };
    });
    let entry: RunBehaviorEntry;
    if (prepared.entry) entry = prepared.entry;
    else {
      let active = activeProgramTools.get(store);
      if (!active) {
        active = new Map();
        activeProgramTools.set(store, active);
      }
      const key = JSON.stringify([runId, binding.instanceId, binding.actionId]);
      const inputHash = hash(prepared.input);
      const pending = active.get(key);
      if (pending && pending.inputHash !== inputHash) fail('BEHAVIOR_OPPORTUNITY_INPUT_CHANGED');
      const work =
        pending?.work ??
        (async () => {
          const output = await executePackageExtensionProgram(
            prepared.program!,
            prepared.input!,
            signal,
            {
              profile: prepared.profile,
              attachment: prepared.attachment!,
              conversation: packageConversationExecution(
                store,
                prepared.snapshot!,
                prepared.profile,
                prepared.attachment!,
                prepared.program!,
                { request: prepared.snapshot!.request }
              ),
              modelServices: services,
              assertVariableWriteAccess: () =>
                assertExtensionVariableWriteAccess(
                  store,
                  prepared.profile,
                  prepared.attachment!,
                  prepared.program!
                ),
              assertCurrent: () => {
                const current = behaviorToolContext(store, runId, binding, call, signal);
                if (hash(current.progress) !== prepared.progressHash)
                  fail('BEHAVIOR_OPPORTUNITY_DEPENDENCY_CHANGED');
              },
            }
          );
          return store.transaction(() => {
            const context = behaviorToolContext(store, runId, binding, call, signal);
            if (hash(context.progress) !== prepared.progressHash)
              fail('BEHAVIOR_OPPORTUNITY_DEPENDENCY_CHANGED');
            if (output.variables && Object.keys(output.variables.changes).length)
              assertExtensionVariableWriteAccess(
                store,
                prepared.profile,
                prepared.attachment!,
                prepared.program!
              );
            const entry = resolveAction(
              store,
              context.run.snapshot,
              context.progress,
              context.definition.ref,
              context.action,
              call.args as RuntimeValue,
              'model',
              { ...output, programHash: hash(prepared.program) }
            );
            saveProgress(store, runId, context.progress);
            return entry;
          });
        })();
      if (!pending) active.set(key, { inputHash, work });
      try {
        entry = await work;
      } finally {
        if (active.get(key)?.work === work) active.delete(key);
      }
    }
    if (signal?.aborted) fail('BEHAVIOR_RUN_CANCELLED');
    return {
      callId: call.callId,
      name: call.name,
      args: structuredClone(call.args),
      denied: false,
      result: structuredClone(entry.result),
    };
  } catch (error) {
    // Cancellation/ownership remains a terminal host decision. Guest messages never become tool output.
    if (signal?.aborted) fail('BEHAVIOR_RUN_CANCELLED');
    const permissionDenied =
      error instanceof BehaviorError && error.message === 'BEHAVIOR_TOOL_NOT_ALLOWED';
    if (
      !permissionDenied &&
      !(error instanceof ExtensionProgramError) &&
      !isRecoverableBehaviorExecutionError(error)
    )
      throw error;
    const code = error instanceof ExtensionProgramError ? error.code : (error as Error).message;
    return {
      callId: call.callId,
      name: permissionDenied ? 'unapproved' : call.name,
      args: {},
      denied: true,
      result: {
        code,
        unavailable: true,
        continueWithoutAction: true,
      },
      errorKind: 'recoverable',
    };
  }
}

/** The source transaction adopts the complete global action chain before per-package commits. */
export function commitRunBehaviorVariables(store: Store, run: Run, source: Source): void {
  if (!run.snapshot.behaviorExecution) return;
  if (!store.db.isTransaction) throw new Error('CHAT_VARIABLE_TRANSACTION_REQUIRED');
  const progress = runBehaviorProgress(store, run.id);
  if (!progress) fail('BEHAVIOR_RUN_JOURNAL_MISSING');
  const branch = store.product.branch(run.chatId, run.snapshot.branchId);
  const currentRun = store.run(run.id);
  if (
    source.runId !== run.id ||
    source.chatId !== run.chatId ||
    currentRun.status !== 'completed' ||
    currentRun.sourceRevision !== source.id ||
    branch.headRevision !== source.id
  )
    fail('BEHAVIOR_SOURCE_STALE');
  for (const entry of progress!.entries) {
    if (!entry.program?.conversation) continue;
    const definition = definitions(run.snapshot).find(
      (item) => item.instanceId === entry.instanceId
    );
    const action = definition?.behavior.actions.find((item) => item.id === entry.actionId);
    if (!definition || !action?.program) fail('BEHAVIOR_TOOL_NOT_ALLOWED');
    assertRunConversationReceipt(
      store,
      run.snapshot,
      definition!.ref,
      action!.program!,
      entry.program.conversation,
      undefined,
      !behaviorHookBeforeRequest(action!)
    );
  }
  const entries = progress!.entries.filter((entry) => entry.program?.variables);
  if (!entries.length) return;
  let state = variableStateFromProfile(run.snapshot.profile);
  if (!isDeepStrictEqual(readChatVariables(store, run.chatId, branch.id), state))
    fail('BEHAVIOR_VARIABLE_STATE_STALE');
  for (const entry of entries) {
    const definition = definitions(run.snapshot).find(
      (item) => item.instanceId === entry.instanceId
    );
    const action = definition?.behavior.actions.find((item) => item.id === entry.actionId);
    if (!definition || !action?.program) fail('BEHAVIOR_TOOL_NOT_ALLOWED');
    if (Object.keys(entry.program!.variables!.changes).length)
      assertExtensionVariableWriteAccess(
        store,
        run.snapshot.profile,
        definition!.ref,
        action!.program!
      );
    state = projectExtensionVariableMutation(state, entry.program!.variables!);
  }
  if (!isDeepStrictEqual(state, progress!.variableState)) fail('BEHAVIOR_VARIABLE_STATE_STALE');
  for (const entry of entries)
    adoptExtensionVariableMutation(
      store,
      run.chatId,
      branch.id,
      source.hash,
      `run:${run.id}:${hash(entryKey(entry))}`,
      entry.program!.variables!
    );
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
  const definition = definitions(preparedBehaviorSnapshot(store, run.id, run.snapshot)).find(
    (d) => d.instanceId === instanceId
  );
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
  const base = preparedBehaviorSnapshot(store, run.id, run.snapshot);
  return progress
    ? {
        ...base,
        ...(progress.variableState
          ? { profile: profileWithExtensionVariables(base.profile, progress.variableState) }
          : {}),
        packageStates: structuredClone(progress.states).filter(
          (state) =>
            !base.packageBehaviorUnavailable?.some((item) => item.instanceId === state.instanceId)
        ),
      }
    : base;
}

/** A fork keeps recorded facts; subsequent turns obtain the new branch's independent opportunity. */
export function copyForkRunBehaviors(
  store: Store,
  chatId: string,
  branchId: string,
  sourceIds: Map<string, string>,
  runIds?: Map<string, string>
) {
  const copied = new Map<string, string>();
  const pairs = new Map(runIds);
  for (const [oldSourceId, newSourceId] of sourceIds)
    pairs.set(store.source(oldSourceId).runId, store.source(newSourceId).runId);
  for (const [oldRunId, newRunId] of pairs) {
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
