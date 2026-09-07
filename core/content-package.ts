import {
  validatePromptProgram,
  type PromptControl,
  type PromptExpression,
  type PromptTemplate,
} from './prompt-program.js';
import { validatePackageBehavior, type PackageBehavior } from './package-behavior.js';
import { validatePackageImages, type PackageImage } from './package-images.js';
import { validatePackageStarts, type PackageStart } from './package-start.js';
import { validateSourceSegmentPolicy, type SourceSegmentPolicy } from './source-segments.js';
import { validatePackageModules, type PackageModuleRef } from './package-features.js';

export const PACKAGE_ROLES = ['bot', 'persona', 'module'] as const;
export type PackageRole = (typeof PACKAGE_ROLES)[number];
export const PACKAGE_TARGETS = [
  'main',
  'translation',
  'state',
  'memory',
  'status',
  'image',
] as const;
export type PackageTarget = (typeof PACKAGE_TARGETS)[number];
export type PackageAttachment = { id: string; revision: number; role: PackageRole };
/** Flat authoring folders only; folder membership does not change loading or runtime order. */
export type PackageLoreFolder = { id: string; name: string };
export type PackageLore = {
  id: string;
  title: string;
  description: string;
  text: string;
  loading: 'pinned' | 'discoverable';
  relatedIds?: string[];
  folderId?: string;
  loreContext?: import('./lore-context.js').LorePlacement;
};
export type PackageInstruction = {
  id: string;
  target: PackageTarget;
  attachmentRoles?: PackageRole[];
  position?: string;
  text: string;
  template?: PromptTemplate;
  when?: PromptExpression;
};
export type PackageTransform = {
  id: string;
  target: 'source' | 'translation';
  pattern: string;
  flags: string;
  replacement: string;
};
export type PackageStateView = {
  title: string;
  fields: { key: string; label: string; format?: 'text' | 'number' | 'boolean'; suffix?: string }[];
};
/** The attachment chooses a role. Identity is optional, including for a package used as a bot. */
export type ContentPackage = {
  version: 1;
  id: string;
  revision: number;
  title: string;
  description: string;
  body?: string;
  identity?: { name: string; description: string };
  roleBindings?: Partial<Record<PackageRole, string>>;
  images?: PackageImage[];
  portraitImageId?: string;
  starts?: PackageStart[];
  modules?: PackageModuleRef[];
  sourceSegments?: SourceSegmentPolicy;
  lore: PackageLore[];
  loreFolders?: PackageLoreFolder[];
  instructions: PackageInstruction[];
  controls: PromptControl[];
  stateView?: PackageStateView;
  behavior?: PackageBehavior;
  transforms: PackageTransform[];
};
export class ContentPackageError extends Error {
  readonly statusCode = 400;
  constructor(
    readonly code: string,
    readonly itemId?: string
  ) {
    super(`${code}${itemId ? ` (${itemId})` : ''}`);
    this.name = 'ContentPackageError';
  }
}
const fail = (code: string, id?: string): never => {
  throw new ContentPackageError(code, id);
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

/** Validate data only. Pattern compilation and execution happen in an isolated worker. */
export function validatePackageTransform(value: unknown): PackageTransform {
  const t = object(value, ['id', 'target', 'pattern', 'flags', 'replacement']);
  id(t.id);
  if (t.target !== 'source' && t.target !== 'translation') fail('PACKAGE_TRANSFORM_TARGET', t.id);
  string(t.pattern, 4096);
  string(t.flags, 8);
  string(t.replacement, 16_384);
  if (!t.pattern || !/^[gimsuy]*$/u.test(t.flags) || new Set(t.flags).size !== t.flags.length)
    fail('PACKAGE_REGEX_FLAGS', t.id);
  return structuredClone(t) as PackageTransform;
}

export function validatePackageAttachment(value: unknown): PackageAttachment {
  const a = object(value, ['id', 'revision', 'role']);
  id(a.id);
  if (
    !Number.isSafeInteger(a.revision) ||
    Number(a.revision) < 1 ||
    !PACKAGE_ROLES.includes(a.role as PackageRole)
  )
    fail('PACKAGE_INVALID_ATTACHMENT');
  return structuredClone(a) as PackageAttachment;
}

export function validateContentPackage(value: unknown): ContentPackage {
  const p = object(value, [
    'version',
    'id',
    'revision',
    'title',
    'description',
    'body',
    'identity',
    'roleBindings',
    'images',
    'portraitImageId',
    'starts',
    'modules',
    'sourceSegments',
    'lore',
    'loreFolders',
    'instructions',
    'controls',
    'stateView',
    'behavior',
    'transforms',
  ]);
  if (p.version !== 1) fail('PACKAGE_VERSION_UNSUPPORTED');
  id(p.id);
  if (!Number.isSafeInteger(p.revision) || Number(p.revision) < 1) fail('PACKAGE_INVALID_REVISION');
  string(p.title, 200);
  string(p.description, 4000);
  if (p.body !== undefined) string(p.body, 1_000_000);
  if (p.identity !== undefined) {
    const v = object(p.identity, ['name', 'description']);
    string(v.name, 200);
    string(v.description, 100_000);
  }
  if (p.roleBindings !== undefined) {
    const v = object(p.roleBindings, [...PACKAGE_ROLES]);
    for (const text of Object.values(v)) string(text, 100_000);
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
    ]);
    id(l.id);
    loreIds.push(l.id);
    string(l.title, 200);
    string(l.description, 4000);
    string(l.text, 1_000_000);
    if (l.loading !== 'pinned' && l.loading !== 'discoverable') fail('PACKAGE_LORE_LOADING', l.id);
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
    const l = raw as PackageLore;
    if (l.relatedIds?.some((ref) => !loreIds.includes(ref))) fail('PACKAGE_LORE_REFERENCE', l.id);
  }
  list(p.instructions, 150);
  list(p.controls, 150);
  const instructionIds: string[] = [];
  for (const raw of p.instructions) {
    const n = object(raw, [
      'id',
      'target',
      'attachmentRoles',
      'position',
      'text',
      'template',
      'when',
    ]);
    id(n.id);
    if (n.id === '__package_current__') fail('PACKAGE_RESERVED_ID', n.id);
    instructionIds.push(n.id);
    string(n.text, 200_000);
    if (n.position !== undefined) {
      id(n.position);
      if (n.target !== 'main') fail('PACKAGE_POSITION_TARGET', n.id);
    }
    if (!PACKAGE_TARGETS.includes(n.target as PackageTarget))
      fail('PACKAGE_INSTRUCTION_TARGET', n.id);
    if (n.attachmentRoles !== undefined) {
      list(n.attachmentRoles, 3);
      if (
        !n.attachmentRoles.length ||
        n.attachmentRoles.some((role) => !PACKAGE_ROLES.includes(role as PackageRole))
      )
        fail('PACKAGE_INSTRUCTION_ROLE', n.id);
      unique(n.attachmentRoles as string[]);
    }
  }
  unique(instructionIds);
  // Reuse the established AST/control validator; text is retained even when a template exists.
  validatePromptProgram({
    version: 1,
    controls: p.controls,
    blocks: (p.instructions as PackageInstruction[]).map((n) => ({
      id: n.id,
      title: n.id,
      kind: 'message',
      role: 'system',
      template: n.template ?? [{ kind: 'text', text: n.text }],
      ...(n.when === undefined ? {} : { when: n.when }),
    })),
  });
  if (p.stateView !== undefined) {
    const v = object(p.stateView, ['title', 'fields']);
    string(v.title, 200);
    list(v.fields, 100);
    const keys: string[] = [];
    for (const raw of v.fields) {
      const f = object(raw, ['key', 'label', 'format', 'suffix']);
      id(f.key);
      keys.push(f.key);
      string(f.label, 200);
      if (f.suffix !== undefined) string(f.suffix, 100);
      if (f.format !== undefined && !['text', 'number', 'boolean'].includes(String(f.format)))
        fail('PACKAGE_STATE_FORMAT', f.key);
    }
    unique(keys);
  }
  if (p.behavior !== undefined) validatePackageBehavior(p.behavior);
  try {
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
    if (p.starts !== undefined)
      validatePackageStarts(p.starts, {
        controls: p.controls as PromptControl[],
        behavior: p.behavior as PackageBehavior | undefined,
      });
    if (p.modules !== undefined) validatePackageModules(p.modules);
    if (p.sourceSegments !== undefined)
      validateSourceSegmentPolicy(p.sourceSegments, p.controls as PromptControl[]);
  } catch (error) {
    if (error instanceof ContentPackageError) throw error;
    fail(error instanceof Error ? error.message : 'PACKAGE_FEATURE_INVALID');
  }
  list(p.transforms, 32);
  const transforms = p.transforms.map(validatePackageTransform);
  unique(transforms.map((t) => t.id));
  if (JSON.stringify(value).length > 4_000_000) fail('PACKAGE_SIZE_LIMIT');
  return structuredClone(value) as ContentPackage;
}
