import type { PackageAttachment } from '../core/content-package.js';
import { packageInstanceId } from '../core/execution-context.js';
import { ExtensionProgramError, type ExtensionProgram } from '../core/extension-program.js';
import { BehaviorError } from '../core/package-behavior.js';
import { historicalPersonaExcluded } from '../core/persona-scope.js';
import type { ProfileSnapshot } from '../core/product.js';
import { PromptEvaluationError, type RuntimeValue } from '../core/prompt-values.js';
import { resolveTemplateVariableContext } from '../core/template-variables.js';
import {
  validateChatVariableMutation,
  validateChatVariableState,
  validateChatVariableValues,
  type ChatVariableMutation,
  type ChatVariableState,
} from '../core/chat-variables.js';
import { readChatVariables, writeChatVariablesInTransaction } from './chat-variables.js';
import { behaviorPayloadHash } from './package-behavior-store.js';
import { HttpError } from './request-validation.js';
import type { Store } from './store.js';

const fail = (code: string): never => {
  throw new ExtensionProgramError(code);
};
export const variableStateFromProfile = (profile: ProfileSnapshot | undefined): ChatVariableState =>
  validateChatVariableState(profile?.variableState ?? { revision: 0, values: {} });
export const chatVariableStateHash = (state: ChatVariableState) =>
  behaviorPayloadHash(validateChatVariableState(state));

export function projectExtensionVariableMutation(
  state: ChatVariableState,
  value: ChatVariableMutation
): ChatVariableState {
  const before = validateChatVariableState(state),
    mutation = validateChatVariableMutation(value);
  if (
    mutation.beforeRevision !== before.revision ||
    mutation.beforeHash !== chatVariableStateHash(before)
  )
    throw new BehaviorError(409, 'BEHAVIOR_VARIABLE_STATE_STALE');
  const entries = Object.entries(mutation.changes);
  if (!entries.length) return before;
  const values = { ...before.values };
  for (const [key, text] of entries) {
    if (text === null) delete values[key];
    else values[key] = text;
  }
  return validateChatVariableState({ revision: before.revision + 1, values });
}

/** A derived invocation view; the originally reserved ProfileSnapshot remains unchanged. */
export function profileWithExtensionVariables(
  profile: ProfileSnapshot | undefined,
  state: ChatVariableState
): ProfileSnapshot | undefined {
  if (!profile) return undefined;
  const result = { ...profile };
  if (state.revision > 0) result.variableState = validateChatVariableState(state);
  else delete result.variableState;
  return result;
}

function attached(profile: ProfileSnapshot | undefined, ref: PackageAttachment) {
  return (
    profile &&
    !historicalPersonaExcluded(profile, ref.role) &&
    profile.packageAttachments?.some(
      (item) => item.id === ref.id && item.revision === ref.revision && item.role === ref.role
    ) &&
    profile.packages?.some((pkg) => pkg.id === ref.id && pkg.revision === ref.revision)
  );
}

export function runtimeWithExtensionVariables(
  runtime: Record<string, RuntimeValue>,
  profile: ProfileSnapshot | undefined,
  state: ChatVariableState
): Record<string, RuntimeValue> {
  const {
    variables: _variables,
    variableDefaultsError: _error,
    variableStateRevision: _revision,
    ...rest
  } = runtime;
  return {
    ...rest,
    ...resolveTemplateVariableContext(profileWithExtensionVariables(profile, state)),
  };
}
function granted(profile: ProfileSnapshot | undefined, ref: PackageAttachment) {
  const grant = profile?.extensionGrants?.[packageInstanceId(ref)];
  return (
    attached(profile, ref) &&
    grant?.packageRevision === ref.revision &&
    grant.capabilities.includes('variables.write')
  );
}

/** Frozen receipt admission used by archive readers; never checks today's live grants. */
export function validateExtensionVariablePermission(
  mutation: ChatVariableMutation,
  profile: ProfileSnapshot | undefined,
  ref: PackageAttachment,
  program: ExtensionProgram
): void {
  validateChatVariableMutation(mutation);
  const writes = Object.keys(mutation.changes).length > 0;
  if (
    !attached(profile, ref) ||
    (writes
      ? !program.capabilities?.includes('variables.write') || !granted(profile, ref)
      : !program.capabilities?.includes('variables.read'))
  )
    fail('BEHAVIOR_HOST_VARIABLES_DENIED');
}

/** Captured permission and live revocation are both checked without replacing frozen data. */
export function assertExtensionVariableWriteAccess(
  store: Store,
  profile: ProfileSnapshot | undefined,
  ref: PackageAttachment,
  program: ExtensionProgram
): void {
  if (!program.capabilities?.includes('variables.write') || !granted(profile, ref))
    fail('BEHAVIOR_HOST_VARIABLES_DENIED');
  const live = store.product.profile(profile!.chatId);
  if (
    !granted(
      {
        ...profile!,
        packageAttachments: live.packageAttachments,
        extensionGrants: live.extensionGrants,
      },
      ref
    )
  )
    fail('BEHAVIOR_HOST_VARIABLES_DENIED');
}

/** Caller owns the action/source transaction and idempotency boundary. No guest writes here. */
export function adoptExtensionVariableMutation(
  store: Store,
  chatId: string,
  branchId: string,
  sourceHash: string | null,
  idempotencyKey: string,
  mutation: ChatVariableMutation
): ChatVariableState {
  if (!store.db.isTransaction) throw new Error('CHAT_VARIABLE_TRANSACTION_REQUIRED');
  const before = readChatVariables(store, chatId, branchId);
  const after = projectExtensionVariableMutation(before, mutation);
  if (after.revision === before.revision) return before;
  try {
    return writeChatVariablesInTransaction(store, chatId, branchId, {
      expectedRevision: before.revision,
      expectedSourceHash: sourceHash,
      idempotencyKey,
      values: after.values,
    });
  } catch (error) {
    if (error instanceof HttpError && error.message.startsWith('CHAT_VARIABLE_'))
      throw new BehaviorError(error.statusCode, 'BEHAVIOR_VARIABLE_STATE_STALE');
    throw error;
  }
}

function argumentsFor(value: RuntimeValue, keys: readonly string[]) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    fail('BEHAVIOR_HOST_ARGUMENTS');
  return value as Record<string, RuntimeValue>;
}
function integer(value: RuntimeValue | undefined, fallback: number, max: number) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max)
    fail('BEHAVIOR_HOST_ARGUMENTS');
  return value as number;
}

/** Stages branch-local effects in memory. Guest results cannot forge this receipt. */
export function createExtensionVariableSession(
  program: ExtensionProgram,
  profile: ProfileSnapshot | undefined,
  ref: PackageAttachment,
  assertCurrent: () => void,
  assertWriteAccess?: () => void
) {
  const captured = profile ? structuredClone(profile) : undefined;
  const before = variableStateFromProfile(captured);
  let state = before,
    used = false,
    generation = 0;
  const changes: Record<string, string | null> = {};
  const mutation = (): ChatVariableMutation => ({
    beforeRevision: before.revision,
    beforeHash: chatVariableStateHash(before),
    changes: structuredClone(changes),
  });
  const requireWrite = () => {
    if (
      !program.capabilities?.includes('variables.write') ||
      !granted(captured, ref) ||
      !assertWriteAccess
    )
      fail('BEHAVIOR_HOST_VARIABLES_DENIED');
    assertWriteAccess!();
  };
  return {
    get generation() {
      return generation;
    },
    profile: () => profileWithExtensionVariables(captured, state),
    receipt: () => (used ? mutation() : undefined),
    assertWriteAccess: () => {
      if (Object.keys(changes).length) requireWrite();
    },
    async host(method: string, value: RuntimeValue, signal: AbortSignal): Promise<RuntimeValue> {
      if (signal.aborted) fail('BEHAVIOR_HOST_ABORTED');
      if (
        !attached(captured, ref) ||
        !['variables.list', 'variables.read', 'variables.set', 'variables.delete'].includes(method)
      )
        fail('BEHAVIOR_HOST_VARIABLES_DENIED');
      assertCurrent();
      const write = method === 'variables.set' || method === 'variables.delete';
      if (write) requireWrite();
      else if (!program.capabilities?.includes('variables.read'))
        fail('BEHAVIOR_HOST_VARIABLES_DENIED');
      const args = argumentsFor(
        value,
        method === 'variables.list'
          ? ['offset', 'limit']
          : method === 'variables.read'
            ? ['key', 'offset', 'limit']
            : method === 'variables.set'
              ? ['key', 'value']
              : ['key']
      );
      if (method !== 'variables.list' && typeof args.key !== 'string')
        fail('BEHAVIOR_HOST_ARGUMENTS');
      const key = args.key as string;
      if (method !== 'variables.list') {
        try {
          validateChatVariableValues({ [key]: '' });
        } catch (error) {
          if (error instanceof PromptEvaluationError) fail('BEHAVIOR_HOST_ARGUMENTS');
          throw error;
        }
      }
      if (write) {
        if (method === 'variables.set' && typeof args.value !== 'string')
          fail('BEHAVIOR_HOST_ARGUMENTS');
        const next = {
          ...changes,
          [key]: method === 'variables.delete' ? null : (args.value as string),
        };
        let projected: ChatVariableState;
        try {
          projected = projectExtensionVariableMutation(before, { ...mutation(), changes: next });
        } catch (error) {
          if (error instanceof PromptEvaluationError) fail('BEHAVIOR_HOST_VARIABLES_LIMIT');
          throw error;
        }
        Object.assign(changes, next);
        state = projected;
        used = true;
        generation++;
        return null;
      }
      const context = resolveTemplateVariableContext(
        profileWithExtensionVariables(captured, state)
      );
      if (context.variableDefaultsError) fail('BEHAVIOR_HOST_VARIABLES_LIMIT');
      const resolved = context.variables ?? {};
      const offset = integer(args.offset, 0, Number.MAX_SAFE_INTEGER);
      const limit = integer(
        args.limit,
        method === 'variables.list' ? 20 : 8000,
        method === 'variables.list' ? 50 : 16000
      );
      if (limit === 0) fail('BEHAVIOR_HOST_ARGUMENTS');
      used = true;
      if (method === 'variables.list') {
        const keys = Object.keys(resolved).sort();
        const items = keys.slice(offset, offset + limit).map((key) => ({
          key,
          totalChars: resolved[key].length,
          overridden: Object.hasOwn(state.values, key),
        }));
        return {
          items,
          nextOffset: offset + items.length < keys.length ? offset + items.length : null,
          total: keys.length,
        };
      }
      if (!Object.hasOwn(resolved, key))
        return { value: null, offset: 0, nextOffset: null, totalChars: 0, overridden: false };
      const text = resolved[key];
      const chunk = text.slice(offset, offset + limit);
      return {
        value: chunk,
        overridden: Object.hasOwn(state.values, key),
        offset,
        nextOffset: offset + chunk.length < text.length ? offset + chunk.length : null,
        totalChars: text.length,
      };
    },
  };
}
