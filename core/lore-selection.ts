import {
  contentAttachmentKey,
  type RisuContent,
  type ContentAttachment,
  type RisuLoreProjection,
} from './risu-content.js';

/**
 * The frozen answer of one auxiliary model call that read a package's discoverable lore catalog and
 * named the entries this turn needs. The host asks once after reservation and the current
 * execution projects that decision without an additional model call.
 */
export type LoreSelectionEntry = {
  key: string;
  inputHash: string;
  /** Retention budget in local tokens, as recorded in the frozen policy. */
  budget: number;
  /** Lore ids the model chose, in its own order, after the budget trim. */
  selected: string[];
  /**
   * Candidates omitted for the token budget or judged irrelevant to this request.
   */
  omitted: { id: string; reason: 'budget' | 'irrelevant' }[];
  judgment?: import('./judgment.js').JevJudgmentReceipt;
  /** The JEV model the request used. Absent when no provider request was made. */
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

/** One attached revision. A package's whole lorebook is offered at once, so there is no field part. */
export function loreSelectionKey(attachment: ContentAttachment): string {
  return contentAttachmentKey(attachment);
}

/**
 * The lore entries the model chooses among: the discoverable ones, in package order. Risu activation
 * rules are ignored in this mode exactly as they are in discoverable mode, and pinned lore is never a
 * candidate because it is already sent.
 */
export function loreSelectionLore(pkg: RisuContent): RisuLoreProjection[] {
  if (pkg.loreActivation?.mode !== 'model') return [];
  return pkg.lore.filter((lore) => lore.loading === 'discoverable');
}

/**
 * The decision `compileContentAttachment` reads: which of this attachment's candidates the model
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
