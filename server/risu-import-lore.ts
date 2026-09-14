import type { ContentPackage } from '../core/content-package.js';
import { RISU_IMPORT_MAX_LORE_ENTRIES, type RisuImportPreview } from '../core/risu-import.js';
import { HttpError, record } from './request-validation.js';
import {
  convertCharbook,
  interpretLoreDecorators,
  type LoreDecorators,
  type RisuCharBookEntry,
} from './compat/risu/lorebook.js';
import {
  object,
  present,
  string,
  type RisuCard,
  type RisuCardLoreEntry,
} from './risu-import-card.js';
import type { RisuImportFindings } from './risu-import-findings.js';
import type { RisuImportText } from './risu-import-text.js';

/**
 * Every decorator Risu records, and what leaving it unapplied costs. 'unsupported' marks the ones that
 * decide what the model receives or when it receives it; 'info' marks the ones Risu itself does nothing
 * with in the prompt. `activate` and `dont_activate` carry no finding because the import applies both.
 */
const DECORATOR_LEVELS = {
  end: 'unsupported',
  activate_only_after: 'unsupported',
  activate_only_every: 'unsupported',
  keep_activate_after_match: 'unsupported',
  dont_activate_after_match: 'unsupported',
  depth: 'unsupported',
  reverse_depth: 'unsupported',
  role: 'unsupported',
  scan_depth: 'unsupported',
  is_greeting: 'unsupported',
  position: 'unsupported',
  inject_lore: 'unsupported',
  inject_at: 'unsupported',
  inject_replace: 'unsupported',
  inject_prepend: 'unsupported',
  ignore_on_max_context: 'unsupported',
  additional_keys: 'unsupported',
  exclude_keys: 'unsupported',
  exclude_keys_all: 'unsupported',
  match_full_word: 'unsupported',
  match_partial_word: 'unsupported',
  probability: 'unsupported',
  priority: 'unsupported',
  instruct_depth: 'info',
  is_user_icon: 'info',
  disable_ui_prompt: 'info',
  recursive: 'info',
  unrecursive: 'info',
  no_recursive_search: 'info',
  activate: null,
  dont_activate: null,
} satisfies Record<keyof LoreDecorators, 'unsupported' | 'info' | null>;
/** Unknown names come from the file, so the notice lists a bounded number of bounded names. */
const MAX_UNKNOWN_DECORATORS = 20;
const MAX_UNKNOWN_DECORATOR_LENGTH = 40;

/** An absent decorator reads back as `null`, `false` or `[]`; anything else a line wrote. */
const carries = (value: LoreDecorators[keyof LoreDecorators]) =>
  Array.isArray(value) ? value.length > 0 : value !== null && value !== false;

/** The decorators one entry carries, minus the two the import acts on itself. */
function reportedDecorators(decorators: LoreDecorators) {
  const found: { decorator: string; level: 'unsupported' | 'info' }[] = [];
  for (const decorator of Object.keys(DECORATOR_LEVELS) as (keyof LoreDecorators)[]) {
    const level = DECORATOR_LEVELS[decorator];
    if (level === null || !carries(decorators[decorator])) continue;
    // `@@end` and `@@ignore_on_max_context` write depth and priority through the upstream locals they
    // share, so those two values are that decorator's own doing rather than a line the entry carried.
    if (decorator === 'depth' && decorators.end && decorators.depth === 0) continue;
    if (
      decorator === 'priority' &&
      decorators.ignore_on_max_context &&
      decorators.priority === -1000
    )
      continue;
    found.push({ decorator, level });
  }
  return found;
}

const decoratorMessage = (decorator: string, level: 'unsupported' | 'info') =>
  level === 'info'
    ? `로어의 \`@@${decorator}\` 지시문은 모델에 보내는 내용을 바꾸지 않아요. 나중 키워드 활성화 작업을 위해 기록해 두고 지금은 적용하지 않아요.`
    : `로어의 \`@@${decorator}\` 지시문은 로어가 모델에 들어가는 내용과 시점을 바꿔요. 나중 키워드 활성화 작업을 위해 기록해 두고 지금은 적용하지 않아요.`;

/**
 * The card's lorebook as Risu normalizes it on import: the entry `extensions` another frontend wrote
 * (position/depth/role, selectiveLogic with secondary keys, probability, delay, match_whole_words)
 * become the `@@` lines Risu reads. Only each entry's content is taken from here; the book-level
 * settings the conversion also derives have no reader yet.
 *
 * The entries handed over are copies, because the conversion writes back onto the entry and deletes
 * the keys it migrates from its `extensions`, and the card has to stay as the file wrote it.
 */
function risuLoreContents(book: Record<string, unknown>, entries: RisuCardLoreEntry[]): string[] {
  const strings = (value: unknown) =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  return convertCharbook({
    lorebook: [],
    loresettings: undefined,
    loreExt: undefined,
    charbook: {
      extensions: { ...object(book.extensions) },
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
        })
      ),
    },
  }).lorebook.map((converted) => converted.content);
}

/**
 * Reads the card's lorebook. Every entry appears in the preview so the import screen can offer it
 * as a memory, while only the entries the package actually uses reach its lore.
 */
export function importRisuLore({
  card,
  cardText,
  findings,
}: {
  card: RisuCard;
  cardText: RisuImportText;
  findings: RisuImportFindings;
}): { preview: RisuImportPreview['lore']; lore: ContentPackage['lore'] } {
  const book = object(card.character_book);
  const entries = book.entries === undefined ? [] : book.entries;
  if (!Array.isArray(entries) || entries.length > RISU_IMPORT_MAX_LORE_ENTRIES)
    throw new HttpError(400, 'RISU_IMPORT_INVALID_FILE');
  const preview: RisuImportPreview['lore'] = [];
  const lore: ContentPackage['lore'] = [];
  const read = entries.map((raw) => record(raw) as RisuCardLoreEntry);
  const contents = risuLoreContents(book, read);
  const unknown = new Set<string>();
  for (const [index, entry] of read.entries()) {
    const id = `lore-${index}`;
    const name = string(entry.name) || string(entry.comment) || `로어 ${index + 1}`;
    const parsed = interpretLoreDecorators(contents[index]);
    const content = parsed.body;
    // Risu never sends an entry it never activates; that content belongs to the material's own use.
    const executable = parsed.decorators.dont_activate;
    const enabled = entry.enabled !== false && !executable;
    const loading =
      entry.constant === true || parsed.decorators.activate
        ? ('pinned' as const)
        : ('discoverable' as const);
    preview.push({
      id,
      title: name.slice(0, 200),
      text: content,
      enabled,
      loading,
      memoryCandidate: false,
    });
    if (executable)
      findings.add(
        'lore-not-activated',
        'warning',
        '활성화하지 않는 로어는 모델에 보내지 않아요. 자료가 스스로 쓰는 자료·코드로 보고 원본 파일에만 보존해요.'
      );
    for (const { decorator, level } of reportedDecorators(parsed.decorators))
      findings.add(`lore-decorator:${decorator}`, level, decoratorMessage(decorator, level));
    for (const found of parsed.unknown) unknown.add(found.slice(0, MAX_UNKNOWN_DECORATOR_LENGTH));
    // Risu reads a decorator only in the leading block, so a later `@@` line stays in the body.
    if (content.split('\n').some((line) => line.trim().startsWith('@@')))
      findings.add(
        'lore-decorator-position',
        'unsupported',
        '본문 중간의 `@@` 지시문은 해석하지 않고 그대로 남겨요. 원래 규칙과 다르게 동작할 수 있어요.'
      );
    if (!enabled || !content.trim()) continue;
    if (loading === 'discoverable')
      findings.add(
        'lore-discovery',
        'warning',
        '키워드로 켜지던 로어는 모델이 필요할 때 조회하는 자료로 가져와요. 항상 활성인 로어는 그대로 전달해요.'
      );
    if (
      entry.use_regex ||
      entry.selective ||
      entry.position === 'after_char' ||
      present(entry.extensions)
    )
      findings.add(
        'lore-rules',
        'warning',
        '로어의 원래 위치·추가 활성 조건은 그대로 재현하지 않아요. 본문과 항상 활성 여부를 가져와요.'
      );
    const loreText = cardText.convert(content),
      template = cardText.template(loreText),
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
      ...(template ? { template } : {}),
      loading,
      ...(typeof order === 'number' && Number.isSafeInteger(order) && Math.abs(order) <= 1_000_000
        ? { loreContext: { placement: 'background' as const, order } }
        : {}),
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
  return { preview, lore };
}
