import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ChatCopyState } from '../core/chat-backup.js';
import type { ProviderTool } from '../core/transport.js';
import { fields, HttpError, number, record, text } from './request-validation.js';
import type { Store } from './store.js';
import { HelperToolError } from './app-errors.js';

type RangeNote = { id: string; text: string; sourceIds: string[] };
type State = { revision: number; notes: RangeNote[] };
const key = (chatId: string) => 'illustration-continuity:' + chatId;
const idField = { type: 'string', minLength: 1, maxLength: 100 } as const;
const noteMax = 8000;
export const HELPER_ILLUSTRATION_CONTINUITY_TOOLS: ProviderTool[] = [
  {
    name: 'illustration.continuity.read',
    description:
      'Read the temporary visual notes of a chat (outfits, props and other visible details that hold for a range of scenes) together with the revision needed for saving. Pass sourceId to see only the notes that apply to one scene.',
    inputSchema: {
      type: 'object',
      properties: {
        sourceId: { ...idField, description: 'Limit to the notes that apply to this scene.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'illustration.continuity.save',
    description:
      'Create, edit or remove temporary visual notes that illustrations should respect across a range of existing scenes, such as an outfit worn for three scenes. A new note needs text and fromSourceId; toSourceId is the last scene it covers, included, and defaults to the same scene. Notes whose ranges overlap all apply together. A range can only name scenes that exist; extend it later when new scenes are written.',
    inputSchema: {
      type: 'object',
      properties: {
        expectedRevision: {
          type: 'integer',
          minimum: 0,
          description: 'Revision from illustration.continuity.read.',
        },
        edits: {
          type: 'array',
          minItems: 1,
          description: 'Notes to create, edit or remove.',
          items: {
            type: 'object',
            properties: {
              id: {
                ...idField,
                description: 'Id of the note to edit or remove. Omit to create a note.',
              },
              fromSourceId: { ...idField, description: 'First scene the note covers.' },
              toSourceId: { ...idField, description: 'Last scene the note covers, included.' },
              text: {
                type: 'string',
                minLength: 1,
                maxLength: noteMax,
                description: 'The visible detail to keep consistent.',
              },
              remove: {
                type: 'boolean',
                enum: [true],
                description: 'With id: delete the note.',
              },
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
    throw new HelperToolError(404, 'SCENE_NOT_FOUND', 'The scene is not in this chat.');
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
  if (!Array.isArray(edits) || !edits.length)
    throw new HelperToolError(400, 'CONTINUITY_EDITS_REQUIRED', 'Supply continuity edits.');
  return store.transaction(() => {
    const head = store.chat(chatId).headRevision;
    const state = load(store, chatId);
    if (state.revision !== expected)
      throw new HelperToolError(409, 'REVISION_CONFLICT', 'Illustration continuity changed.');
    const current = new Map(state.notes.map((note) => [note.id, note]));
    const seen = new Set<string>();
    const changedNotes: { sourceId: string; title: string }[] = [];
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
      if (seen.has(id))
        throw new HelperToolError(400, 'CONTINUITY_NOTE_DUPLICATE', 'Each note ID appears once.');
      seen.add(id);
      const previous = current.get(id);
      if ((edit.id !== undefined || edit.remove === true) && !previous)
        throw new HelperToolError(404, 'CONTINUITY_NOTE_NOT_FOUND', 'Read the notes again.');
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
            throw new HelperToolError(
              400,
              'CONTINUITY_RANGE_INVALID',
              'Choose an ordered scene range in the current chat.'
            );
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
