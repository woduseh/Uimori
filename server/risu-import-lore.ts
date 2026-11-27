import type { RisuContent } from '../core/risu-content.js';
import { RISU_IMPORT_MAX_LORE_ENTRIES, type RisuImportPreview } from '../core/risu-import.js';
import { record } from './request-validation.js';
import {
  convertCharbook,
  interpretLoreDecorators,
  type LoreDecorators,
  type RisuCharBookEntry,
} from './compat/risu/lorebook.js';
import { object, string, type RisuCard, type RisuCardLoreEntry } from './risu-import-card.js';
import type { RisuImportFindings } from './risu-import-findings.js';
import { AppError } from './app-errors.js';

type DecoratorNotice = 'position' | 'activation';
const DECORATOR_NOTICES = {
  end: 'position',
  depth: 'position',
  reverse_depth: 'position',
  role: 'position',
  position: 'position',
  inject_lore: 'position',
  inject_at: 'position',
  inject_replace: 'position',
  inject_prepend: 'position',
  activate: null,
  dont_activate: null,
  keep_activate_after_match: 'activation',
  dont_activate_after_match: 'activation',
  is_greeting: 'activation',
  instruct_depth: 'activation',
  is_user_icon: 'activation',
  disable_ui_prompt: 'activation',
  activate_only_after: 'activation',
  activate_only_every: 'activation',
  scan_depth: 'activation',
  additional_keys: 'activation',
  exclude_keys: 'activation',
  exclude_keys_all: 'activation',
  match_full_word: 'activation',
  match_partial_word: 'activation',
  probability: 'activation',
  priority: 'activation',
  ignore_on_max_context: 'activation',
  recursive: 'activation',
  unrecursive: 'activation',
  no_recursive_search: 'activation',
} satisfies Record<keyof LoreDecorators, DecoratorNotice | null>;
const NOTICES = {
  position: { level: 'unsupported', code: 'lore-decorator-placement' },
  activation: { level: 'info', code: 'lore-decorator-activation' },
} as const;
const MAX_UNKNOWN_DECORATORS = 20;
const MAX_UNKNOWN_DECORATOR_LENGTH = 40;
const MAX_PREVIEW_KEY_CHARS = 200;

const carries = (value: LoreDecorators[keyof LoreDecorators]) =>
  Array.isArray(value) ? value.length > 0 : value !== null && value !== false;

function reportedDecorators(decorators: LoreDecorators) {
  const found: { decorator: string; notice: DecoratorNotice }[] = [];
  for (const decorator of Object.keys(DECORATOR_NOTICES) as (keyof LoreDecorators)[]) {
    const notice = DECORATOR_NOTICES[decorator];
    if (notice === null || !carries(decorators[decorator])) continue;
    // https://github.com/kwaroran/RisuAI/blob/cad8595aa39620df4246f56918f0962c2aa0263a/src/ts/process/lorebook.svelte.ts#L302-L354 (2026-11-20):
    // `@@end` sets the same `pos` and `depth` locals as `@@depth`, to 'depth' and 0.
    if (decorator === 'depth' && decorators.end && decorators.depth === 0) continue;
    found.push({ decorator, notice });
  }
  return found;
}

const POSITION_DECORATORS = ['end', 'depth', 'reverse_depth', 'role'];

export function nativeLoreDecoratorReport(content: string) {
  const parsed = interpretLoreDecorators(content);
  const decorators = parsed.decorators;
  const depth = decorators.depth ?? decorators.reverse_depth ?? 0;
  const positioned =
    !decorators.position &&
    !decorators.inject_lore &&
    !decorators.inject_at &&
    (decorators.depth !== null || decorators.reverse_depth !== null || decorators.role !== null) &&
    Number.isSafeInteger(depth) &&
    depth >= 0 &&
    depth <= 1_000_000;
  return {
    parsed,
    positioned,
    notices: reportedDecorators(decorators)
      .filter(({ decorator }) => !(positioned && POSITION_DECORATORS.includes(decorator)))
      .map(({ decorator, notice }) => ({ decorator, ...NOTICES[notice] })),
    // https://github.com/kwaroran/ccardlib/blob/e9a4b49e9e2f551866b62e20d307b00241378244/src/decorators.ts#L7-L38 (2026-11-20):
    // parseDecorators stops at the first line that does not start with `@@` and returns that line
    // and everything after it, later `@@` lines included, as the body.
    inlineDirective: parsed.body.split('\n').some((line) => line.trim().startsWith('@@')),
  };
}

// https://github.com/kwaroran/RisuAI/blob/cad8595aa39620df4246f56918f0962c2aa0263a/src/ts/characterCards.ts#L1058-L1119 (2026-11-20):
// convertCharbook assigns `use_regex` and `selective` on each entry it is given and deletes the
// keys it migrates from that entry's `extensions` object.
function convertedLorebook(book: Record<string, unknown>, entries: RisuCardLoreEntry[]) {
  const strings = (value: unknown) =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  const number = (value: unknown) => (typeof value === 'number' ? value : undefined);
  return convertCharbook({
    lorebook: [],
    loresettings: undefined,
    loreExt: undefined,
    charbook: {
      extensions: { ...object(book.extensions) },
      // https://github.com/kwaroran/RisuAI/blob/cad8595aa39620df4246f56918f0962c2aa0263a/src/ts/characterCards.ts#L1045-L1054 (2026-11-20):
      // convertCharbook builds the book settings only when recursive_scanning, scan_depth and
      // token_budget are all present (neither null nor undefined).
      scan_depth: number(book.scan_depth),
      token_budget: number(book.token_budget),
      recursive_scanning:
        typeof book.recursive_scanning === 'boolean' ? book.recursive_scanning : undefined,
      entries: entries.map(
        (entry): RisuCharBookEntry => ({
          keys: strings(entry.keys),
          secondary_keys: strings(entry.secondary_keys),
          content: string(entry.content),
          extensions: { ...object(entry.extensions) },
          selective: entry.selective === true,
          use_regex: entry.use_regex === true,
          enabled: entry.enabled !== false,
          insertion_order: typeof entry.insertion_order === 'number' ? entry.insertion_order : 0,
          ...(typeof entry.mode === 'string' ? { mode: entry.mode } : {}),
        })
      ),
    },
  });
}

export function importRisuLore({
  card,
  findings,
}: {
  card: RisuCard;
  findings: RisuImportFindings;
}): {
  preview: RisuImportPreview['lore'];
  lore: RisuContent['lore'];
  loreActivation?: RisuContent['loreActivation'];
} {
  const book = object(card.character_book);
  const entries = book.entries === undefined ? [] : book.entries;
  if (!Array.isArray(entries) || entries.length > RISU_IMPORT_MAX_LORE_ENTRIES)
    throw new AppError(400, 'RISU_IMPORT_INVALID_FILE');
  const preview: RisuImportPreview['lore'] = [];
  const lore: RisuContent['lore'] = [];
  const read = entries.map((raw) => record(raw) as RisuCardLoreEntry);
  const converted = convertedLorebook(book, read);
  const unknown = new Set<string>();
  let activated = false;
  for (const [index, entry] of read.entries()) {
    const id = `lore-${index}`;
    const name = string(entry.name) || string(entry.comment) || `로어 ${index + 1}`;
    const source = converted.lorebook[index];
    const report = nativeLoreDecoratorReport(source.content);
    const parsed = report.parsed;
    const decorators = parsed.decorators;
    const nativeDepth = decorators.depth ?? decorators.reverse_depth ?? 0;
    const nativePosition = report.positioned
      ? {
          mode:
            decorators.depth !== null
              ? ('depth' as const)
              : decorators.reverse_depth !== null
                ? ('reverse_depth' as const)
                : ('lore' as const),
          depth: nativeDepth,
          role: decorators.role ?? ('system' as const),
          order:
            typeof entry.insertion_order === 'number' &&
            Number.isSafeInteger(entry.insertion_order) &&
            Math.abs(entry.insertion_order) <= 1_000_000
              ? entry.insertion_order
              : 0,
        }
      : undefined;
    const content = parsed.body;
    const executable = parsed.decorators.dont_activate;
    const enabled = entry.mode !== 'folder' && entry.enabled !== false && !executable;
    const loading =
      entry.constant === true || parsed.decorators.activate
        ? ('pinned' as const)
        : ('discoverable' as const);
    const keys = source.key;
    preview.push({
      id,
      title: name.slice(0, 200),
      text: content,
      enabled,
      loading,
      ...(keys ? { keys: keys.slice(0, MAX_PREVIEW_KEY_CHARS) } : {}),
    });
    if (executable) findings.add('lore-not-activated');
    for (const { decorator, code } of report.notices) findings.add(code, { decorator });
    for (const found of parsed.unknown) unknown.add(found.slice(0, MAX_UNKNOWN_DECORATOR_LENGTH));
    if (report.inlineDirective) findings.add('lore-inline-directive');
    if (!enabled || !content.trim()) continue;
    activated = true;
    const loreText = string(content),
      order = entry.insertion_order;
    lore.push({
      id,
      title: name.slice(0, 200),
      description: Array.isArray(entry.keys)
        ? entry.keys
            .filter((key: unknown) => typeof key === 'string')
            .join(', ')
            .slice(0, 4000)
        : '',
      text: loreText,
      loading,
      ...(typeof order === 'number' && Number.isSafeInteger(order) && Math.abs(order) <= 1_000_000
        ? { loreContext: { placement: 'background' as const, order } }
        : {}),
      ...(nativePosition ? { nativeRisuPosition: nativePosition } : {}),
    });
  }
  if (unknown.size) {
    const names = [...unknown].slice(0, MAX_UNKNOWN_DECORATORS).map((item) => `@@${item}`);
    const rest = unknown.size - names.length;
    findings.add('lore-decorator-unknown', { names: names.join(', '), more: rest });
  }
  if (preview.some((item) => !item.enabled)) findings.add('disabled-lore');
  if (!activated) return { preview, lore };
  return { preview, lore, loreActivation: { mode: 'model' } };
}
