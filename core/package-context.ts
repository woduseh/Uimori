import {
  RisuContentError,
  type RisuContent,
  type ContentAttachment,
  type ContentTarget,
} from './risu-content.js';
import { compileContentAttachment, type CompiledContentAttachment } from './package-runtime.js';
import type { Resource, RunSnapshot } from './types.js';
import { projectChatPackageCompilation } from './chat-overrides.js';
import { loreSelectionKey, projectLoreSelectionReceipt } from './lore-selection.js';
import { projectNativeRisuFields } from './risu-native-execution.js';
import { projectRisuImageHandoff } from './risu-image-handoff.js';

export type ResolvedPackage = CompiledContentAttachment & {
  /** This turn's dynamically admitted bodies; fixed/native positions keep their authored path. */
  selectedLore: Resource[];
  attachment: ContentAttachment;
  package: RisuContent;
};
export function compiledPackages(snapshot: RunSnapshot, target: ContentTarget): ResolvedPackage[] {
  const profile = snapshot.profile;
  const selection = snapshot.loreSelection;
  return (profile?.packageAttachments ?? []).flatMap((attachment) => {
    const stored = profile?.packages?.find(
      (p) => p.id === attachment.id && p.revision === attachment.revision
    );
    const authored =
      stored && projectRisuImageHandoff(stored, target !== 'image' && profile?.image === true);
    const pkg =
      authored && projectNativeRisuFields(authored, attachment, snapshot.nativeRisuExecution);
    if (!pkg) throw new RisuContentError('PACKAGE_SNAPSHOT_REVISION_MISSING', attachment.id);
    const chosen = selection
      ? projectLoreSelectionReceipt(selection, loreSelectionKey(attachment))
      : undefined;
    const compiled = compileContentAttachment(pkg, attachment, {
      chatId: snapshot.chatId,
      ...(chosen ? { loreSelection: chosen } : {}),
    });
    const projected = projectChatPackageCompilation(
      profile!,
      attachment,
      pkg,
      compiled,
      () => true,
      chosen
    );
    const selectedLore = projected.compiled.resources.filter(
      (resource) =>
        resource.sourceKind === 'lore' && chosen?.has(resource.risuSource?.entryId ?? '')
    );
    const dynamic = new Set(
      selectedLore
        .filter((resource) => target === 'main' && !resource.nativeRisuPosition)
        .map((resource) => resource.id)
    );
    const retainedNative = projected.compiled.resources.filter(
      (resource) =>
        resource.nativeRisuPosition &&
        snapshot.loreContext?.entries.some(
          (entry) =>
            entry.retention === 'selection' &&
            entry.id === resource.id &&
            entry.revision === resource.revision &&
            entry.start === 0 &&
            entry.end === resource.text.length &&
            entry.text === resource.text
        )
    );
    const pinned = projected.compiled.pinned.filter((resource) => !dynamic.has(resource.id));
    for (const resource of retainedNative)
      if (!pinned.some((item) => item.id === resource.id)) pinned.push(resource);
    return [
      {
        ...projected.compiled,
        pinned,
        selectedLore,
        attachment: structuredClone(attachment),
        package: structuredClone(projected.package),
      },
    ];
  });
}
export type ContentRoleContext = {
  pinned: Resource[];
};
export function packageContext(
  snapshot: RunSnapshot,
  target: ContentTarget
): ContentRoleContext | undefined {
  return packageContextFromCompiled(compiledPackages(snapshot, target));
}
/** Project one request's already validated packages without compiling their templates again. */
export function packageContextFromCompiled(
  packages: readonly ResolvedPackage[]
): ContentRoleContext | undefined {
  if (!packages.length) return undefined;
  return {
    pinned: packages.flatMap((p) => p.pinned),
  };
}
export function packageSlots(
  snapshot: RunSnapshot,
  target: ContentTarget
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
