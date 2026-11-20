import type { CharacterCardV3, CharacterCardV3Asset, LorebookEntry } from './compat/risu/types.js';
import type { readCharacterCard, readCharacterCardPath } from './character-card-file.js';

export type RisuCardInput =
  | ReturnType<typeof readCharacterCard>
  | Awaited<ReturnType<typeof readCharacterCardPath>>;

export type RisuCard = Partial<CharacterCardV3['data']> & Record<string, unknown>;
export type RisuCardAsset = Partial<CharacterCardV3Asset> & Record<string, unknown>;
export type RisuCardLoreEntry = Partial<LorebookEntry> & Record<string, unknown>;

export const string = (value: unknown) => (typeof value === 'string' ? value : '');
export const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
