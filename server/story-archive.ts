import {
  archiveComparer,
  archiveRejector,
  HttpError,
  type ArchiveReject,
  type ArchiveRow as Row,
} from './request-validation.js';
import { randomUUID } from 'node:crypto';
import type { Store } from './store.js';
import { lineageHash } from './story-store.js';
import type { StorySnapshot } from '../core/story.js';
import { sourceHash, type SourceScope } from '../core/source-history.js';
import { validateAuthorNote, type AuthorNote } from '../core/notes.js';
import type { RunSnapshot } from '../core/types.js';
import { disableArchivedConnection } from '../core/product.js';
const parse = (value: unknown): any => (typeof value === 'string' ? JSON.parse(value) : value);
const reject: ArchiveReject = archiveRejector('Story archive');
function object(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return reject('invalid object');
  return value as Row;
}
function shape(value: unknown, required: string[], optional: string[] = []): Row {
  const row = object(value);
  if (
    required.some((key) => !Object.hasOwn(row, key)) ||
    Object.keys(row).some((key) => !required.includes(key) && !optional.includes(key))
  )
    reject('invalid fields');
  return row;
}
function id(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) reject('invalid identity');
}
function integer(value: unknown, min = 0, max = 1e9): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max)
    reject('invalid integer');
}
const same = archiveComparer(reject);
const rows = (store: Store, table: string): Row[] =>
  store.db.prepare(`SELECT * FROM ${table}`).all() as Row[];
const canonHash = (entries: AuthorNote[]) =>
  sourceHash(JSON.stringify([...entries].sort((a, b) => a.id.localeCompare(b.id))));

function sourceRef(store: Store, chatId: string, revision: unknown, hash: unknown) {
  id(revision);
  id(hash);
  const source = store.sourceAtHash(revision, hash);
  if (source.chatId !== chatId || sourceHash(source.text) !== hash)
    reject('source reference outside chat');
  return source;
}
/** Retains historical edits. Ancestry is immutable; each entry selects its own preserved content hash. */
function entryScope(store: Store, chatId: string, entry: AuthorNote): SourceScope {
  if (entry.atRevision === null) return { chatId, history: [] };
  const anchor = sourceRef(store, chatId, entry.atRevision, entry.atHash);
  const references = new Map<string, string>([[anchor.id, anchor.hash]]);
  const history = store.history(anchor.id).map((item) => {
    const source = references.has(item.revision)
      ? sourceRef(store, chatId, item.revision, references.get(item.revision))
      : store.sourceOriginal(item.revision);
    if (source.chatId !== chatId) reject('source ancestry outside chat');
    return {
      revision: source.id,
      text: source.text,
      contentHash: source.hash,
    };
  });
  return { chatId, history };
}
export type StorySnapshotArchiveValidator = (snapshot: RunSnapshot) => void;
/** Validate source ancestry, immutable note evidence and scene ownership inside restore's transaction. */
export function validateStoryArchive(store: Store): StorySnapshotArchiveValidator {
  try {
    const notes = new Map(rows(store, 'author_notes').map((row) => [row.id, row]));
    const snapshotValue = (
      value: unknown,
      chatId: string,
      parentRevision: string | null
    ): RunSnapshot => {
      const snapshot = object(value) as RunSnapshot;
      if (
        snapshot.chatId !== chatId ||
        snapshot.parentRevision !== parentRevision ||
        !store.validateHistory(snapshot.history, parentRevision)
      )
        reject('snapshot ancestry mismatch');
      for (const item of snapshot.history)
        if (store.sourceOriginal(item.revision).chatId !== chatId)
          reject('snapshot ancestry outside chat');
      const story = shape(
        snapshot.story,
        ['lineageHash', 'canonHash', 'notes'],
        ['sceneCommandId']
      ) as StorySnapshot;
      if (story.lineageHash !== lineageHash(snapshot.history)) reject('snapshot lineage mismatch');
      if (!Array.isArray(story.notes)) reject('invalid snapshot notes');
      const seenNotes = new Set<string>();
      for (const raw of story.notes) {
        const note = validateAuthorNote(raw, { chatId, history: snapshot.history });
        const stored = notes.get(note.id);
        if (seenNotes.has(note.id) || !stored || stored.chat_id !== chatId || note.retired)
          reject('snapshot note missing or duplicated');
        seenNotes.add(note.id);
        same(note, parse(stored.entry), 'snapshot note differs from stored entry');
      }
      if (story.canonHash !== canonHash(story.notes)) reject('snapshot note hash mismatch');
      if (story.sceneCommandId !== undefined) {
        const command = store.db
          .prepare('SELECT chat_id FROM scene_commands WHERE id=?')
          .get(story.sceneCommandId) as Row | undefined;
        if (!command || command.chat_id !== chatId) reject('snapshot scene command outside chat');
      }
      return snapshot;
    };
    for (const row of notes.values()) {
      id(row.id);
      store.chat(row.chat_id);
      const note = object(parse(row.entry)) as AuthorNote;
      if (note.id !== row.id || note.chatId !== row.chat_id) reject('note identity mismatch');
      validateAuthorNote(note, entryScope(store, row.chat_id, note));
      if (row.replaces_id !== null) {
        const prior = notes.get(row.replaces_id);
        if (!prior || prior.chat_id !== row.chat_id) reject('note replacement outside chat');
        validateAuthorNote(parse(prior.entry), entryScope(store, row.chat_id, note));
      }
      const seen = new Set<string>();
      let cursor: Row | undefined = row;
      while (cursor) {
        if (seen.has(cursor.id)) reject('note replacement cycle');
        seen.add(cursor.id);
        cursor = cursor.replaces_id === null ? undefined : notes.get(cursor.replaces_id);
      }
    }
    for (const row of rows(store, 'author_note_heads')) {
      store.chat(row.chat_id);
      integer(row.revision, 1);
    }
    for (const row of rows(store, 'author_note_commands')) {
      store.chat(row.chat_id);
      id(row.request_key);
      const command = object(parse(row.command)),
        result = object(parse(row.result)),
        saved = notes.get(result.note?.id);
      if (
        !saved ||
        saved.chat_id !== row.chat_id ||
        command.idempotencyKey !== row.request_key ||
        result.revision !== command.expectedRevision + 1
      )
        reject('invalid note command receipt');
      same(parse(saved.entry), result.note, 'note command result mismatch');
    }
    for (const row of rows(store, 'runs')) {
      const snapshot = parse(row.snapshot);
      if (snapshot.story !== undefined) snapshotValue(snapshot, row.chat_id, row.parent_revision);
    }
    for (const row of rows(store, 'scene_commands')) {
      id(row.id);
      store.chat(row.chat_id);
      if (!['pending', 'consumed', 'failed', 'cancelled'].includes(row.status))
        reject('invalid scene command status');
      if (
        typeof row.label !== 'string' ||
        !row.label.trim() ||
        row.label.length > 120 ||
        typeof row.request !== 'string' ||
        !row.request.trim() ||
        row.request.length > 4000
      )
        reject('invalid scene command');
      const branch = store.product.branch(row.chat_id, row.branch_id);
      if (branch.chatId !== row.chat_id) reject('scene branch outside chat');
      if (row.run_id !== null) {
        const run = store.run(row.run_id);
        if (
          run.chatId !== row.chat_id ||
          run.snapshot.branchId !== row.branch_id ||
          run.request !== row.request
        )
          reject('scene run mismatch');
      }
      if (row.source_revision !== null) {
        const source = store.sourceOriginal(row.source_revision);
        if (source.chatId !== row.chat_id || source.runId !== row.run_id)
          reject('scene source mismatch');
      }
      if (row.status === 'consumed' && (row.source_revision === null || row.run_id === null))
        reject('consumed command lacks source');
    }
    return (snapshot) => {
      try {
        if (snapshot.story !== undefined)
          snapshotValue(snapshot, snapshot.chatId, snapshot.parentRevision);
      } catch (error) {
        if (error instanceof HttpError && error.statusCode === 400) throw error;
        reject('invalid graph or source evidence');
      }
    };
  } catch (error) {
    if (error instanceof HttpError && error.statusCode === 400) throw error;
    reject('invalid graph or source evidence');
  }
}
const opaqueKeys = [
  'opaqueState',
  'previous_response_id',
  'thoughtSignature',
  'thought_signature',
  'continuation',
];
function stripEnvelope(value: Row) {
  for (const key of opaqueKeys) delete value[key];
}
function normalizeSnapshot(value: unknown): Row {
  const snapshot = object(value);
  stripEnvelope(snapshot);
  for (const section of [snapshot.profile])
    if (section && typeof section === 'object') {
      stripEnvelope(section);
      for (const raw of [
        ...Object.values(section.models ?? {}),
        ...(section.contextModel ? [section.contextModel] : []),
      ]) {
        const model = object(raw);
        stripEnvelope(model);
        const connection = object(model.connection);
        stripEnvelope(connection);
        disableArchivedConnection(connection);
      }
    }
  return snapshot;
}
/** Remove provider continuation and disable connections without touching authored text. */
export function normalizeStoryArchiveRow(table: string, row: Row): void {
  if (['runs', 'context_checkpoints', 'context_jobs'].includes(table))
    row.snapshot = JSON.stringify(normalizeSnapshot(parse(row.snapshot)));
  if (table === 'context_jobs' && ['queued', 'running'].includes(row.status)) {
    row.status = 'interrupted';
    row.error = 'Restored uncertain context job; explicit retry required';
  }
}
/** Copy selected stored artifacts within forkChat's existing transaction; never queue work or copy attempts. */
export function copyStoryFork(
  store: Store,
  originalChatId: string,
  newChatId: string,
  sourceIds: Map<string, string>,
  runIds: Map<string, string>
): {
  mapStory: (story: StorySnapshot, history: RunSnapshot['history']) => StorySnapshot;
  commands: Map<string, string>;
} {
  store.db.exec('PRAGMA defer_foreign_keys=ON');
  const excluded: { kind: string; reason: string }[] = [];
  const exclude = (kind: string, reason: string) => {
    excluded.push({ kind, reason });
  };
  const selected = (revision: string | null) => revision === null || sourceIds.has(revision);
  const sourceId = (revision: string | null): string | null => {
    if (revision === null) return null;
    const mapped = sourceIds.get(revision);
    if (!mapped) throw new Error('unavailable source dependency');
    return mapped;
  };
  const insert = (table: string, row: Row) => {
    const columns = Object.keys(row);
    store.db
      .prepare(
        `INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`
      )
      .run(...columns.map((column) => row[column]));
  };
  const allNotes = rows(store, 'author_notes').filter((row) => row.chat_id === originalChatId);
  const notes = new Map(
    allNotes
      .filter((row) => selected(parse(row.entry).atRevision))
      .map((row) => [row.id, randomUUID()])
  );
  const commandRows = rows(store, 'scene_commands').filter(
    (row) =>
      row.chat_id === originalChatId &&
      row.status === 'consumed' &&
      sourceIds.has(row.source_revision) &&
      runIds.has(row.run_id)
  );
  const commands = new Map(commandRows.map((row) => [row.id, randomUUID()]));
  const mapEntry = (entry: AuthorNote): AuthorNote => {
    const mapped = notes.get(entry.id);
    if (!mapped) throw new Error('unavailable note dependency');
    return {
      ...structuredClone(entry),
      id: mapped,
      chatId: newChatId,
      atRevision: sourceId(entry.atRevision),
    };
  };
  const mapStory = (story: StorySnapshot, history: RunSnapshot['history']): StorySnapshot => {
    const mappedHistory = history.map((item) => ({ ...item, revision: sourceId(item.revision)! }));
    const mappedNotes = story.notes.map(mapEntry);
    const result: StorySnapshot = {
      ...structuredClone(story),
      notes: mappedNotes,
      lineageHash: lineageHash(mappedHistory),
      canonHash: canonHash(mappedNotes),
    };
    if (story.sceneCommandId !== undefined) {
      const mapped = commands.get(story.sceneCommandId);
      if (mapped) result.sceneCommandId = mapped;
      else delete result.sceneCommandId;
    }
    return result;
  };
  for (const row of allNotes)
    if (notes.has(row.id)) {
      const entry = mapEntry(parse(row.entry));
      const replacementCopied = allNotes.some(
        (candidate) => candidate.replaces_id === row.id && notes.has(candidate.id)
      );
      insert('author_notes', {
        ...row,
        id: entry.id,
        chat_id: newChatId,
        entry: JSON.stringify(entry),
        replaces_id: row.replaces_id === null ? null : (notes.get(row.replaces_id) ?? null),
        retired_at: replacementCopied ? row.retired_at : null,
      });
    }
  if (notes.size) insert('author_note_heads', { chat_id: newChatId, revision: notes.size });
  for (const row of commandRows)
    insert('scene_commands', {
      ...row,
      id: commands.get(row.id),
      chat_id: newChatId,
      branch_id: `main:${newChatId}`,
      request_key: `fork:${row.id}`,
      run_id: runIds.get(row.run_id),
      source_revision: sourceId(row.source_revision),
    });
  for (const [oldRun, newRun] of runIds) {
    const original = store.run(oldRun).snapshot;
    if (!original.story) continue;
    const mapped = store.run(newRun).snapshot;
    try {
      mapped.story = mapStory(original.story, original.history);
    } catch {
      delete mapped.story;
      exclude('run snapshot', 'unavailable immutable dependency; original prose preserved');
    }
    store.db.prepare('UPDATE runs SET snapshot=? WHERE id=?').run(JSON.stringify(mapped), newRun);
  }
  if (excluded.length) store.event(newChatId, 'story.fork.excluded', JSON.stringify(excluded));
  return { mapStory, commands };
}
