import type { RisuContent } from '../core/risu-content.js';
import { RISU_IMPORT_MAX_LORE_ENTRIES, type RisuImportPreview } from '../core/risu-import.js';
import { HttpError, record } from './request-validation.js';
import {
  convertCharbook,
  interpretLoreDecorators,
  type LoreDecorators,
  type RisuCharBookEntry,
} from './compat/risu/lorebook.js';
import { object, string, type RisuCard, type RisuCardLoreEntry } from './risu-import-card.js';
import type { RisuImportFindings } from './risu-import-findings.js';

/** Source rules stay in the Risu document; only pinned/disabled and placement are host policy. */
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
  position: {
    level: 'unsupported' as const,
    message: (decorator: string) =>
      `로어의 \`@@${decorator}\` 위치·삽입 지시문은 원본에 보존하지만 현재 문맥 배치에는 적용하지 않아요.`,
  },
  activation: {
    level: 'info' as const,
    message: (decorator: string) =>
      `로어의 \`@@${decorator}\` 규칙은 원본에 보존해요. 선택적 로어는 JEV 관련성 판단과 작문 모델의 조회로 제공해요.`,
  },
};
/** Unknown names come from the file, so the notice lists a bounded number of bounded names. */
const MAX_UNKNOWN_DECORATORS = 20;
const MAX_UNKNOWN_DECORATOR_LENGTH = 40;
/** The preview shows the keys so the import screen can name what turns an entry on. */
const MAX_PREVIEW_KEY_CHARS = 200;

/** An absent decorator reads back as `null`, `false` or `[]`; anything else a line wrote. */
const carries = (value: LoreDecorators[keyof LoreDecorators]) =>
  Array.isArray(value) ? value.length > 0 : value !== null && value !== false;

/** Source decorators that are not implemented by the host placement projection. */
function reportedDecorators(decorators: LoreDecorators) {
  const found: { decorator: string; notice: DecoratorNotice }[] = [];
  for (const decorator of Object.keys(DECORATOR_NOTICES) as (keyof LoreDecorators)[]) {
    const notice = DECORATOR_NOTICES[decorator];
    if (notice === null || !carries(decorators[decorator])) continue;
    // `@@end` writes depth through the upstream local the two share, so that value is that
    // decorator's own doing rather than a line the entry carried.
    if (decorator === 'depth' && decorators.end && decorators.depth === 0) continue;
    found.push({ decorator, notice });
  }
  return found;
}

/**
 * The card's lorebook as Risu normalizes it on import: the entry `extensions` another frontend wrote
 * (position/depth/role, selectiveLogic with secondary keys, probability, delay, match_whole_words)
 * become the `@@` lines Risu reads. The host derives enabled state and placement from those lines.
 *
 * The entries handed over are copies, because the conversion writes back onto the entry and deletes
 * the keys it migrates from its `extensions`, and the card has to stay as the file wrote it.
 */
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
      // Risu derives the book settings only when the file supplied all three of them.
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

/**
 * Reads the card's lorebook. Every entry appears in the preview, while only active entries reach
 * the runtime projection. Import never moves card lore into a chat's user notes.
 */
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
    throw new HttpError(400, 'RISU_IMPORT_INVALID_FILE');
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
    const parsed = interpretLoreDecorators(source.content);
    const decorators = parsed.decorators;
    const nativeDepth = decorators.depth ?? decorators.reverse_depth ?? 0;
    const nativePosition =
      !decorators.position &&
      !decorators.inject_lore &&
      !decorators.inject_at &&
      (decorators.depth !== null ||
        decorators.reverse_depth !== null ||
        decorators.role !== null) &&
      Number.isSafeInteger(nativeDepth) &&
      nativeDepth >= 0 &&
      nativeDepth <= 1_000_000
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
    // Risu never sends an entry it never activates; that content belongs to the material's own use.
    const executable = parsed.decorators.dont_activate;
    const enabled = entry.enabled !== false && !executable;
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
    if (executable)
      findings.add(
        'lore-not-activated',
        'warning',
        '활성화하지 않는 로어는 모델에 보내지 않아요. 자료가 스스로 쓰는 자료·코드로 보고 원본 파일에만 보존해요.'
      );
    for (const { decorator, notice } of reportedDecorators(parsed.decorators)) {
      if (nativePosition && ['end', 'depth', 'reverse_depth', 'role'].includes(decorator)) continue;
      findings.add(
        `lore-decorator:${decorator}`,
        NOTICES[notice].level,
        NOTICES[notice].message(decorator)
      );
    }
    for (const found of parsed.unknown) unknown.add(found.slice(0, MAX_UNKNOWN_DECORATOR_LENGTH));
    // Risu reads a decorator only in the leading block, so a later `@@` line stays in the body.
    if (content.split('\n').some((line) => line.trim().startsWith('@@')))
      findings.add(
        'lore-decorator-position',
        'unsupported',
        '본문 중간의 `@@` 지시문은 해석하지 않고 그대로 남겨요. 원래 규칙과 다르게 동작할 수 있어요.'
      );
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
    findings.add(
      'lore-decorator-unknown',
      'unsupported',
      `Risu가 모르는 \`@@\` 지시문은 본문에서 빠진 채 사라져요: ${names.join(', ')}${rest ? ` 외 ${rest}개` : ''}`
    );
  }
  if (preview.some((item) => !item.enabled))
    findings.add('disabled-lore', 'info', '비활성 로어는 적용하지 않고 원본 파일에 보존해요.');
  if (!activated) return { preview, lore };
  return { preview, lore, loreActivation: { mode: 'model' } };
}
