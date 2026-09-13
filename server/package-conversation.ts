import type { PackageAttachment } from '../core/content-package.js';
import type { ExtensionConversationSnapshot } from '../core/extension-conversation.js';
import { ExtensionProgramError, type ExtensionProgram } from '../core/extension-program.js';
import type { ProfileSnapshot } from '../core/product.js';
import type { RunSnapshot } from '../core/types.js';
import {
  captureExtensionConversation,
  resolveExtensionConversation,
  extensionConversationViewHash,
} from './extension-conversation.js';
import {
  assertExtensionConversationReadAccess,
  validateExtensionConversationPermission,
} from './extension-conversation-access.js';
import type { Store } from './store.js';

type Scope = Pick<
  RunSnapshot,
  'chatId' | 'branchId' | 'parentRevision' | 'history' | 'extensionConversation'
>;

/** Capture only admitted read grants; a missing optional read context must not block prose. */
export function captureRunConversation(
  store: Store,
  snapshot: RunSnapshot,
  runId: string,
  supersedesRunId?: string
): RunSnapshot {
  if (snapshot.extensionConversation)
    return {
      ...snapshot,
      extensionConversation: { ...snapshot.extensionConversation, admissionRunId: runId },
    };
  if (
    !Object.values(snapshot.profile?.extensionGrants ?? {}).some((grant) =>
      grant.capabilities.includes('conversation.read')
    )
  )
    return snapshot;
  try {
    return {
      ...snapshot,
      extensionConversation: captureExtensionConversation(store, snapshot, {
        admissionRunId: runId,
        supersedesRunId,
      }),
    };
  } catch (error) {
    if (!(error instanceof ExtensionProgramError)) throw error;
    return snapshot;
  }
}

export function captureUserConversation(
  store: Store,
  profile: ProfileSnapshot,
  ref: PackageAttachment,
  program: ExtensionProgram,
  branchId: string,
  parentRevision: string | null
): ExtensionConversationSnapshot | undefined {
  if (!program.capabilities?.includes('conversation.read')) return;
  try {
    assertExtensionConversationReadAccess(store, profile, ref, program);
    return captureExtensionConversation(store, {
      chatId: profile.chatId,
      branchId,
      parentRevision,
      history: store.history(parentRevision),
    });
  } catch (error) {
    if (!(error instanceof ExtensionProgramError)) throw error;
    return;
  }
}

/** Resolves only captured source versions; it never discovers today's conversation on replay. */
export function conversationScopeFromRefs(
  store: Store,
  captured: ExtensionConversationSnapshot | undefined,
  owner: Pick<Scope, 'chatId' | 'branchId' | 'parentRevision'>
): Scope {
  if (
    !captured ||
    captured.chatId !== owner.chatId ||
    captured.branchId !== owner.branchId ||
    captured.parentRevision !== owner.parentRevision
  )
    throw new ExtensionProgramError('BEHAVIOR_HOST_CONVERSATION_UNAVAILABLE');
  return {
    chatId: captured.chatId,
    branchId: captured.branchId,
    parentRevision: captured.parentRevision,
    extensionConversation: captured,
    history: captured.messages.flatMap((ref) => {
      if (ref.kind !== 'source') return [];
      const source = store.sourceAtHash(ref.sourceRevision, ref.hash);
      return [{ revision: ref.sourceRevision, text: source.text, contentHash: ref.hash }];
    }),
  };
}

export function packageConversationExecution(
  store: Store,
  scope: Scope | (() => Scope),
  profile: ProfileSnapshot | undefined,
  ref: PackageAttachment,
  program: ExtensionProgram,
  append: { request?: string; response?: string } = {}
) {
  if (!program.capabilities?.includes('conversation.read')) return undefined;
  return {
    assertReadAccess: () => assertExtensionConversationReadAccess(store, profile, ref, program),
    read: () => {
      const captured = typeof scope === 'function' ? scope() : scope;
      if (captured.chatId !== profile?.chatId)
        throw new ExtensionProgramError('BEHAVIOR_HOST_CONVERSATION_DENIED');
      return resolveExtensionConversation(store, captured, captured.extensionConversation, append);
    },
  };
}

export function assertRunConversationReceipt(
  store: Store,
  snapshot: RunSnapshot,
  ref: PackageAttachment,
  program: ExtensionProgram,
  receipt: { viewHash: string },
  response?: string,
  includeRequest = true
): void {
  assertExtensionConversationReadAccess(store, snapshot.profile, ref, program);
  const view = resolveExtensionConversation(store, snapshot, snapshot.extensionConversation, {
    ...(includeRequest ? { request: snapshot.request } : {}),
    ...(response !== undefined ? { response } : {}),
  });
  validateExtensionConversationPermission(
    receipt,
    snapshot.profile,
    ref,
    program,
    extensionConversationViewHash(view)
  );
}
