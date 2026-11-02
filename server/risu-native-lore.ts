import { nativeRisuLore, type RisuContentSource } from '../core/risu-native.js';
import { convertCharbook, type RisuCharBookEntry } from './compat/risu/lorebook.js';

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/** Card lore enters Risu's database through convertCharbook; module lore is already in that form. */
export function nativeRisuReadableLore(
  native: RisuContentSource,
  entries = nativeRisuLore(native),
  module = native.module?.lorebook != null
): Record<string, unknown>[] {
  if (module) return entries;
  const book = object(native.card.character_book);
  return convertCharbook({
    lorebook: [],
    loresettings: undefined,
    loreExt: undefined,
    charbook: {
      extensions: { ...object(book.extensions) },
      entries: entries.map(
        (entry): RisuCharBookEntry => ({
          keys: strings(entry.keys),
          secondary_keys: strings(entry.secondary_keys),
          content: typeof entry.content === 'string' ? entry.content : '',
          extensions: structuredClone(object(entry.extensions)),
          enabled: entry.enabled !== false,
          insertion_order: typeof entry.insertion_order === 'number' ? entry.insertion_order : 0,
          ...(typeof entry.name === 'string' ? { name: entry.name } : {}),
          ...(typeof entry.comment === 'string' ? { comment: entry.comment } : {}),
          ...(typeof entry.constant === 'boolean' ? { constant: entry.constant } : {}),
          ...(typeof entry.selective === 'boolean' ? { selective: entry.selective } : {}),
          ...(typeof entry.case_sensitive === 'boolean'
            ? { case_sensitive: entry.case_sensitive }
            : {}),
          ...(typeof entry.use_regex === 'boolean' ? { use_regex: entry.use_regex } : {}),
          ...(typeof entry.mode === 'string' ? { mode: entry.mode } : {}),
          ...(typeof entry.folder === 'string' ? { folder: entry.folder } : {}),
        })
      ),
    },
  }).lorebook as unknown as Record<string, unknown>[];
}
