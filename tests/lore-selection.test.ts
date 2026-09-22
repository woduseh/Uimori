import { describe, expect, it } from 'vitest';
import {
  validateRisuContent,
  type RisuContent,
  type ContentAttachment,
  type RisuLoreProjection,
} from '../core/risu-content.js';
import {
  loreSelectionKey,
  loreSelectionLore,
  projectLoreSelectionReceipt,
  type LoreSelectionReceipt,
} from '../core/lore-selection.js';

// The receipt is data: the model call that produced it lives in the worker, and everything here is
// what the current compilation may conclude from the record
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
    version: 2,
    id: 'card',
    revision: 1,
    title: 'Aria',
    description: '',
    lore: [],
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
