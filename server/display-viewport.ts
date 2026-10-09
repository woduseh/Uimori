import { number } from './request-validation.js';

/** Legacy display callers may omit both dimensions; partial or invalid viewports are rejected. */
export function readDisplayViewport(query: Record<string, unknown>) {
  if (query.viewportWidth === undefined && query.viewportHeight === undefined) return undefined;
  return {
    width: number(Number(query.viewportWidth), 'viewport width', 1, Number.MAX_SAFE_INTEGER),
    height: number(Number(query.viewportHeight), 'viewport height', 1, Number.MAX_SAFE_INTEGER),
  };
}
