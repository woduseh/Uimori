import type {
  ExtensionOperationCommand,
  ExtensionOperationSnapshot,
} from '../core/extension-operation.js';
import { validateExtensionUserModelAttribution } from '../core/extension-model.js';
import { packageInstanceId } from '../core/execution-context.js';
import { ExtensionProgramError, type ResolvedExtensionProgram } from '../core/extension-program.js';
import type { Usage } from '../core/types.js';
import {
  authorizeExtensionModelAccess,
  createExtensionModelService,
  type ExtensionModelHooks,
} from './extension-model.js';
import { executePackageExtensionProgram } from './package-extension-execution.js';
import {
  cancelExtensionOperation,
  claimExtensionOperation,
  createExtensionOperation,
  extensionOperation,
  findExtensionOperation,
  finishExtensionOperationAttempt,
  finishExtensionOperationInTransaction,
  ownsExtensionOperation,
  queuedExtensionOperations,
  settleExtensionOperationUsage,
  startExtensionOperationAttempt,
} from './extension-operations.js';
import {
  assertUserBehaviorProgramCurrent,
  performBehaviorAction,
  prepareUserBehaviorProgram,
} from './package-behavior-host.js';
import { behaviorPayloadHash } from './package-behavior-store.js';
import { HttpError } from './request-validation.js';
import type { Store } from './store.js';

type Options = Pick<
  ExtensionModelHooks,
  'signal' | 'approvedOrigins' | 'resolveCredential' | 'executeCodex' | 'vertexRequestTier'
> & {
  owner: string;
  publish: (chatId: string) => void;
  track: (work: Promise<void>) => void;
};

export function createExtensionOperationRunner(store: Store, options: Options) {
  const active = new Map<string, AbortController>();
  function pump() {
    if (options.signal.aborted) return;
    for (const id of queuedExtensionOperations(store)) {
      if (active.size >= 2) break;
      if (active.has(id)) continue;
      const claimed = claimExtensionOperation(store, id, options.owner);
      if (!claimed) continue;
      const controller = new AbortController();
      active.set(id, controller);
      const signal = AbortSignal.any([controller.signal, options.signal]);
      const work = (async () => {
        const usage: Usage = { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
        let result: ResolvedExtensionProgram | null = null;
        const snapshot = claimed.snapshot;
        const { panel, ...command } = claimed.command;
        const binding = {
          instanceId: claimed.instanceId,
          actionId: command.actionId,
          trigger: 'user' as const,
        };
        const assertCurrent = () => {
          if (signal.aborted || !ownsExtensionOperation(store, claimed))
            throw new ExtensionProgramError('EXTENSION_CANCELLED');
          assertUserBehaviorProgramCurrent(
            store,
            claimed.chatId,
            claimed.branchId,
            claimed.instanceId,
            command,
            snapshot.guard,
            panel
          );
        };
        const authorizeModel = () => {
          assertCurrent();
          authorizeExtensionModelAccess(store, snapshot, binding, binding);
        };
        try {
          assertCurrent();
          const ref = snapshot.profile.packageAttachments?.find(
            (item) =>
              item.id === snapshot.scope.packageId &&
              item.revision === snapshot.scope.packageRevision &&
              packageInstanceId(item) === claimed.instanceId
          );
          const pkg = snapshot.profile.packages?.find(
            (item) =>
              item.id === snapshot.scope.packageId &&
              item.revision === snapshot.scope.packageRevision
          );
          const program = pkg?.behavior?.actions.find(
            (item) => item.id === command.actionId
          )?.program;
          if (!ref || !program) throw new HttpError(409, 'BEHAVIOR_ACTION_UNKNOWN');
          const hooks: ExtensionModelHooks = {
            ...options,
            signal,
            authorize: (connection) => store.product.authorize(connection),
            authorizeExtensionModel: authorizeModel,
            onAttemptStart: (wire) =>
              store.transaction(() => {
                authorizeModel();
                const { target } = validateExtensionUserModelAttribution(
                  snapshot.profile,
                  binding,
                  wire.extensionAction
                );
                if (
                  wire.role !== 'state' ||
                  wire.agentId !== undefined ||
                  wire.modelId !== target.modelId ||
                  wire.connectionId !== target.connectionId
                )
                  throw new HttpError(400, 'BEHAVIOR_HOST_MODEL_ATTRIBUTION');
                store.product.authorize(target.connection);
                const attemptId = startExtensionOperationAttempt(store, claimed, wire);
                options.publish(claimed.chatId);
                return attemptId;
              }),
            onAttemptFinish: (attemptId, outcome) =>
              finishExtensionOperationAttempt(store, claimed.id, attemptId, outcome),
          };
          const models = createExtensionModelService(snapshot, hooks, usage, {
            phase: 'user-action',
            userAction: binding,
          });
          await executePackageExtensionProgram(
            program,
            { state: snapshot.state, input: command.input },
            signal,
            {
              profile: snapshot.profile,
              attachment: ref,
              assertCurrent,
              waitForSlot: true,
              modelServices: {
                hostWaitMs: models.hostWaitMs,
                modelGenerate: (args, callSignal) => models.generate(binding, args, callSignal),
                assertModelAccess: authorizeModel,
              },
              onExecuted: (executed) => {
                result = { ...executed, programHash: behaviorPayloadHash(program) };
              },
            }
          );
          assertCurrent();
          store.transaction(() => {
            assertCurrent();
            performBehaviorAction(
              store,
              claimed.chatId,
              claimed.branchId,
              claimed.instanceId,
              command,
              false,
              panel,
              {
                guard: snapshot.guard,
                runtime: snapshot.runtime,
                result: result!,
              }
            );
            if (
              !finishExtensionOperationInTransaction(
                store,
                claimed,
                'completed',
                result,
                usage,
                null
              )
            )
              throw new HttpError(409, 'EXTENSION_OPERATION_NOT_ACTIVE');
          });
        } catch (error) {
          if (!options.signal.aborted) {
            const message =
              error instanceof ExtensionProgramError
                ? error.code
                : error instanceof HttpError
                  ? error.message
                  : '';
            const code = /^(?:BEHAVIOR|EXTENSION|MODEL)_[A-Z0-9_]{1,100}$/u.test(message)
              ? message
              : 'EXTENSION_OPERATION_FAILED';
            store.transaction(() => {
              finishExtensionOperationInTransaction(store, claimed, 'failed', result, usage, code);
              settleExtensionOperationUsage(store, id, usage);
            });
          }
        } finally {
          active.delete(id);
          if (!options.signal.aborted) {
            options.publish(claimed.chatId);
            queueMicrotask(pump);
          }
        }
      })();
      options.track(work);
      options.publish(claimed.chatId);
    }
  }
  return {
    requiresOperation(
      chatId: string,
      requestedBranch: string | undefined,
      instanceId: string,
      command: ExtensionOperationCommand
    ) {
      const branch = store.product.branch(chatId, requestedBranch);
      if (findExtensionOperation(store, chatId, branch.id, instanceId, command.idempotencyKey))
        return true;
      const profile = store.product.snapshot(chatId);
      const ref = profile?.packageAttachments?.find(
        (item) => packageInstanceId(item) === instanceId
      );
      const pkg = profile?.packages?.find(
        (item) => item.id === ref?.id && item.revision === ref?.revision
      );
      return (
        pkg?.behavior?.actions
          .find((item) => item.id === command.actionId)
          ?.program?.capabilities?.includes('model.generate') === true
      );
    },
    enqueue(
      chatId: string,
      requestedBranch: string | undefined,
      instanceId: string,
      input: ExtensionOperationCommand
    ) {
      if (options.signal.aborted) throw new HttpError(409, 'EXTENSION_INTERRUPTED');
      const branch = store.product.branch(chatId, requestedBranch);
      const prior = findExtensionOperation(
        store,
        chatId,
        branch.id,
        instanceId,
        input.idempotencyKey
      );
      if (prior) {
        if (behaviorPayloadHash(prior.command) !== behaviorPayloadHash(input))
          throw new HttpError(409, 'BEHAVIOR_IDEMPOTENCY_CONFLICT');
        return { operationId: prior.id, reused: true };
      }
      const { panel, ...command } = input;
      const prepared = prepareUserBehaviorProgram(
        store,
        chatId,
        branch.id,
        instanceId,
        command,
        panel
      );
      if (!prepared) {
        performBehaviorAction(store, chatId, branch.id, instanceId, command, false, panel);
        return { operationId: null, reused: true };
      }
      const snapshot: ExtensionOperationSnapshot = {
        version: 1,
        scope: prepared.scope,
        stateRevision: prepared.stateRevision,
        state: prepared.input.state,
        runtime: prepared.runtime,
        guard: prepared.guard,
        profile: prepared.profile,
        settings: prepared.settings,
        sourceRevision: prepared.sourceRevision,
        sourceHash: prepared.sourceHash,
      };
      const admitted = createExtensionOperation(store, input, snapshot);
      if (!admitted.reused) queueMicrotask(pump);
      options.publish(chatId);
      return { operationId: admitted.operation.id, reused: admitted.reused };
    },
    cancel(chatId: string, id: string) {
      const operation = extensionOperation(store, id);
      if (operation.chatId !== chatId) throw new HttpError(404, 'EXTENSION_OPERATION_NOT_FOUND');
      const cancelled = cancelExtensionOperation(store, id);
      active.get(id)?.abort();
      options.publish(chatId);
      return { cancelled: cancelled.status === 'cancelled', status: cancelled.status };
    },
    pump,
  };
}
export type ExtensionOperationController = ReturnType<typeof createExtensionOperationRunner>;
