import {
  ContentPackageError,
  validateContentPackage,
  type ContentPackage,
  type PackageAttachment,
  type PackageTarget,
} from './content-package.js';
import { compilePackageAttachment, type CompiledPackageAttachment } from './package-runtime.js';
import type { Resource, RunSnapshot } from './types.js';
import { executionContext } from './execution-context.js';

export type ResolvedPackage = CompiledPackageAttachment & {
  attachment: PackageAttachment;
  package: ContentPackage;
};
export function compiledPackages(snapshot: RunSnapshot, target: PackageTarget): ResolvedPackage[] {
  const profile = snapshot.profile;
  return (profile?.packageAttachments ?? []).flatMap((attachment) => {
    const pkg = profile?.packages?.find(
      (p) => p.id === attachment.id && p.revision === attachment.revision
    );
    if (!pkg) throw new ContentPackageError('PACKAGE_SNAPSHOT_REVISION_MISSING', attachment.id);
    if (target === 'main' && attachment.role === 'persona' && profile?.personaReference === false) {
      validateContentPackage(pkg);
      return [];
    }
    const compiled = compilePackageAttachment(pkg, attachment, {
      chatId: snapshot.chatId,
      target,
      runtime: executionContext(snapshot, target, attachment),
      values:
        profile?.packageValues?.[`${attachment.id}@${attachment.revision}:${attachment.role}`],
    });
    // Validate every attachment before filtering persona references from the main role.
    return [
      { ...compiled, attachment: structuredClone(attachment), package: structuredClone(pkg) },
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
  const packages = compiledPackages(snapshot, target);
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
