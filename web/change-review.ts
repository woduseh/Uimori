import { useEffect, useRef, useState } from 'react';
import { NATIVE_PREFIX, listItemFieldLabels } from './helper-change-location.js';
import { formatNumber, t } from './i18n.js';
import { codeFieldName } from './code-field-reveal.js';
import {
  editorChangeView,
  editorFieldChanges,
  editorItemName,
  type EditorChangeKind,
  type EditorChangeView,
  type EditorFieldChange,
  type EditorListItem,
  type EditorListKind,
} from './editor-values.js';
import { promptBlockTypeLabels, type ChangedSection } from './studio-sections.js';
import { firstChangeOffset } from './text-diff-rows.js';

export type LabelPart = { text: string; identifier?: boolean };
export type ReviewCard<K extends string> = {
  id: string;
  section: K;
  change: EditorFieldChange;
  related: EditorFieldChange[];
  label: LabelPart[];
  name: string;
  badge: string | null;
  view: EditorChangeView;
  added: number;
  removed: number;
};
export type ReviewSection<K extends string> = ChangedSection<K> & { cards: ReviewCard<K>[] };
export type ReviewTotals = { sections: number; items: number; added: number; removed: number };
export type ChangeTarget<K extends string> = {
  section: K;
  item: number | null;
  field: string | null;
  offset: number | null;
};

const fieldLabels: Partial<Record<EditorListKind, Record<string, string>>> = {
  ...listItemFieldLabels,
  regex: {
    comment: 'native.text_9aa18e5071',
    type: 'native.text_81c4f73cf0',
    in: 'native.text_6b5f44ef65',
    out: 'native.text_dce02ee0f0',
    ableFlag: 'native.text_3debd57307',
    flag: 'native.text_ce80b34836',
  },
  triggers: { comment: 'native.text_9aa18e5071' },
};
const topFields: Record<string, string> = {
  '/title': 'visualpanels.name',
  '/description': 'visualpanels.description',
  '/package/nativeRisu/card/name': 'native.text_9aa18e5071',
  '/package/nativeRisu/module/name': 'native.text_9aa18e5071',
  '/package/nativeRisu/card/description': 'native.text_08117feaa5',
  '/package/nativeRisu/module/description': 'native.text_9e7348ca61',
  '/package/nativeRisu/card/first_mes': 'native.text_104a1f537a',
};
const badges: Partial<Record<EditorChangeKind, string>> = {
  added: 'shared.changeAdded',
  removed: 'helperResults.deleted',
  moved: 'helperChanges.reordered',
};
const CODE_FIELDS: Record<string, readonly string[]> = {
  basic: ['description'],
  greetings: ['first_mes', 'alternate_greetings'],
  instructions: ['post_history_instructions', 'mes_example'],
  lore: ['content'],
  display: ['backgroundHTML', 'backgroundEmbedding'],
  regex: ['in', 'out'],
  blocks: ['text', 'innerFormat', 'defaultText'],
};
const ITEM_BODY: Partial<Record<EditorListKind, string>> = {
  lore: 'content',
  prompt: 'text',
  regex: 'in',
};

function itemLabel(item: EditorListItem): string {
  const name = editorItemName(item.value);
  const number = `#${formatNumber(item.index + 1)}`;
  switch (item.kind) {
    case 'greetings':
      return t('native.alternateMessage', { number: item.index + 1 });
    case 'lore':
      return name || t('native.unnamedLore');
    case 'regex':
      return name || t('native.regexFallbackName');
    case 'prompt': {
      const value = item.value as { type?: unknown } | null;
      const type = typeof value?.type === 'string' ? value.type : '';
      return name || promptBlockTypeLabels()[type] || type || number;
    }
    default:
      return name || number;
  }
}

export function changeLabel(change: EditorFieldChange): LabelPart[] {
  if (change.item) {
    const parts: LabelPart[] = [{ text: itemLabel(change.item) }];
    const [field] = change.field;
    if (field !== undefined) {
      const key = fieldLabels[change.item.kind]?.[field];
      parts.push(
        key && change.field.length === 1
          ? { text: t(key) }
          : { text: change.field.join('/'), identifier: true }
      );
    }
    return parts;
  }
  const known = topFields[change.path];
  if (known) return [{ text: t(known) }];
  const relative = change.path.replace(NATIVE_PREFIX, '').split('/').filter(Boolean);
  return [{ text: relative.join('/') || '/', identifier: true }];
}

const NATIVE_NAME = /^\/package\/nativeRisu\/(card|module)\/name$/u;
const NATIVE_NOTES = /^\/package\/nativeRisu\/(card\/creator_notes|module\/description)$/u;
const NATIVE_BODY = /^\/package\/nativeRisu\/card\/description$/u;
const NATIVE_GREETINGS = /^\/package\/nativeRisu\/card\/(first_mes|alternate_greetings)(\/|$)/u;
const NATIVE_LORE = /^\/package\/nativeRisu\/(card\/character_book|module\/lorebook)(\/|$)/u;
const NATIVE_DEFAULTS =
  /^\/package\/nativeRisu\/(card\/extensions\/risuai|module)\/defaultVariables(\/|$)/u;

const CONTENT_MIRRORS: readonly { mirror: string; source: RegExp }[] = [
  { mirror: '/title', source: NATIVE_NAME },
  { mirror: '/package/title', source: NATIVE_NAME },
  { mirror: '/package/identity/name', source: NATIVE_NAME },
  { mirror: '/description', source: NATIVE_NOTES },
  { mirror: '/package/description', source: NATIVE_NOTES },
  { mirror: '/text', source: NATIVE_BODY },
  { mirror: '/package/body', source: NATIVE_BODY },
  { mirror: '/package/starts', source: NATIVE_GREETINGS },
  { mirror: '/package/lore', source: NATIVE_LORE },
  { mirror: '/package/variableDefaults', source: NATIVE_DEFAULTS },
];

const mirrorOf = (path: string) =>
  CONTENT_MIRRORS.find(({ mirror }) => path === mirror || path.startsWith(`${mirror}/`));

function mirrorSources(changes: readonly EditorFieldChange[]) {
  const sources = new Map<EditorFieldChange, EditorFieldChange>();
  for (const change of changes) {
    const rule = mirrorOf(change.path);
    const source =
      rule &&
      changes.find(
        (other) => other !== change && !mirrorOf(other.path) && rule.source.test(other.path)
      );
    if (source) sources.set(change, source);
  }
  return sources;
}

export function reviewSections<K extends string>(
  sections: readonly ChangedSection<K>[],
  changes: readonly EditorFieldChange[],
  sectionOf: (path: string) => K
): ReviewSection<K>[] {
  const sources = mirrorSources(changes);
  const related = new Map<EditorFieldChange, EditorFieldChange[]>();
  const groups = new Map<K, EditorFieldChange[]>();
  for (const change of changes) {
    const source = sources.get(change);
    if (source) {
      related.set(source, [...(related.get(source) ?? []), change]);
      continue;
    }
    const id = sectionOf(change.path);
    groups.set(id, [...(groups.get(id) ?? []), change]);
  }
  return sections.map((section) => {
    const shown = groups.get(section.id) ?? [];
    const ids = new Set<string>();
    const cards = shown.map((change): ReviewCard<K> => {
      const label = changeLabel(change);
      const view = editorChangeView(change);
      const diff = view.type === 'text' && !('omitted' in view.diff) ? view.diff : null;
      let id = `${section.id}:${change.kind}:${change.path}`;
      while (ids.has(id)) id += "'";
      ids.add(id);
      return {
        id,
        section: section.id,
        change,
        related: related.get(change) ?? [],
        label,
        name: label.map((part) => part.text).join(' / '),
        badge: badges[change.kind] ?? null,
        view,
        added: diff?.added ?? 0,
        removed: diff?.removed ?? 0,
      };
    });
    return { ...section, cards };
  });
}

export function reviewTotals(sections: readonly ReviewSection<string>[]): ReviewTotals {
  let items = 0;
  let added = 0;
  let removed = 0;
  for (const section of sections)
    for (const card of section.cards) {
      items++;
      added += card.added;
      removed += card.removed;
    }
  return { sections: sections.length, items, added, removed };
}

function changedEffect(before: unknown, after: unknown) {
  if (!Array.isArray(after)) return undefined;
  const old = Array.isArray(before) ? before : [];
  const index = after.findIndex(
    (effect, position) => JSON.stringify(effect) !== JSON.stringify(old[position])
  );
  return index < 0 ? undefined : String(index);
}

function targetField(change: EditorFieldChange): { item: number | null; field: string } {
  if (change.item) {
    const { kind, index } = change.item;
    if (kind === 'greetings') return { item: index + 1, field: 'alternate_greetings' };
    const [first, second] = change.field;
    if (first === undefined) return { item: index, field: ITEM_BODY[kind] ?? '' };
    if (kind === 'triggers' && first === 'effect') {
      const effect = second ?? changedEffect(change.before, change.after);
      if (effect !== undefined) return { item: index, field: `effect.${effect}` };
    }
    if (kind === 'regex' && (first === 'find' || first === 'replace'))
      return { item: index, field: first === 'find' ? 'in' : 'out' };
    return { item: index, field: first };
  }
  const key = change.path.split('/').at(-1) ?? '';
  return key === 'first_mes' ? { item: 0, field: key } : { item: null, field: key };
}

const isCodeField = (section: string, field: string) =>
  !!CODE_FIELDS[section]?.includes(field) ||
  (section === 'triggers' && /^effect\.\d+$/u.test(field));

export function changeTarget<K extends string>(card: ReviewCard<K>): ChangeTarget<K> {
  const { change, section, view } = card;
  if (change.kind === 'removed' && change.item && !change.field.length)
    return { section, item: null, field: null, offset: null };
  const { item, field } = targetField(change);
  const code = isCodeField(section, field);
  return {
    section,
    item,
    field: code ? field : null,
    offset:
      code && view.type === 'text' && 'hunks' in view.diff
        ? firstChangeOffset(view.diff.hunks)
        : null,
  };
}

const UNSAFE_REVERT = /^\/package\/(portraitImageId|images)(\/|$)|\/(assets|emotions)(\/|$)/u;

export function canRevert(card: ReviewCard<string>, section: ChangedSection<string>): boolean {
  return !section.pending && card.view.type !== 'summary' && !UNSAFE_REVERT.test(card.change.path);
}

function itemFieldNames(change: EditorFieldChange): string[] {
  const item = change.item!;
  if (item.kind === 'greetings') return [''];
  const value = change.after;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  const names = Object.keys(record).filter((key) => typeof record[key] === 'string');
  if (item.kind === 'triggers' && Array.isArray(record.effect))
    record.effect.forEach((effect, index) => {
      if (
        effect &&
        typeof effect === 'object' &&
        typeof (effect as { code?: unknown }).code === 'string'
      )
        names.push(`effect/${index}`);
    });
  return names;
}

const BASE_DELAY_MS = 300;

export function useCodeFieldBases(
  base: unknown,
  model: unknown,
  dirty: boolean,
  sectionOf: (path: string) => string
): ReadonlyMap<string, string> | null {
  const [bases, setBases] = useState<ReadonlyMap<string, string> | null>(null);
  const owner = useRef(sectionOf);
  owner.current = sectionOf;
  useEffect(() => {
    if (!dirty) {
      setBases(null);
      return;
    }
    const timer = setTimeout(
      () => setBases(codeFieldBases(editorFieldChanges(base, model), owner.current)),
      BASE_DELAY_MS
    );
    return () => clearTimeout(timer);
  }, [base, model, dirty]);
  return bases;
}

export function codeFieldBases(
  changes: readonly EditorFieldChange[],
  sectionOf: (path: string) => string
): Map<string, string> {
  const bases = new Map<string, string>();
  const remember = (change: EditorFieldChange, section: string, before: string) => {
    const { item, field } = targetField(change);
    if (isCodeField(section, field)) bases.set(codeFieldName(section, item, field), before);
  };
  for (const change of changes) {
    if (change.kind === 'removed' || change.kind === 'moved') continue;
    const section = sectionOf(change.path);
    if (change.item && !change.field.length && change.kind === 'added') {
      for (const name of itemFieldNames(change))
        remember({ ...change, field: name ? name.split('/') : [] }, section, '');
      continue;
    }
    if (
      change.item?.kind === 'triggers' &&
      change.field.length === 1 &&
      change.field[0] === 'effect'
    ) {
      const old = Array.isArray(change.before) ? change.before : [];
      const effects = Array.isArray(change.after) ? change.after : [];
      effects.forEach((effect, index) => {
        const code = (value: unknown) =>
          value && typeof value === 'object' ? (value as { code?: unknown }).code : undefined;
        if (typeof code(effect) === 'string' && code(effect) !== code(old[index]))
          bases.set(
            codeFieldName(section, change.item!.index, `effect.${index}`),
            typeof code(old[index]) === 'string' ? (code(old[index]) as string) : ''
          );
      });
      continue;
    }
    if (typeof change.after !== 'string') continue;
    remember(change, section, typeof change.before === 'string' ? change.before : '');
  }
  return bases;
}
