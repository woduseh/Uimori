// SPDX-License-Identifier: GPL-3.0-only
// Snapshot of RisuAI (https://github.com/kwaroran/RisuAI) at commit cad8595aa39620df4246f56918f0962c2aa0263a.
// Upstream sources: src/ts/process/lorebook.svelte.ts:75-299,300-515,516-664
//   src/ts/storage/database.svelte.ts:73-78 (the two lorebook settings defaults, quoted below)
// Copyright (c) Kwaroran and the RisuAI contributors. Licensed under GPL-3.0-only; see ./LICENSE.
// Modifications for Uimori:
//   - `loadLoreBookV3Prompt` (lorebook.svelte.ts:75-664) becomes the pure `activateLore`. Its matching
//     rules, its query order, its recursion, its sort order, its greedy token filter and its inject
//     merge are copied statement for statement; only the app-state reads became parameters. The table
//     under `LoreActivationInput` / `LoreActivationDeps` names every one of them.
//   - The decorator switch (:300-515) is NOT copied here. ./lorebook.ts already owns it as the pure
//     `interpretLoreDecorators`, and this file reads its `LoreDecorators` record back into the upstream
//     locals (`pos`, `depth`, `scanDepth`, `role`, `priority`, `searchQueries`, `forceState`,
//     `itemRecursive`, `fullWordMatching`, `inject`, `activated`) with the formulas that file's header
//     documents. The two behaviours the record cannot carry are stated under "Known divergences".
//   - Upstream is `async` only because `tokenize` is. `deps.estimateTokens` is synchronous, so
//     `activateLore` is a synchronous, deterministic function: given the same input, deps and
//     `random()` sequence it returns the same result, and it touches nothing outside its arguments.
//   - The caller's entries are never mutated. Upstream clones with `safeStructuredClone`
//     (lorebook.svelte.ts:82) because the `mode:'child'` branch writes back onto the entry; the clone
//     is kept, from ./cbs-support.js.
//   - `matchLog` is not returned, so its `prompt` field - upstream's `\x01{{<name>}}:<text>\x01`
//     rendering at :121-135 - is dropped with everything that fed it: `DBState.db.username`,
//     `msg.name`, `findCharacterbyId(msg.saying)?.name` and `char.name`. Nothing observable depends on
//     it: both the plain search (:186,209) and the regex search (:156) read `m.data`, never `m.prompt`.
//     The `source` field survives because `matchedBy` is derived from it.
//   - `setChatVar` (:584,587) is reported as `result.variableWrites` instead of being performed. When
//     `deps.setChatVar` is supplied it is also called, in the same order, so a host that wants the
//     upstream side effect still gets it.
//   - The `console.log('loreinjectionLores', ...)` at :637 is dropped.
//   - Additions, none of which changes an activation decision: every returned lore carries the `index`
//     of the entry it came from, `matchedBy` says which upstream branch activated it, and `omitted`
//     lists the entries that did not survive with the reason they did not. Upstream returns neither.
//   - `matchTimes` (:251) is declared upstream and never read; it is not copied. `disabledUIPrompts`
//     (:250,483) is accumulated upstream and never read or returned by this function either, so
//     `@@disable_ui_prompt` is parsed and has no effect here, exactly as upstream.
//   - Typing-only changes, none of which changes a value: `inject` is `LoreInject | null` rather than
//     upstream's `null` assigned into a non-nullable type, `forceState` is a literal union rather than
//     `string`, `regexString.split('/').pop()` is narrowed by the `if(regexFlag)` guard upstream
//     already has, and the `act?.inject?.lore` filter at :627 is written as a type predicate.
//     No @ts-nocheck: this file type-checks under `strict`.
//
// Upstream behaviour worth stating explicitly, because it is surprising and is kept as-is:
//   - `keepActivateAfterMatch` / `dontActivateAfterMatch` (:252-253) are declared outside both loops
//     and never reset per entry. So once ONE entry carries `@@keep_activate_after_match` whose variable
//     is not yet 'true', EVERY entry activated after it - in that pass and every later pass - also gets
//     a `__internal_ka_<its own id>` write. Same for `@@dont_activate_after_match` and `__internal_da_`.
//     This is reproduced, not fixed.
//   - A regex key keeps its leading slash in the compiled pattern (:151-155). For `/foo/i`,
//     `regexFlag` is `i` and `regexString.replace('/i','')` strips the LAST `/i`, leaving `/foo`, which
//     is then compiled as `new RegExp('/foo','i')`. A regex key therefore matches text containing the
//     literal `/foo`. A key with no flags (`/foo/`) yields an empty `regexFlag`, which the `if(regexFlag)`
//     guard rejects, so it never matches anything.
//   - Entry case sensitivity is not read here. `loreBook.extentions.risu_case_sensitive` appears nowhere
//     in `loadLoreBookV3Prompt`; the plain search lowercases both sides unconditionally (:177-179,190,208)
//     and the regex search is case-sensitive unless the key's own `i` flag says otherwise (:155-156).
//   - `@@scan_depth x` stores `parseInt`'s NaN (:371). `messages.slice(len - NaN, len)` is
//     `slice(0, len)`, so a NaN scan depth scans the WHOLE chat rather than nothing.
//   - An `@@inject_lore` entry is merged into its target and then removed from the result (:627-633).
//     If no activated lore has `source === inject.location`, the entry is dropped silently. Such an
//     entry appears in neither `activated` nor `omitted`, because none of the four omission reasons
//     applies to it.
//
// Known divergences, both from reading `LoreDecorators` back instead of replaying the switch:
//   - `@@keep_activate_after_match` / `@@dont_activate_after_match` write the same `forceState` as
//     `@@activate` / `@@dont_activate`, and the record does not keep their relative order. Here the two
//     `after_match` variable lookups are applied first and an explicit `@@activate` / `@@dont_activate`
//     overrides them; when both `after_match` variables are already 'true', `dont_activate_after_match`
//     wins. Upstream the last decorator line of the four wins. Only an entry that carries two of them
//     at once can tell the difference.
//   - `@@additional_keys`, `@@exclude_keys` and `@@exclude_keys_all` are pushed onto `searchQueries` in
//     decorator order upstream (:439-460); the record groups them by kind, so they are pushed here in
//     the order additional, exclude, exclude_all, then the entry's own key and secondkey (:522-532).
//     Every query must pass for the entry to activate, so the activation decision is unchanged; only
//     which query short-circuits first, and therefore the match log behind `matchedBy`, can differ.

import { pickHashRand, safeStructuredClone } from './cbs-support.js';
import { type LoreDecoratorRole, interpretLoreDecorators } from './lorebook.js';
import type { loreBook } from './types.js';

/* ------------------------------------------------------------------------------------------------ *
 * Injected dependencies
 * ------------------------------------------------------------------------------------------------ */

export type LoreActivationDeps = {
  /**
   * Replaces `await tokenize(...)` (lorebook.svelte.ts:576), which is the active model's tokenizer.
   * Uimori injects its own estimator. Only the token budget uses it.
   */
  estimateTokens(text: string): number;
  /**
   * Replaces `Math.random()` in the `@@probability` roll (lorebook.svelte.ts:489). A value in [0, 1).
   * It is consumed once per `@@probability` line, for every entry that is not yet activated, on every
   * recursion pass - so a seeded generator reproduces a run exactly.
   */
  random(): number;
  /**
   * Replaces `getChatVar` (lorebook.svelte.ts:328,338), which is chat-scoped storage with RisuAI's
   * default-variable fallback. Read for `__internal_ka_<id>` and `__internal_da_<id>` only. Return ''
   * for an unset key; only the exact string 'true' forces the entry's state.
   */
  getChatVar(key: string): string;
  /**
   * Optional mirror of `setChatVar` (lorebook.svelte.ts:584,587). The writes are returned as
   * `result.variableWrites` whether or not this is supplied; supply it only if the host wants the
   * upstream side effect performed here as well.
   */
  setChatVar?(key: string, value: string): void;
  /**
   * Replaces `risuChatParser(content, {chara: char})` (lorebook.svelte.ts:576), which upstream applies
   * ONLY to count tokens against the CBS-evaluated text. It is not applied to keys, to the returned
   * body, or to the text recursive scanning searches. Defaults to the identity function, which is what
   * tests use; a host that wants upstream's count passes its CBS evaluator with `runVar` off.
   */
  parseCbs?(text: string): string;
};

// No `now()`: `loadLoreBookV3Prompt` reads no clock. Its only non-determinism is `Math.random()`.

/* ------------------------------------------------------------------------------------------------ *
 * Input
 * ------------------------------------------------------------------------------------------------ */

/** One chat message. `data` is the text searched for keys; `role` only labels the match log. */
export type LoreActivationMessage = {
  /**
   * Upstream's `Message['role']` is `'user' | 'char'` and the branch at :122 is `role === 'user'`, so
   * `'system'` - which Uimori has and Risu does not - takes the non-user branch. The choice reaches
   * nothing but the dropped match-log prompt.
   */
  role: 'user' | 'char' | 'system';
  data: string;
};

/**
 * The lorebook settings. Upstream reads each as `char.loreSettings?.<field> ?? <fallback>`
 * (lorebook.svelte.ts:84-88); the fallback is named per field.
 */
export type LoreActivationSettings = {
  /** `?? DBState.db.loreBookDepth`, whose database default is 5 (database.svelte.ts:73-75). */
  scanDepth: number;
  /** `?? DBState.db.loreBookToken`, whose database default is 800 (database.svelte.ts:76-78). */
  tokenBudget: number;
  /** `?? true`. */
  recursiveScanning: boolean;
  /** `?? false`. */
  fullWordMatching: boolean;
};

export type LoreActivationInput = {
  /**
   * Replaces `safeStructuredClone(characterLore.concat(chatLore).concat(moduleLorebook))`
   * (lorebook.svelte.ts:79-82). The caller concatenates in that order - character lore, then chat lore,
   * then module lore - because order decides `mode:'child'` parents (:287) and every tie in the sort.
   * The array and its entries are cloned before use, so neither is modified.
   */
  entries: loreBook[];
  /**
   * Replaces `char.chats[page].message` (lorebook.svelte.ts:83). Oldest first, the current request
   * last. Upstream's `chatLength` is `messages.length + 1` (:87, "includes first message"), and that is
   * what `@@activate_only_after` and `@@activate_only_every` are compared against.
   */
  messages: LoreActivationMessage[];
  settings: LoreActivationSettings;
  /**
   * Replaces `char.chats[page].fmIndex` (lorebook.svelte.ts:379), the index of the chosen first
   * message. `@@is_greeting N` activates only when `(fmIndex ?? -1) + 1 === N`, so the default -1 makes
   * `@@is_greeting 0` the match for a chat with no chosen greeting.
   */
  fmIndex?: number;
};

/* ------------------------------------------------------------------------------------------------ *
 * Result
 * ------------------------------------------------------------------------------------------------ */

/** Upstream's `inject` local (lorebook.svelte.ts:265-270,391-434). */
export type LoreInject = {
  operation: 'append' | 'prepend' | 'replace';
  location: string;
  param: string;
  lore: boolean;
};

/**
 * Which branch activated the entry. Uimori addition - upstream records no such thing.
 *
 * - `constant`: `alwaysActive` (lorebook.svelte.ts:518), so no key search ran.
 * - `child`: a `mode:'child'` entry that took its parent's content (:285-298).
 * - `forced`: `forceState === 'activate'` (:558-560), from `@@activate` or a `__internal_ka_` variable.
 * - `key`: every search query passed, and every match came from a chat message.
 * - `recursive`: as `key`, but at least one positive query matched the content of an already activated
 *   lore instead of a message (:137-143).
 */
export type LoreActivationMatch = 'constant' | 'child' | 'forced' | 'key' | 'recursive';

/** One entry of upstream's returned `actives` (lorebook.svelte.ts:566-580,661-663). */
export type ActivatedLore = {
  /** Index into `input.entries`. Uimori addition. */
  index: number;
  /** Upstream's `prompt`: the entry content with its `@@` decorator block removed, trimmed. */
  body: string;
  /** Upstream's `pos`. `''`, `'depth'`, `'reverse_depth'`, `'after_desc'`, `'before_desc'`,
   *  `'personality'`, `'scenario'`, or a `pt_*` prompt-template slot. */
  position: string;
  /** Upstream's `depth`, 0 unless `@@depth` / `@@reverse_depth` / `@@end` set it. */
  depth: number;
  role: LoreDecoratorRole;
  /** The entry's `insertorder`. The returned array is already ordered by it, ascending. */
  order: number;
  /** `@@priority`, `-1000` for `@@ignore_on_max_context`, else the entry's `insertorder`. */
  priority: number;
  /** What `deps.estimateTokens` returned for this body; what the budget counted. */
  tokens: number;
  /** `comment || 'lorebook <index>'`. `@@inject_lore` targets a lore by this string. */
  source: string;
  inject: LoreInject | null;
  matchedBy: LoreActivationMatch;
};

export type LoreVariableWrite = { key: string; value: string };

export type OmittedLore = {
  index: number;
  /**
   * - `budget`: activated, then cut by the token budget (lorebook.svelte.ts:614-620).
   * - `probability`: the `@@probability` roll failed (:488-493).
   * - `decorator`: `@@activate_only_after`, `@@activate_only_every`, `@@is_greeting`, `@@dont_activate`
   *   or a `__internal_da_` variable turned it off.
   * - `inactive`: no key matched, or the entry has no key and is not always active (:260-262), or it is
   *   a `mode:'child'` entry with no usable parent (:285-298).
   */
  reason: 'budget' | 'probability' | 'decorator' | 'inactive';
};

export type LoreActivationResult = {
  /** Upstream's return value, in its order: ascending `order`, with `@@inject_lore` entries merged into
   *  their targets and removed. */
  activated: ActivatedLore[];
  /** Upstream's `setChatVar` calls, in the order it makes them. */
  variableWrites: LoreVariableWrite[];
  /** Every other entry, ascending by index. Uimori addition. */
  omitted: OmittedLore[];
};

/* ------------------------------------------------------------------------------------------------ *
 * src/ts/process/lorebook.svelte.ts - loadLoreBookV3Prompt
 * ------------------------------------------------------------------------------------------------ */

type SearchQuery = { keys: string[]; negative: boolean; all?: boolean };
type ScanEntry = { source: string; data: string };
type ForceState = 'none' | 'activate' | 'deactivate';

/** `fullLore[i].id ?? pickHashRand(5555, fullLore[i].content).toString()` (lorebook.svelte.ts:328). */
function loreVarId(entry: loreBook): string {
  return entry.id ?? pickHashRand(5555, entry.content).toString();
}

/**
 * RisuAI's lorebook activation engine as a pure function: decides which entries are active for one
 * request, in which order, and where each one goes.
 */
export function activateLore(
  input: LoreActivationInput,
  deps: LoreActivationDeps
): LoreActivationResult {
  const parseCbs = deps.parseCbs ?? ((text: string) => text);

  // :79-88 - everything the upstream prologue reads out of DBState and the selected character.
  const fullLore = safeStructuredClone(input.entries);
  const currentChat = input.messages;
  const loreDepth = input.settings.scanDepth;
  const loreToken = input.settings.tokenBudget;
  const fullWordMatchingSetting = input.settings.fullWordMatching;
  const chatLength = currentChat.length + 1; //includes first message
  const recursiveScanning = input.settings.recursiveScanning;
  const fmIndex = input.fmIndex ?? -1;

  const recursivePrompt: ScanEntry[] = [];
  // :94-98 - upstream also carries each match's `prompt` and matched key; only `source` is used here.
  const matchLog: { source: string }[] = [];

  // :100-230
  const searchMatch = (
    messages: LoreActivationMessage[],
    arg: {
      keys: string[];
      searchDepth: number;
      regex: boolean;
      fullWordMatching: boolean;
      all?: boolean;
      dontSearchWhenRecursive: boolean;
    }
  ): boolean => {
    const sliced = messages.slice(messages.length - arg.searchDepth, messages.length);
    const newKeys: string[] = [];
    for (const key of arg.keys) {
      const trimmed = key.trim();
      if (trimmed.length > 0) {
        newKeys.push(trimmed);
      }
    }
    arg.keys = newKeys;
    let mList: ScanEntry[] = sliced
      .map((msg, i) => {
        if (msg.role === 'user') {
          return { source: `message ${i} by user`, data: msg.data };
        }
        return { source: `message ${i} by char`, data: msg.data };
      })
      .concat(
        // Recursive lore is appended AFTER the depth-limited slice, so the scan depth never bounds it.
        arg.dontSearchWhenRecursive
          ? []
          : recursivePrompt.map((msg) => {
              return { source: `lorebook ${msg.source}`, data: msg.data };
            })
      );

    // :145-172 - regex keys are tested against the raw text, before the lowercasing below.
    if (arg.regex) {
      for (const mText of mList) {
        for (const regexString of arg.keys) {
          if (!regexString.startsWith('/')) {
            return false;
          }
          const regexFlag = regexString.split('/').pop();
          if (regexFlag) {
            arg.keys[0] = regexString.replace(`/${regexFlag}`, '');
            try {
              const regex = new RegExp(arg.keys[0], regexFlag);
              const d = regex.test(mText.data);
              if (d) {
                matchLog.push({ source: mText.source });
                return true;
              }
            } catch (_error) {
              return false;
            }
          }
        }
      }
      return false;
    }

    // :174-180 - both sides are lowercased, and CBS comment tags are removed before matching.
    mList = mList.map((m) => {
      return {
        source: m.source,
        data: m.data
          .toLocaleLowerCase()
          .replace(/\{\{\/\/(.+?)\}\}/g, '')
          .replace(/\{\{comment:(.+?)\}\}/g, ''),
      };
    });

    const allMode = arg.all ?? false;
    let allModeMatched = true;

    // :185-224
    for (const m of mList) {
      let mText = m.data;
      if (arg.fullWordMatching) {
        // Full-word matching splits on a single space only, so punctuation stays attached to the word.
        const splited = mText.split(' ');
        for (const key of arg.keys) {
          if (splited.includes(key.toLocaleLowerCase())) {
            matchLog.push({ source: m.source });
            if (!allMode) {
              return true;
            }
          } else if (allMode) {
            allModeMatched = false;
          }
        }
      } else {
        // Partial matching removes every space from both the text and the key before `includes`.
        mText = mText.replace(/ /g, '');
        for (const key of arg.keys) {
          const realKey = key.toLocaleLowerCase().replace(/ /g, '');
          if (mText.includes(realKey)) {
            matchLog.push({ source: m.source });
            if (!allMode) {
              return true;
            }
          } else if (allMode) {
            allModeMatched = false;
          }
        }
      }
    }
    if (allMode && allModeMatched) {
      return true;
    }
    return false;
  };

  let matching = true;
  const actives: ActivatedLore[] = [];
  const activatedIndexes: number[] = [];
  const variableWrites: LoreVariableWrite[] = [];
  const omittedReason = new Map<number, OmittedLore['reason']>();
  // :252-253 - declared outside both loops and never reset. See the header.
  let keepActivateAfterMatch = false;
  let dontActivateAfterMatch = false;

  while (matching) {
    matching = false;
    for (let i = 0; i < fullLore.length; i++) {
      if (activatedIndexes.includes(i)) {
        continue;
      }
      if (!fullLore[i].alwaysActive && !fullLore[i].key) {
        // :260-262 - checked before the decorators, so `@@activate` cannot save a keyless entry.
        omittedReason.set(i, 'inactive');
        continue;
      }
      let activated = true;
      let reason: OmittedLore['reason'] | null = null;
      const deactivate = (why: OmittedLore['reason']) => {
        activated = false;
        reason ??= why;
      };
      let pos = '';
      let inject: LoreInject | null = null;
      let depth = 0;
      let scanDepth = loreDepth;
      const order = fullLore[i].insertorder;
      let priority = fullLore[i].insertorder;
      let forceState: ForceState = 'none';
      let role: LoreDecoratorRole = 'system';
      const searchQueries: SearchQuery[] = [];
      let fullWordMatching = fullWordMatchingSetting;
      let dontSearchWhenRecursive = false;
      let childPromoted = false;

      // :285-298 - a child takes the content of the first earlier entry sharing its id, but only while
      // that parent is still inactive. `undefined === undefined` is true, so an id-less child adopts
      // the first id-less entry before it.
      if (fullLore[i].mode === 'child') {
        activated = false;
        for (let j = 0; j < i; j++) {
          if (fullLore[j].id === fullLore[i].id) {
            if (!activatedIndexes.includes(j)) {
              fullLore[i].comment = fullLore[j].comment;
              fullLore[i].content = fullLore[j].content;
              fullLore[i].alwaysActive = true;
              activated = true;
              childPromoted = true;
            }
            break;
          }
        }
      }
      let itemRecursive: 'global' | true | false = 'global';

      // :300-515 - the decorator switch, read back from ./lorebook.js. Each block below cites the
      // upstream case it stands for; the readback formulas are the ones LoreDecorators documents.
      const interpreted = interpretLoreDecorators(fullLore[i].content);
      const content = interpreted.body;
      const decorators = interpreted.decorators;

      // :302-305,347-356,384-390 - `@@end`, `@@depth`, `@@reverse_depth` and `@@position` all write
      // `pos`, and the first three also write `depth`.
      if (decorators.position !== null) {
        pos = decorators.position;
      } else if (decorators.reverse_depth !== null) {
        pos = 'reverse_depth';
      } else if (decorators.depth !== null) {
        pos = 'depth';
      }
      depth = decorators.depth ?? decorators.reverse_depth ?? 0;

      // :307-316
      if (decorators.activate_only_after !== null && chatLength < decorators.activate_only_after) {
        deactivate('decorator');
      }
      // :317-326 - `@@activate_only_every 0` gives `chatLength % 0 === NaN`, which is never 0.
      if (
        decorators.activate_only_every !== null &&
        chatLength % decorators.activate_only_every !== 0
      ) {
        deactivate('decorator');
      }
      // :327-336
      if (decorators.keep_activate_after_match) {
        const vara = deps.getChatVar(`__internal_ka_${loreVarId(fullLore[i])}`);
        if (vara === 'true') {
          forceState = 'activate';
        } else {
          keepActivateAfterMatch = true;
        }
      }
      // :337-346
      if (decorators.dont_activate_after_match) {
        const vara = deps.getChatVar(`__internal_da_${loreVarId(fullLore[i])}`);
        if (vara === 'true') {
          forceState = 'deactivate';
        } else {
          dontActivateAfterMatch = true;
        }
      }
      // :363-369
      if (decorators.role !== null) {
        role = decorators.role;
      }
      // :370-373 - a NaN argument is stored, exactly as upstream. See the header.
      if (decorators.scan_depth !== null) {
        scanDepth = decorators.scan_depth;
      }
      // :374-383
      if (decorators.is_greeting !== null && fmIndex + 1 !== decorators.is_greeting) {
        deactivate('decorator');
      }
      // :391-434 - one `inject` object built from whichever of the four decorators appeared.
      if (
        decorators.inject_lore !== null ||
        decorators.inject_at !== null ||
        decorators.inject_replace !== null ||
        decorators.inject_prepend !== null
      ) {
        inject = {
          operation:
            decorators.inject_replace !== null
              ? 'replace'
              : decorators.inject_prepend !== null
                ? 'prepend'
                : 'append',
          location: decorators.inject_lore ?? decorators.inject_at ?? '',
          param: decorators.inject_replace ?? decorators.inject_prepend ?? '',
          lore: decorators.inject_lore !== null,
        };
      }
      // :435-437,494-497 - `@@ignore_on_max_context` is `priority = -1000`; the last write wins.
      if (decorators.priority !== null) {
        priority = decorators.priority;
      }
      // :439-460 - grouped by kind here; see "Known divergences" in the header.
      for (const keys of decorators.additional_keys) {
        searchQueries.push({ keys, negative: false });
      }
      for (const keys of decorators.exclude_keys) {
        searchQueries.push({ keys, negative: true });
      }
      for (const keys of decorators.exclude_keys_all) {
        searchQueries.push({ keys, negative: true, all: true });
      }
      // :461-468
      if (decorators.match_full_word) {
        fullWordMatching = true;
      } else if (decorators.match_partial_word) {
        fullWordMatching = false;
      }
      // :473-480
      if (decorators.activate) {
        forceState = 'activate';
      } else if (decorators.dont_activate) {
        forceState = 'deactivate';
      }
      // :488-493 - one roll per entry per pass. A NaN argument never deactivates, because every
      // comparison with NaN is false.
      if (decorators.probability !== null && deps.random() * 100 > decorators.probability) {
        deactivate('probability');
      }
      // :499-506
      if (decorators.unrecursive) {
        itemRecursive = false;
      } else if (decorators.recursive) {
        itemRecursive = true;
      }
      // :507-510
      if (decorators.no_recursive_search) {
        dontSearchWhenRecursive = true;
      }

      let matchedRecursively = false;
      if (!activated || forceState !== 'none' || fullLore[i].alwaysActive) {
        //if the lore is not activated or force activated, skip the search
      } else {
        // :522-532 - the entry's own keys come after the decorator queries.
        searchQueries.push({
          keys: fullLore[i].key.split(','),
          negative: false,
        });

        if (fullLore[i].secondkey && fullLore[i].selective) {
          searchQueries.push({
            keys: fullLore[i].secondkey.split(','),
            negative: false,
          });
        }

        // :534-555 - every query must pass; the first failure stops the search.
        for (const query of searchQueries) {
          const logged = matchLog.length;
          const result = searchMatch(currentChat, {
            keys: query.keys,
            searchDepth: scanDepth,
            regex: fullLore[i].useRegex ?? false,
            fullWordMatching: fullWordMatching,
            all: query.all,
            dontSearchWhenRecursive: dontSearchWhenRecursive,
          });
          if (query.negative) {
            if (result) {
              deactivate('inactive');
              break;
            }
          } else {
            if (result) {
              // Uimori addition: remember whether this positive query matched recursive lore.
              matchedRecursively ||= matchLog
                .slice(logged)
                .some((entry) => entry.source.startsWith('lorebook '));
            } else {
              deactivate('inactive');
              break;
            }
          }
        }
      }

      // :558-563
      if (forceState === 'activate') {
        activated = true;
        reason = null;
      } else if (forceState === 'deactivate') {
        activated = false;
        reason = 'decorator';
      }

      if (activated) {
        actives.push({
          index: i,
          body: content,
          position: pos,
          depth: depth,
          role: role,
          order: order,
          // Count tokens against the CBS-evaluated text (e.g. {{#if}}, {{getglobalvar}})
          // so cutoff reflects what actually reaches the context, not the unevaluated source.
          // runVar is left false (matching the output path in index.svelte.ts), so this
          // evaluation has no side effects like setvar.
          tokens: deps.estimateTokens(parseCbs(content)),
          priority: priority,
          source: fullLore[i].comment || `lorebook ${i}`,
          inject: inject ?? null,
          matchedBy: childPromoted
            ? 'child'
            : fullLore[i].alwaysActive
              ? 'constant'
              : forceState === 'activate'
                ? 'forced'
                : matchedRecursively
                  ? 'recursive'
                  : 'key',
        });
        activatedIndexes.push(i);
        omittedReason.delete(i);

        // :583-588 - both flags are sticky across entries and passes. See the header.
        if (keepActivateAfterMatch) {
          const write = { key: `__internal_ka_${loreVarId(fullLore[i])}`, value: 'true' };
          variableWrites.push(write);
          deps.setChatVar?.(write.key, write.value);
        }
        if (dontActivateAfterMatch) {
          const write = { key: `__internal_da_${loreVarId(fullLore[i])}`, value: 'true' };
          variableWrites.push(write);
          deps.setChatVar?.(write.key, write.value);
        }

        // :591-603 - an activated entry's body becomes searchable text for every later search, in this
        // pass and the next, and asks for another pass.
        let recursive = recursiveScanning;
        if (itemRecursive !== 'global') {
          recursive = itemRecursive;
        }

        if (recursive) {
          matching = true;
          recursivePrompt.push({
            data: content,
            source: fullLore[i].comment || `lorebook ${i}`,
          });
        }
      } else {
        omittedReason.set(i, reason ?? 'inactive');
      }
    }
  }

  // :608-610 - highest priority first, decided before the budget.
  const activesSorted = actives.sort((a, b) => {
    return b.priority - a.priority;
  });

  let usedTokens = 0;

  // :614-620 - greedy, not a cutoff: a cheap low-priority lore can still fit after an expensive one
  // was skipped.
  const activesFiltered = activesSorted.filter((act) => {
    if (usedTokens + act.tokens <= loreToken) {
      usedTokens += act.tokens;
      return true;
    }
    omittedReason.set(act.index, 'budget');
    return false;
  });

  let activesResorted = activesFiltered.sort((a, b) => {
    return b.order - a.order;
  });

  // :627-633
  const loreinjectionLores = activesResorted.filter(
    (act): act is ActivatedLore & { inject: LoreInject } => act.inject?.lore === true
  );

  activesResorted = activesResorted.filter((act) => {
    return !act?.inject?.lore;
  });

  //I know this will make token count wrong, but performance is more important here

  // :638-659
  for (const lore of loreinjectionLores) {
    const foundLoreIndex = activesResorted.findIndex((l) => {
      return l.source === lore.inject.location;
    });
    if (foundLoreIndex !== -1) {
      const foundLore = activesResorted[foundLoreIndex];
      switch (lore.inject.operation) {
        case 'append': {
          foundLore.body += ` ${lore.body}`;
          break;
        }
        case 'prepend': {
          foundLore.body = `${lore.body} ${foundLore.body}`;
          break;
        }
        case 'replace': {
          foundLore.body = foundLore.body.replace(lore.inject.param, lore.body);
          break;
        }
      }
    }
  }

  const omitted: OmittedLore[] = [...omittedReason]
    .map(([index, reason]) => ({ index, reason }))
    .sort((a, b) => a.index - b.index);

  // :661-663
  return {
    activated: activesResorted.reverse(),
    variableWrites,
    omitted,
  };
}
