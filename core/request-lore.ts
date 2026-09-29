/** Host evidence about reference bodies in one provider attempt, never model input. */
export type RequestLore = {
  status: 'complete' | 'partial';
  entries: {
    id: string;
    title: string;
    source?: { contentId: string; entryId?: string; sourceName: string };
    via: 'pinned' | 'retained' | 'tool-result';
    delivery: 'full' | 'excerpt' | 'summary' | 'unverified';
  }[];
};
