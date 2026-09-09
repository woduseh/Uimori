import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  ContentPackageError,
  validateContentPackage,
  validatePackageAttachment,
  type ContentPackage,
  type PackageAttachment,
  type PackageLore,
  type PackageRole,
} from './content-package.js';
import { compilePackageAttachment, type CompiledPackageAttachment } from './package-runtime.js';
import type { ProfileSnapshot } from './product.js';

export const CHAT_LORE_FIELDS = ['title', 'description', 'text'] as const;
export type ChatLoreField = (typeof CHAT_LORE_FIELDS)[number];
export type ChatAttachmentScope = { id: string; role: PackageRole; modulePath: string[] };
export type ChatLoreSelector = ChatAttachmentScope & { loreId: string; field: ChatLoreField };
export type ChatLoreOverride = {
  id: string;
  chatId: string;
  revision: number;
  selector: ChatLoreSelector;
  basePackageRevision: number;
  baseEntry: PackageLore;
  baseValue: string;
  baseHash: string;
  value: string;
  baseRootRevision: number;
  baseModuleRevisions: { id: string; revision: number }[];
  atSource: string | null;
  atHash: string | null;
  retired: boolean;
  createdAt: string;
};
export type ChatLoreConflict = {
  overrideId: string;
  kind: 'source-changed' | 'entry-missing' | 'attachment-missing' | 'anchor-changed';
  currentValue: string | null;
};
export type ChatPackagePath = {
  scope: ChatAttachmentScope;
  attachment: PackageAttachment;
  package: ContentPackage;
};
export type ChatPackageProjection = ChatPackagePath & {
  overrideIds: string[];
  conflicts: ChatLoreConflict[];
};
export type ChatOverrideSnapshot = {
  version: 1;
  revision: number;
  roots: PackageAttachment[];
  entries: ChatLoreOverride[];
  headRevision: string | null;
  headHash: string | null;
  projections: ChatPackageProjection[];
  conflicts: ChatLoreConflict[];
};
export const chatAttachmentKey = (scope: ChatAttachmentScope) =>
  JSON.stringify([scope.id, scope.role, scope.modulePath]);
export const chatLoreKey = (selector: ChatLoreSelector) =>
  JSON.stringify([
    selector.id,
    selector.role,
    selector.modulePath,
    selector.loreId,
    selector.field,
  ]);
const leafKey = (ref: PackageAttachment) => `${ref.id}:${ref.role}`;
export const chatOverrideHash = (value: string) => createHash('sha256').update(value).digest('hex');
const invalid = (message: string): never => {
  throw new ContentPackageError(`CHAT_OVERRIDE_${message}`);
};
const id = (value: unknown) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}$/.test(value))
    return invalid('ID');
  return value;
};
export function validateChatLoreSelector(value: unknown): ChatLoreSelector {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('SELECTOR');
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some((key) => !['id', 'role', 'modulePath', 'loreId', 'field'].includes(key))
  )
    invalid('SELECTOR_FIELDS');
  if (
    !['bot', 'persona', 'module'].includes(String(input.role)) ||
    !CHAT_LORE_FIELDS.includes(input.field as ChatLoreField)
  )
    invalid('TEXT_FIELD_REQUIRED');
  if (!Array.isArray(input.modulePath) || input.modulePath.length > 20)
    return invalid('MODULE_PATH');
  return {
    id: id(input.id),
    role: input.role as PackageRole,
    modulePath: input.modulePath.map(id),
    loreId: id(input.loreId),
    field: input.field as ChatLoreField,
  };
}

/** Enumerate link paths separately from the canonical module closure, whose behavior still executes once. */
export function chatPackagePaths(
  profile: Pick<ProfileSnapshot, 'packageAttachments' | 'packages'>,
  roots: PackageAttachment[]
): ChatPackagePath[] {
  const result: ChatPackagePath[] = [];
  const walk = (
    root: PackageAttachment,
    raw: PackageAttachment,
    modulePath: string[],
    ancestors: Set<string>
  ) => {
    if (result.length >= 2000 || modulePath.length > 20) invalid('PATH_LIMIT');
    const attachment = profile.packageAttachments?.find(
      (ref) => ref.id === raw.id && ref.role === raw.role
    );
    if (!attachment) return invalid('ATTACHMENT_MISSING');
    const pkg = profile.packages?.find(
      (item) => item.id === attachment.id && item.revision === attachment.revision
    );
    if (!pkg) return invalid('PACKAGE_MISSING');
    if (ancestors.has(pkg.id)) invalid('MODULE_CYCLE');
    result.push({
      scope: { id: root.id, role: root.role, modulePath },
      attachment: structuredClone(attachment),
      package: structuredClone(pkg),
    });
    const seen = new Set(ancestors);
    seen.add(pkg.id);
    for (const module of pkg.modules ?? [])
      walk(root, { ...module, role: 'module' }, [...modulePath, module.id], seen);
  };
  for (const root of roots) walk(validatePackageAttachment(root), root, [], new Set());
  return result;
}

/** A separate immutable text projection. No original package or executable definition is changed. */
export function buildChatOverrideSnapshot(
  profile: Pick<ProfileSnapshot, 'packageAttachments' | 'packages'>,
  roots: PackageAttachment[],
  revision: number,
  entries: ChatLoreOverride[],
  head: { headRevision: string | null; headHash: string | null } = {
    headRevision: null,
    headHash: null,
  }
): ChatOverrideSnapshot {
  const active = entries.filter((entry) => !entry.retired);
  const paths = active.length ? chatPackagePaths(profile, roots) : [];
  const affected = new Set<string>(),
    conflicts: ChatLoreConflict[] = [];
  for (const entry of active) {
    const path = paths.find(
      (item) => chatAttachmentKey(item.scope) === chatAttachmentKey(entry.selector)
    );
    if (path) affected.add(leafKey(path.attachment));
    else conflicts.push({ overrideId: entry.id, kind: 'attachment-missing', currentValue: null });
  }
  const projections = paths
    .filter((path) => affected.has(leafKey(path.attachment)))
    .map((path): ChatPackageProjection => {
      const local = active.filter(
        (entry) => chatAttachmentKey(entry.selector) === chatAttachmentKey(path.scope)
      );
      const pkg = structuredClone(path.package),
        issues: ChatLoreConflict[] = [];
      for (const entry of local) {
        let lore = pkg.lore.find((item) => item.id === entry.selector.loreId);
        const original = path.package.lore.find((item) => item.id === entry.selector.loreId);
        if (!original || original[entry.selector.field] !== entry.baseValue)
          issues.push({
            overrideId: entry.id,
            kind: original ? 'source-changed' : 'entry-missing',
            currentValue: original?.[entry.selector.field] ?? null,
          });
        if (!lore) {
          lore = structuredClone(entry.baseEntry);
          pkg.lore.push(lore);
        }
        lore[entry.selector.field] = entry.value;
      }
      // A deleted entry can reference a folder or neighbor removed by the original author. The old text is
      // preserved, while unavailable presentation links are dropped from this execution projection only.
      for (const lore of pkg.lore) {
        if (lore.folderId && !pkg.loreFolders?.some((folder) => folder.id === lore.folderId))
          delete lore.folderId;
        if (lore.relatedIds)
          lore.relatedIds = lore.relatedIds.filter((related) =>
            pkg.lore.some((item) => item.id === related)
          );
      }
      return {
        ...path,
        package: validateContentPackage(pkg),
        overrideIds: local.map((entry) => entry.id),
        conflicts: issues,
      };
    });
  return {
    version: 1,
    revision,
    ...head,
    roots: structuredClone(roots),
    entries: structuredClone(entries),
    projections,
    conflicts: [...conflicts, ...projections.flatMap((projection) => projection.conflicts)],
  };
}

/** Only lore is split when two link paths need different text. State, actions and instructions stay canonical. */
export function projectChatPackageCompilation(
  profile: ProfileSnapshot,
  attachment: PackageAttachment,
  pkg: ContentPackage,
  compiled: CompiledPackageAttachment,
  includeRoot: (role: PackageRole) => boolean = () => true
): { package: ContentPackage; compiled: CompiledPackageAttachment } {
  const projections =
    profile.chatOverrides?.projections.filter(
      (item) =>
        leafKey(item.attachment) === leafKey(attachment) &&
        item.attachment.revision === attachment.revision &&
        includeRoot(item.scope.role)
    ) ?? [];
  if (!projections.length) return { package: pkg, compiled };
  const distinct = projections.some(
    (item) => !isDeepStrictEqual(item.package.lore, projections[0].package.lore)
  );
  const selected = distinct ? projections : [projections[0]];
  const prefix = `package:${pkg.id}:${attachment.role}`;
  const resources = [
    ...compiled.resources.filter((resource) => resource.sourceKind !== 'lore'),
    ...selected.flatMap((projection) => {
      const scopePrefix = distinct
        ? `${prefix}:scope:${chatOverrideHash(chatAttachmentKey(projection.scope)).slice(0, 24)}`
        : prefix;
      return compilePackageAttachment(projection.package, attachment, {
        chatId: profile.chatId,
        target: 'main',
        values: compiled.values,
        resourcesOnly: true,
      })
        .resources.filter((resource) => resource.sourceKind === 'lore')
        .map((resource) => ({
          ...resource,
          id: resource.id.replace(prefix, scopePrefix),
          ...(resource.relatedIds
            ? {
                relatedIds: resource.relatedIds.map((related) =>
                  related.replace(prefix, scopePrefix)
                ),
              }
            : {}),
          ...(distinct
            ? {
                title: `${resource.title} · ${projection.scope.role}/${projection.scope.modulePath.join('/') || projection.scope.id}`,
              }
            : {}),
        }));
    }),
  ];
  return {
    package: distinct ? pkg : selected[0].package,
    compiled: {
      ...compiled,
      resources,
      pinned: resources.filter((resource) => resource.loading === 'pinned'),
    },
  };
}
