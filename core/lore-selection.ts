import {
  packageControlKey,
  type ContentPackage,
  type PackageAttachment,
  type PackageLore,
} from './content-package.js';

/**
 * The frozen answer of one auxiliary model call that read a package's discoverable lore catalog and
 * named the entries this turn needs. The host asks once, after reservation; every later compilation -
 * a candidate, a fork, a chat-backup restore, an archive replay - projects this receipt instead of
 * asking again, so the lore a run pinned stays the lore a replay reconstructs.
 */
export type LoreSelectionEntry = {
  key: string;
  inputHash: string;
  /** The 조회 로어 문자 한도 the trim counted against, in UTF-16 code units. */
  budget: number;
  /** Lore ids the model chose, in its own order, after the budget trim. */
  selected: string[];
  /**
   * `budget` names a candidate the trim dropped. `unknown` names an id the answer invented, which is
   * deliberately not a candidate of this attachment and decides nothing.
   */
  omitted: { id: string; reason: 'budget' | 'unknown' }[];
  /** The context model the request used. Absent when no provider request was made. */
  model?: string;
  /** The candidate list reached `LORE_SELECTION_LIMITS.catalogChars` and was cut. */
  partial?: 'catalog';
  error?: string;
};
export type LoreSelectionReceipt = { version: 1; entries: LoreSelectionEntry[] };
export const LORE_SELECTION_LIMITS = {
  entries: 200,
  ids: 2000,
  catalogChars: 200_000,
  summaryChars: 160,
  historyMessages: 12,
  messageChars: 1_000,
  requestChars: 4_000,
};

export class LoreSelectionError extends Error {
  readonly statusCode = 400;
  constructor(readonly code: string) {
    super(code);
    this.name = 'LoreSelectionError';
  }
}
const fail = (code: string): never => {
  throw new LoreSelectionError(code);
};

/** One attached revision. A package's whole lorebook is offered at once, so there is no field part. */
export function loreSelectionKey(attachment: PackageAttachment): string {
  return packageControlKey(attachment);
}

/**
 * The lore entries the model chooses among: the discoverable ones, in package order. Risu activation
 * rules are ignored in this mode exactly as they are in discoverable mode, and pinned lore is never a
 * candidate because it is already sent.
 */
export function loreSelectionLore(pkg: ContentPackage): PackageLore[] {
  if (pkg.loreActivation?.mode !== 'model') return [];
  return pkg.lore.filter((lore) => lore.loading === 'discoverable');
}

/**
 * The decision `compilePackageAttachment` reads: which of this attachment's candidates the model
 * chose. `undefined` means the run made no decision for it - no entry, or an entry the step abandoned -
 * and compilation falls back to each entry's own `loading`.
 */
export function projectLoreSelectionReceipt(
  receipt: LoreSelectionReceipt,
  key: string
): ReadonlySet<string> | undefined {
  const entry = receipt.entries.find((item) => item.key === key);
  if (!entry || entry.error !== undefined) return undefined;
  return new Set(entry.selected);
}

const REASONS = ['budget', 'unknown'];
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    fail('LORE_SELECTION_INVALID_FIELDS');
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): asserts value is string {
  if (typeof value !== 'string' || value.length > max) fail('LORE_SELECTION_INVALID_STRING');
}

/** Data-only validation. An archived receipt is read back through exactly this contract. */
export function validateLoreSelectionReceipt(value: unknown): LoreSelectionReceipt {
  const receipt = record(value, ['version', 'entries']);
  if (receipt.version !== 1) fail('LORE_SELECTION_VERSION_UNSUPPORTED');
  if (!Array.isArray(receipt.entries) || receipt.entries.length > LORE_SELECTION_LIMITS.entries)
    fail('LORE_SELECTION_ENTRY_LIMIT');
  const keys: string[] = [];
  for (const raw of receipt.entries as unknown[]) {
    const entry = record(raw, [
      'key',
      'inputHash',
      'budget',
      'selected',
      'omitted',
      'model',
      'partial',
      'error',
    ]);
    text(entry.key, 400);
    keys.push(entry.key);
    if (typeof entry.inputHash !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.inputHash))
      fail('LORE_SELECTION_INPUT_HASH');
    if (!Number.isSafeInteger(entry.budget) || Number(entry.budget) < 0)
      fail('LORE_SELECTION_BUDGET');
    if (!Array.isArray(entry.selected) || entry.selected.length > LORE_SELECTION_LIMITS.ids)
      fail('LORE_SELECTION_ID_LIMIT');
    if (!Array.isArray(entry.omitted) || entry.omitted.length > LORE_SELECTION_LIMITS.ids)
      fail('LORE_SELECTION_ID_LIMIT');
    const ids: string[] = [];
    for (const id of entry.selected as unknown[]) {
      text(id, 200);
      ids.push(id);
    }
    for (const raw of entry.omitted as unknown[]) {
      const omitted = record(raw, ['id', 'reason']);
      text(omitted.id, 200);
      ids.push(omitted.id);
      if (!REASONS.includes(omitted.reason as string)) fail('LORE_SELECTION_REASON');
    }
    // One entry decides each lore once: an id cannot be both selected and omitted, or listed twice.
    if (new Set(ids).size !== ids.length) fail('LORE_SELECTION_DUPLICATE_LORE');
    if (entry.model !== undefined) text(entry.model, 400);
    if (entry.partial !== undefined && entry.partial !== 'catalog') fail('LORE_SELECTION_PARTIAL');
    if (entry.error !== undefined) text(entry.error, 400);
  }
  if (new Set(keys).size !== keys.length) fail('LORE_SELECTION_DUPLICATE_KEY');
  return structuredClone(value) as LoreSelectionReceipt;
}
