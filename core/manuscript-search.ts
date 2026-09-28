import type { ReaderTarget } from './reader-target.js';

export type SearchKind = 'original' | 'translation' | 'request';
export type ManuscriptSearchQuery = {
  query: string;
  scope: 'workspace' | 'chat' | 'bot';
  chatId?: string;
  botId?: string;
  kinds: SearchKind[];
  cursor?: string | null;
  limit?: number;
};
export type SearchMatch = {
  kind: SearchKind;
  contentHash: string;
  snippet: { text: string; match: boolean }[];
};
export type ManuscriptSearchResult = {
  items: {
    target: ReaderTarget;
    title: string;
    botId: string;
    sceneNumber: number;
    matches: SearchMatch[];
  }[];
  nextCursor: string | null;
  coverage: 'complete' | 'building' | 'partial';
};
export type SearchDocument = {
  sourceId: string;
  chatId: string;
  kind: SearchKind;
  contentHash: string;
  text: string;
};
export type SearchIndexBatch = {
  sourceId: string;
  revision: number;
  documents: SearchDocument[];
}[];
