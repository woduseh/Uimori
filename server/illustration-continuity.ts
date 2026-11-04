import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ChatCopyState } from '../core/chat-backup.js';
import type { ProviderTool } from '../core/transport.js';
import { fields, HttpError, number, record, text } from './request-validation.js';
import type { Store } from './store.js';

// Membership is frozen when the range is chosen. Editing a scene keeps its note;
// a replacement scene or a later continuation does not inherit an unrelated outfit.
type RangeNote = { id: string; text: string; sourceIds: string[] };
type State = { revision: number; notes: RangeNote[] };
const key = (chatId: string) => 'illustration-continuity:' + chatId;
const idField = { type: 'string', minLength: 1, maxLength: 100 } as const;
const noteMax = 8000;
export const HELPER_ILLUSTRATION_CONTINUITY_TOOLS: ProviderTool[] = [
  {
    name: 'illustration.continuity.read',
    description:
      'Read temporary visual notes and their revision. Set sourceId to see only the notes for one scene.',
    inputSchema: { type: 'object', properties: { sourceId: idField }, additionalProperties: false },
  },
  {
    name: 'illustration.continuity.save',
    description:
      'Save temporary outfits, props or other visible details for a range of existing scenes. Create a note with text and fromSourceId; toSourceId is inclusive and defaults to the same scene. Edit by id with only the fields to change, or remove with {id, remove:true}. Overlapping notes apply together.',
    inputSchema: {
      type: 'object',
      properties: {
        expectedRevision: { type: 'integer', minimum: 0 },
        edits: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              id: idField,
              fromSourceId: idField,
              toSourceId: idField,
              text: { type: 'string', minLength: 1, maxLength: noteMax },
              remove: { type: 'boolean', enum: [true] },
            },
            additionalProperties: false,
          },
        },
      },
      required: ['expectedRevision', 'edits'],
      additionalProperties: false,
    },
  },
];

function load(store: Store, chatId: string): State {
  const row = store.db.prepare('SELECT value FROM app_metadata WHERE key=?').get(key(chatId));
  return row ? JSON.parse(String(row.value)) : { revision: 0, notes: [] };
}

function write(store: Store, chatId: string, state: State) {
  store.db
    .prepare('INSERT OR REPLACE INTO app_metadata(key,value) VALUES(?,?)')
    .run(key(chatId), JSON.stringify(state));
}

const describe = (note: RangeNote) => ({
  id: note.id,
  text: note.text,
  fromSourceId: note.sourceIds[0],
  toSourceId: note.sourceIds.at(-1)!,
});

export function readIllustrationContinuity(
  store: Store,
  chatId: string,
  args: Record<string, unknown>
) {
  fields(args, ['sourceId']);
  store.chat(chatId);
  const sourceId = args.sourceId === undefined ? undefined : text(args.sourceId, 'scene ID', 100);
  if (sourceId && store.sourceMetadata(sourceId).chatId !== chatId)
    throw new HttpError(404, 'Scene not found in this chat');
  const state = load(store, chatId);
  const notes = sourceId
    ? state.notes.filter((note) => note.sourceIds.includes(sourceId))
    : state.notes;
  return { chatId, revision: state.revision, notes: notes.map(describe) };
}

export function sceneAppearanceNotes(store: Store, chatId: string, sourceId: string): string[] {
  return load(store, chatId)
    .notes.filter((note) => note.sourceIds.includes(sourceId))
    .map((note) => note.text);
}

export function saveIllustrationContinuity(
  store: Store,
  chatId: string,
  args: Record<string, unknown>
) {
  fields(args, ['expectedRevision', 'edits']);
  const expected = number(args.expectedRevision, 'continuity revision', 0);
  const edits = args.edits;
  if (!Array.isArray(edits) || !edits.length) throw new HttpError(400, 'Supply continuity edits');
  return store.transaction(() => {
    const head = store.chat(chatId).headRevision;
    const state = load(store, chatId);
    if (state.revision !== expected) throw new HttpError(409, 'Illustration continuity changed');
    const current = new Map(state.notes.map((note) => [note.id, note]));
    const seen = new Set<string>();
    const changedNotes: { sourceId: string; title: string }[] = [];
    // Only IDs are needed to resolve a range, including long manuscripts.
    const chain = store.db
      .prepare(`WITH RECURSIVE chain(id,parent,depth) AS (
      SELECT id,parent_revision,0 FROM sources WHERE id=? AND chat_id=?
      UNION ALL SELECT s.id,s.parent_revision,c.depth+1 FROM chain c JOIN sources s ON s.id=c.parent WHERE s.chat_id=?
    ) SELECT id FROM chain ORDER BY depth DESC`)
      .all(head, chatId, chatId)
      .map((row) => String(row.id));
    for (const raw of edits) {
      const edit = record(raw);
      fields(
        edit,
        edit.remove === true ? ['id', 'remove'] : ['id', 'fromSourceId', 'toSourceId', 'text']
      );
      const id = edit.id === undefined ? randomUUID() : text(edit.id, 'note ID', 100);
      if (seen.has(id)) throw new HttpError(400, 'Duplicate continuity note ID');
      seen.add(id);
      const previous = current.get(id);
      if ((edit.id !== undefined || edit.remove === true) && !previous)
        throw new HttpError(404, 'Unknown continuity note');
      let note: RangeNote;
      if (edit.remove === true && previous) {
        note = previous;
        current.delete(id);
      } else {
        const content = text(
          edit.text === undefined ? previous?.text : edit.text,
          'continuity text',
          noteMax
        );
        let sourceIds = previous?.sourceIds;
        if (!sourceIds || edit.fromSourceId !== undefined || edit.toSourceId !== undefined) {
          const from = text(
            edit.fromSourceId === undefined ? previous?.sourceIds[0] : edit.fromSourceId,
            'first scene',
            100
          );
          const to = text(
            edit.toSourceId === undefined ? (previous?.sourceIds.at(-1) ?? from) : edit.toSourceId,
            'last scene',
            100
          );
          const start = chain.indexOf(from),
            end = chain.indexOf(to);
          if (start < 0 || end < start)
            throw new HttpError(400, 'Choose an ordered scene range in the current chat');
          sourceIds = chain.slice(start, end + 1);
        }
        note = { id, text: content, sourceIds };
        if (isDeepStrictEqual(note, previous)) continue;
        current.set(id, note);
      }
      changedNotes.push({
        sourceId: note.sourceIds[0],
        title: note.text.slice(0, 120).replace(/[\uD800-\uDBFF]$/u, ''),
      });
    }
    const next = {
      revision: state.revision + Number(changedNotes.length > 0),
      notes: [...current.values()],
    };
    if (changedNotes.length) write(store, chatId, next);
    return {
      chatId,
      revision: next.revision,
      changed: changedNotes.length > 0,
      changedNotes,
      notes: next.notes.map(describe),
    };
  });
}

export function removeDeletedContinuityScenes(store: Store, chatId: string, removed: Set<string>) {
  const state = load(store, chatId);
  if (!state.notes.some((note) => note.sourceIds.some((id) => removed.has(id)))) return;
  const notes = state.notes
    .map((note) => ({ ...note, sourceIds: note.sourceIds.filter((id) => !removed.has(id)) }))
    .filter((note) => note.sourceIds.length);
  write(store, chatId, { revision: state.revision + 1, notes });
}

export function captureIllustrationContinuity(
  store: Store,
  chatId: string,
  history: { revision: string }[]
): ChatCopyState['illustrationContinuity'] {
  const state = load(store, chatId);
  if (!state.notes.length) return undefined;
  const indices = new Map(history.map(({ revision }, index) => [revision, index]));
  return state.notes.flatMap((note) => {
    const scenes = note.sourceIds.flatMap((id) => indices.get(id) ?? []);
    return scenes.length ? [{ text: note.text, scenes }] : [];
  });
}

export function restoreIllustrationContinuity(
  store: Store,
  chatId: string,
  history: { revision: string }[],
  value: unknown
) {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new HttpError(400, 'Invalid illustration continuity');
  const notes = value.map((entry) => {
    const item = record(entry);
    fields(item, ['text', 'scenes']);
    if (!Array.isArray(item.scenes) || !item.scenes.length)
      throw new HttpError(400, 'Invalid continuity scenes');
    const scenes = item.scenes.map((index) =>
      number(index, 'continuity scene', 0, history.length - 1)
    );
    if (scenes.some((index, i) => i > 0 && index !== scenes[i - 1] + 1))
      throw new HttpError(400, 'Invalid continuity range');
    return {
      id: randomUUID(),
      text: text(item.text, 'continuity text', noteMax),
      sourceIds: scenes.map((i) => history[i].revision),
    };
  });
  if (notes.length) write(store, chatId, { revision: 1, notes });
}
