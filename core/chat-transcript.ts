import { CONTENT_ROLES, type ContentAttachment } from './risu-content.js';
import type { ImportedMemoryOrigin } from './notes.js';
import {
  CHAT_TITLE_MAX_CHARS,
  SOURCE_TEXT_MAX_CHARS,
  TRANSLATION_TEXT_MAX_CHARS,
} from './content-limits.js';

/**
 * One chat's authored history as a small file: source texts in order, the request that produced
 * each, the latest translation, the user's notes and the attached package references. It carries
 * no runs, snapshots, package state, draws or attempts, so it survives schema resets that the full
 * archive does not. Import reads it as authored history of a new chat.
 */
export const CHAT_TRANSCRIPT_FORMAT = 'uimori-chat-transcript';
export const CHAT_TRANSCRIPT_VERSION = 2;
export const CHAT_TRANSCRIPT_LIMITS = {
  entries: 5000,
  request: 20_000,
  text: SOURCE_TEXT_MAX_CHARS,
  translation: TRANSLATION_TEXT_MAX_CHARS,
  notes: 500,
  noteText: 32_000,
  author: 200,
  attachments: 300,
  title: CHAT_TITLE_MAX_CHARS,
} as const;

export type ChatTranscriptEntry = {
  /** The user request recorded on the run that produced this source; may be empty. */
  request: string;
  /** The source text as currently read, including the latest user edit. */
  text: string;
  /** The latest translation whose source hash still matched, or null. */
  translation: string | null;
};
export type ChatTranscriptNote = {
  text: string;
  author: string;
  /** Index into `entries` the note was anchored at; null means before any entry. */
  atIndex: number | null;
} & (
  | { kind: 'author-note'; origin?: never }
  | { kind: 'imported-memory'; origin: ImportedMemoryOrigin }
);
export type ChatTranscript = {
  format: typeof CHAT_TRANSCRIPT_FORMAT;
  version: typeof CHAT_TRANSCRIPT_VERSION;
  exportedAt: string;
  title: string;
  packageAttachments: ContentAttachment[];
  notes: ChatTranscriptNote[];
  entries: ChatTranscriptEntry[];
};

const fail = (code: string): never => {
  throw new Error(code);
};
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : fail('CHAT_TRANSCRIPT_INVALID_SHAPE');
const keys = (value: Record<string, unknown>, allowed: readonly string[]) => {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    fail('CHAT_TRANSCRIPT_UNKNOWN_FIELD');
};
const string = (value: unknown, max: number, code: string, empty = false): string => {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()))
    return fail(code);
  return value;
};
const list = (value: unknown, max: number, code: string): unknown[] => {
  if (!Array.isArray(value) || value.length > max) return fail(code);
  return value;
};
const revision = (value: unknown): number =>
  Number.isSafeInteger(value) && Number(value) >= 1
    ? Number(value)
    : fail('CHAT_TRANSCRIPT_INVALID_REFERENCE');

export function validateChatTranscript(value: unknown): ChatTranscript {
  const body = object(value);
  keys(body, [
    'format',
    'version',
    'exportedAt',
    'title',
    'packageAttachments',
    'notes',
    'entries',
  ]);
  if (body.format !== CHAT_TRANSCRIPT_FORMAT) fail('CHAT_TRANSCRIPT_INVALID_FORMAT');
  if (body.version !== 1 && body.version !== CHAT_TRANSCRIPT_VERSION)
    fail('CHAT_TRANSCRIPT_UNSUPPORTED_VERSION');
  const exportedAt = string(body.exportedAt, 40, 'CHAT_TRANSCRIPT_INVALID_TIME');
  if (!Number.isFinite(Date.parse(exportedAt))) fail('CHAT_TRANSCRIPT_INVALID_TIME');
  const title = string(body.title, CHAT_TRANSCRIPT_LIMITS.title, 'CHAT_TRANSCRIPT_INVALID_TITLE');
  const packageAttachments = list(
    body.packageAttachments,
    CHAT_TRANSCRIPT_LIMITS.attachments,
    'CHAT_TRANSCRIPT_INVALID_REFERENCE'
  ).map((raw): ContentAttachment => {
    const item = object(raw);
    keys(item, ['id', 'revision', 'role']);
    if (!CONTENT_ROLES.includes(item.role as ContentAttachment['role']))
      fail('CHAT_TRANSCRIPT_INVALID_REFERENCE');
    return {
      id: string(item.id, 100, 'CHAT_TRANSCRIPT_INVALID_REFERENCE'),
      revision: revision(item.revision),
      role: item.role as ContentAttachment['role'],
    };
  });
  if (new Set(packageAttachments.map((item) => item.id)).size !== packageAttachments.length)
    fail('CHAT_TRANSCRIPT_DUPLICATE_REFERENCE');
  const entries = list(
    body.entries,
    CHAT_TRANSCRIPT_LIMITS.entries,
    'CHAT_TRANSCRIPT_INVALID_ENTRIES'
  ).map((raw): ChatTranscriptEntry => {
    const item = object(raw);
    keys(item, ['request', 'text', 'translation']);
    return {
      request: string(
        item.request,
        CHAT_TRANSCRIPT_LIMITS.request,
        'CHAT_TRANSCRIPT_INVALID_REQUEST',
        true
      ),
      text: string(item.text, CHAT_TRANSCRIPT_LIMITS.text, 'CHAT_TRANSCRIPT_INVALID_TEXT'),
      translation:
        item.translation === null
          ? null
          : string(
              item.translation,
              CHAT_TRANSCRIPT_LIMITS.translation,
              'CHAT_TRANSCRIPT_INVALID_TRANSLATION'
            ),
    };
  });
  const notes = list(body.notes, CHAT_TRANSCRIPT_LIMITS.notes, 'CHAT_TRANSCRIPT_INVALID_NOTES').map(
    (raw): ChatTranscriptNote => {
      const item = object(raw);
      keys(
        item,
        body.version === 1
          ? ['text', 'author', 'atIndex']
          : ['text', 'author', 'atIndex', 'kind', 'origin']
      );
      const atIndex = item.atIndex;
      if (
        atIndex !== null &&
        (!Number.isSafeInteger(atIndex) || Number(atIndex) < 0 || Number(atIndex) >= entries.length)
      )
        fail('CHAT_TRANSCRIPT_INVALID_NOTE_ANCHOR');
      const note = {
        text: string(item.text, CHAT_TRANSCRIPT_LIMITS.noteText, 'CHAT_TRANSCRIPT_INVALID_NOTES'),
        author: string(item.author, CHAT_TRANSCRIPT_LIMITS.author, 'CHAT_TRANSCRIPT_INVALID_NOTES'),
        atIndex: atIndex === null ? null : Number(atIndex),
      };
      if (body.version === 1 || item.kind === 'author-note') {
        if (item.origin !== undefined) fail('CHAT_TRANSCRIPT_INVALID_NOTE_ORIGIN');
        return { ...note, kind: 'author-note' };
      }
      if (item.kind !== 'imported-memory') fail('CHAT_TRANSCRIPT_INVALID_NOTE_KIND');
      const origin = object(item.origin);
      keys(origin, ['fileHash', 'entryId', 'title']);
      const fileHash = string(origin.fileHash, 64, 'CHAT_TRANSCRIPT_INVALID_NOTE_ORIGIN');
      if (!/^[a-f0-9]{64}$/u.test(fileHash)) fail('CHAT_TRANSCRIPT_INVALID_NOTE_ORIGIN');
      return {
        ...note,
        kind: 'imported-memory',
        origin: {
          fileHash,
          entryId: string(origin.entryId, 200, 'CHAT_TRANSCRIPT_INVALID_NOTE_ORIGIN'),
          title: string(origin.title, 200, 'CHAT_TRANSCRIPT_INVALID_NOTE_ORIGIN'),
        },
      };
    }
  );
  return {
    format: CHAT_TRANSCRIPT_FORMAT,
    version: CHAT_TRANSCRIPT_VERSION,
    exportedAt,
    title,
    packageAttachments,
    notes,
    entries,
  };
}
