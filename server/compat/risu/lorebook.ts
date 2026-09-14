// The lorebook reader of the Risu importer, re-exported from the RisuAI snapshot. Uimori code reaches
// the snapshot only through this compat layer (tests/risu-snapshot-boundary.test.ts): `convertCharbook`
// normalizes a card's `character_book` the way Risu does on import, and `interpretLoreDecorators` reads
// the `@@` decorator block that normalization writes.
import {
  convertCharbook,
  interpretLoreDecorators,
} from '../../../third_party/risuai/cad8595a/lorebook.js';

export { convertCharbook, interpretLoreDecorators };
export type {
  LoreDecoratorResult,
  LoreDecorators,
} from '../../../third_party/risuai/cad8595a/lorebook.js';

/** The card shapes `convertCharbook` reads, taken from the function so no second import is needed. */
export type RisuCharacterBook = Parameters<typeof convertCharbook>[0]['charbook'];
export type RisuCharBookEntry = RisuCharacterBook['entries'][number];
