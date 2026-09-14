/**
 * The offset/limit page shape every Host read shares. Argument parsing and error codes stay with
 * each caller; only the slicing and the nextOffset arithmetic live here.
 */

/** Shared list-page bounds. Every list-shaped Host method uses both values. */
export const HOST_LIST_PAGE_DEFAULT = 20;
export const HOST_LIST_PAGE_MAX = 50;
/**
 * Shared text-page bounds, in UTF-16 units. `conversation.page` defaults to the maximum instead of
 * HOST_TEXT_PAGE_DEFAULT because one call spans several messages.
 */
export const HOST_TEXT_PAGE_DEFAULT = 8000;
export const HOST_TEXT_PAGE_MAX = 16000;

/**
 * One page of a list. An offset past the end yields an empty page and a null nextOffset; callers
 * that reject such an offset check it before calling. A zero limit reports the same offset again,
 * which is why every caller keeps a minimum of 1.
 */
export function pageSlice<T>(
  items: readonly T[],
  offset: number,
  limit: number
): { items: T[]; nextOffset: number | null; total: number } {
  const page = items.slice(offset, offset + limit);
  const end = offset + page.length;
  return { items: page, nextOffset: end < items.length ? end : null, total: items.length };
}

/**
 * One page of a string, measured in UTF-16 units so a page boundary can split a surrogate pair the
 * same way the hand-rolled slices did. The returned offset is the requested one, unclamped.
 */
export function pageText(
  text: string,
  offset: number,
  limit: number
): { text: string; offset: number; nextOffset: number | null; totalChars: number } {
  const end = Math.min(text.length, offset + limit);
  return {
    text: text.slice(offset, end),
    offset,
    nextOffset: end < text.length ? end : null,
    totalChars: text.length,
  };
}
