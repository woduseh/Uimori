/** Extra viewport sweeps and precise styling checks are an explicit design review. */
export const visualReview = process.env.NR_VISUAL_REVIEW === '1';

export function reviewWidths(additional: readonly number[]): readonly number[] {
  return visualReview ? additional : [390, 1440];
}
