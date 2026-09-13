import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { AfterResponsePackage, AfterResponseProgress } from '../core/after-response.js';
import { projectBehaviorOutputs } from '../core/behavior-output.js';
import { executionContext, packageInstanceId } from '../core/execution-context.js';
import { EXTENSION_PROGRAM_API, ExtensionProgramError } from '../core/extension-program.js';
import {
  BehaviorError,
  BehaviorEvaluationError,
  behaviorActionAllowed,
  behaviorActionTriggers,
  validateBehaviorValue,
} from '../core/package-behavior.js';
import { historicalPersonaExcluded } from '../core/persona-scope.js';
import type { RunSnapshot } from '../core/types.js';
import { createPackageExtensionHost } from './extension-materials.js';
import { createResponseExtensionHost } from './extension-response.js';
import { executeExtensionProgram } from './extension-runtime.js';
import {
  completedRunBehaviorView,
  runBehaviorProgress,
  saveProgress,
  validateOwner,
} from './package-behavior-run.js';
import { behaviorPayloadHash } from './package-behavior-store.js';
import type { Run, Store } from './store.js';

const DEADLINE_MS = 10_000;
const active = new WeakMap<Store, Map<string, { sourceHash: string; work: Promise<void> }>>();
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
  onProgress?: () => void
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
  const work = compute().catch((error: unknown) => {
    if (!(error instanceof BehaviorError) || error.message !== 'BEHAVIOR_RUN_JOURNAL_LIMIT')
      throw error;
    // This pure optional computation cannot consume the existing journal's remaining capacity
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
  });
  workByRun.set(runId, { sourceHash, work });
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
    const controller = new AbortController();
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
      if (prior.status === 'completed') return;
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
        saveProgress(store, runId, { ...current, afterResponse: structuredClone(progress) });
        store.event(run.chatId, 'run.package-after-response', runId);
      });
      onProgress?.();
    };
    persist();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const deadline = setTimeout(() => {
      expired = true;
      controller.abort();
    }, DEADLINE_MS);
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
      for (const d of hooks) {
        assertOwner();
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
        try {
          if (authoritativeFailure || parserFailures.has(d.instanceId))
            throw new ExtensionProgramError('BEHAVIOR_AFTER_RESPONSE_PARSER_FAILED');
          for (const action of d.actions) {
            assertOwner();
            if (expired) throw new ExtensionProgramError('BEHAVIOR_AFTER_RESPONSE_TIMEOUT');
            const input = action.automaticInput ?? {};
            const hostRuntime = executionContext(
              {
                ...snapshot,
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
            const assertCurrent = () => {
              assertOwner();
              if (controller.signal.aborted)
                throw new ExtensionProgramError('BEHAVIOR_HOST_ABORTED');
            };
            const materials = createPackageExtensionHost(
              action.program,
              snapshot.profile,
              d.ref,
              assertCurrent
            );
            const response = createResponseExtensionHost(action.program, text, assertCurrent);
            const resolved = await executeExtensionProgram(
              action.program,
              { state: receipt.after.state, input },
              controller.signal,
              {
                waitForSlot: true,
                hostWaitMs: DEADLINE_MS,
                host: (method, args, hostSignal) =>
                  method.startsWith('response.')
                    ? response(method, args, hostSignal)
                    : materials(method, args, hostSignal),
              }
            );
            assertOwner();
            if (expired) throw new ExtensionProgramError('BEHAVIOR_AFTER_RESPONSE_TIMEOUT');
            try {
              validateBehaviorValue(d.behavior.stateSchema, resolved.state);
            } catch (error) {
              if (error instanceof BehaviorError)
                throw new ExtensionProgramError('BEHAVIOR_AFTER_RESPONSE_STATE_INVALID');
              throw error;
            }
            const after = {
              ...structuredClone(receipt.after),
              state: resolved.state,
              stateRevision: receipt.after.stateRevision + 1,
            };
            receipt.entries.push({
              instanceId: d.instanceId,
              actionId: action.id,
              trigger: 'after-turn',
              input: structuredClone(input),
              before: structuredClone(receipt.after),
              after,
              result: resolved.result,
              draws: {},
              drawSeed: null,
              hostRuntime,
              program: {
                ...resolved,
                api: EXTENSION_PROGRAM_API,
                programHash: behaviorPayloadHash(action.program),
              },
            });
            receipt.after = after;
            // Guest receipts include host context; bound the whole cohort, not just one result.
            if (receipt.entries.length > 100 || JSON.stringify(receipt).length > 1_000_000)
              throw new ExtensionProgramError('BEHAVIOR_AFTER_RESPONSE_RECEIPT_LIMIT');
          }
        } catch (error) {
          assertOwner();
          if (
            !(error instanceof ExtensionProgramError) &&
            !(error instanceof BehaviorEvaluationError)
          )
            throw error;
          receipt.status = 'failed';
          receipt.code = expired
            ? 'BEHAVIOR_AFTER_RESPONSE_TIMEOUT'
            : error instanceof ExtensionProgramError
              ? error.code
              : 'BEHAVIOR_AFTER_RESPONSE_EVALUATION_FAILED';
          receipt.after = structuredClone(before);
          receipt.entries = [];
        }
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
    store.behavior.commitRunActionInTransaction(
      scope,
      definition.behavior,
      entry,
      sourceHash,
      `after:${run.id}:${behaviorPayloadHash(JSON.stringify([instanceId, entry.actionId]))}`
    );
    expected = entry.after;
  }
  if (!isDeepStrictEqual(expected, receipt.after)) fail('BEHAVIOR_AFTER_RESPONSE_RECEIPT_INVALID');
}
