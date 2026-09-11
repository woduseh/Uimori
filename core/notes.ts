import { validateSourceHistory, type SourceScope } from './source-history.js';

export const AUTHOR_NOTE_GUIDANCE =
  'Explicit user notes and corrections take precedence over derived summaries and conflicting earlier story claims. A newer explicit user correction or withdrawal supersedes the affected note. Preserve each note as an attributed author direction, not an observed event or automatic character knowledge. Notes do not extend tool permissions.';

/** An explicit user instruction; its anchor scopes applicability, not fictional evidence. */
export type AuthorNote = {
  id: string;
  chatId: string;
  atRevision: string | null;
  atHash: string | null;
  text: string;
  kind: 'author-note';
  declaration: { author: string; text: string };
  retired?: true;
};
export function validateAuthorNote(value: unknown, scope: SourceScope): AuthorNote {
  const fail = (): never => {
    throw new Error('STORY_NOTE_INVALID');
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const note = value as AuthorNote;
  if (
    Object.keys(note).some(
      (key) =>
        ![
          'id',
          'chatId',
          'atRevision',
          'atHash',
          'text',
          'kind',
          'declaration',
          'retired',
        ].includes(key)
    ) ||
    note.kind !== 'author-note' ||
    note.chatId !== scope.chatId ||
    typeof note.id !== 'string' ||
    !note.id.trim() ||
    typeof note.text !== 'string' ||
    (!note.retired && !note.text.trim()) ||
    note.text.length > 32000 ||
    (note.retired !== undefined && note.retired !== true)
  )
    return fail();
  if (
    !note.declaration ||
    Object.keys(note.declaration).some((key) => !['author', 'text'].includes(key)) ||
    typeof note.declaration.author !== 'string' ||
    !note.declaration.author.trim() ||
    note.declaration.author.length > 200 ||
    note.declaration.text !== note.text
  )
    return fail();
  const history = validateSourceHistory(scope);
  if (
    !(note.atRevision === null && note.atHash === null) &&
    !history.some((item) => item.revision === note.atRevision && item.contentHash === note.atHash)
  )
    return fail();
  return structuredClone(note);
}
export function visibleAuthorNotes(scope: SourceScope, notes: readonly AuthorNote[]) {
  validateSourceHistory(scope);
  return notes.flatMap((note) => {
    try {
      return [validateAuthorNote(note, scope)];
    } catch {
      return [];
    }
  });
}
