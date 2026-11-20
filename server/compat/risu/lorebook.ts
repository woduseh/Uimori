import {
  convertCharbook,
  interpretLoreDecorators,
} from '../../../third_party/risuai/cad8595a/lorebook.js';

export { convertCharbook, interpretLoreDecorators };
export type {
  LoreDecoratorResult,
  LoreDecorators,
} from '../../../third_party/risuai/cad8595a/lorebook.js';

export type RisuCharacterBook = Parameters<typeof convertCharbook>[0]['charbook'];
export type RisuCharBookEntry = RisuCharacterBook['entries'][number];
