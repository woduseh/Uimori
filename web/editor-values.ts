import {
  alignSequences,
  diffText,
  TEXT_DIFF_LIMITS,
  type TextDiff,
  type TextDiffLimits,
} from '../core/text-diff.js';

export function sameEditorValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) return false;
    for (let i = 0; i < left.length; i++)
      if (!sameEditorValue(left[i] ?? null, right[i] ?? null)) return false;
    return true;
  }
  if (Array.isArray(right)) return false;
  const before = left as Record<string, unknown>;
  const after = right as Record<string, unknown>;
  const keys = Object.keys(before).filter((key) => before[key] !== undefined);
  return (
    keys.length === Object.keys(after).filter((key) => after[key] !== undefined).length &&
    keys.every((key) => Object.hasOwn(after, key) && sameEditorValue(before[key], after[key]))
  );
}

const container = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object';
const pointer = (key: string) => key.replaceAll('~', '~0').replaceAll('/', '~1');

export function changedValuePaths(left: unknown, right: unknown, path = ''): string[] {
  if (sameEditorValue(left, right)) return [];
  if (!container(left) || !container(right) || Array.isArray(left) !== Array.isArray(right))
    return [path];
  const lists = Array.isArray(left) && Array.isArray(right);
  const keys = lists
    ? Array.from({ length: Math.max(left.length, right.length) }, (_, index) => String(index))
    : [...new Set([...Object.keys(left), ...Object.keys(right)])];
  const paths = keys.flatMap((key) =>
    changedValuePaths(
      lists ? (left[Number(key)] ?? null) : left[key],
      lists ? (right[Number(key)] ?? null) : right[key],
      `${path}/${pointer(key)}`
    )
  );
  return paths.length ? paths : [path];
}

export type EditorListKind =
  | 'lore'
  | 'greetings'
  | 'regex'
  | 'triggers'
  | 'prompt'
  | 'terms'
  | 'images';
export type EditorChangeKind = 'changed' | 'added' | 'removed' | 'moved';
export type EditorListItem = { kind: EditorListKind; value: unknown; index: number };
export type EditorFieldChange = {
  path: string;
  item: EditorListItem | null;
  field: string[];
  kind: EditorChangeKind;
  before: unknown;
  after: unknown;
};

const LIST_PATHS: readonly [RegExp, EditorListKind][] = [
  [/\/(character_book\/entries|lorebook)$/u, 'lore'],
  [/\/card\/alternate_greetings$/u, 'greetings'],
  [/\/(customScripts|regex|presetRegex)$/u, 'regex'],
  [/\/(triggerscript|trigger)$/u, 'triggers'],
  [/\/promptTemplate$/u, 'prompt'],
  [/\/translationGuide\/terms$/u, 'terms'],
  [/^\/package\/images$/u, 'images'],
];
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const listKind = (path: string) => LIST_PATHS.find(([pattern]) => pattern.test(path))?.[1] ?? null;
const itemId = (item: unknown) =>
  record(item) && (typeof item.id === 'string' || typeof item.id === 'number')
    ? `${typeof item.id}:${item.id}`
    : null;

export function editorItemName(item: unknown): string {
  if (typeof item === 'string') return '';
  if (!record(item)) return '';
  for (const candidate of [item.comment, item.name, item.title, item.source, item.key, item.keys]) {
    const value = Array.isArray(candidate) ? candidate[0] : candidate;
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function idPairs(before: readonly unknown[], after: readonly unknown[]) {
  const index = (items: readonly unknown[]) => {
    const ids = new Map<string, number>();
    for (const [position, item] of items.entries()) {
      const id = itemId(item);
      if (id === null || ids.has(id)) return null;
      ids.set(id, position);
    }
    return ids;
  };
  const left = index(before);
  const right = index(after);
  if (!left || !right || (!left.size && !right.size)) return null;
  const pairs: [number, number][] = [];
  for (const [id, position] of right) {
    const match = left.get(id);
    if (match !== undefined) pairs.push([match, position]);
  }
  const matched = new Set(pairs.map(([from]) => from));
  const taken = new Set(pairs.map(([, to]) => to));
  const order = alignSequences(
    pairs.toSorted((a, b) => a[0] - b[0]).map(([from]) => String(from)),
    pairs.map(([from]) => String(from))
  );
  const moved: [number, number][] = [];
  if (order) {
    let cursor = 0;
    for (const step of order) {
      if (step === 'insert') moved.push(pairs[cursor]!);
      if (step !== 'delete') cursor++;
    }
  }
  return {
    pairs,
    moved,
    removed: before.map((_, position) => position).filter((position) => !matched.has(position)),
    added: after.map((_, position) => position).filter((position) => !taken.has(position)),
  };
}

function contentPairs(before: readonly unknown[], after: readonly unknown[]) {
  const keysBefore = before.map((item) => JSON.stringify(item ?? null));
  const keysAfter = after.map((item) => JSON.stringify(item ?? null));
  const script = alignSequences(keysBefore, keysAfter);
  const gaps: { removed: number[]; added: number[] }[] = [];
  if (!script) {
    const shared = Math.min(before.length, after.length);
    gaps.push(
      ...Array.from({ length: shared }, (_, position) => ({
        removed: [position],
        added: [position],
      })),
      {
        removed: before.map((_, position) => position).slice(shared),
        added: after.map((_, position) => position).slice(shared),
      }
    );
  } else {
    let x = 0;
    let y = 0;
    let gap: (typeof gaps)[number] | null = null;
    for (const step of script) {
      if (step === 'equal') {
        x++;
        y++;
        gap = null;
        continue;
      }
      if (!gap) gaps.push((gap = { removed: [], added: [] }));
      if (step === 'delete') gap.removed.push(x++);
      else gap.added.push(y++);
    }
  }
  const waiting = new Map<string, number[]>();
  for (const gap of gaps)
    for (const position of gap.removed) {
      const key = keysBefore[position]!;
      waiting.set(key, [...(waiting.get(key) ?? []), position]);
    }
  const movedFrom = new Map<number, number>();
  for (const gap of gaps)
    for (const position of gap.added) {
      const from = waiting.get(keysAfter[position]!)?.shift();
      if (from !== undefined) movedFrom.set(position, from);
    }
  const movedSources = new Set(movedFrom.values());
  const pairs: [number, number][] = [];
  const removed: number[] = [];
  const added: number[] = [];
  const named = new Map<string, number[]>();
  for (const gap of gaps)
    for (const position of gap.removed) {
      const name = editorItemName(before[position]);
      if (name && !movedSources.has(position))
        named.set(name, [...(named.get(name) ?? []), position]);
    }
  const pairedFrom = new Set<number>();
  const pairedTo = new Set<number>();
  for (const gap of gaps)
    for (const position of gap.added) {
      if (movedFrom.has(position)) continue;
      const from = named.get(editorItemName(after[position]))?.shift();
      if (from === undefined) continue;
      pairs.push([from, position]);
      pairedFrom.add(from);
      pairedTo.add(position);
    }
  for (const gap of gaps) {
    const left = gap.removed.filter(
      (position) => !movedSources.has(position) && !pairedFrom.has(position)
    );
    const right = gap.added.filter(
      (position) => !movedFrom.has(position) && !pairedTo.has(position)
    );
    while (left.length && right.length) pairs.push([left.shift()!, right.shift()!]);
    removed.push(...left);
    added.push(...right);
  }
  const moved = [...movedFrom].map(([to, from]): [number, number] => [from, to]);
  return { pairs, moved, removed, added };
}

export function editorFieldChanges(before: unknown, after: unknown): EditorFieldChange[] {
  const changes: (EditorFieldChange & { order: number })[] = [];
  const push = (change: EditorFieldChange, order: number) => changes.push({ ...change, order });
  const walk = (
    left: unknown,
    right: unknown,
    path: string,
    item: EditorListItem | null,
    field: string[],
    order: number
  ) => {
    if (sameEditorValue(left, right)) return;
    const kind = item ? null : listKind(path);
    if (kind && (Array.isArray(left) || left == null) && (Array.isArray(right) || right == null)) {
      compareList((left ?? []) as unknown[], (right ?? []) as unknown[], path, kind, order);
      return;
    }
    if (
      (record(left) || left === undefined) &&
      (record(right) || right === undefined) &&
      (record(left) || record(right))
    ) {
      const a = (left ?? {}) as Record<string, unknown>;
      const b = (right ?? {}) as Record<string, unknown>;
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)]))
        walk(a[key], b[key], `${path}/${pointer(key)}`, item, [...field, key], order);
      return;
    }
    push(
      {
        path,
        item,
        field,
        kind: left === undefined ? 'added' : right === undefined ? 'removed' : 'changed',
        before: left,
        after: right,
      },
      order
    );
  };
  const compareList = (
    left: unknown[],
    right: unknown[],
    path: string,
    kind: EditorListKind,
    order: number
  ) => {
    const entry = (value: unknown, index: number) => ({ kind, value, index });
    const found = idPairs(left, right) ?? contentPairs(left, right);
    for (const [from, to] of found.pairs)
      walk(left[from], right[to], `${path}/${to}`, entry(right[to], to), [], order + to);
    for (const [from, to] of found.moved)
      push(
        {
          path: `${path}/${to}`,
          item: entry(right[to], to),
          field: [],
          kind: 'moved',
          before: left[from],
          after: right[to],
        },
        order + to
      );
    for (const from of found.removed)
      push(
        {
          path: `${path}/${from}`,
          item: entry(left[from], from),
          field: [],
          kind: 'removed',
          before: left[from],
          after: undefined,
        },
        order + from
      );
    for (const to of found.added)
      push(
        {
          path: `${path}/${to}`,
          item: entry(right[to], to),
          field: [],
          kind: 'added',
          before: undefined,
          after: right[to],
        },
        order + to
      );
  };
  walk(before, after, '', null, [], 0);
  return changes
    .map((change, position) => ({ change, position }))
    .sort((a, b) => a.change.order - b.change.order || a.position - b.position)
    .map(({ change: { order: _order, ...change } }) => change);
}

export type EditorChangeView =
  | { type: 'text'; diff: TextDiff }
  | { type: 'value'; before: unknown; after: unknown }
  | { type: 'summary'; before: number | null; after: number | null }
  | { type: 'none' };

const CODE_PATH =
  /\/(customScripts|regex|presetRegex|triggerscript|trigger|lua|css|backgroundHTML|backgroundEmbedding|defaultVariables|templateDefaultVariables|customModuleToggle|customPromptTemplateToggle|toggles)(\/|$)/u;
const SUMMARY_PATH = /^\/package\/images(\/|$)|\/(assets|emotions)(\/|$)/u;
const textual = (value: unknown) =>
  value === undefined || (typeof value === 'string' && !value.startsWith('data:'));
const ITEM_BODY: Partial<Record<EditorListKind, string>> = {
  lore: 'content',
  prompt: 'text',
  terms: 'target',
  regex: 'out',
};
const scalar = (value: unknown) =>
  value === undefined || value === null || typeof value !== 'object';
const json = (value: unknown) => (value === undefined ? '' : `${JSON.stringify(value, null, 2)}\n`);

export function editorChangeView(
  change: EditorFieldChange,
  limits: TextDiffLimits = TEXT_DIFF_LIMITS
): EditorChangeView {
  const { before, after, kind, item, path } = change;
  if (kind === 'moved') return { type: 'none' };
  const binary = (value: unknown) => typeof value === 'string' && !textual(value);
  if (
    (SUMMARY_PATH.test(path) && !(textual(before) && textual(after))) ||
    binary(before) ||
    binary(after)
  ) {
    if (item && !change.field.length) return { type: 'none' };
    const count = (value: unknown) => (Array.isArray(value) ? value.length : null);
    return { type: 'summary', before: count(before), after: count(after) };
  }
  const text = (left: string, right: string) => {
    return {
      type: 'text' as const,
      diff: diffText(left, right, CODE_PATH.test(path) ? 'code' : 'prose', limits),
    };
  };
  if (item && !change.field.length && kind !== 'changed') {
    const value = kind === 'added' ? after : before;
    const key = ITEM_BODY[item.kind];
    const body = item.kind === 'greetings' ? value : record(value) && key ? value[key] : undefined;
    if (typeof body !== 'string' || !body) return { type: 'none' };
    return kind === 'added' ? text('', body) : text(body, '');
  }
  if (textual(before) && textual(after))
    return text((before as string | undefined) ?? '', (after as string | undefined) ?? '');
  if (scalar(before) && scalar(after)) return { type: 'value', before, after };
  return { type: 'text', diff: diffText(json(before), json(after), 'code', limits) };
}
