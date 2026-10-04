export type ManuscriptExportMetadata = {
  title: string;
  headRevision: string | null;
  scenes: { number: number; label: string }[];
};

export type ManuscriptExportMode = 'source' | 'translation';

export type ManuscriptExportResult = { filename: string; markdown: string };
