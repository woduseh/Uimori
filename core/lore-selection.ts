import {
  contentAttachmentKey,
  type RisuContent,
  type ContentAttachment,
  type RisuLoreProjection,
} from './risu-content.js';

export type LoreSelectionEntry = {
  key: string;
  inputHash: string;
  budget: number;
  selected: string[];
  omitted: { id: string; reason: 'budget' | 'irrelevant' }[];
  judgment?: import('./judgment.js').JevJudgmentReceipt;
  model?: string;
  partial?: 'catalog';
  coverage?: { total: number; evaluated: number };
  error?: string;
};
export type LoreSelectionReceipt = { version: 1; entries: LoreSelectionEntry[] };
export const LORE_SELECTION_LIMITS = {
  entries: 200,
  ids: 2000,
  historyMessages: 12,
  messageTokens: 500,
};

export function loreSelectionKey(attachment: ContentAttachment): string {
  return contentAttachmentKey(attachment);
}

export function loreSelectionLore(pkg: RisuContent): RisuLoreProjection[] {
  if (pkg.loreActivation?.mode !== 'model') return [];
  return pkg.lore.filter((lore) => lore.loading === 'discoverable');
}

export function projectLoreSelectionReceipt(
  receipt: LoreSelectionReceipt,
  key: string
): ReadonlySet<string> | undefined {
  const entry = receipt.entries.find((item) => item.key === key);
  if (!entry || entry.error !== undefined) return undefined;
  return new Set(entry.selected);
}
