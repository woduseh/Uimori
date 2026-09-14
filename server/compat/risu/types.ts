// The card-format types the Risu importer reads, re-exported from the RisuAI snapshot. Uimori code
// reaches the snapshot only through this compat layer (tests/risu-snapshot-boundary.test.ts), and
// these are declarations only: no snapshot runtime crosses the line.
export type {
  CharacterCardV3,
  CharacterCardV3Asset,
  LorebookEntry,
  customscript,
  triggerscript,
} from '../../../third_party/risuai/cad8595a/types.js';
