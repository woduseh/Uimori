import { describe, expect, it } from 'vitest';
import type { RisuContent, RisuLoreProjection } from '../core/risu-content.js';
import { loreSelectionLore } from '../core/lore-selection.js';

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
});
