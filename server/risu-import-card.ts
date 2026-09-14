import type {
  CharacterCardV3,
  CharacterCardV3Asset,
  LorebookEntry,
  customscript,
  triggerscript,
} from './compat/risu/types.js';
import type { readCharacterCard } from './character-card-file.js';

/** The parsed card and the identity of the file it came from, as the reader hands it over. */
export type RisuCardInput = ReturnType<typeof readCharacterCard>;

/**
 * A card as the importer reads it: every spec field optional and every other field still readable,
 * because a real file may omit, mistype or extend any of them. The readers below keep that
 * tolerance, so a wrong type reads as empty instead of failing the import.
 */
export type RisuCard = Partial<CharacterCardV3['data']> & Record<string, unknown>;
export type RisuCardAsset = Partial<CharacterCardV3Asset> & Record<string, unknown>;
export type RisuCardLoreEntry = Partial<LorebookEntry> & Record<string, unknown>;
/** Risu's own bag under `extensions.risuai`, holding the code surfaces of a card. */
export type RisuCardExtension = {
  customScripts?: customscript[];
  defaultVariables?: string;
  triggerscript?: triggerscript[];
  lowLevelAccess?: boolean;
} & Record<string, unknown>;

export const string = (value: unknown) => (typeof value === 'string' ? value : '');
export const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export const present = (value: unknown): boolean =>
  value !== undefined &&
  value !== null &&
  value !== false &&
  value !== '' &&
  (Array.isArray(value)
    ? value.length > 0
    : typeof value === 'object'
      ? Object.keys(value).length > 0
      : true);
