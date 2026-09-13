import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { AfterResponsePackage, AfterResponseProgress } from '../core/after-response.js';
import { projectBehaviorOutputs } from '../core/behavior-output.js';
import { executionContext, packageInstanceId } from '../core/execution-context.js';
import { ExtensionProgramError, type ExtensionProgramReceipt } from '../core/extension-program.js';
import { createExtensionProgramReceipt } from './extension-program-receipt.js';
import {
  BehaviorError,
  BehaviorEvaluationError,
  behaviorActionAllowed,
  behaviorActionTriggers,
} from '../core/package-behavior.js';
import { historicalPersonaExcluded } from '../core/persona-scope.js';
import type { ExtensionModelBinding } from '../core/extension-model.js';
import { fields, record, text as requestText, HttpError } from './request-validation.js';
import type { RunSnapshot } from '../core/types.js';
import { createResponseExtensionHost } from './extension-response.js';
import {
  packageConversationExecution,
  assertRunConversationReceipt,
} from './package-conversation.js';
import {
  executePackageExtensionProgram,
  type PackageExtensionModelServices,
} from './package-extension-execution.js';
import {
  completedRunBehaviorView,
  runBehaviorProgress,
  saveProgress,
  validateOwner,
} from './package-behavior-run.js';
import { behaviorPayloadHash } from './package-behavior-store.js';
import type { Run, Store } from './store.js';
import {
  variableStateFromProfile,
  profileWithExtensionVariables,
  projectExtensionVariableMutation,
  assertExtensionVariableWriteAccess,
  adoptExtensionVariableMutation,
} from './extension-variables.js';

const DEADLINE_MS = 10_000;
const active = new WeakMap<
  Store,
  Map<string, { sourceHash: string; work: Promise<void>; controller: AbortController }>
>();
function fail(code: string): never {
  throw new BehaviorError(409, code);
}
function definitions(snapshot: RunSnapshot) {
  return (snapshot.profile?.packageAttachments ?? []).flatMap((ref) => {
    const instanceId = packageInstanceId(ref);
    if (
      historicalPersonaExcluded(snapshot.profile, ref.role) ||
      snapshot.packageBehaviorUnavailable?.some((item) => item.instanceId === instanceId)
    )
      return [];
    const behavior = snapshot.profile?.packages?.find(
      (pkg) => pkg.id === ref.id && pkg.revision === ref.revision
    )?.behavior;
    const before = snapshot.packageStates?.find((item) => item.instanceId === instanceId);
    return behavior && before
      ? [
          {
            ref,
            instanceId,
            behavior,
            before,
            actions: behavior.actions.filter((action) =>
              behaviorActionTriggers(action).includes('after-turn')
            ),
          },
        ]
      : [];
  });
}

/** Resolve optional response hooks without publishing state or replaying opportunity entries. */
export async function prepareAfterResponse(
  store: Store,
  runId: string,
  text: string,
  signal?: AbortSignal,
  onProgress?: () => void,
  modelServices?: (binding: ExtensionModelBinding) => PackageExtensionModelServices
): Promise<void> {
  const run = store.run(runId);
  const snapshot = completedRunBehaviorView(store, run);
  const defs = definitions(snapshot);
  const hooks = defs.filter((item) => item.actions.length);
  if (!hooks.length) return;
  const sourceHash = createHash('sha256').update(text).digest('hex');
  let workByRun = active.get(store);
  if (!workByRun) {
    workByRun = new Map();
    active.set(store, workByRun);
  }
  const pending = workByRun.get(runId);
  if (pending) {
    if (pending.sourceHash !== sourceHash) fail('BEHAVIOR_AFTER_RESPONSE_SOURCE_CHANGED');
    return pending.work;
  }
  const controller = new AbortController();
  // Register ownership before computation can persist and synchronously notify a skip caller.
  let resolveWork!: () => void;
  let rejectWork!: (error: unknown) => void;
  const work = new Promise<void>((resolve, reject) => {
    resolveWork = resolve;
    rejectWork = reject;
  });
  workByRun.set(runId, { sourceHash, work, controller });
  void compute()
    .catch((error: unknown) => {
      if (!(error instanceof BehaviorError) || error.message !== 'BEHAVIOR_RUN_JOURNAL_LIMIT')
        throw error;
      // This optional computation cannot consume the existing journal's remaining capacity
      // at the expense of committing its source. Preserve every before/model/preparation fact.
      store.transaction(() => {
        assertCurrentRun();
        const current = runBehaviorProgress(store, runId);
        if (!current) fail('BEHAVIOR_RUN_JOURNAL_MISSING');
        if (current.afterResponse && current.afterResponse.sourceHash !== sourceHash)
          fail('BEHAVIOR_AFTER_RESPONSE_SOURCE_CHANGED');
        delete current.afterResponse;
        saveProgress(store, runId, current);
        store.event(run.chatId, 'run.package-after-response.unavailable', runId);
      });
      onProgress?.();
    })
    .then(resolveWork, rejectWork);
  try {
    await work;
  } finally {
    workByRun.delete(runId);
  }

  function assertCurrentRun() {
    if (signal?.aborted) fail('BEHAVIOR_RUN_CANCELLED');
    const current = store.run(runId);
    if (!isDeepStrictEqual(current.snapshot, run.snapshot))
      fail('BEHAVIOR_AFTER_RESPONSE_SOURCE_CHANGED');
    validateOwner(store, current);
  }

  async function compute() {
    let ownerFailure: unknown;
    let expired = false;
    const assertOwner = () => {
      if (ownerFailure) throw ownerFailure;
      assertCurrentRun();
    };
    assertOwner();
    if (
      store.db
        .prepare(
          "SELECT 1 FROM events WHERE chat_id=? AND kind='run.package-after-response.unavailable' AND entity_id=? LIMIT 1"
        )
        .get(run.chatId, runId)
    )
      return;
    const prior = runBehaviorProgress(store, runId)?.afterResponse;
    if (prior) {
      if (prior.sourceHash !== sourceHash) fail('BEHAVIOR_AFTER_RESPONSE_SOURCE_CHANGED');
      if (prior.status === 'completed' || prior.status === 'skipped') return;
      // A durable unfinished receipt belongs to an interrupted computation, never a replay.
      fail('BEHAVIOR_AFTER_RESPONSE_INTERRUPTED');
    }
    const progress: AfterResponseProgress = {
      version: 1,
      sourceHash,
      status: 'running',
      completed: 0,
      total: hooks.length,
      packages: [],
    };
    const persist = () => {
      store.transaction(() => {
        assertOwner();
        const current = runBehaviorProgress(store, runId);
        if (!current) fail('BEHAVIOR_RUN_JOURNAL_MISSING');
        if (current.afterResponse && current.afterResponse.sourceHash !== sourceHash)
          fail('BEHAVIOR_AFTER_RESPONSE_SOURCE_CHANGED');
        if (current.afterResponse?.status === 'skipped') return;
        saveProgress(store, runId, { ...current, afterResponse: structuredClone(progress) });
        store.event(run.chatId, 'run.package-after-response', runId);
      });
      onProgress?.();
    };
    persist();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const started = Date.now();
    let hostBudget = 0;
    const expire = () => {
      expired = true;
      controller.abort();
    };
    let deadline = setTimeout(expire, DEADLINE_MS);
    const skipped = () => runBehaviorProgress(store, runId)?.afterResponse?.status === 'skipped';
    const ownerCheck = setInterval(() => {
      try {
        assertOwner();
      } catch (error) {
        ownerFailure = error;
        controller.abort();
      }
    }, 50);
    try {
      const parserStates = structuredClone(snapshot.packageStates ?? []);
      const parserFailures = new Map<string, string>();
      let authoritativeFailure = false;
      for (const d of defs) {
        if (!d.behavior.outputParsers.length) continue;
        try {
          const state = projectBehaviorOutputs(
            d.behavior,
            d.behavior.outputParsers.map((parser) => parser.id),
            d.before.state,
            text,
            executionContext(snapshot, 'main', d.ref)
          );
          if (d.behavior.outputParsers.length) {
            const at = parserStates.findIndex((item) => item.instanceId === d.instanceId);
            parserStates[at] = { ...d.before, state, stateRevision: d.before.stateRevision + 1 };
          }
        } catch (error) {
          if (!(error instanceof BehaviorEvaluationError)) throw error;
          parserFailures.set(d.instanceId, 'BEHAVIOR_AFTER_RESPONSE_PARSER_FAILED');
          if (d.behavior.mode !== 'annotation') authoritativeFailure = true;
        }
      }
      let variables = variableStateFromProfile(snapshot.profile);
      for (const d of hooks) {
        assertOwner();
        if (skipped()) return;
        const before = structuredClone(
          parserStates.find((item) => item.instanceId === d.instanceId)!
        );
        const receipt: AfterResponsePackage = {
          instanceId: d.instanceId,
          status: 'ready',
          before,
          after: structuredClone(before),
          entries: [],
        };
        let packageVariables = structuredClone(variables);
        try {
          if (authoritativeFailure || parserFailures.has(d.instanceId))
            throw new ExtensionProgramError('BEHAVIOR_AFTER_RESPONSE_PARSER_FAILED');
          for (const action of d.actions) {
            assertOwner();
            if (skipped()) return;
            if (expired) throw new ExtensionProgramError('BEHAVIOR_AFTER_RESPONSE_TIMEOUT');
            const input = action.automaticInput ?? {};
            const profile = profileWithExtensionVariables(snapshot.profile, packageVariables);
            const hostRuntime = executionContext(
              {
                ...snapshot,
                profile,
                packageStates: parserStates.map((state) =>
                  state.instanceId === d.instanceId ? receipt.after : state
                ),
              },
              'main',
              d.ref
            );
            if (!behaviorActionAllowed(action, receipt.after.state, input, hostRuntime)) continue;
            if (!action.program || action.draws?.length)
              fail('BEHAVIOR_AFTER_RESPONSE_PROGRAM_REQUIRED');
            const usesModel = action.program.capabilities?.includes('model.generate') === true;
            const services = usesModel
              ? modelServices?.({
                  instanceId: d.instanceId,
                  actionId: action.id,
                  trigger: 'after-turn',
                })
              : undefined;
            if (services) {
              const bounded = Math.min(
                30 * 60_000,
                Math.max(0, Number.isFinite(services.hostWaitMs) ? services.hostWaitMs : 0)
              );
              if (bounded > hostBudget) {
                hostBudget = bounded;
                clearTimeout(deadline);
                deadline = setTimeout(
                  expire,
                  Math.max(0, started + DEADLINE_MS + hostBudget - Date.now())
                );
              }
            }
            const assertCurrent = () => {
              assertOwner();
              if (controller.signal.aborted || skipped())
                throw new ExtensionProgramError('BEHAVIOR_HOST_ABORTED');
            };
            const response = createResponseExtensionHost(action.program, text, assertCurrent);
            const resolved = await executePackageExtensionProgram(
              action.program,
              { state: receipt.after.state, input },
              controller.signal,
              {
                waitForSlot: true,
                profile,
                attachment: d.ref,
                assertCurrent,
                assertVariableWriteAccess: () =>
                  assertExtensionVariableWriteAccess(store, profile, d.ref, action.program!),
                modelServices: services,
                responseHost: response,
                conversation: packageConversationExecution(
                  store,
                  run.snapshot,
                  profile,
                  d.ref,
                  action.program!,
                  { request: run.snapshot.request, response: text }
                ),
                hostWaitMs: services
                  ? Math.max(1, Math.min(30 * 60_000, services.hostWaitMs))
                  : DEADLINE_MS,
              }
            );
            assertOwner();
            if (skipped()) return;
            assertCurrent();
            if (expired) throw new ExtensionProgramError('BEHAVIOR_AFTER_RESPONSE_TIMEOUT');
            let program: ExtensionProgramReceipt;
            try {
              const programHash = behaviorPayloadHash(action.program);
              program = createExtensionProgramReceipt(
                { ...resolved, programHash },
                {
                  programHash,
                  stateSchema: d.behavior.stateSchema,
                }
              );
            } catch (error) {
              if (error instanceof BehaviorError)
                throw new ExtensionProgramError('BEHAVIOR_AFTER_RESPONSE_STATE_INVALID');
              throw error;
            }
            const after = {
              ...structuredClone(receipt.after),
              state: program.state,
              stateRevision: receipt.after.stateRevision + 1,
            };
            receipt.entries.push({
              instanceId: d.instanceId,
              actionId: action.id,
              trigger: 'after-turn',
              input: structuredClone(input),
              before: structuredClone(receipt.after),
              after,
              result: program.result,
              draws: {},
              drawSeed: null,
              hostRuntime,
              program,
            });
            receipt.after = after;
            if (program.variables)
              packageVariables = projectExtensionVariableMutation(
                packageVariables,
                program.variables
              );
            // Guest receipts include host context; bound the whole cohort, not just one result.
            if (receipt.entries.length > 100 || JSON.stringify(receipt).length > 1_000_000)
              throw new ExtensionProgramError('BEHAVIOR_AFTER_RESPONSE_RECEIPT_LIMIT');
          }
        } catch (error) {
          const expectedAbort =
            controller.signal.aborted &&
            (error === controller.signal.reason ||
              (error instanceof Error && error.name === 'AbortError'));
          if (
            !(error instanceof ExtensionProgramError) &&
            !(error instanceof BehaviorEvaluationError) &&
            !expectedAbort
          )
            throw error;
          assertOwner();
          if (skipped()) return;
          receipt.status = 'failed';
          receipt.code = expired
            ? 'BEHAVIOR_AFTER_RESPONSE_TIMEOUT'
            : error instanceof ExtensionProgramError
              ? error.code
              : 'BEHAVIOR_AFTER_RESPONSE_EVALUATION_FAILED';
          receipt.after = structuredClone(before);
          receipt.entries = [];
        }
        if (receipt.status === 'ready') variables = packageVariables;
        progress.packages.push(receipt);
        progress.completed++;
        persist();
      }
      assertOwner();
      progress.status = 'completed';
      persist();
    } finally {
      clearTimeout(deadline);
      clearInterval(ownerCheck);
      signal?.removeEventListener('abort', abort);
      controller.abort();
    }
  }
}

/** Called only inside a package savepoint, after native output parser adoption. */
export function commitAfterResponseInstance(
  store: Store,
  run: Run,
  instanceId: string,
  sourceHash: string
): void {
  const progress = runBehaviorProgress(store, run.id)?.afterResponse;
  if (!progress) return;
  if (progress.status === 'skipped') {
    if (progress.sourceHash !== sourceHash) fail('BEHAVIOR_AFTER_RESPONSE_SOURCE_CHANGED');
    return;
  }
  if (
    progress.version !== 1 ||
    progress.status !== 'completed' ||
    progress.sourceHash !== sourceHash ||
    progress.completed !== progress.total ||
    progress.packages.length !== progress.total ||
    new Set(progress.packages.map((item) => item.instanceId)).size !== progress.total
  )
    fail('BEHAVIOR_AFTER_RESPONSE_RECEIPT_INVALID');
  const receipt = progress.packages.find((item) => item.instanceId === instanceId);
  if (!receipt || receipt.status === 'failed') return;
  const definition = definitions(completedRunBehaviorView(store, run)).find(
    (item) => item.instanceId === instanceId
  );
  if (!definition || receipt.status !== 'ready') fail('BEHAVIOR_AFTER_RESPONSE_RECEIPT_INVALID');
  const scope = {
    chatId: run.chatId,
    branchId: run.snapshot.branchId ?? `main:${run.chatId}`,
    attachmentInstanceId: instanceId,
    packageId: definition.ref.id,
    packageRevision: definition.ref.revision,
    behaviorRevision: definition.behavior.revision,
    schemaVersion: definition.behavior.schemaVersion,
  };
  const current = store.behavior.read(scope, definition.behavior);
  if (
    current.stateRevision !== receipt.before.stateRevision ||
    !isDeepStrictEqual(current.state, receipt.before.state)
  )
    fail('BEHAVIOR_STATE_STALE');
  let expected = receipt.before;
  const ids = new Set<string>();
  let previousAction = -1;
  for (const entry of receipt.entries) {
    const actionIndex = definition.actions.findIndex((action) => action.id === entry.actionId);
    if (
      entry.instanceId !== instanceId ||
      entry.trigger !== 'after-turn' ||
      ids.has(entry.actionId) ||
      actionIndex <= previousAction ||
      !isDeepStrictEqual(entry.before, expected) ||
      !isDeepStrictEqual(entry.after, {
        ...expected,
        state: entry.after.state,
        stateRevision: expected.stateRevision + 1,
      })
    )
      fail('BEHAVIOR_AFTER_RESPONSE_RECEIPT_INVALID');
    ids.add(entry.actionId);
    previousAction = actionIndex;
    if (entry.program.conversation) {
      const completedSource = store.run(run.id).sourceRevision;
      if (!completedSource) fail('BEHAVIOR_SOURCE_STALE');
      const response = store.sourceOriginal(completedSource!);
      if (response.hash !== sourceHash) fail('BEHAVIOR_SOURCE_STALE');
      assertRunConversationReceipt(
        store,
        run.snapshot,
        definition.ref,
        definition.actions[actionIndex].program!,
        entry.program.conversation,
        response.text
      );
    }
    store.behavior.commitRunActionInTransaction(
      scope,
      definition.behavior,
      entry,
      sourceHash,
      `after:${run.id}:${behaviorPayloadHash(JSON.stringify([instanceId, entry.actionId]))}`
    );
    if (entry.program.variables) {
      if (Object.keys(entry.program.variables.changes).length)
        assertExtensionVariableWriteAccess(
          store,
          run.snapshot.profile,
          definition.ref,
          definition.actions[actionIndex].program!
        );
      adoptExtensionVariableMutation(
        store,
        run.chatId,
        scope.branchId,
        sourceHash,
        `after-vars:${run.id}:${behaviorPayloadHash(JSON.stringify([instanceId, entry.actionId]))}`,
        entry.program.variables
      );
    }
    expected = entry.after;
  }
  if (!isDeepStrictEqual(expected, receipt.after)) fail('BEHAVIOR_AFTER_RESPONSE_RECEIPT_INVALID');
}

/** Close optional adoption immediately; the owning preparation still awaits host settlement. */
export function skipAfterResponse(store: Store, runId: string, value: unknown) {
  const result = store.transaction(() => {
    const body = record(value);
    fields(body, ['chatId', 'branchId', 'expectedRevision', 'idempotencyKey']);
    const run = store.run(runId);
    const chatId = requestText(body.chatId, 'chat ID', 200),
      branchId = requestText(body.branchId, 'branch ID', 200),
      key = requestText(body.idempotencyKey, 'idempotency key', 200);
    if (
      chatId !== run.chatId ||
      branchId !== (run.snapshot.branchId ?? `main:${run.chatId}`) ||
      body.expectedRevision !== run.parentRevision
    )
      throw new HttpError(409, 'BEHAVIOR_AFTER_RESPONSE_OWNER_MISMATCH');
    const progress = runBehaviorProgress(store, runId);
    const afterResponse = progress?.afterResponse;
    if (!progress || !afterResponse)
      throw new HttpError(409, 'BEHAVIOR_AFTER_RESPONSE_NOT_RUNNING');
    if (afterResponse.skipKey === key) return { skipped: true, afterResponse };
    if (afterResponse.status !== 'running') return { skipped: false, afterResponse };
    if (!['queued', 'running', 'waiting_for_state'].includes(run.status))
      throw new HttpError(409, 'BEHAVIOR_AFTER_RESPONSE_FINISHED');
    validateOwner(store, run);
    progress.afterResponse = { ...afterResponse, status: 'skipped', skipKey: key };
    saveProgress(store, runId, progress);
    store.event(run.chatId, 'run.package-after-response', runId);
    return { skipped: true, afterResponse: progress.afterResponse };
  });
  if (result.skipped) active.get(store)?.get(runId)?.controller.abort();
  return result;
}
