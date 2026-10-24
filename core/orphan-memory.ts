import type { AuthorNote } from './notes.js';
import type { ChatLoreOverride } from './chat-overrides.js';

export type OrphanMemoryReason = 'missing-source' | 'outside-history' | 'source-changed';
export type OrphanMemoryEntry =
  | { kind: 'note'; note: AuthorNote; reason: OrphanMemoryReason }
  | { kind: 'lore'; override: ChatLoreOverride; reason: OrphanMemoryReason };
export type OrphanMemoryDetail = {
  headRevision: string | null;
  headHash: string | null;
  revision: number;
  loreRevision: number;
  entries: OrphanMemoryEntry[];
};
