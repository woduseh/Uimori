import { historicalPersonaExcluded } from './persona-scope.js';
import {
  ContentPackageError,
  validateContentPackage,
  type ContentPackage,
  type PackageAttachment,
  type PackageTarget,
} from './content-package.js';
import { compilePackageAttachment, type CompiledPackageAttachment } from './package-runtime.js';
import type { Resource, RunSnapshot } from './types.js';
import { executionContext, packageInstanceId } from './execution-context.js';
import { projectChatPackageCompilation } from './chat-overrides.js';
import { packageIdentityFromProfile } from './package-identity.js';
import { projectRisuCompatReceipt } from './risu-compat.js';
import { projectLoreActivationReceipt } from './lore-activation.js';
import { loreSelectionKey, projectLoreSelectionReceipt } from './lore-selection.js';
import { projectNativeRisuFields } from './risu-native-execution.js';
import { projectRisuImageHandoff } from './risu-image-handoff.js';

export type ResolvedPackage = CompiledPackageAttachment & {
  attachment: PackageAttachment;
  package: ContentPackage;
};
export function compiledPackages(snapshot: RunSnapshot, target: PackageTarget): ResolvedPackage[] {
  const profile = snapshot.profile;
  const receipt = snapshot.risuCompat;
  const activation = snapshot.loreActivation;
  const selection = snapshot.loreSelection;
  return (profile?.packageAttachments ?? []).flatMap((attachment) => {
    const stored = profile?.packages?.find(
      (p) => p.id === attachment.id && p.revision === attachment.revision
    );
    const authored =
      stored && projectRisuImageHandoff(stored, target === 'main' && profile?.image === true);
    const pkg =
      authored && projectNativeRisuFields(authored, attachment, snapshot.nativeRisuExecution);
    if (!pkg) throw new ContentPackageError('PACKAGE_SNAPSHOT_REVISION_MISSING', attachment.id);
    if (historicalPersonaExcluded(profile, attachment.role, target)) {
      validateContentPackage(pkg);
      return [];
    }
    // An abandoned scan projects as undefined, which is the same as no receipt at all: the
    // attachment's lore keeps its own `loading`.
    const decided = activation ? projectLoreActivationReceipt(activation, attachment) : undefined;
    // An abandoned selection projects the same way: the attachment's lore keeps its own `loading`.
    const chosen = selection
      ? projectLoreSelectionReceipt(selection, loreSelectionKey(attachment))
      : undefined;
    const compiled = compilePackageAttachment(pkg, attachment, {
      chatId: snapshot.chatId,
      target,
      runtime: executionContext(snapshot, target, attachment),
      identity: packageIdentityFromProfile(profile!, target),
      behaviorUnavailable: snapshot.packageBehaviorUnavailable?.find(
        (item) => item.instanceId === packageInstanceId(attachment)
      )?.code,
      values:
        profile?.packageValues?.[`${attachment.id}@${attachment.revision}:${attachment.role}`],
      ...(receipt ? { compat: projectRisuCompatReceipt(receipt, attachment) } : {}),
      ...(decided ? { loreActivation: decided } : {}),
      ...(chosen ? { loreSelection: chosen } : {}),
    });
    const projected = projectChatPackageCompilation(
      profile!,
      attachment,
      pkg,
      compiled,
      (role) => !historicalPersonaExcluded(profile, role, target),
      packageIdentityFromProfile(profile!, target),
      decided,
      chosen
    );
    // Historical exclusions still validate the frozen package above.
    return [
      {
        ...projected.compiled,
        attachment: structuredClone(attachment),
        package: structuredClone(projected.package),
      },
    ];
  });
}
export type PackageRoleContext = {
  pinned: Resource[];
  instructions: { id: string; revision: number; text: string }[];
};
export function packageContext(
  snapshot: RunSnapshot,
  target: PackageTarget
): PackageRoleContext | undefined {
  return packageContextFromCompiled(compiledPackages(snapshot, target));
}
/** Project one request's already validated packages without compiling their templates again. */
export function packageContextFromCompiled(
  packages: readonly ResolvedPackage[]
): PackageRoleContext | undefined {
  if (!packages.length) return undefined;
  return {
    pinned: packages.flatMap((p) => p.pinned),
    instructions: packages.flatMap((p) =>
      p.instructions.filter((n) => !n.position).map((n) => ({ ...n, revision: p.package.revision }))
    ),
  };
}
export function packageSlots(
  snapshot: RunSnapshot,
  target: PackageTarget
): { bot: string; persona: string; lore: string; char?: string } {
  const packages = compiledPackages(snapshot, target);
  const body = (role: 'bot' | 'persona') =>
    packages
      .filter((p) => p.attachment.role === role)
      .flatMap((p) => p.pinned.filter((r) => r.sourceKind === role).map((r) => r.text))
      .join('\n\n');
  return {
    bot: body('bot'),
    persona: body('persona'),
    lore: packages
      .flatMap((p) =>
        p.pinned
          .filter((r) => r.sourceKind !== 'bot' && r.sourceKind !== 'persona')
          .map((r) => r.text)
      )
      .join('\n\n'),
    ...(packages.find((p) => p.attachment.role === 'bot')
      ? {
          char:
            packages.find((p) => p.attachment.role === 'bot')!.package.identity?.name ??
            packages.find((p) => p.attachment.role === 'bot')!.package.title,
        }
      : {}),
  };
}
