import type { PackageAttachment } from '../core/content-package.js';
import { packageInstanceId } from '../core/execution-context.js';
import type { ExtensionProgram } from '../core/extension-program.js';
import { BehaviorError } from '../core/package-behavior.js';
import { pageSlice, pageText } from '../core/paging.js';
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
import {
  createHostDispatcher,
  failHost as fail,
  hostArguments,
  type HostMethodOf,
} from './extension-host-methods.js';
import { behaviorPayloadHash } from './package-behavior-store.js';
import { HttpError } from './request-validation.js';
import type { Store } from './store.js';

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
  let resolvedAt = -1;
  let resolvedValues: Record<string, string> = {};
  /** The staged view the guest reads. Unresolvable declarations are a limit, not an argument. */
  const resolved = () => {
    if (resolvedAt !== generation) {
      const context = resolveTemplateVariableContext(
        profileWithExtensionVariables(captured, state)
      );
      if (context.variableDefaultsError) fail('BEHAVIOR_HOST_VARIABLES_LIMIT');
      resolvedValues = context.variables ?? {};
      resolvedAt = generation;
    }
    return resolvedValues;
  };
  const stage = (key: string, value: string | null): null => {
    const next = { ...changes, [key]: value };
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
    host: createHostDispatcher<HostMethodOf<'variables'>>({
      // The attachment, not the capability, admits a method here; the capability is a gate below.
      denied: 'BEHAVIOR_HOST_VARIABLES_DENIED',
      granted: () => attached(captured, ref) === true,
      screen: hostArguments,
      gate: (entry) => {
        assertCurrent();
        if (entry.capability === 'variables.write') requireWrite();
        else if (!program.capabilities?.includes(entry.capability))
          fail('BEHAVIOR_HOST_VARIABLES_DENIED');
      },
      // A key and the staged view are both refused before any page argument is read.
      precheck: (entry, args) => {
        if (entry.args.includes('key')) {
          if (typeof args.key !== 'string') fail('BEHAVIOR_HOST_ARGUMENTS');
          try {
            validateChatVariableValues({ [args.key]: '' });
          } catch (error) {
            if (error instanceof PromptEvaluationError) fail('BEHAVIOR_HOST_ARGUMENTS');
            throw error;
          }
        }
        if (entry.capability === 'variables.read') resolved();
      },
      handlers: {
        'variables.set': async ({ args }) => {
          if (typeof args.value !== 'string') fail('BEHAVIOR_HOST_ARGUMENTS');
          return stage(args.key as string, args.value);
        },
        'variables.delete': async ({ args }) => stage(args.key as string, null),
        'variables.list': async ({ offset, limit }) => {
          const values = resolved();
          used = true;
          const page = pageSlice(Object.keys(values).sort(), offset, limit);
          return {
            items: page.items.map((key) => ({
              key,
              totalChars: values[key].length,
              overridden: Object.hasOwn(state.values, key),
            })),
            nextOffset: page.nextOffset,
            total: page.total,
          };
        },
        'variables.read': async ({ args, offset, limit }) => {
          const values = resolved();
          const key = args.key as string;
          used = true;
          if (!Object.hasOwn(values, key))
            return { value: null, offset: 0, nextOffset: null, totalChars: 0, overridden: false };
          const page = pageText(values[key], offset, limit);
          return {
            value: page.text,
            overridden: Object.hasOwn(state.values, key),
            offset: page.offset,
            nextOffset: page.nextOffset,
            totalChars: page.totalChars,
          };
        },
      },
    }),
  };
}
