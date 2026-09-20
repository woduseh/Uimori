/**
 * The offset/limit page shape for Host library reads. Argument parsing and error codes stay with
 * each caller; only the slicing and the nextOffset arithmetic live here.
 */

/** Shared library list-page bounds. */
export const HOST_LIST_PAGE_DEFAULT = 20;
export const HOST_LIST_PAGE_MAX = 50;

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
