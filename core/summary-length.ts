/** UI-selected soft caps. The actual target also respects model and consumer budgets. */
export const SUMMARY_LENGTH_VALUES = ['auto', 2048, 4096, 8192, 16384] as const;
export type SummaryLength = (typeof SUMMARY_LENGTH_VALUES)[number];
export type SummaryLengthSettings = { conversation: SummaryLength; helper: SummaryLength };
export const DEFAULT_SUMMARY_LENGTH: SummaryLengthSettings = {
  conversation: 'auto',
  helper: 'auto',
};
export function summaryLengthLimit(
  purpose: 'conversation' | 'helper' | 'tool-results',
  setting?: SummaryLength
): number {
  if (purpose === 'tool-results') return 2048;
  // Missing on old frozen snapshots: keep the historic 2K policy on resume.
  if (setting === undefined) return 2048;
  if (setting === 'auto') return purpose === 'conversation' ? 8192 : 4096;
  return setting;
}
