import { HttpError } from './request-validation.js';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Store } from './store.js';
import { lineageHash, storyDependencyKey } from './story-store.js';
import {
  activationRebuildState,
  defaultStoryConfig,
  type StoryConfig,
  type StorySnapshot,
  type StoryState,
} from '../core/story.js';
import {
  initialState,
  reduceStateProposal,
  validateStateModule,
  validateStateValues,
} from '../core/state.js';
import { sourceHash, type SourceScope } from '../core/source-history.js';
import { validateAuthorNote, type AuthorNote } from '../core/notes.js';
import { validateModelSnapshot } from './provider-archive.js';
import type { RunSnapshot } from '../core/types.js';

type Row = Record<string, any>;
const parse = (value: unknown): any => (typeof value === 'string' ? JSON.parse(value) : value);
function reject(reason: string): never {
  throw new HttpError(400, `Story archive: ${reason}`);
}
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
function same(left: unknown, right: unknown, reason: string) {
  if (!isDeepStrictEqual(left, right)) reject(reason);
}
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
      ...(item.sourceSegments ? { sourceSegments: item.sourceSegments } : {}),
    };
  });
  return { chatId, history };
}
function configValue(
  store: Store,
  value: unknown,
  chatId: string,
  currentSelection = true
): StoryConfig {
  const config = shape(value, ['revision', 'module', 'stateModel', 'activatedAt']);
  integer(config.revision);
  if (config.module !== null) validateStateModule(config.module);
  for (const value of [config.stateModel])
    if (value !== null) {
      const ref = shape(value, ['id']);
      id(ref.id);
      if (currentSelection) store.product.get('model', ref.id);
    }
  if (config.activatedAt !== null) {
    const ref = shape(config.activatedAt, ['revision', 'hash']);
    sourceRef(store, chatId, ref.revision, ref.hash);
  }
  if (config.revision === 0) same(config, defaultStoryConfig(), 'invalid default configuration');
  if (config.module && config.module.revision > config.revision) reject('future module revision');
  return config as StoryConfig;
}
function initial(config: StoryConfig, chatId: string): StoryState | null {
  const module = config.module;
  return module
    ? {
        id: `initial:${chatId}:${module.revision}`,
        sourceRevision: config.activatedAt?.revision ?? null,
        sourceHash: config.activatedAt?.hash ?? null,
        moduleRevision: module.revision,
        values: initialState(module),
        canonical: module.mode !== 'annotation',
      }
    : null;
}

export type StorySnapshotArchiveValidator = (snapshot: RunSnapshot) => void;

/** Validate after base archive graph checks, inside the importing transaction. The returned
 * validator shares the same source/state/note and configuration revision ledger for other owners. */
export function validateStoryArchive(store: Store): StorySnapshotArchiveValidator {
  try {
    const configs = new Map<string, StoryConfig>();
    const modules = new Map<string, unknown>();
    const currentRevisions = new Map<string, number>();
    // Settings have one current row. Historical configurations are owned by their
    // Run/job snapshots, which must still agree whenever they share a revision.
    const rememberConfig = (chatId: string, config: StoryConfig) => {
      const currentRevision = currentRevisions.get(chatId);
      if (currentRevision !== undefined && config.revision > currentRevision)
        reject('snapshot configuration is newer than current settings');
      const key = `${chatId}:${config.revision}`;
      if (configs.has(key)) same(configs.get(key), config, 'snapshot configuration mismatch');
      configs.set(key, config);
      if (config.module) {
        const moduleKey = `${chatId}:${config.module.revision}`;
        if (modules.has(moduleKey))
          same(modules.get(moduleKey), config.module, 'module revision was mutated');
        modules.set(moduleKey, config.module);
      }
    };
    for (const row of rows(store, 'story_configs')) {
      store.chat(row.chat_id);
      integer(row.revision, 1);
      const config = configValue(store, parse(row.body), row.chat_id);
      if (config.revision !== row.revision) reject('configuration revision mismatch');
      currentRevisions.set(row.chat_id, row.revision);
      rememberConfig(row.chat_id, config);
    }
    const jobs = new Map(rows(store, 'story_jobs').map((row) => [row.id, row]));
    const states = new Map(rows(store, 'story_states').map((row) => [row.id, row]));
    const notes = new Map(rows(store, 'author_notes').map((row) => [row.id, row]));
    const snapshots = new Map<string, RunSnapshot>();
    const snapshotValue = (
      value: unknown,
      chatId: string,
      parentRevision: string | null,
      stateSource?: { id: string; hash: string }
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
      if (!snapshot.story) reject('story snapshot missing');
      const story = shape(
        snapshot.story,
        ['config', 'state', 'waiting', 'lineageHash', 'canonHash', 'notes', 'models'],
        ['sceneCommandId']
      ) as StorySnapshot;
      const config = configValue(store, story.config, chatId, false);
      rememberConfig(chatId, config);
      if (typeof story.waiting !== 'boolean' || story.lineageHash !== lineageHash(snapshot.history))
        reject('snapshot lineage mismatch');
      if (story.waiting !== (config.module?.mode === 'authoritative' && story.state === null))
        reject('state barrier mismatch');
      const modelMap = shape(story.models, [], ['state', 'context']);
      for (const [kind, ref] of [['state', config.stateModel]] as const) {
        if (!ref) {
          if (modelMap[kind] !== undefined) reject('unselected model snapshot');
          continue;
        }
        const selected = validateModelSnapshot(modelMap[kind]);
        if (selected.id !== ref.id) reject('model snapshot selection mismatch');
      }
      if (modelMap.context !== undefined) validateModelSnapshot(modelMap.context);
      if (story.state !== null) {
        const state = shape(story.state, [
          'id',
          'sourceRevision',
          'sourceHash',
          'moduleRevision',
          'values',
          'canonical',
        ]) as StoryState;
        if (!config.module || state.moduleRevision !== config.module.revision)
          reject('state module mismatch');
        validateStateValues(config.module, state.values);
        if (state.id.startsWith('initial:')) {
          // An explicit activation rebuild may start immediately before its own
          // source. Only a source-bound job can carry this baseline; ordinary
          // original Run snapshots must retain their original initial state.
          const rebuild = stateSource
            ? activationRebuildState(chatId, config, stateSource, snapshot.history)
            : null;
          if (
            !isDeepStrictEqual(state, initial(config, chatId)) &&
            !isDeepStrictEqual(state, rebuild)
          )
            reject('initial state mismatch');
        } else {
          const row = states.get(state.id);
          if (!row || row.chat_id !== chatId) reject('parent state missing');
          same(state, parse(row.body), 'parent state snapshot mismatch');
          if (
            !snapshot.history.some(
              (item) =>
                item.revision === state.sourceRevision && sourceHash(item.text) === state.sourceHash
            )
          )
            reject('parent state not in ancestry');
        }
        if (
          state.sourceRevision !== null &&
          !snapshot.history.some(
            (item) =>
              item.revision === state.sourceRevision && sourceHash(item.text) === state.sourceHash
          )
        )
          reject('state anchor not in ancestry');
      }
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
    for (const row of jobs.values()) {
      id(row.id);
      integer(row.generation);
      integer(row.config_revision, 1);
      if (
        row.kind !== 'state' ||
        !['completed', 'failed', 'stale', 'cancelled', 'interrupted'].includes(row.status) ||
        ![0, 1].includes(row.mock) ||
        row.owner !== null
      )
        reject('invalid restored job status');
      const source = sourceRef(store, row.chat_id, row.source_revision, row.source_hash);
      const snapshot = snapshotValue(
        parse(row.snapshot),
        row.chat_id,
        source.parentRevision,
        row.kind === 'state' ? source : undefined
      );
      snapshots.set(row.id, snapshot);
      const originalSnapshot = store.run(source.runId).snapshot;
      same(snapshot.resources, originalSnapshot.resources, 'job resource snapshot mismatch');
      same(snapshot.profile, originalSnapshot.profile, 'job profile snapshot mismatch');
      if (!Array.isArray(parse(row.inputs)) || !Array.isArray(parse(row.tool_events)))
        reject('invalid job diagnostics');
      if (row.dependency_key !== storyDependencyKey(row.kind, source, snapshot))
        reject('job dependency key mismatch');
      if (snapshot.story!.config.revision !== row.config_revision)
        reject('job configuration mismatch');
      if (!snapshot.story!.config.module) reject('job role disabled');
      if (row.status === 'completed' && row.result === null) reject('completed job lacks result');
      const stateRows = [...states.values()].filter((state) => state.job_id === row.id);
      if (
        (row.kind === 'state' && row.status === 'completed' && stateRows.length !== 1) ||
        (row.kind !== 'state' && stateRows.length)
      )
        reject('state completion mismatch');
    }
    for (const row of states.values()) {
      const job = jobs.get(row.job_id);
      const snapshot = snapshots.get(row.job_id);
      if (
        !job ||
        !snapshot ||
        job.kind !== 'state' ||
        !['completed', 'stale'].includes(job.status) ||
        row.chat_id !== job.chat_id ||
        row.source_revision !== job.source_revision ||
        row.source_hash !== job.source_hash
      )
        reject('orphan or mismatched state');
      const module = snapshot.story!.config.module!;
      if (
        row.module_revision !== module.revision ||
        row.parent_state_id !== (snapshot.story!.state?.id ?? null)
      )
        reject('state dependency mismatch');
      const source = sourceRef(store, row.chat_id, row.source_revision, row.source_hash);
      const reduced = reduceStateProposal(
        module,
        snapshot.story!.state?.values ?? initialState(module),
        parse(job.result),
        { revision: source.id, hash: source.hash, text: source.text }
      );
      same(
        parse(row.body),
        {
          id: row.id,
          sourceRevision: source.id,
          sourceHash: source.hash,
          moduleRevision: module.revision,
          ...reduced,
        },
        'state reducer result mismatch'
      );
    }
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
  for (const section of [snapshot.profile, snapshot.story])
    if (section && typeof section === 'object') {
      stripEnvelope(section);
      for (const raw of [
        ...Object.values(section.models ?? {}),
        ...(section.contextModel ? [section.contextModel] : []),
      ]) {
        const model = object(raw);
        stripEnvelope(model);
        const connection = object(model.connection);
        delete connection.credentialEnv;
        delete connection.secret;
        delete connection.apiKey;
        delete connection.accessToken;
        stripEnvelope(connection);
        connection.enabled = false;
      }
    }
  return snapshot;
}
function normalizeToolEvent(value: unknown) {
  const event = object(value);
  stripEnvelope(event);
  if (event.result && typeof event.result === 'object' && !Array.isArray(event.result)) {
    // Local read pagination is useful diagnostic data, not provider continuation.
    for (const key of opaqueKeys.filter((key) => key !== 'continuation')) delete event.result[key];
  }
}
/** Called on a detached archive row before insertion. No prose or typed state fields are rewritten. */
export function normalizeStoryArchiveRow(table: string, row: Row): void {
  if (['runs', 'story_jobs', 'context_checkpoints', 'context_jobs'].includes(table))
    row.snapshot = JSON.stringify(normalizeSnapshot(parse(row.snapshot)));
  if (table === 'runs' && row.status === 'waiting_for_state') {
    row.status = 'interrupted';
    row.error = 'Restored state-dependent run; explicit retry required';
  }
  if (table === 'context_jobs' && ['queued', 'running'].includes(row.status)) {
    row.status = 'interrupted';
    row.error = 'Restored uncertain context job; explicit retry required';
  }
  if (table === 'story_jobs') {
    if (['queued', 'running'].includes(row.status)) {
      row.status = 'interrupted';
      row.error = 'Restored uncertain story job; explicit retry required';
    }
    row.owner = null;
    if (row.result !== null) {
      const result = object(parse(row.result));
      stripEnvelope(result);
      row.result = JSON.stringify(result);
    }
    if (row.inputs !== undefined) {
      const inputs = parse(row.inputs);
      if (!Array.isArray(inputs)) reject('invalid input diagnostics');
      for (const raw of inputs) {
        const input = object(raw);
        stripEnvelope(input);
        if (Array.isArray(input.results)) input.results.forEach(normalizeToolEvent);
      }
      row.inputs = JSON.stringify(inputs);
    }
    if (row.tool_events !== undefined) {
      const events = parse(row.tool_events);
      if (!Array.isArray(events)) reject('invalid tool diagnostics');
      events.forEach(normalizeToolEvent);
      row.tool_events = JSON.stringify(events);
    }
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
  const mapConfig = (config: StoryConfig): StoryConfig => ({
    ...structuredClone(config),
    activatedAt: config.activatedAt
      ? { ...config.activatedAt, revision: sourceId(config.activatedAt.revision)! }
      : null,
  });
  for (const row of rows(store, 'story_configs').filter((row) => row.chat_id === originalChatId)) {
    const config = parse(row.body) as StoryConfig;
    if (!selected(config.activatedAt?.revision ?? null)) {
      exclude('config', 'activation outside selected ancestry');
      continue;
    }
    const mapped = mapConfig(config);
    insert('story_configs', { ...row, chat_id: newChatId, body: JSON.stringify(mapped) });
  }
  const allJobs = rows(store, 'story_jobs').filter((row) => row.chat_id === originalChatId);
  const allStates = rows(store, 'story_states').filter((row) => row.chat_id === originalChatId);
  const allNotes = rows(store, 'author_notes').filter((row) => row.chat_id === originalChatId);
  const candidates = allJobs.filter(
    (row) => row.status === 'completed' && selected(row.source_revision)
  );
  const jobs = new Map(candidates.map((row) => [row.id, randomUUID()]));
  const states = new Map(
    allStates.filter((row) => jobs.has(row.job_id)).map((row) => [row.id, randomUUID()])
  );
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
  const initialId = (old: string) =>
    old.startsWith(`initial:${originalChatId}:`)
      ? `initial:${newChatId}:${old.slice(`initial:${originalChatId}:`.length)}`
      : null;
  const stateId = (old: string) => {
    const mapped = initialId(old) ?? states.get(old);
    if (!mapped) throw new Error('unavailable parent state dependency');
    return mapped;
  };
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
  const mapState = (state: StoryState | null): StoryState | null =>
    state
      ? {
          ...structuredClone(state),
          id: stateId(state.id),
          sourceRevision: sourceId(state.sourceRevision),
        }
      : null;
  const mapStory = (story: StorySnapshot, history: RunSnapshot['history']): StorySnapshot => {
    const config = mapConfig(story.config);
    const mappedHistory = history.map((item) => ({ ...item, revision: sourceId(item.revision)! }));
    const mappedNotes = story.notes.map(mapEntry);
    const result: StorySnapshot = {
      ...structuredClone(story),
      config: structuredClone(config),
      state: mapState(story.state),
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
  // Remove the transitive closure of unresolved dependencies before copying any artifact.
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of candidates.filter((row) => jobs.has(row.id))) {
      try {
        const snapshot = parse(row.snapshot) as RunSnapshot;
        mapStory(snapshot.story!, snapshot.history);
      } catch {
        jobs.delete(row.id);
        for (const state of allStates.filter((state) => state.job_id === row.id))
          states.delete(state.id);
        exclude(row.kind, 'unavailable immutable dependency');
        changed = true;
      }
    }
  }
  for (const row of allJobs)
    if (selected(row.source_revision) && row.status !== 'completed')
      exclude(row.kind, 'only completed stored jobs are copied');
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
  for (const row of candidates.filter((row) => jobs.has(row.id))) {
    const snapshot = parse(row.snapshot) as RunSnapshot;
    const originalSource = store.sourceOriginal(row.source_revision);
    const copiedRunId = runIds.get(originalSource.runId);
    if (!copiedRunId) throw new Error('Fork source run mapping missing');
    const copiedRun = store.run(copiedRunId);
    const mapped: RunSnapshot = {
      ...structuredClone(snapshot),
      chatId: newChatId,
      parentRevision: sourceId(snapshot.parentRevision),
      branchId: `main:${newChatId}`,
      history: snapshot.history.map((item) => ({ ...item, revision: sourceId(item.revision)! })),
      story: mapStory(snapshot.story!, snapshot.history),
      resources: structuredClone(copiedRun.snapshot.resources),
      ...(snapshot.profile
        ? { profile: { ...structuredClone(snapshot.profile), chatId: newChatId } }
        : {}),
    };
    delete mapped.candidateOf;
    const result = {
      ...parse(row.result),
      sourceRevision: sourceId(parse(row.result).sourceRevision),
    };
    const copied = {
      ...row,
      id: jobs.get(row.id),
      chat_id: newChatId,
      source_revision: sourceId(row.source_revision),
      owner: null,
      snapshot: JSON.stringify(mapped),
      result: JSON.stringify(result),
      inputs: '[]',
      tool_events: '[]',
      dependency_key: storyDependencyKey(
        row.kind,
        { id: sourceId(row.source_revision)!, hash: row.source_hash },
        mapped
      ),
    };
    insert('story_jobs', copied);
  }
  for (const row of allStates.filter((row) => states.has(row.id))) {
    const body = mapState(parse(row.body))!;
    insert('story_states', {
      ...row,
      id: body.id,
      job_id: jobs.get(row.job_id),
      chat_id: newChatId,
      source_revision: sourceId(row.source_revision),
      parent_state_id: row.parent_state_id === null ? null : stateId(row.parent_state_id),
      body: JSON.stringify(body),
    });
  }
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
