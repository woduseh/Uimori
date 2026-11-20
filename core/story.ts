import type { AuthorNote } from './notes.js';

export type StorySnapshot = {
  canonHash: string;
  notes: AuthorNote[];
};
export type SceneCommand = {
  id: string;
  chatId: string;
  label: string;
  request: string;
  status: 'pending' | 'consumed' | 'failed' | 'cancelled';
  runId: string | null;
  sourceRevision: string | null;
};
export type StoryDetail = { notes: AuthorNote[]; notesRevision: number };
