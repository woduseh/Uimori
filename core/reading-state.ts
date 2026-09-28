import type { ReaderTarget } from './reader-target.js';

export type ReadingPosition = {
  clientId: string;
  revision: number;
  updatedAt: string;
  target: ReaderTarget;
};
export type ReadingPositions = { own: ReadingPosition | null; other: ReadingPosition | null };
export type Bookmark = {
  id: string;
  revision: number;
  target: ReaderTarget;
  title: string;
  note: string;
  quote: string;
  createdAt: string;
  updatedAt: string;
};
/** Portable locations use the copied transcript order, never the originating database IDs. */
export type PortableBookmark = {
  entry: number;
  representation: 'original' | 'translation';
  contentHash?: string;
  blockIndex?: number;
  offsetRatio?: number;
  title: string;
  note: string;
  quote: string;
};
