import type { PackageAttachment } from '../core/content-package.js';
import { packageInstanceId } from '../core/execution-context.js';
import { ExtensionProgramError, type ExtensionProgram } from '../core/extension-program.js';
import { historicalPersonaExcluded } from '../core/persona-scope.js';
import type { ProfileSnapshot } from '../core/product.js';
import type { Store } from './store.js';

function assertCapturedGrant(
  profile: ProfileSnapshot | undefined,
  ref: PackageAttachment,
  program: ExtensionProgram
): void {
  const grant = profile?.extensionGrants?.[packageInstanceId(ref)];
  if (
    !profile ||
    historicalPersonaExcluded(profile, ref.role) ||
    !profile.packageAttachments?.some(
      (item) => item.id === ref.id && item.revision === ref.revision && item.role === ref.role
    ) ||
    !program.capabilities?.includes('conversation.read') ||
    grant?.packageRevision !== ref.revision ||
    !grant.capabilities.includes('conversation.read')
  )
    throw new ExtensionProgramError('BEHAVIOR_HOST_CONVERSATION_DENIED');
}

/** Frozen grant check; callers may validate old receipts without consulting today's permissions. */
export function validateExtensionConversationPermission(
  receipt: { viewHash: string },
  profile: ProfileSnapshot | undefined,
  ref: PackageAttachment,
  program: ExtensionProgram,
  expectedViewHash?: string
): void {
  assertCapturedGrant(profile, ref, program);
  if (
    !/^[a-f0-9]{64}$/u.test(receipt.viewHash) ||
    (expectedViewHash !== undefined && receipt.viewHash !== expectedViewHash)
  )
    throw new ExtensionProgramError('BEHAVIOR_HOST_CONVERSATION_UNAVAILABLE');
}

/** A read grant is checked at every Host call and again before publishing derived effects. */
export function assertExtensionConversationReadAccess(
  store: Store,
  profile: ProfileSnapshot | undefined,
  ref: PackageAttachment,
  program: ExtensionProgram
): void {
  assertCapturedGrant(profile, ref, program);
  const live = store.product.profile(profile!.chatId);
  assertCapturedGrant(
    {
      ...profile!,
      packageAttachments: live.packageAttachments,
      extensionGrants: live.extensionGrants,
    },
    ref,
    program
  );
}
