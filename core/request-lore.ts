/** Host evidence about reference bodies in one provider attempt, never model input. */
export type RequestLore = {
  status: 'complete' | 'partial';
  /** Frozen automatic-selection coverage; absent for older or non-story attempts. */
  selection?: { total: number; evaluated: number; selected: number; failed?: number };
  entries: {
    id: string;
    title: string;
    source?: { contentId: string; entryId?: string; sourceName: string };
    via: 'pinned' | 'selected' | 'retained' | 'tool-result';
    delivery: 'full' | 'excerpt' | 'summary' | 'unverified';
  }[];
};
