import type { ContentPackage, PackageLoreActivation } from '../core/content-package.js';
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

/**
 * What is left to say about a decorator now that the keyword engine reads the whole block. `null` is a
 * decorator the engine itself applies, so it carries no finding at all; the four notices below are the
 * ones it cannot apply or cannot apply fully.
 */
type DecoratorNotice = 'position' | 'memory' | 'greeting' | 'inert';
const DECORATOR_NOTICES = {
  // The engine decides WHICH entries are active; where and in what shape they reach the model is a
  // separate decision Uimori has not taken.
  end: 'position',
  depth: 'position',
  reverse_depth: 'position',
  role: 'position',
  position: 'position',
  inject_lore: 'position',
  inject_at: 'position',
  inject_replace: 'position',
  inject_prepend: 'position',
  // The engine performs the lookup, but the writes it would leave behind are not persisted.
  keep_activate_after_match: 'memory',
  dont_activate_after_match: 'memory',
  is_greeting: 'greeting',
  instruct_depth: 'inert',
  is_user_icon: 'inert',
  disable_ui_prompt: 'inert',
  // Applied by the engine at reservation.
  activate: null,
  dont_activate: null,
  activate_only_after: null,
  activate_only_every: null,
  scan_depth: null,
  additional_keys: null,
  exclude_keys: null,
  exclude_keys_all: null,
  match_full_word: null,
  match_partial_word: null,
  probability: null,
  priority: null,
  ignore_on_max_context: null,
  recursive: null,
  unrecursive: null,
  no_recursive_search: null,
} satisfies Record<keyof LoreDecorators, DecoratorNotice | null>;
const NOTICES: Record<
  DecoratorNotice,
  { level: 'info' | 'unsupported'; message: (decorator: string) => string }
> = {
  position: {
    level: 'unsupported',
    message: (decorator) =>
      `로어의 \`@@${decorator}\` 지시문은 로어가 모델에 들어가는 위치·형태를 바꿔요. 아직 적용하지 않아요.`,
  },
  memory: {
    level: 'unsupported',
    message: (decorator) =>
      `로어의 \`@@${decorator}\` 지시문이 남기는 활성 상태 기억은 저장하지 않아요. 이번 생성 안에서만 반영돼요.`,
  },
  greeting: {
    level: 'info',
    message: (decorator) =>
      `로어의 \`@@${decorator}\` 지시문은 선택한 시작문 순번을 알 수 없어 0번으로 봐요.`,
  },
  inert: {
    level: 'info',
    message: (decorator) =>
      `로어의 \`@@${decorator}\` 지시문은 모델에 보내는 내용을 바꾸지 않아요. 적용하지 않아요.`,
  },
};
/** Unknown names come from the file, so the notice lists a bounded number of bounded names. */
const MAX_UNKNOWN_DECORATORS = 20;
const MAX_UNKNOWN_DECORATOR_LENGTH = 40;
/** The stored activation rule stays inside the package validator's limits. */
const MAX_ACTIVATION_KEY_CHARS = 4000;
const MAX_RULE_CHARS = 4000;
const MAX_RULE_LINES = 64;
/** The preview shows the keys so the import screen can name what turns an entry on. */
const MAX_PREVIEW_KEY_CHARS = 200;

/** An absent decorator reads back as `null`, `false` or `[]`; anything else a line wrote. */
const carries = (value: LoreDecorators[keyof LoreDecorators]) =>
  Array.isArray(value) ? value.length > 0 : value !== null && value !== false;

/** The decorators one entry carries that the keyword engine does not settle by itself. */
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
 * become the `@@` lines Risu reads, and the book's own scan settings become `loresettings`. Both the
 * converted records and those settings are what the keyword engine is later run over.
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
 * The leading `@@` block of the converted content, exactly the lines the decorator parser consumed:
 * the input trimmed, each line trimmed, up to the first line that is not a decorator. Storing them
 * verbatim is what lets the engine read the same block back at reservation.
 */
function leadingRules(content: string): string[] {
  const lines = content.trim().split('\n');
  const block: string[] = [];
  for (const line of lines) {
    if (!line.trim().startsWith('@@')) break;
    block.push(line.trim());
  }
  return block;
}

/** Keeps whole keys only: a key cut in half would match text the original rule never matched. */
function limitKeys(keys: string, max: number): string {
  if (keys.length <= max) return keys;
  const cut = keys.slice(0, max);
  const boundary = cut.lastIndexOf(',');
  return boundary < 0 ? '' : cut.slice(0, boundary);
}

/**
 * Reads the card's lorebook. Every entry appears in the preview so the import screen can offer it
 * as a memory, while only the entries the package actually uses reach its lore.
 */
export function importRisuLore({
  card,
  findings,
  native = false,
}: {
  card: RisuCard;
  findings: RisuImportFindings;
  native?: boolean;
}): {
  preview: RisuImportPreview['lore'];
  lore: ContentPackage['lore'];
  loreActivation?: ContentPackage['loreActivation'];
} {
  const book = object(card.character_book);
  const entries = book.entries === undefined ? [] : book.entries;
  if (!Array.isArray(entries) || entries.length > RISU_IMPORT_MAX_LORE_ENTRIES)
    throw new HttpError(400, 'RISU_IMPORT_INVALID_FILE');
  const preview: RisuImportPreview['lore'] = [];
  const lore: ContentPackage['lore'] = [];
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
      native &&
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
    const keys = limitKeys(source.key, MAX_ACTIVATION_KEY_CHARS);
    preview.push({
      id,
      title: name.slice(0, 200),
      text: content,
      enabled,
      loading,
      memoryCandidate: false,
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
    let rules = leadingRules(source.content);
    if (rules.length > MAX_RULE_LINES || rules.join('\n').length > MAX_RULE_CHARS) {
      rules = rules.slice(0, MAX_RULE_LINES);
      while (rules.length && rules.join('\n').length > MAX_RULE_CHARS) rules.pop();
      findings.add(
        'lore-rules-truncated',
        'warning',
        '지시문이 너무 많은 로어는 앞부분만 남기고 잘라요. 잘린 지시문은 활성 판단에 쓰이지 않아요.'
      );
    }
    // Stored even for an entry with no key and no rule: Risu never activates such an entry, and
    // recording that is what keeps it out of the model instead of turning it into a lookup.
    const activation: PackageLoreActivation = {
      keys,
      ...(source.secondkey
        ? { secondaryKeys: limitKeys(source.secondkey, MAX_ACTIVATION_KEY_CHARS) }
        : {}),
      ...(source.selective ? { selective: true } : {}),
      ...(source.useRegex ? { regex: true } : {}),
      ...(source.mode === 'child' ? { child: true } : {}),
      ...(rules.length ? { rules: rules.join('\n') } : {}),
    };
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
      activation,
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
  findings.add(
    'lore-keyword',
    'info',
    '키워드 활성화 규칙을 그대로 가져와요. 활성 예산은 채팅 설정의 조회 로어 문자 한도를 따르고, 위치·삽입 지시문은 적용하지 않아요.'
  );
  const settings = converted.loresettings;
  return {
    preview,
    lore,
    loreActivation: {
      mode: 'keyword',
      // Risu's own book settings, and only when the file supplied them; the card's token budget is
      // replaced by the chat's 조회 로어 문자 한도, so it is dropped here.
      ...(settings &&
      Number.isSafeInteger(settings.scanDepth) &&
      settings.scanDepth >= 0 &&
      settings.scanDepth <= 1000
        ? { scanDepth: settings.scanDepth }
        : {}),
      ...(typeof settings?.recursiveScanning === 'boolean'
        ? { recursiveScanning: settings.recursiveScanning }
        : {}),
      ...(typeof settings?.fullWordMatching === 'boolean'
        ? { fullWordMatching: settings.fullWordMatching }
        : {}),
    },
  };
}
