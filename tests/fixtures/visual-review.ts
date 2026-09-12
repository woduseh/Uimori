import { DEFAULT_WIDTHS } from './browser-viewports.js';
/** Extra viewport sweeps and precise styling checks are an explicit design review. */
export const visualReview = process.env.NR_VISUAL_REVIEW === '1';

export function reviewWidths(additional: readonly number[]): readonly number[] {
  return visualReview ? [...new Set([...additional, ...DEFAULT_WIDTHS])] : DEFAULT_WIDTHS;
}
