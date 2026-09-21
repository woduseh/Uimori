import { validateRisuImageHandoff, type RisuImageHandoff } from './risu-image-handoff.js';
import { validatePackageImages, type PackageImage } from './package-images.js';
import { validatePackageStarts, type PackageStart } from './package-start.js';
import { validatePackageModules, type PackageModuleRef } from './package-features.js';
import { validateTemplateVariableDefaults } from './template-variables.js';
import { assertRisuContentSource, type RisuContentSource } from './risu-native.js';

export const CONTENT_ROLES = ['bot', 'persona', 'module'] as const;
export type ContentRole = (typeof CONTENT_ROLES)[number];
export type ContentTarget = 'main' | 'translation' | 'state' | 'status' | 'image';
export type ContentAttachment = { id: string; revision: number; role: ContentRole };
/** Chat-local package values are keyed by the exact attachment identity; a new revision starts fresh. */
export const contentAttachmentKey = (r: ContentAttachment) => `${r.id}@${r.revision}:${r.role}`;
/** Flat authoring folders only; folder membership does not change loading or runtime order. */
export type RisuLoreFolder = { id: string; name: string };
export type RisuLoreProjection = {
  id: string;
  title: string;
  description: string;
  text: string;
  loading: 'pinned' | 'discoverable';
  relatedIds?: string[];
  folderId?: string;
  loreContext?: import('./lore-context.js').LorePlacement;
  nativeRisuPosition?: import('./risu-native.js').NativeRisuLorePosition;
};
/** The attachment chooses a role. Identity is optional, including for a package used as a bot. */
export type RisuContent = {
  version: 2;
  id: string;
  revision: number;
  title: string;
  description: string;
  body?: string;
  variableDefaults?: { values: Record<string, string>; attachmentRoles?: ContentRole[] };
  identity?: { name: string; description: string };
  images?: PackageImage[];
  portraitImageId?: string;
  starts?: PackageStart[];
  modules?: PackageModuleRef[];
  lore: RisuLoreProjection[];
  loreFolders?: RisuLoreFolder[];
  /** Optional lore is selected by JEV or left discoverable through the writer's tools. */
  loreActivation?: { mode: 'discoverable' | 'model' };
  nativeRisu: RisuContentSource;
  imageHandoff?: RisuImageHandoff;
};
export class RisuContentError extends Error {
  readonly statusCode = 400;
  constructor(
    readonly code: string,
    readonly itemId?: string
  ) {
    super(`${code}${itemId ? ` (${itemId})` : ''}`);
    this.name = 'RisuContentError';
  }
}
const fail = (code: string, id?: string): never => {
  throw new RisuContentError(code, id);
};
function object(v: unknown, keys: string[]): Record<string, unknown> {
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    Object.keys(v).some((k) => !keys.includes(k))
  )
    fail('PACKAGE_INVALID_FIELDS');
  return v as Record<string, unknown>;
}
function string(v: unknown, max: number): asserts v is string {
  if (typeof v !== 'string' || v.length > max) fail('PACKAGE_INVALID_STRING');
}
function id(v: unknown): asserts v is string {
  string(v, 64);
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/u.test(v)) fail('PACKAGE_INVALID_ID');
}
function list(v: unknown, max: number): asserts v is unknown[] {
  if (!Array.isArray(v) || v.length > max) fail('PACKAGE_LIST_LIMIT');
}
function unique(values: string[]) {
  if (new Set(values).size !== values.length) fail('PACKAGE_DUPLICATE_ID');
}

export function validateContentAttachment(value: unknown): ContentAttachment {
  const a = object(value, ['id', 'revision', 'role']);
  id(a.id);
  if (
    !Number.isSafeInteger(a.revision) ||
    Number(a.revision) < 1 ||
    !CONTENT_ROLES.includes(a.role as ContentRole)
  )
    fail('PACKAGE_INVALID_ATTACHMENT');
  return structuredClone(a) as ContentAttachment;
}

/** Validate a JSON content value without taking ownership of it.
 * Synchronous read-only consumers may borrow it; editors use validateRisuContent for an owned copy.
 */
export function assertRisuContent(value: unknown): asserts value is RisuContent {
  const p = object(value, [
    'version',
    'id',
    'revision',
    'title',
    'description',
    'body',
    'variableDefaults',
    'identity',
    'images',
    'portraitImageId',
    'starts',
    'modules',
    'lore',
    'loreFolders',
    'loreActivation',
    'nativeRisu',
    'imageHandoff',
  ]);
  if (p.version !== 2) fail('PACKAGE_VERSION_UNSUPPORTED');
  id(p.id);
  if (!Number.isSafeInteger(p.revision) || Number(p.revision) < 1) fail('PACKAGE_INVALID_REVISION');
  string(p.title, 200);
  string(p.description, 4000);
  if (p.body !== undefined) string(p.body, 1_000_000);
  if (p.variableDefaults !== undefined) {
    const declaration = object(p.variableDefaults, ['values', 'attachmentRoles']);
    validateTemplateVariableDefaults(declaration.values);
    if (declaration.attachmentRoles !== undefined) {
      list(declaration.attachmentRoles, 3);
      if (
        !declaration.attachmentRoles.length ||
        declaration.attachmentRoles.some((role) => !CONTENT_ROLES.includes(role as ContentRole))
      )
        fail('PACKAGE_VARIABLE_DEFAULTS_ROLE');
      unique(declaration.attachmentRoles as string[]);
    }
  }
  if (p.identity !== undefined) {
    const v = object(p.identity, ['name', 'description']);
    string(v.name, 200);
    string(v.description, 100_000);
  }
  const folderIds: string[] = [];
  if (p.loreFolders !== undefined) {
    list(p.loreFolders, 2000);
    for (const raw of p.loreFolders) {
      const f = object(raw, ['id', 'name']);
      id(f.id);
      folderIds.push(f.id);
      string(f.name, 100);
      if (!f.name.trim() || f.name !== f.name.trim()) fail('PACKAGE_LORE_FOLDER_NAME', f.id);
    }
    unique(folderIds);
  }
  const folderSet = new Set(folderIds);
  list(p.lore, 2000);
  const loreIds: string[] = [];
  for (const raw of p.lore) {
    const l = object(raw, [
      'id',
      'title',
      'description',
      'text',
      'loading',
      'relatedIds',
      'folderId',
      'loreContext',
      'nativeRisuPosition',
    ]);
    id(l.id);
    loreIds.push(l.id);
    string(l.title, 200);
    string(l.description, 4000);
    string(l.text, 1_000_000);
    if (l.loading !== 'pinned' && l.loading !== 'discoverable') fail('PACKAGE_LORE_LOADING', l.id);
    if (l.nativeRisuPosition !== undefined) {
      const position = object(l.nativeRisuPosition, ['mode', 'depth', 'role', 'order']);
      if (
        !p.nativeRisu ||
        !['lore', 'depth', 'reverse_depth'].includes(position.mode as string) ||
        !['system', 'user', 'assistant'].includes(position.role as string) ||
        !Number.isSafeInteger(position.depth) ||
        (position.depth as number) < 0 ||
        (position.depth as number) > 1_000_000 ||
        !Number.isSafeInteger(position.order) ||
        Math.abs(position.order as number) > 1_000_000
      )
        fail('PACKAGE_NATIVE_RISU_LORE_POSITION', l.id);
    }
    if (l.loreContext !== undefined) {
      const placement = object(l.loreContext, ['placement', 'group', 'order']);
      if (placement.placement !== 'background' && placement.placement !== 'scene')
        fail('PACKAGE_LORE_PLACEMENT', l.id);
      if (placement.group !== undefined) string(placement.group, 200);
      if (
        placement.order !== undefined &&
        (!Number.isSafeInteger(placement.order) || Math.abs(placement.order as number) > 1_000_000)
      )
        fail('PACKAGE_LORE_ORDER', l.id);
    }
    if (l.folderId !== undefined) {
      id(l.folderId);
      if (!folderSet.has(l.folderId)) fail('PACKAGE_LORE_FOLDER_REFERENCE', l.id);
    }
    if (l.relatedIds !== undefined) {
      list(l.relatedIds, 2000);
      l.relatedIds.forEach(id);
      unique(l.relatedIds as string[]);
    }
  }
  unique(loreIds);
  for (const raw of p.lore) {
    const l = raw as RisuLoreProjection;
    if (l.relatedIds?.some((ref) => !loreIds.includes(ref))) fail('PACKAGE_LORE_REFERENCE', l.id);
  }
  try {
    {
      assertRisuContentSource(p.nativeRisu);
      const native = p.nativeRisu;
      if (p.imageHandoff !== undefined) validateRisuImageHandoff(p.imageHandoff, native);
      for (const asset of native.assets)
        if (!(p.images as PackageImage[] | undefined)?.some((image) => image.id === asset.imageId))
          fail('PACKAGE_NATIVE_RISU_ASSET_REFERENCE');
    }
    if (p.images !== undefined) validatePackageImages(p.images);
    if (p.portraitImageId !== undefined) {
      id(p.portraitImageId);
      if (
        !(p.images as PackageImage[] | undefined)?.some(
          (image) => image.id === p.portraitImageId && image.allowedUse !== 'inline'
        )
      )
        fail('PACKAGE_PORTRAIT_REFERENCE');
    }
    if (p.starts !== undefined) validatePackageStarts(p.starts);
    if (p.modules !== undefined) validatePackageModules(p.modules);
  } catch (error) {
    if (error instanceof RisuContentError) throw error;
    fail(error instanceof Error ? error.message : 'PACKAGE_FEATURE_INVALID');
  }
  if (p.loreActivation !== undefined) {
    const activation = object(p.loreActivation, ['mode']);
    if (!['discoverable', 'model'].includes(activation.mode as string))
      fail('PACKAGE_LORE_ACTIVATION_MODE');
  }
  const serialized = JSON.stringify(value);
  if (new TextEncoder().encode(serialized).byteLength > 12 * 1024 * 1024)
    fail('PACKAGE_SIZE_LIMIT');
}

/** Preserve the detached-copy contract used by importers, editors and archive validation. */
export function validateRisuContent(value: unknown): RisuContent {
  assertRisuContent(value);
  return structuredClone(value);
}
