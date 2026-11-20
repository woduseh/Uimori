export type RequestLore = {
  status: 'complete' | 'partial';
  selection?: { total: number; evaluated: number; selected: number; failed?: number };
  entries: {
    id: string;
    title: string;
    source?: { contentId: string; entryId?: string; sourceName: string };
    via: 'pinned' | 'selected' | 'retained' | 'tool-result';
    delivery: 'full' | 'excerpt' | 'summary' | 'unverified';
  }[];
};
