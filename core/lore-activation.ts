import {
  packageControlKey,
  type ContentPackage,
  type PackageAttachment,
  type PackageLore,
} from './content-package.js';

/**
 * The frozen result of scanning one attached package's lorebook for keywords. The engine runs once at
 * reservation; every later compilation - a candidate, a fork, a chat-backup restore, an archive replay -
 * projects this receipt instead of scanning again, so the lore a run sent stays the lore a replay
 * reconstructs.
 */
export type LoreActivationEntry = {
  key: string;
  inputHash: string;
  /** The 조회 로어 문자 한도 the scan counted against, in UTF-16 code units. */
  budget: number;
  /** Lore ids the engine activated, in its own order (ascending insert order). */
  activated: string[];
  omitted: { id: string; reason: 'budget' | 'probability' | 'decorator' | 'inactive' }[];
  partial?: 'variable-write' | 'error';
  error?: string;
};
export type LoreActivationReceipt = { version: 1; entries: LoreActivationEntry[] };
export const LORE_ACTIVATION_LIMITS = { entries: 200, ids: 2000 };

export class LoreActivationError extends Error {
  readonly statusCode = 400;
  constructor(readonly code: string) {
    super(code);
    this.name = 'LoreActivationError';
  }
}
const fail = (code: string): never => {
  throw new LoreActivationError(code);
};

/** One attached revision. A package's whole lorebook is scanned at once, so there is no field part. */
export function loreActivationKey(attachment: PackageAttachment): string {
  return packageControlKey(attachment);
}

/**
 * The lore entries the engine scans: the ones the import preserved an activation rule for, in package
 * order. A package that is not in keyword mode has none, so switching the mode off keeps the rules
 * stored and stops them deciding anything.
 */
export function loreActivationLore(pkg: ContentPackage): PackageLore[] {
  if (pkg.loreActivation?.mode !== 'keyword') return [];
  return pkg.lore.filter((lore) => lore.activation !== undefined);
}

/**
 * The decision `compilePackageAttachment` reads: which of this attachment's lore ids are active.
 * `undefined` means the run made no decision for it - no entry, or an entry the engine abandoned - and
 * compilation falls back to each entry's own `loading`.
 */
export function projectLoreActivationReceipt(
  receipt: LoreActivationReceipt,
  attachment: PackageAttachment
): ReadonlySet<string> | undefined {
  const entry = receipt.entries.find((item) => item.key === loreActivationKey(attachment));
  if (!entry || entry.partial === 'error') return undefined;
  return new Set(entry.activated);
}

const PARTIAL = ['variable-write', 'error'];
const REASONS = ['budget', 'probability', 'decorator', 'inactive'];
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    fail('LORE_ACTIVATION_INVALID_FIELDS');
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): asserts value is string {
  if (typeof value !== 'string' || value.length > max) fail('LORE_ACTIVATION_INVALID_STRING');
}

/** Data-only validation. An archived receipt is read back through exactly this contract. */
export function validateLoreActivationReceipt(value: unknown): LoreActivationReceipt {
  const receipt = record(value, ['version', 'entries']);
  if (receipt.version !== 1) fail('LORE_ACTIVATION_VERSION_UNSUPPORTED');
  if (!Array.isArray(receipt.entries) || receipt.entries.length > LORE_ACTIVATION_LIMITS.entries)
    fail('LORE_ACTIVATION_ENTRY_LIMIT');
  const keys: string[] = [];
  for (const raw of receipt.entries as unknown[]) {
    const entry = record(raw, [
      'key',
      'inputHash',
      'budget',
      'activated',
      'omitted',
      'partial',
      'error',
    ]);
    text(entry.key, 400);
    keys.push(entry.key);
    if (typeof entry.inputHash !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.inputHash))
      fail('LORE_ACTIVATION_INPUT_HASH');
    if (!Number.isSafeInteger(entry.budget) || Number(entry.budget) < 0)
      fail('LORE_ACTIVATION_BUDGET');
    if (!Array.isArray(entry.activated) || entry.activated.length > LORE_ACTIVATION_LIMITS.ids)
      fail('LORE_ACTIVATION_ID_LIMIT');
    if (!Array.isArray(entry.omitted) || entry.omitted.length > LORE_ACTIVATION_LIMITS.ids)
      fail('LORE_ACTIVATION_ID_LIMIT');
    const ids: string[] = [];
    for (const id of entry.activated as unknown[]) {
      text(id, 200);
      ids.push(id);
    }
    for (const raw of entry.omitted as unknown[]) {
      const omitted = record(raw, ['id', 'reason']);
      text(omitted.id, 200);
      ids.push(omitted.id);
      if (!REASONS.includes(omitted.reason as string)) fail('LORE_ACTIVATION_REASON');
    }
    // One entry decides each lore once: an id cannot be both activated and omitted, or listed twice.
    if (new Set(ids).size !== ids.length) fail('LORE_ACTIVATION_DUPLICATE_LORE');
    if (entry.partial !== undefined && !PARTIAL.includes(entry.partial as string))
      fail('LORE_ACTIVATION_PARTIAL');
    if (entry.error !== undefined) text(entry.error, 400);
  }
  if (new Set(keys).size !== keys.length) fail('LORE_ACTIVATION_DUPLICATE_KEY');
  return structuredClone(value) as LoreActivationReceipt;
}
