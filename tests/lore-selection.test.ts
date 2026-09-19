import { describe, expect, it } from 'vitest';
import {
  validateRisuContent,
  type RisuContent,
  type ContentAttachment,
  type RisuLoreProjection,
} from '../core/risu-content.js';
import {
  LORE_SELECTION_LIMITS,
  loreSelectionKey,
  loreSelectionLore,
  projectLoreSelectionReceipt,
  validateLoreSelectionReceipt,
  type LoreSelectionReceipt,
} from '../core/lore-selection.js';

// The receipt is data: the model call that produced it lives in the worker, and everything here is
// what a reader - compilation, an archive replay, a restored backup - may conclude from the record
// alone.

const ATTACHMENT: ContentAttachment = { id: 'card', revision: 1, role: 'bot' };
const KEY = loreSelectionKey(ATTACHMENT);

function lore(
  id: string,
  loading: RisuLoreProjection['loading'] = 'discoverable'
): RisuLoreProjection {
  return { id, title: id, description: '', text: `${id} body`, loading };
}

function pkg(partial: Partial<RisuContent> = {}): RisuContent {
  return {
    version: 1,
    id: 'card',
    revision: 1,
    title: 'Aria',
    description: '',
    lore: [],
    instructions: [],
    nativeRisu: { version: 1, card: {}, assets: [], sourceHash: 'a'.repeat(64) },
    ...partial,
  };
}

const receipt = (): LoreSelectionReceipt => ({
  version: 1,
  entries: [
    {
      key: KEY,
      inputHash: 'a'.repeat(64),
      budget: 48_000,
      selected: ['harbor'],
      omitted: [{ id: 'dragon', reason: 'budget' }],
      model: 'jev-latest',
    },
  ],
});

describe('receipt contract', () => {
  it('accepts a well formed receipt and rejects a bad hash or an extra field', () => {
    expect(validateLoreSelectionReceipt(receipt())).toEqual(receipt());
    const bad = receipt();
    bad.entries[0].inputHash = 'not-a-hash';
    expect(() => validateLoreSelectionReceipt(bad)).toThrow('LORE_SELECTION_INPUT_HASH');
    expect(() => validateLoreSelectionReceipt({ ...receipt(), selectedAt: 'now' })).toThrow(
      'LORE_SELECTION_INVALID_FIELDS'
    );
  });

  it('refuses one lore decided twice, whether as two decisions or the same one', () => {
    const overlap = receipt();
    overlap.entries[0].omitted.push({ id: 'harbor', reason: 'irrelevant' });
    expect(() => validateLoreSelectionReceipt(overlap)).toThrow('LORE_SELECTION_DUPLICATE_LORE');
    const repeated = receipt();
    repeated.entries[0].selected.push('harbor');
    expect(() => validateLoreSelectionReceipt(repeated)).toThrow('LORE_SELECTION_DUPLICATE_LORE');
  });

  it('refuses an unknown reason, an unknown partial mark and a negative budget', () => {
    const reason = receipt();
    reason.entries[0].omitted[0].reason = 'probability' as never;
    expect(() => validateLoreSelectionReceipt(reason)).toThrow('LORE_SELECTION_REASON');
    const partial = receipt();
    partial.entries[0].partial = 'error' as never;
    expect(() => validateLoreSelectionReceipt(partial)).toThrow('LORE_SELECTION_PARTIAL');
    const budget = receipt();
    budget.entries[0].budget = -1;
    expect(() => validateLoreSelectionReceipt(budget)).toThrow('LORE_SELECTION_BUDGET');
  });

  it('refuses more entries and more decided ids than the limits allow', () => {
    const entries = receipt();
    entries.entries = Array.from({ length: LORE_SELECTION_LIMITS.entries + 1 }, (_, index) => ({
      ...receipt().entries[0],
      key: `card@${index + 1}:bot`,
    }));
    expect(() => validateLoreSelectionReceipt(entries)).toThrow('LORE_SELECTION_ENTRY_LIMIT');
    const ids = receipt();
    ids.entries[0].selected = Array.from(
      { length: LORE_SELECTION_LIMITS.ids + 1 },
      (_, index) => `lore-${index}`
    );
    expect(() => validateLoreSelectionReceipt(ids)).toThrow('LORE_SELECTION_ID_LIMIT');
  });

  it('projects the decision of one attachment, and no decision at all without an entry', () => {
    expect([...projectLoreSelectionReceipt(receipt(), KEY)!]).toEqual(['harbor']);
    expect(projectLoreSelectionReceipt(receipt(), 'other@1:module')).toBeUndefined();
  });

  it('projects an abandoned selection as no decision, not as an empty one', () => {
    const abandoned = receipt();
    abandoned.entries[0] = {
      ...abandoned.entries[0],
      selected: [],
      omitted: [],
      error: 'LORE_SELECTION_OUTPUT_INVALID',
    };
    expect(projectLoreSelectionReceipt(abandoned, KEY)).toBeUndefined();
  });
});

describe('candidate lore', () => {
  const entries = [lore('pinned-note', 'pinned'), lore('harbor'), lore('dragon')];

  it('offers the discoverable entries, and nothing at all outside model mode', () => {
    expect(
      loreSelectionLore(pkg({ lore: entries, loreActivation: { mode: 'model' } })).map(
        (item) => item.id
      )
    ).toEqual(['harbor', 'dragon']);
    expect(loreSelectionLore(pkg({ lore: entries }))).toEqual([]);
    expect(
      loreSelectionLore(pkg({ lore: entries, loreActivation: { mode: 'discoverable' } }))
    ).toEqual([]);
  });

  it('accepts the new mode on a package and still refuses an unknown one', () => {
    const value = pkg({ lore: entries, loreActivation: { mode: 'model' } });
    expect(validateRisuContent(value)).toEqual(value);
    expect(() => validateRisuContent(pkg({ loreActivation: { mode: 'always' } as never }))).toThrow(
      'PACKAGE_LORE_ACTIVATION_MODE'
    );
  });
});
