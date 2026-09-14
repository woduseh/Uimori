// SPDX-License-Identifier: GPL-3.0-only
// Snapshot of RisuAI (https://github.com/kwaroran/RisuAI) at commit cad8595aa39620df4246f56918f0962c2aa0263a.
// Upstream sources: src/ts/characterCards.ts:1038-1143
//   src/ts/process/lorebook.svelte.ts:250,252-253,263-299,300-515
//   src/ts/util.ts:44-46
// Copyright (c) Kwaroran and the RisuAI contributors. Licensed under GPL-3.0-only; see ./LICENSE.
// Modifications for Uimori:
//   - `convertCharbook` is copied whole and exported (upstream it is module-private). Its statements,
//     order, guards and template strings are unchanged, so the `@@` lines it prepends to an entry's
//     content are byte-identical to Risu's. It still mutates the entries it is given, exactly as
//     upstream does: `use_regex` and `selective` are written back onto the entry, and the `extensions`
//     object it deletes keys from is the entry's own object, not a copy.
//   - `convertCharbook` reads no app state upstream, so nothing had to become a parameter. Its only
//     non-local dependency is `checkNullish` (src/ts/util.ts:44-46), copied verbatim below.
//   - Typing-only changes in `convertCharbook`, none of which changes a value: `loresettings` is
//     declared `loreSettings | undefined` because every upstream caller passes `undefined` into it
//     (characterCards.ts:632,923) under a non-strict tsconfig; the `loresettings` object literal
//     carries an `as loreSettings` cast because `CharacterBook`'s `token_budget` / `scan_depth` /
//     `recursive_scanning` are optional while `loreSettings` requires them, which is exactly what the
//     `checkNullish` guard above it establishes; and the `extentions` object literal carries a cast
//     because `book.case_sensitive` is optional while `loreBook['extentions']` requires a boolean.
//     No @ts-nocheck: this file type-checks under `strict`.
//   - `interpretLoreDecorators` is the decorator hook of `getLoreBook`
//     (lorebook.svelte.ts:300-515) turned into a pure function. Upstream that hook is a closure that
//     mutates the activation loop's own locals; there is no value to return. Here every such mutation
//     is recorded in the returned `decorators` record instead, and the activation loop itself - key
//     search, recursion, token budget, sorting, chat-variable reads and writes - is NOT copied. It is
//     V5's job. The table under `LoreDecorators` says which upstream local each field replaces.
//   - `interpretLoreDecorators` keeps the hook's return values exactly (`return` vs `return false`)
//     so the `@@@` fallback chain in ./ccardlib-decorator.ts behaves identically.
//   - One guard added, not upstream: `case 'position'` reads `arg[0].startsWith('pt_')`, which throws
//     a TypeError on a bare `@@position` line with no argument. Here a missing argument is read as the
//     empty string, which matches neither accepted form, so the decorator is rejected instead of
//     throwing. Every other argument expression is copied as-is, including the ones upstream leaves
//     unchecked: `@@scan_depth`, `@@priority` and `@@probability` store `parseInt`'s result even when
//     it is NaN, while `@@depth`, `@@reverse_depth`, `@@activate_only_after`, `@@activate_only_every`
//     and `@@is_greeting` reject a NaN argument.
//   - `CCardLib.decorator.parse` is not vendored by RisuAI; it comes from the MIT-licensed
//     @risuai/ccardlib 0.4.2. It lives in ./ccardlib-decorator.ts under its own MIT header and is
//     imported here, so this file carries no MIT code.

import { parseDecorators } from './ccardlib-decorator.js';
import type { CharacterBook, loreBook, loreSettings } from './types.js';

/* ------------------------------------------------------------------------------------------------ *
 * src/ts/util.ts
 * ------------------------------------------------------------------------------------------------ */

function checkNullish(data: any) {
  return data === undefined || data === null;
}

/* ------------------------------------------------------------------------------------------------ *
 * src/ts/characterCards.ts - CCv2/CCv3 `character_book` to Risu `loreBook[]`
 * ------------------------------------------------------------------------------------------------ */

/**
 * Risu's card-import normalization of a `character_book`. A CCv3 `Lorebook` is structurally assignable
 * to `CharacterBook`, which is why upstream passes both through this one function.
 *
 * Entry `extensions` that Risu has no database field for are migrated into `@@` decorator lines
 * prepended to the entry's content. Because each block prepends, the resulting content reads, top to
 * bottom: match_whole_words, delay, selectiveLogic, position/depth/role, probability, original content.
 */
export function convertCharbook(arg: {
  lorebook: loreBook[];
  charbook: CharacterBook;
  loresettings: loreSettings | undefined;
  loreExt: any;
}) {
  let { lorebook, loresettings, loreExt, charbook } = arg;
  if (
    !checkNullish(charbook.recursive_scanning) &&
    !checkNullish(charbook.scan_depth) &&
    !checkNullish(charbook.token_budget)
  ) {
    loresettings = {
      tokenBudget: charbook.token_budget,
      scanDepth: charbook.scan_depth,
      recursiveScanning: charbook.recursive_scanning,
      fullWordMatching: charbook?.extensions?.risu_fullWordMatching ?? false,
    } as loreSettings;
  }

  loreExt = charbook.extensions;

  for (const book of charbook.entries) {
    let content = book.content;

    if (book.use_regex && !book.keys?.[0]?.startsWith('/')) {
      book.use_regex = false;
    }

    //extention migration
    const extensions = book.extensions ?? {};

    if (
      extensions.useProbability &&
      extensions.probability !== undefined &&
      extensions.probability !== 100
    ) {
      content = `@@probability ${extensions.probability}\n` + content;
      delete extensions.useProbability;
      delete extensions.probability;
    }
    if (
      extensions.position === 4 &&
      typeof extensions.depth === 'number' &&
      typeof extensions.role === 'number'
    ) {
      content =
        `@@depth ${extensions.depth}\n@@role ${['system', 'user', 'assistant'][extensions.role]}\n` +
        content;
      delete extensions.position;
      delete extensions.depth;
      delete extensions.role;
    }
    if (
      typeof extensions.selectiveLogic === 'number' &&
      book.secondary_keys &&
      book.secondary_keys.length > 0
    ) {
      switch (extensions.selectiveLogic) {
        case 0: {
          if (!book.secondary_keys || book.secondary_keys.length === 0) {
            book.selective = false;
          }
          break;
        }
        case 1: {
          book.selective = false;
          content = `@@exclude_keys_all ${book.secondary_keys.join(',')}\n` + content;
          break;
        }
        case 2: {
          book.selective = false;
          for (const secKey of book.secondary_keys) {
            content = `@@exclude_keys ${secKey}\n` + content;
          }
          break;
        }
        case 3: {
          book.selective = false;
          for (const secKey of book.secondary_keys) {
            content = `@@additional_keys ${secKey}\n` + content;
          }
          break;
        }
      }
    }
    if (typeof extensions.delay === 'number' && extensions.delay > 0) {
      content = `@@activate_only_after ${extensions.delay}\n` + content;
      delete extensions.delay;
    }
    if (extensions.match_whole_words === true) {
      content = `@@match_full_word\n` + content;
      delete extensions.match_whole_words;
    }
    if (extensions.match_whole_words === false) {
      content = `@@match_partial_word\n` + content;
      delete extensions.match_whole_words;
    }

    lorebook.push({
      key: book.keys.join(', '),
      secondkey: book.secondary_keys?.join(', ') ?? '',
      insertorder: book.insertion_order,
      comment: book.name ?? book.comment ?? '',
      content: content,
      mode: (book.mode as any) ?? 'normal',
      alwaysActive: book.constant ?? false,
      selective: book.selective ?? false,
      extentions: { ...extensions, risu_case_sensitive: book.case_sensitive } as loreBook['extentions'],
      activationPercent: book.extensions?.risu_activationPercent,
      loreCache: book.extensions?.risu_loreCache ?? null,
      useRegex: book.use_regex ?? false,
      folder: book.folder,
    });
  }

  return {
    lorebook,
    loresettings,
    loreExt,
  };
}

/* ------------------------------------------------------------------------------------------------ *
 * src/ts/process/lorebook.svelte.ts - the `@@` decorator switch
 * ------------------------------------------------------------------------------------------------ */

export type LoreDecoratorRole = 'system' | 'user' | 'assistant';

/**
 * Every decorator RisuAI's switch accepts, as data.
 *
 * `null` / `false` / `[]` means the decorator was absent, so the activation loop keeps its own default.
 * The upstream local each field replaces, and that local's default:
 *
 * | field                                        | upstream local            | upstream default        |
 * | -------------------------------------------- | ------------------------- | ----------------------- |
 * | end, depth, reverse_depth, position          | `pos` and `depth`         | `''`, `0`               |
 * | activate_only_after, activate_only_every     | `activated`               | `true` (needs chat len) |
 * | is_greeting, probability                     | `activated`               | `true` (needs chat/RNG) |
 * | keep_activate_after_match                    | `keepActivateAfterMatch`  | `false`                 |
 * | dont_activate_after_match                    | `dontActivateAfterMatch`  | `false`                 |
 * | role                                         | `role`                    | `'system'`              |
 * | scan_depth                                   | `scanDepth`               | the lorebook setting    |
 * | inject_lore, inject_at                       | `inject.location/.lore`   | `null` inject           |
 * | inject_replace, inject_prepend               | `inject.operation/.param` | `null` inject           |
 * | priority, ignore_on_max_context              | `priority`                | the entry's insertorder |
 * | additional_keys, exclude_keys*               | `searchQueries`           | `[]`                    |
 * | match_full_word, match_partial_word          | `fullWordMatching`        | the lorebook setting    |
 * | activate, dont_activate                      | `forceState`              | `'none'`                |
 * | disable_ui_prompt                            | `disabledUIPrompts`       | `[]`                    |
 * | unrecursive, recursive                       | `itemRecursive`           | `'global'`              |
 * | no_recursive_search                          | `dontSearchWhenRecursive` | `false`                 |
 * | instruct_depth, is_user_icon                 | none - accepted no-ops    | -                       |
 *
 * Several upstream cases write the SAME local, so the record resolves them the way the last write
 * would have, rather than keeping every occurrence:
 *
 * - `pos` / `depth`: `@@end` is `pos='depth'; depth=0`, `@@depth N` is `pos='depth'; depth=N`,
 *   `@@reverse_depth N` is `pos='reverse_depth'; depth=N`, and `@@position X` writes `pos` only, so it
 *   can leave a depth set by an earlier `@@depth`. Read them back as
 *   `pos = position ?? (reverse_depth !== null ? 'reverse_depth' : depth !== null ? 'depth' : '')` and
 *   `depth = depth ?? reverse_depth ?? 0`. At most one of `depth` / `reverse_depth` is non-null, and
 *   `position` is non-null only when `@@position` was the last of the four.
 * - `priority`: holds the final value, so `-1000` when `@@ignore_on_max_context` came last and the
 *   `@@priority` argument when that came last. `ignore_on_max_context` only reports its presence.
 * - `inject`: an inject exists when any of the four fields is non-null. `location = inject_lore ??
 *   inject_at ?? ''`, `lore = inject_lore !== null`, `operation` is `'replace'` / `'prepend'` /
 *   `'append'` by which of the two is non-null, and `param = inject_replace ?? inject_prepend ?? ''`.
 * - `fullWordMatching`, `forceState`, `itemRecursive`: at most one of each opposing pair is `true`,
 *   the one that was written last.
 *
 * `end` is a presence flag on top of the `pos` / `depth` resolution, so `@@end` yields
 * `{ end: true, depth: 0 }`.
 */
export interface LoreDecorators {
  end: boolean;
  activate_only_after: number | null;
  activate_only_every: number | null;
  keep_activate_after_match: boolean;
  dont_activate_after_match: boolean;
  depth: number | null;
  reverse_depth: number | null;
  /** `@@instruct_depth`, `@@reverse_instruct_depth` and `@@instruct_scan_depth`: instruct mode does not
   *  exist in Risu, so the switch accepts all three spellings and does nothing with them. */
  instruct_depth: boolean;
  role: LoreDecoratorRole | null;
  scan_depth: number | null;
  is_greeting: number | null;
  position: string | null;
  inject_lore: string | null;
  inject_at: string | null;
  inject_replace: string | null;
  inject_prepend: string | null;
  ignore_on_max_context: boolean;
  additional_keys: string[][];
  exclude_keys: string[][];
  exclude_keys_all: string[][];
  match_full_word: boolean;
  match_partial_word: boolean;
  /** Upstream is a `//TODO` that rejects the decorator. Presence only. */
  is_user_icon: boolean;
  activate: boolean;
  dont_activate: boolean;
  disable_ui_prompt: string[];
  probability: number | null;
  priority: number | null;
  unrecursive: boolean;
  recursive: boolean;
  no_recursive_search: boolean;
}

export interface LoreDecoratorResult {
  /** The entry content with its leading decorator block removed, trimmed. */
  body: string;
  decorators: LoreDecorators;
  /** Names that reached the switch's `default:` branch, in order, duplicates kept. A decorator Risu
   *  knows but rejects for a bad argument (`@@role nobody`, `@@depth x`) is NOT listed here. */
  unknown: string[];
}

function emptyDecorators(): LoreDecorators {
  return {
    end: false,
    activate_only_after: null,
    activate_only_every: null,
    keep_activate_after_match: false,
    dont_activate_after_match: false,
    depth: null,
    reverse_depth: null,
    instruct_depth: false,
    role: null,
    scan_depth: null,
    is_greeting: null,
    position: null,
    inject_lore: null,
    inject_at: null,
    inject_replace: null,
    inject_prepend: null,
    ignore_on_max_context: false,
    additional_keys: [],
    exclude_keys: [],
    exclude_keys_all: [],
    match_full_word: false,
    match_partial_word: false,
    is_user_icon: false,
    activate: false,
    dont_activate: false,
    disable_ui_prompt: [],
    probability: null,
    priority: null,
    unrecursive: false,
    recursive: false,
    no_recursive_search: false,
  };
}

/**
 * Reads the `@@` decorator block of a lorebook entry exactly the way RisuAI's activation loop does,
 * and reports what it found instead of applying it.
 */
export function interpretLoreDecorators(content: string): LoreDecoratorResult {
  const decorators = emptyDecorators();
  const unknown: string[] = [];

  // Where several cases write one upstream local, the later write clears the fields standing for the
  // earlier ones, so the record always reads back as the last write. See LoreDecorators above.
  const body = parseDecorators(content, (name, arg) => {
    switch (name) {
      case 'end': {
        decorators.end = true;
        decorators.depth = 0;
        decorators.reverse_depth = null;
        decorators.position = null;
        return;
      }
      case 'activate_only_after': {
        const int = parseInt(arg[0]);
        if (Number.isNaN(int)) {
          return false;
        }
        decorators.activate_only_after = int;
        return;
      }
      case 'activate_only_every': {
        const int = parseInt(arg[0]);
        if (Number.isNaN(int)) {
          return false;
        }
        decorators.activate_only_every = int;
        return;
      }
      case 'keep_activate_after_match': {
        // Upstream also promotes this to forceState='activate' when the chat variable
        // `__internal_ka_<id>` is already 'true'. That lookup belongs to the activation loop.
        decorators.keep_activate_after_match = true;
        return false;
      }
      case 'dont_activate_after_match': {
        // Same shape as keep_activate_after_match, against `__internal_da_<id>`.
        decorators.dont_activate_after_match = true;
        return false;
      }
      case 'depth':
      case 'reverse_depth': {
        const int = parseInt(arg[0]);
        if (Number.isNaN(int)) {
          return false;
        }
        decorators.depth = name === 'depth' ? int : null;
        decorators.reverse_depth = name === 'depth' ? null : int;
        decorators.position = null;
        return;
      }
      case 'instruct_depth':
      case 'reverse_instruct_depth':
      case 'instruct_scan_depth': {
        //the instruct mode does not exists in risu
        decorators.instruct_depth = true;
        return false;
      }
      case 'role': {
        if (arg[0] === 'user' || arg[0] === 'assistant' || arg[0] === 'system') {
          decorators.role = arg[0];
          return;
        }
        return false;
      }
      case 'scan_depth': {
        decorators.scan_depth = parseInt(arg[0]);
        return;
      }
      case 'is_greeting': {
        const int = parseInt(arg[0]);
        if (Number.isNaN(int)) {
          return false;
        }
        decorators.is_greeting = int;
        return;
      }
      case 'position': {
        const target = arg[0] as string | undefined;
        if (
          target !== undefined &&
          (target.startsWith('pt_') ||
            ['after_desc', 'before_desc', 'personality', 'scenario'].includes(target))
        ) {
          decorators.position = target;
          return;
        }
        return false;
      }
      case 'inject_lore': {
        decorators.inject_lore = arg.join(' ');
        decorators.inject_at = null;
        return;
      }
      case 'inject_at': {
        decorators.inject_at = arg.join(' ');
        decorators.inject_lore = null;
        return;
      }
      case 'inject_replace': {
        decorators.inject_replace = arg.join(' ');
        decorators.inject_prepend = null;
        return;
      }
      case 'inject_prepend': {
        decorators.inject_prepend = arg.join(' ');
        decorators.inject_replace = null;
        return;
      }
      case 'ignore_on_max_context': {
        decorators.priority = -1000;
        decorators.ignore_on_max_context = true;
        return;
      }
      case 'additional_keys': {
        decorators.additional_keys.push(arg);
        return;
      }
      case 'exclude_keys': {
        decorators.exclude_keys.push(arg);
        return;
      }
      case 'exclude_keys_all': {
        decorators.exclude_keys_all.push(arg);
        return;
      }
      case 'match_full_word': {
        decorators.match_full_word = true;
        decorators.match_partial_word = false;
        return;
      }
      case 'match_partial_word': {
        decorators.match_partial_word = true;
        decorators.match_full_word = false;
        return;
      }
      case 'is_user_icon': {
        //TODO
        decorators.is_user_icon = true;
        return false;
      }
      case 'activate': {
        decorators.activate = true;
        decorators.dont_activate = false;
        return;
      }
      case 'dont_activate': {
        decorators.dont_activate = true;
        decorators.activate = false;
        return;
      }
      case 'disable_ui_prompt': {
        if (['post_history_instructions', 'system_prompt'].includes(arg[0])) {
          decorators.disable_ui_prompt.push(arg[0]);
          return;
        }
        return false;
      }
      case 'probability': {
        // Upstream rolls `Math.random() * 100 > parseInt(arg[0])` here; the roll is the caller's.
        decorators.probability = parseInt(arg[0]);
        return;
      }
      case 'priority': {
        decorators.priority = parseInt(arg[0]);
        return;
      }
      //We can already do it with search depth, but its more readable and performant this way
      case 'unrecursive': {
        decorators.unrecursive = true;
        decorators.recursive = false;
        return;
      }
      case 'recursive': {
        decorators.recursive = true;
        decorators.unrecursive = false;
        return;
      }
      case 'no_recursive_search': {
        decorators.no_recursive_search = true;
        return;
      }
      default: {
        unknown.push(name);
        return false;
      }
    }
  });

  return { body, decorators, unknown };
}
