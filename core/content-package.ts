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
import { validatePackageIdentityTemplate } from './package-identity.js';
import { validatePackagePanels, type PackagePanel } from './package-panels.js';
import { validateTemplateVariableDefaults } from './template-variables.js';

export const PACKAGE_ROLES = ['bot', 'persona', 'module'] as const;
export type PackageRole = (typeof PACKAGE_ROLES)[number];
export const PACKAGE_TARGETS = ['main', 'translation', 'state', 'status', 'image'] as const;
export type PackageTarget = (typeof PACKAGE_TARGETS)[number];
export type PackageAttachment = { id: string; revision: number; role: PackageRole };
/** Chat-local package values are keyed by the exact attachment identity; a new revision starts fresh. */
export const packageControlKey = (r: PackageAttachment) => `${r.id}@${r.revision}:${r.role}`;
/** Flat authoring folders only; folder membership does not change loading or runtime order. */
export type PackageLoreFolder = { id: string; name: string };
/** One lore entry's preserved Risu activation rule, as the import read it off the card. */
export type PackageLoreActivation = {
  /** Risu's `loreBook.key`: the comma-separated keyword list. An empty list never activates. */
  keys: string;
  /** Risu's `loreBook.secondkey`, read only when `selective` is set. */
  secondaryKeys?: string;
  selective?: boolean;
  regex?: boolean;
  /** Risu's `mode === 'child'`: the entry takes the content of the entry declared before it. */
  child?: boolean;
  /** The leading `@@` decorator block Risu reads, lines joined by '\n'. */
  rules?: string;
};
export type PackageLore = {
  id: string;
  title: string;
  description: string;
  text: string;
  template?: PromptTemplate;
  loading: 'pinned' | 'discoverable';
  relatedIds?: string[];
  folderId?: string;
  loreContext?: import('./lore-context.js').LorePlacement;
  /** Applied only while the package is in keyword mode; kept as data when it is not. */
  activation?: PackageLoreActivation;
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
  bodyTemplate?: PromptTemplate;
  variableDefaults?: { values: Record<string, string>; attachmentRoles?: PackageRole[] };
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
  panels?: PackagePanel[];
  behavior?: PackageBehavior;
  transforms: PackageTransform[];
  /**
   * How this package's lore reaches the model. Absent means 'discoverable': the model looks an entry
   * up when it needs it. 'keyword' hands the decision to the preserved Risu rules instead, which are
   * kept either way, so the mode can be switched off and back on without losing them.
   */
  loreActivation?: {
    mode: 'keyword' | 'discoverable';
    /** Risu's own lorebook settings; the defaults below are Risu's. */
    scanDepth?: number;
    recursiveScanning?: boolean;
    fullWordMatching?: boolean;
  };
  /**
   * Fields whose authored text keeps its original Risu CBS instead of a converted template. The
   * declaration is data: the text is evaluated once at reservation by the compat evaluator, and a
   * package without a matching receipt renders the preserved text unchanged.
   */
  compat?: { risuCbs: { fields: string[] } };
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

/**
 * Validate the preserved activation rule as data. The keys are Risu's own comma-separated strings and
 * the rules are its `@@` lines; neither is parsed here, because the engine owns both grammars.
 */
export function validatePackageLoreActivation(
  value: unknown,
  loreId: string
): PackageLoreActivation {
  const a = object(value, ['keys', 'secondaryKeys', 'selective', 'regex', 'child', 'rules']);
  if (typeof a.keys !== 'string' || a.keys.length > 4000)
    fail('PACKAGE_LORE_ACTIVATION_KEYS', loreId);
  if (
    a.secondaryKeys !== undefined &&
    (typeof a.secondaryKeys !== 'string' || a.secondaryKeys.length > 4000)
  )
    fail('PACKAGE_LORE_ACTIVATION_KEYS', loreId);
  for (const flag of ['selective', 'regex', 'child'] as const)
    if (a[flag] !== undefined && typeof a[flag] !== 'boolean')
      fail('PACKAGE_LORE_ACTIVATION_FLAG', loreId);
  if (a.rules !== undefined) {
    const lines = typeof a.rules === 'string' ? a.rules.split('\n') : [];
    if (
      typeof a.rules !== 'string' ||
      a.rules.length > 4000 ||
      lines.length > 64 ||
      // Risu stops reading decorators at the first line that is not one, so a rule block that carries
      // anything else would silently become body text the engine scans instead.
      lines.some((line) => line.trim() && !line.trim().startsWith('@@'))
    )
      fail('PACKAGE_LORE_ACTIVATION_RULES', loreId);
  }
  return structuredClone(a) as PackageLoreActivation;
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
    'bodyTemplate',
    'variableDefaults',
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
    'panels',
    'behavior',
    'transforms',
    'loreActivation',
    'compat',
  ]);
  if (p.version !== 1) fail('PACKAGE_VERSION_UNSUPPORTED');
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
        declaration.attachmentRoles.some((role) => !PACKAGE_ROLES.includes(role as PackageRole))
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
      'template',
      'loading',
      'relatedIds',
      'folderId',
      'loreContext',
      'activation',
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
    if (l.activation !== undefined) validatePackageLoreActivation(l.activation, l.id);
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
  const controlIds = (p.controls as PromptControl[]).map((control) => control.id);
  if (p.bodyTemplate !== undefined) {
    if (p.body === undefined) fail('PACKAGE_TEXT_TEMPLATE_BODY_REQUIRED');
    validatePackageIdentityTemplate(p.bodyTemplate, controlIds, (reason) =>
      fail(`PACKAGE_TEXT_TEMPLATE_${reason}`, 'body')
    );
  }
  for (const lore of p.lore as PackageLore[])
    if (lore.template !== undefined)
      validatePackageIdentityTemplate(lore.template, controlIds, (reason) =>
        fail(`PACKAGE_TEXT_TEMPLATE_${reason}`, lore.id)
      );
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
    if (p.panels !== undefined)
      validatePackagePanels(p.panels, {
        controls: p.controls as PromptControl[],
        behavior: p.behavior as PackageBehavior | undefined,
      });
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
  if (p.loreActivation !== undefined) {
    const activation = object(p.loreActivation, [
      'mode',
      'scanDepth',
      'recursiveScanning',
      'fullWordMatching',
    ]);
    if (activation.mode !== 'keyword' && activation.mode !== 'discoverable')
      fail('PACKAGE_LORE_ACTIVATION_MODE');
    if (
      activation.scanDepth !== undefined &&
      (!Number.isSafeInteger(activation.scanDepth) ||
        Number(activation.scanDepth) < 0 ||
        Number(activation.scanDepth) > 1000)
    )
      fail('PACKAGE_LORE_ACTIVATION_SCAN_DEPTH');
    for (const flag of ['recursiveScanning', 'fullWordMatching'] as const)
      if (activation[flag] !== undefined && typeof activation[flag] !== 'boolean')
        fail('PACKAGE_LORE_ACTIVATION_FLAG');
  }
  if (p.compat !== undefined) {
    const declaration = object(p.compat, ['risuCbs']);
    const risuCbs = object(declaration.risuCbs, ['fields']);
    list(risuCbs.fields, 500);
    unique(risuCbs.fields as string[]);
    // Every declared id has to name a field this package actually stores, so the evaluator and the
    // receipt cannot disagree about what was preserved.
    const declarable = new Set<string>([
      ...(p.body === undefined ? [] : ['body']),
      ...loreIds.map((loreId) => `lore:${loreId}`),
      ...instructionIds.map((instructionId) => `instruction:${instructionId}`),
      ...((p.starts as PackageStart[] | undefined) ?? []).map((start) => `start:${start.id}`),
    ]);
    for (const field of risuCbs.fields) {
      string(field, 200);
      if (!declarable.has(field)) fail('PACKAGE_COMPAT_FIELD', field);
    }
  }
  list(p.transforms, 32);
  const transforms = p.transforms.map(validatePackageTransform);
  unique(transforms.map((t) => t.id));
  if (JSON.stringify(value).length > 4_000_000) fail('PACKAGE_SIZE_LIMIT');
  return structuredClone(value) as ContentPackage;
}
