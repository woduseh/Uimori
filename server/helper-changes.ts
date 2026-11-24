import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { chatLoreKey, type ChatLoreOverride } from '../core/chat-overrides.js';
import type {
  HelperChange,
  HelperChangeAnchor,
  HelperChangeListSection,
  HelperChangeLocation,
  HelperTask,
} from '../core/helper.js';
import {
  editableResource,
  resourceListKind,
  type ResourceKind,
  type SavedResource,
} from '../core/resource-editing.js';
import { alignSequences, diffText, type TextDiff, type TextDiffMode } from '../core/text-diff.js';
import { displayTranslationJob } from '../core/translation-display.js';
import { sceneTitle } from './scene-titles.js';
import { pruneThemeAssets, themeAssetHashes } from './theme-assets.js';
import { imageDataHashes, queueImageCleanup } from './unused-data.js';
import { latestTranslation } from './source-editing.js';
import type { Store } from './store.js';

export const HELPER_CHANGE_RETENTION = { turns: 15, days: 30 } as const;
const RESPONSE_DIFF_CHARS = 200_000;
const TARGET_DIFF_CHARS = 400_000;
const TARGET_ENTRIES = 200;
const NAME_CHARS = 80;

type ChangeTask = Pick<HelperTask, 'id' | 'conversationId'>;
type SceneField = 'original' | 'translation' | 'title';
export type HelperChangeTarget =
  | { domain: 'scene'; chatId: string; sourceId: string; field: SceneField }
  | { domain: 'outline'; chatId: string }
  | { domain: 'notes'; chatId: string };
type Key = { domain: HelperChange['domain']; targetId: string; chatId: string | null };
export type OutlineState = {
  id: string;
  parentId: string | null;
  level: string;
  position: number;
  title: string;
  intent: string;
  fixed: boolean;
  relatedIds?: string[];
}[];
export type NoteState = { id: string; kind: string; text: string }[];
type Capture = { value: unknown; label: { title: string; scene?: number | null } };
type Json = Record<string, unknown>;
type ChangeState = { before: unknown; beforeHash: string | null; afterHash: string | null };

export function initHelperChanges(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS helper_changes(
    task_id TEXT NOT NULL REFERENCES helper_tasks(id) ON DELETE CASCADE,
    domain TEXT NOT NULL,target_id TEXT NOT NULL,chat_id TEXT,source_id TEXT,
    position INTEGER NOT NULL,baseline TEXT,entries TEXT NOT NULL,
    text_removed TEXT CHECK(text_removed IN ('deleted','expired')),updated_at TEXT NOT NULL,
    result TEXT,foreign_edit INTEGER NOT NULL DEFAULT 0,rolled_back_at TEXT,
    PRIMARY KEY(task_id,domain,target_id));
  CREATE INDEX IF NOT EXISTS helper_changes_chat ON helper_changes(chat_id);
  CREATE INDEX IF NOT EXISTS helper_changes_source ON helper_changes(source_id);`);
  const columns = new Set(
    db
      .prepare('PRAGMA table_info(helper_changes)')
      .all()
      .map((column) => String(column.name))
  );
  if (!columns.has('result')) db.exec('ALTER TABLE helper_changes ADD COLUMN result TEXT');
  if (!columns.has('foreign_edit'))
    db.exec('ALTER TABLE helper_changes ADD COLUMN foreign_edit INTEGER NOT NULL DEFAULT 0');
  if (!columns.has('rolled_back_at'))
    db.exec('ALTER TABLE helper_changes ADD COLUMN rolled_back_at TEXT');
}

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : plain(value)
      ? Object.fromEntries(
          Object.keys(value)
            .filter((key) => value[key] !== undefined)
            .sort()
            .map((key) => [key, canonical(value[key])])
        )
      : value;
export const helperStateHash = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value ?? null)))
    .digest('hex');

const plain = (value: unknown): value is Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const encode = (part: string) => part.replaceAll('~', '~0').replaceAll('/', '~1');
const decode = (part: string) => part.replaceAll('~1', '/').replaceAll('~0', '~');
const shortName = (value: string) =>
  value.length > NAME_CHARS
    ? `${value.slice(0, NAME_CHARS).replace(/[\uD800-\uDBFF]$/u, '')}…`
    : value;
const textOf = (value: unknown) =>
  value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);

function firstChangedParagraph(diff: TextDiff, after: string): number | null {
  if ('omitted' in diff || !diff.hunks.length) return null;
  const [hunk] = diff.hunks;
  let offset = hunk!.afterOffset;
  for (const segment of hunk!.segments) {
    if (segment.op !== 'equal') break;
    offset += segment.text.length;
  }
  return after.slice(0, offset).split('\n').length - 1;
}

function storeChange(
  store: Store,
  task: ChangeTask,
  key: Key,
  sourceId: string | null,
  state: ChangeState,
  entries: ((baseline: unknown) => HelperChange[]) | 'companion'
) {
  const db = store.db;
  const row = db
    .prepare(
      'SELECT baseline,entries,result FROM helper_changes WHERE task_id=? AND domain=? AND target_id=? AND text_removed IS NULL'
    )
    .get(task.id, key.domain, key.targetId);
  const baseline = row ? JSON.parse(String(row.baseline)) : state.before;
  const list =
    entries !== 'companion'
      ? boundDiffs(entries(baseline), TARGET_DIFF_CHARS)
      : row
        ? (JSON.parse(String(row.entries)) as HelperChange[])
        : [];
  const foreign =
    !!row && row.result !== null && state.beforeHash !== null && row.result !== state.beforeHash;
  const time = new Date().toISOString();
  if (!list.length && key.domain !== 'scene')
    db.prepare('DELETE FROM helper_changes WHERE task_id=? AND domain=? AND target_id=?').run(
      task.id,
      key.domain,
      key.targetId
    );
  else
    db.prepare(`INSERT INTO helper_changes(task_id,domain,target_id,chat_id,source_id,position,baseline,entries,text_removed,updated_at,result,foreign_edit)
      VALUES(?,?,?,?,?,(SELECT COALESCE(MAX(position),0)+1 FROM helper_changes WHERE task_id=?),?,?,NULL,?,?,?)
      ON CONFLICT(task_id,domain,target_id) DO UPDATE SET entries=excluded.entries,updated_at=excluded.updated_at,
        result=excluded.result,
        foreign_edit=CASE WHEN text_removed IS NULL THEN MAX(foreign_edit,excluded.foreign_edit) ELSE excluded.foreign_edit END,
        baseline=CASE WHEN text_removed IS NULL THEN baseline ELSE excluded.baseline END,text_removed=NULL`).run(
      task.id,
      key.domain,
      key.targetId,
      key.chatId,
      sourceId,
      task.id,
      JSON.stringify(baseline ?? null),
      JSON.stringify(list),
      time,
      state.afterHash,
      foreign ? 1 : 0
    );
  pruneHelperChanges(db, task.conversationId);
}

function resourceTitle(saved: SavedResource) {
  return 'title' in saved ? String(saved.title) : '공통 프롬프트';
}
const BODY_FIELDS = { lore: 'content', prompt: 'text', terms: 'target' } as const;
type ListItem = Extract<HelperChangeLocation, { kind: 'resource-list' }>['item'] & {};
function listItem(section: HelperChangeListSection, item: unknown, index: number): ListItem {
  const named: ListItem = { name: null, index };
  if (!plain(item)) return named;
  const candidates =
    section === 'lore'
      ? [item.comment, item.name, item.key, item.keys]
      : section === 'prompt'
        ? [item.name]
        : [item.source];
  for (const candidate of candidates) {
    const value = Array.isArray(candidate) ? candidate[0] : candidate;
    if (typeof value === 'string' && value.trim()) {
      named.name = shortName(value.trim());
      break;
    }
  }
  if (section === 'prompt' && typeof item.type === 'string' && item.type) named.type = item.type;
  return named;
}
function itemName(section: HelperChangeListSection, item: unknown, index: number): string {
  const { name, type } = listItem(section, item, index);
  return name ?? type ?? `#${index + 1}`;
}
function diffMode(path: string, before: unknown, after: unknown): TextDiffMode {
  if (typeof before !== 'string' && before !== undefined) return 'code';
  if (typeof after !== 'string' && after !== undefined) return 'code';
  if (
    /\/(?:customscript|regex|triggerscript|lua|scripts?|css|backgroundHTML|values|assets)(?:\/|$)/iu.test(
      path
    )
  )
    return 'code';
  return /^\s*[{[<]/u.test(String(after ?? before)) ? 'code' : 'prose';
}
const segments = (path: string) => path.split('/').filter(Boolean).map(decode);

function resourceEntries(
  kind: ResourceKind,
  id: string,
  title: string,
  before: unknown,
  after: unknown
): HelperChange[] {
  const entries: HelperChange[] = [];
  const anchor = (
    path: string | null,
    section: 'lore' | 'prompt' | 'terms' | 'field' | null,
    index: number | null
  ): HelperChangeAnchor => ({ domain: 'resource', kind, id, path, section, index });
  const push = (
    action: HelperChange['action'],
    location: HelperChangeLocation | null,
    diff: TextDiff | null,
    at: HelperChangeAnchor | null
  ) =>
    entries.push({ domain: 'resource', targetId: id, title, location, action, diff, anchor: at });
  if (before === null && after === null) return entries;
  if (before === null) {
    push('create', null, null, anchor(null, null, null));
    return entries;
  }
  if (after === null) {
    push('delete', null, null, null);
    return entries;
  }
  type Item = { section: HelperChangeListSection; index: number; list: string; value: unknown };
  const listLocation = (
    path: string,
    section: HelperChangeListSection,
    item: { value: unknown; index: number } | null,
    field = ''
  ): HelperChangeLocation => ({
    kind: 'resource-list',
    path: segments(path),
    section,
    item: item && listItem(section, item.value, item.index),
    field: segments(field),
  });
  const body = (section: Item['section'], item: unknown) =>
    plain(item) && typeof item[BODY_FIELDS[section]] === 'string'
      ? String(item[BODY_FIELDS[section]])
      : null;
  const walk = (a: unknown, b: unknown, path: string, item: Item | null, relative: string) => {
    if (isDeepStrictEqual(a, b)) return;
    const section = resourceListKind(segments(path));
    if (
      section &&
      (Array.isArray(a) || a == null) &&
      (Array.isArray(b) || b == null) &&
      (Array.isArray(a) || Array.isArray(b))
    ) {
      list((a ?? []) as unknown[], (b ?? []) as unknown[], path, section);
      return;
    }
    if ((plain(a) || a == null) && (plain(b) || b == null) && (plain(a) || plain(b))) {
      const left = (a ?? {}) as Json;
      const right = (b ?? {}) as Json;
      for (const key of new Set([...Object.keys(left), ...Object.keys(right)]))
        walk(left[key], right[key], `${path}/${encode(key)}`, item, `${relative}/${encode(key)}`);
      return;
    }
    const mode = diffMode(path, a, b);
    const location: HelperChangeLocation = item
      ? listLocation(item.list, item.section, item, relative)
      : { kind: 'resource-field', path: segments(path) };
    push(
      a === undefined ? 'create' : b === undefined ? 'delete' : 'update',
      location,
      diffText(textOf(a), textOf(b), mode),
      item ? anchor(path, item.section, item.index) : anchor(path, 'field', null)
    );
  };
  const list = (a: unknown[], b: unknown[], path: string, section: Item['section']) => {
    const keysA = a.map((item) => JSON.stringify(item));
    const keysB = b.map((item) => JSON.stringify(item));
    if (keysA.length === keysB.length && isDeepStrictEqual(keysA.toSorted(), keysB.toSorted())) {
      const names = (items: unknown[]) =>
        items.map((item, index) => `${itemName(section, item, index)}\n`).join('');
      push(
        'reorder',
        listLocation(path, section, null),
        diffText(names(a), names(b), 'code'),
        anchor(path, section, null)
      );
      return;
    }
    const script = alignSequences(keysA, keysB);
    if (!script) {
      push(
        'update',
        listLocation(path, section, null),
        diffText(textOf(a), textOf(b), 'code'),
        anchor(path, section, null)
      );
      return;
    }
    let x = 0;
    let y = 0;
    for (let index = 0; index < script.length; ) {
      if (script[index] === 'equal') {
        x++;
        y++;
        index++;
        continue;
      }
      const removed: number[] = [];
      const added: number[] = [];
      while (index < script.length && script[index] !== 'equal') {
        if (script[index] === 'delete') removed.push(x++);
        else added.push(y++);
        index++;
      }
      const paired = Math.min(removed.length, added.length);
      for (let pair = 0; pair < paired; pair++) {
        const at = added[pair]!;
        walk(
          a[removed[pair]!],
          b[at],
          `${path}/${at}`,
          { section, index: at, list: path, value: b[at] },
          ''
        );
      }
      for (const at of removed.slice(paired)) {
        const text = body(section, a[at]);
        push(
          'delete',
          listLocation(path, section, { value: a[at], index: at }),
          text === null ? null : diffText(text, '', 'prose'),
          anchor(path, section, null)
        );
      }
      for (const at of added.slice(paired)) {
        const text = body(section, b[at]);
        push(
          'create',
          listLocation(path, section, { value: b[at], index: at }),
          text === null ? null : diffText('', text, 'prose'),
          anchor(`${path}/${at}`, section, at)
        );
      }
    }
  };
  walk(...comparedViews(kind, before, after), '', null, '');
  if (entries.length <= TARGET_ENTRIES) return entries;
  const rest = entries.length - TARGET_ENTRIES + 1;
  return [
    ...entries.slice(0, TARGET_ENTRIES - 1),
    {
      domain: 'resource',
      targetId: id,
      title,
      location: { kind: 'resource-more', count: rest },
      action: 'update',
      diff: null,
      anchor: anchor(null, null, null),
    },
  ];
}
export function authoredView(kind: ResourceKind, model: unknown): unknown {
  if (kind !== 'content' || !plain(model) || !plain(model.package)) return model;
  const { kind: contentKind, loading, relatedIds } = model;
  const { nativeRisu, images } = model.package;
  return { kind: contentKind, loading, relatedIds, package: { nativeRisu, images } };
}

type HandoffRange = { field: string; text: string; id: string; enabled: boolean };
function ownerSettings(own: Json, other: Json) {
  const handoff = (value: unknown) =>
    plain(value) && Array.isArray(value.ranges) ? (value.ranges as HandoffRange[]) : null;
  const ranges = handoff(own.imageHandoff);
  const otherRanges = handoff(other.imageHandoff);
  return {
    portraitImageId: own.portraitImageId,
    modules: own.modules,
    loreActivation:
      plain(own.loreActivation) && plain(other.loreActivation)
        ? { mode: own.loreActivation.mode }
        : undefined,
    imageHandoff:
      ranges && otherRanges
        ? {
            enabled: ranges
              .filter(
                (range) =>
                  range.enabled &&
                  otherRanges.some((item) => item.field === range.field && item.text === range.text)
              )
              .map((range) => `${range.field}:${range.id}`),
          }
        : undefined,
  };
}

function comparedViews(kind: ResourceKind, before: unknown, after: unknown): [unknown, unknown] {
  const left = authoredView(kind, before);
  const right = authoredView(kind, after);
  if (kind !== 'content' || !plain(left) || !plain(right)) return [left, right];
  const a = contentPackageSettings(before) as Json;
  const b = contentPackageSettings(after) as Json;
  return [
    { ...left, package: { ...(left.package as Json), ...ownerSettings(a, b) } },
    { ...right, package: { ...(right.package as Json), ...ownerSettings(b, a) } },
  ];
}

export function contentPackageSettings(model: unknown) {
  const pkg = plain(model) && plain(model.package) ? model.package : {};
  const { portraitImageId, modules, loreActivation, imageHandoff } = pkg;
  return { portraitImageId, modules, loreActivation, imageHandoff };
}

export function recordHelperResourceChange(
  store: Store,
  task: ChangeTask,
  kind: ResourceKind,
  id: string,
  before: SavedResource | null,
  after: SavedResource | null
) {
  const title = resourceTitle(after ?? before!);
  storeChange(
    store,
    task,
    { domain: 'resource', targetId: `${kind}:${id}`, chatId: null },
    null,
    {
      before: before && after ? editableResource(kind, before) : null,
      beforeHash: before && helperResourceHash(kind, before),
      afterHash: after && helperResourceHash(kind, after),
    },
    (baseline) =>
      resourceEntries(
        kind,
        id,
        title,
        after ? baseline : {},
        after && editableResource(kind, after)
      )
  );
}

function sceneNumber(store: Store, chatId: string, sourceId: string): number | null {
  let number = 0;
  for (const item of store.history(store.chat(chatId).headRevision)) {
    const enabled = item.sceneContext?.sceneEnabled !== false;
    if (enabled) number++;
    if (item.revision === sourceId) return enabled ? number : null;
  }
  return null;
}

export function helperTargetHash(target: HelperChangeTarget, value: unknown) {
  if (target.domain === 'notes')
    return helperStateHash(
      (value as NoteState).map((note) => JSON.stringify([note.kind, note.text])).sort()
    );
  if (target.domain !== 'outline') return helperStateHash(value);
  const nodes = value as OutlineState;
  const paths = new Map<string, number[]>();
  const path = (id: string, seen = new Set<string>()): number[] => {
    const known = paths.get(id);
    if (known) return known;
    const node = nodes.find((item) => item.id === id);
    if (!node || seen.has(id)) return [];
    seen.add(id);
    const found = [...(node.parentId ? path(node.parentId, seen) : []), node.position];
    paths.set(id, found);
    return found;
  };
  return helperStateHash(
    nodes
      .map((node) =>
        JSON.stringify([
          path(node.id),
          node.level,
          node.title,
          node.intent,
          node.fixed,
          (node.relatedIds ?? []).map((id) => path(id)).sort(),
        ])
      )
      .sort()
  );
}

export function helperResourceHash(kind: ResourceKind, saved: SavedResource) {
  const model = editableResource(kind, saved);
  return helperStateHash(
    kind === 'content'
      ? { view: authoredView(kind, model), settings: contentPackageSettings(model) }
      : model
  );
}

export function captureHelperTarget(store: Store, target: HelperChangeTarget): Capture {
  const title = store.chat(target.chatId).title;
  if (target.domain === 'scene') {
    const source = store.source(target.sourceId);
    const scene = sceneNumber(store, target.chatId, target.sourceId);
    if (target.field === 'title')
      return { value: sceneTitle(store, source.id) || null, label: { title, scene } };
    if (target.field === 'original') return { value: source.text, label: { title, scene } };
    const latest = latestTranslation(store, source.id);
    const shown = latest ? displayTranslationJob(source, latest)?.result?.text : undefined;
    return { value: typeof shown === 'string' ? shown : null, label: { title, scene } };
  }
  if (target.domain === 'outline')
    return {
      value: store.outline.nodes(target.chatId).map((node) => ({
        id: node.id,
        parentId: node.parentId,
        level: node.level,
        position: node.position,
        title: node.title,
        intent: node.intent,
        fixed: node.fixed,
        relatedIds: node.relatedIds ?? [],
      })) satisfies OutlineState,
      label: { title },
    };
  const notes = store.story.notes;
  return {
    value: notes
      .entries(notes.scope(target.chatId, store.chat(target.chatId).headRevision))
      .map((note) => ({ id: note.id, kind: note.kind, text: note.text })) satisfies NoteState,
    label: { title },
  };
}

function sceneEntries(
  target: Extract<HelperChangeTarget, { domain: 'scene' }>,
  baseline: unknown,
  after: Capture
): HelperChange[] {
  const before = typeof baseline === 'string' ? baseline : null;
  const current = typeof after.value === 'string' ? after.value : null;
  if (before === current) return [];
  const diff = diffText(before ?? '', current ?? '', 'prose');
  return [
    {
      domain: 'scene',
      targetId: `${target.sourceId}:${target.field}`,
      title: after.label.title,
      location: { kind: 'scene', scene: after.label.scene ?? null, field: target.field },
      action: before === null ? 'create' : current === null ? 'delete' : 'update',
      diff,
      anchor: {
        domain: 'scene',
        chatId: target.chatId,
        sourceId: target.sourceId,
        field: target.field,
        paragraph: target.field === 'title' ? null : firstChangedParagraph(diff, current ?? ''),
      },
    },
  ];
}

function outlineEntries(
  chatId: string,
  title: string,
  baseline: OutlineState,
  after: OutlineState
): HelperChange[] {
  const entries: HelperChange[] = [];
  const before = new Map(baseline.map((node) => [node.id, node]));
  const current = new Map(after.map((node) => [node.id, node]));
  const push = (
    node: OutlineState[number],
    action: HelperChange['action'],
    field: 'title' | 'intent' | null,
    diff: TextDiff | null,
    present = true
  ) =>
    entries.push({
      domain: 'outline',
      targetId: chatId,
      title,
      location: { kind: 'outline', level: node.level, title: shortName(node.title), field },
      action,
      diff,
      anchor: present ? { domain: 'outline', chatId, nodeId: node.id, field } : null,
    });
  const order = (nodes: OutlineState) =>
    nodes.filter((node) => before.has(node.id) && current.has(node.id)).map((node) => node.id);
  const related = (node: OutlineState[number], nodes: Map<string, OutlineState[number]>) =>
    (node.relatedIds ?? []).map((id) => `${nodes.get(id)?.title ?? id}\n`).join('');
  const kept = new Set<string>();
  const script = alignSequences(order(baseline), order(after));
  if (script) {
    let x = 0;
    const ids = order(baseline);
    for (const step of script) {
      if (step === 'equal') kept.add(ids[x]!);
      if (step !== 'insert') x++;
    }
  }
  for (const node of after) {
    const old = before.get(node.id);
    if (!old) {
      push(node, 'create', null, diffText('', `${node.title}\n${node.intent}`, 'prose'));
      continue;
    }
    for (const field of ['title', 'intent'] as const)
      if (old[field] !== node[field])
        push(node, 'update', field, diffText(old[field], node[field], 'prose'));
    if (old.fixed !== node.fixed)
      push(
        node,
        'update',
        null,
        diffText(`fixed: ${old.fixed}\n`, `fixed: ${node.fixed}\n`, 'code')
      );
    if (old.level !== node.level)
      push(
        node,
        'update',
        null,
        diffText(`level: ${old.level}\n`, `level: ${node.level}\n`, 'code')
      );
    if (!isDeepStrictEqual(old.relatedIds ?? [], node.relatedIds ?? []))
      push(node, 'update', null, diffText(related(old, before), related(node, current), 'code'));
    if (
      old.parentId !== node.parentId ||
      old.position !== node.position ||
      (script && !kept.has(node.id))
    )
      push(node, 'reorder', null, null);
  }
  for (const node of baseline)
    if (!current.has(node.id))
      push(node, 'delete', null, diffText(`${node.title}\n${node.intent}`, '', 'prose'), false);
  return entries;
}

function noteEntries(
  store: Store,
  chatId: string,
  title: string,
  baseline: NoteState,
  after: NoteState
): HelperChange[] {
  const before = new Map(baseline.map((note) => [note.id, note]));
  const replaces = new Map(
    store.db
      .prepare(
        'SELECT id,replaces_id FROM author_notes WHERE chat_id=? AND replaces_id IS NOT NULL'
      )
      .all(chatId)
      .map((row) => [String(row.id), String(row.replaces_id)])
  );
  const entries: HelperChange[] = [];
  const matched = new Set<string>();
  const label = (note: NoteState[number]): HelperChangeLocation => ({
    kind: 'note',
    noteKind: note.kind,
    text: shortName(note.text.replace(/\s+/gu, ' ').trim()),
  });
  for (const note of after) {
    let origin: string | undefined = note.id;
    const seen = new Set<string>();
    while (origin && !before.has(origin) && !seen.has(origin)) {
      seen.add(origin);
      origin = replaces.get(origin);
    }
    const old = origin ? before.get(origin) : undefined;
    if (old) matched.add(old.id);
    if (old?.text === note.text) continue;
    entries.push({
      domain: 'notes',
      targetId: chatId,
      title,
      location: label(note),
      action: old ? 'update' : 'create',
      diff: diffText(old?.text ?? '', note.text, 'prose'),
      anchor: { domain: 'notes', chatId, noteId: note.id },
    });
  }
  for (const note of baseline)
    if (!matched.has(note.id))
      entries.push({
        domain: 'notes',
        targetId: chatId,
        title,
        location: label(note),
        action: 'delete',
        diff: diffText(note.text, '', 'prose'),
        anchor: null,
      });
  return entries;
}

export function withHelperChange<T>(
  store: Store,
  task: ChangeTask | undefined,
  target: HelperChangeTarget,
  mutate: () => T
): T {
  if (!task) return mutate();
  const companion: HelperChangeTarget | null =
    target.domain === 'scene' && target.field === 'original'
      ? { ...target, field: 'translation' }
      : null;
  const before = captureHelperTarget(store, target);
  const companionBefore = companion && captureHelperTarget(store, companion);
  const result = mutate();
  const after = captureHelperTarget(store, target);
  storeChange(
    store,
    task,
    changeKey(target),
    target.domain === 'scene' ? target.sourceId : null,
    {
      before: before.value,
      beforeHash: helperTargetHash(target, before.value),
      afterHash: helperTargetHash(target, after.value),
    },
    (baseline) =>
      target.domain === 'scene'
        ? sceneEntries(target, baseline, after)
        : target.domain === 'outline'
          ? outlineEntries(
              target.chatId,
              after.label.title,
              baseline as OutlineState,
              after.value as OutlineState
            )
          : noteEntries(
              store,
              target.chatId,
              after.label.title,
              baseline as NoteState,
              after.value as NoteState
            )
  );
  if (companion && companionBefore)
    storeChange(
      store,
      task,
      changeKey(companion),
      companion.domain === 'scene' ? companion.sourceId : null,
      {
        before: companionBefore.value,
        beforeHash: helperStateHash(companionBefore.value),
        afterHash: helperStateHash(captureHelperTarget(store, companion).value),
      },
      'companion'
    );
  return result;
}

function changeKey(target: HelperChangeTarget): Key {
  return target.domain === 'scene'
    ? { domain: 'scene', targetId: `${target.sourceId}:${target.field}`, chatId: target.chatId }
    : { domain: target.domain, targetId: target.chatId, chatId: target.chatId };
}

export function recordHelperAction(
  store: Store,
  task: ChangeTask,
  change: {
    domain: 'settings' | 'chat-lore';
    targetId: string;
    chatId: string | null;
    title: string;
    location: HelperChangeLocation;
    action: HelperChange['action'];
    anchor: HelperChangeAnchor;
    value?: { before: unknown; after: unknown };
    diff?: TextDiff | null;
  }
) {
  storeChange(
    store,
    task,
    { domain: change.domain, targetId: change.targetId, chatId: change.chatId },
    null,
    {
      before: change.value ? { value: change.value.before } : null,
      beforeHash: null,
      afterHash: null,
    },
    (baseline) =>
      change.value && isDeepStrictEqual(baseline, { value: change.value.after })
        ? []
        : [
            {
              domain: change.domain,
              targetId: change.targetId,
              title: change.title,
              location: change.location,
              action: change.action,
              diff: change.diff ?? null,
              anchor: change.anchor,
            },
          ]
  );
}

export function recordHelperChatLoreChange(
  store: Store,
  task: ChangeTask,
  chatId: string,
  prior: ChatLoreOverride | undefined,
  saved: ChatLoreOverride
) {
  recordHelperAction(store, task, {
    domain: 'chat-lore',
    targetId: chatLoreKey(saved.selector),
    chatId,
    title: store.chat(chatId).title,
    location: { kind: 'chat-lore' },
    action: saved.retired ? 'delete' : 'update',
    anchor: { domain: 'chat-lore', chatId, overrideId: saved.id },
    value: {
      before: prior && !prior.retired ? prior.value : saved.baseValue,
      after: saved.retired ? saved.baseValue : saved.value,
    },
  });
}

function releaseBaselineFiles(db: DatabaseSync, rows: Record<string, unknown>[]) {
  queueImageCleanup(
    db,
    rows.flatMap((row) => imageDataHashes(row.baseline))
  );
  const themeAssets = rows.flatMap((row) =>
    String(row.target_id).startsWith('theme:') && typeof row.baseline === 'string'
      ? themeAssetHashes(JSON.parse(row.baseline))
      : []
  );
  if (themeAssets.length) pruneThemeAssets(db, themeAssets);
}

function redact(db: DatabaseSync, where: string, values: string[], reason: 'deleted' | 'expired') {
  const rows = db
    .prepare(
      `SELECT task_id,domain,target_id,baseline,entries FROM helper_changes WHERE text_removed IS NULL AND (${where})`
    )
    .all(...values);
  const update = db.prepare(
    'UPDATE helper_changes SET baseline=NULL,entries=?,text_removed=? WHERE task_id=? AND domain=? AND target_id=?'
  );
  for (const row of rows) {
    const entries = (JSON.parse(String(row.entries)) as HelperChange[]).map(
      ({ domain, targetId, title, action }) => ({
        domain,
        targetId,
        title,
        location: null,
        action,
        diff: null,
        anchor: null,
        textRemoved: reason,
      })
    );
    update.run(JSON.stringify(entries), reason, row.task_id, row.domain, row.target_id);
  }
  releaseBaselineFiles(db, rows);
}

function forget(db: DatabaseSync, where: string, values: string[]) {
  const rows = db
    .prepare(`SELECT target_id,baseline FROM helper_changes WHERE ${where}`)
    .all(...values);
  db.prepare(`DELETE FROM helper_changes WHERE ${where}`).run(...values);
  releaseBaselineFiles(db, rows);
}

export function pruneHelperChanges(db: DatabaseSync, conversationId?: string, now = Date.now()) {
  const cutoff = new Date(now - HELPER_CHANGE_RETENTION.days * 86_400_000).toISOString();
  redact(
    db,
    `updated_at < ? OR task_id IN (SELECT id FROM (SELECT id,row_number() OVER (
      PARTITION BY conversation_id ORDER BY rowid DESC) AS turn FROM helper_tasks
      ${conversationId ? 'WHERE conversation_id=?' : ''}) WHERE turn > ${HELPER_CHANGE_RETENTION.turns})`,
    conversationId ? [cutoff, conversationId] : [cutoff],
    'expired'
  );
}

export function forgetHelperResourceChanges(db: DatabaseSync, kind: ResourceKind, id: string) {
  redact(db, "domain='resource' AND target_id=?", [`${kind}:${id}`], 'deleted');
}

export function forgetHelperSceneChanges(db: DatabaseSync, sourceIds: Iterable<string>) {
  redact(
    db,
    'source_id IN (SELECT value FROM json_each(?))',
    [JSON.stringify([...sourceIds])],
    'deleted'
  );
}

export function forgetHelperChatChanges(db: DatabaseSync, chatId: string) {
  forget(
    db,
    `chat_id=? OR task_id IN (SELECT t.id FROM helper_tasks t
      JOIN helper_conversations c ON c.id=t.conversation_id WHERE c.chat_id=?)`,
    [chatId, chatId]
  );
}

export function forgetHelperConversationChanges(db: DatabaseSync, conversationId: string) {
  forget(db, 'task_id IN (SELECT id FROM helper_tasks WHERE conversation_id=?)', [conversationId]);
}

function boundDiffs(entries: HelperChange[], characters: number): HelperChange[] {
  let budget = characters;
  return entries.map((entry) => {
    const diff = entry.diff;
    if (!diff || 'omitted' in diff) return entry;
    const size = diff.hunks.reduce(
      (sum, hunk) => sum + hunk.segments.reduce((total, part) => total + part.text.length, 0),
      0
    );
    if (size > budget)
      return { ...entry, diff: { mode: diff.mode, unit: diff.unit, omitted: 'size' as const } };
    budget -= size;
    return entry;
  });
}

export function readHelperChanges(db: DatabaseSync, taskId: string): HelperChange[] {
  return boundDiffs(
    db
      .prepare('SELECT entries FROM helper_changes WHERE task_id=? ORDER BY position')
      .all(taskId)
      .flatMap((row) => JSON.parse(String(row.entries)) as HelperChange[]),
    RESPONSE_DIFF_CHARS
  );
}
