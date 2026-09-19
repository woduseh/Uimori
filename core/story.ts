import type { AuthorNote } from './notes.js';

/** Frozen notes about this story's events; card variables remain in the native Risu snapshot. */
export type StorySnapshot = {
  lineageHash: string;
  canonHash: string;
  notes: AuthorNote[];
  sceneCommandId?: string;
};
export type SceneCommand = {
  id: string;
  chatId: string;
  branchId: string;
  label: string;
  request: string;
  status: 'pending' | 'consumed' | 'failed' | 'cancelled';
  runId: string | null;
  sourceRevision: string | null;
};
export type StoryDetail = { notes: AuthorNote[]; notesRevision: number; commands: SceneCommand[] };
