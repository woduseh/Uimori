import { describe, expect, test } from 'vitest';
import {
  type LoreActivationDeps,
  type LoreActivationInput,
  type LoreActivationMessage,
  activateLore,
} from '../third_party/risuai/cad8595a/lore-activation.js';
import type { loreBook } from '../third_party/risuai/cad8595a/types.js';

// Pins the snapshotted RisuAI lorebook activation engine. Every expectation here was derived by reading
// RisuAI at cad8595a (src/ts/process/lorebook.svelte.ts:75-664) and @risuai/ccardlib 0.4.2's decorator
// parser, not by running RisuAI. Each test names the upstream lines it stands for.

function entry(partial: Partial<loreBook> = {}): loreBook {
  return {
    key: 'alpha',
    secondkey: '',
    insertorder: 100,
    comment: '',
    content: 'Body',
    mode: 'normal',
    alwaysActive: false,
    selective: false,
    ...partial,
  };
}

function user(data: string): LoreActivationMessage {
  return { role: 'user', data };
}

type RunOptions = {
  messages?: LoreActivationMessage[];
  settings?: Partial<LoreActivationInput['settings']>;
  fmIndex?: number;
  random?: number;
  chatVars?: Record<string, string>;
};

function run(entries: loreBook[], options: RunOptions = {}) {
  const deps: LoreActivationDeps = {
    // One token per character, so a budget expectation reads off the body length.
    estimateTokens: (text) => text.length,
    random: () => options.random ?? 0.5,
    getChatVar: (key) => options.chatVars?.[key] ?? '',
  };
  return activateLore(
    {
      entries,
      messages: options.messages ?? [user('alpha time')],
      settings: {
        // RisuAI's own fallbacks: database.svelte.ts:73-78 for the first two, lorebook.svelte.ts:86,88
        // for the other two.
        scanDepth: 5,
        tokenBudget: 800,
        recursiveScanning: true,
        fullWordMatching: false,
        ...options.settings,
      },
      fmIndex: options.fmIndex,
    },
    deps
  );
}

function activatedBodies(entries: loreBook[], options: RunOptions = {}): string[] {
  return run(entries, options).activated.map((lore) => lore.body);
}

describe('key matching', () => {
  test('a constant entry activates with no key and no search (:260-262,518-520)', () => {
    const result = run([entry({ key: '', alwaysActive: true, content: 'Always here' })], {
      messages: [user('nothing relevant')],
    });

    expect(result.activated).toHaveLength(1);
    expect(result.activated[0]).toMatchObject({ body: 'Always here', matchedBy: 'constant' });
  });

  test('an entry with no key and no alwaysActive is skipped before its decorators (:260-262)', () => {
    // The skip happens before the decorator switch runs, so even @@activate cannot save it.
    const result = run([entry({ key: '', content: '@@activate\nBody' })]);

    expect(result.activated).toHaveLength(0);
    expect(result.omitted).toEqual([{ index: 0, reason: 'inactive' }]);
  });

  test('only the last `scanDepth` messages are searched (:108)', () => {
    const messages = [user('alpha time'), user('one'), user('two'), user('three')];

    // `messages.slice(len - 2, len)` leaves the last two, which do not carry the key.
    expect(activatedBodies([entry()], { messages, settings: { scanDepth: 2 } })).toEqual([]);
    expect(activatedBodies([entry()], { messages, settings: { scanDepth: 4 } })).toEqual(['Body']);
  });

  test('full-word matching splits on a single space, partial matching removes spaces (:187-223)', () => {
    const messages = [user('alphabet soup')];

    // Partial: 'alphabetsoup'.includes('alpha'). Full word: ['alphabet','soup'].includes('alpha').
    expect(activatedBodies([entry()], { messages })).toEqual(['Body']);
    expect(activatedBodies([entry()], { messages, settings: { fullWordMatching: true } })).toEqual(
      []
    );
    // @@match_full_word / @@match_partial_word override the book setting (:461-468).
    expect(
      activatedBodies([entry({ content: '@@match_full_word\nBody' })], { messages })
    ).toEqual([]);
    expect(
      activatedBodies([entry({ content: '@@match_partial_word\nBody' })], {
        messages,
        settings: { fullWordMatching: true },
      })
    ).toEqual(['Body']);
  });

  test('plain matching is case-insensitive on both sides (:177-179,190,208)', () => {
    // The message text and every key are lowercased before comparison; risu_case_sensitive is never
    // read by loadLoreBookV3Prompt.
    expect(activatedBodies([entry({ key: 'ALPHA' })], { messages: [user('alpha time')] })).toEqual([
      'Body',
    ]);
    expect(
      activatedBodies([entry({ key: 'alpha', extentions: { risu_case_sensitive: true } })], {
        messages: [user('ALPHA TIME')],
      })
    ).toEqual(['Body']);
  });

  test('a regex key keeps its leading slash and honours its own flags (:145-172)', () => {
    // `/alpha/i`: regexFlag is 'i', `replace('/i','')` strips the LAST '/i', so the compiled pattern
    // is '/alpha' - the literal slash included - with the 'i' flag.
    const regexEntry = entry({ key: '/alpha/i', useRegex: true });

    expect(activatedBodies([regexEntry], { messages: [user('say /ALPHA now')] })).toEqual(['Body']);
    // Without the 'i' flag the same text no longer matches: the regex path never lowercases.
    expect(
      activatedBodies([entry({ key: '/alpha/g', useRegex: true })], {
        messages: [user('say /ALPHA now')],
      })
    ).toEqual([]);
    // And the bare word without the slash does not match either.
    expect(activatedBodies([regexEntry], { messages: [user('say alpha now')] })).toEqual([]);
  });
});

describe('secondary keys and key decorators', () => {
  test('selective requires the secondkey as well (:527-532)', () => {
    const selective = entry({ secondkey: 'beta', selective: true });

    expect(activatedBodies([selective], { messages: [user('alpha time')] })).toEqual([]);
    expect(activatedBodies([selective], { messages: [user('alpha and beta')] })).toEqual(['Body']);
    // Without `selective` the secondkey is not searched at all.
    expect(
      activatedBodies([entry({ secondkey: 'beta' })], { messages: [user('alpha time')] })
    ).toEqual(['Body']);
  });

  test('@@additional_keys adds a query every one of which must pass (:439-445)', () => {
    // convertCharbook writes one @@additional_keys line per secondary key for selectiveLogic 3.
    const both = entry({ content: '@@additional_keys beta\n@@additional_keys gamma\nBody' });

    expect(activatedBodies([both], { messages: [user('alpha beta gamma')] })).toEqual(['Body']);
    expect(activatedBodies([both], { messages: [user('alpha beta')] })).toEqual([]);
  });

  test('@@exclude_keys deactivates when any excluded key matches (:446-452)', () => {
    const excluding = entry({ content: '@@exclude_keys beta\nBody' });

    expect(activatedBodies([excluding], { messages: [user('alpha time')] })).toEqual(['Body']);
    expect(activatedBodies([excluding], { messages: [user('alpha and beta')] })).toEqual([]);
  });

  test('@@exclude_keys_all needs every key in every scanned message (:453-459,182-227)', () => {
    // `all` mode clears allModeMatched as soon as one key misses one message, so a single message
    // carrying both keys excludes the entry and a message carrying one of them does not.
    const excluding = entry({ content: '@@exclude_keys_all beta,gamma\nBody' });

    expect(activatedBodies([excluding], { messages: [user('alpha beta gamma')] })).toEqual([]);
    expect(activatedBodies([excluding], { messages: [user('alpha beta')] })).toEqual(['Body']);
  });
});

describe('recursive scanning', () => {
  test('an activated entry becomes searchable text for a later pass (:591-603,137-143)', () => {
    // The keyed entry comes first, so it fails in pass 1 and only matches once the constant entry
    // below it has pushed its content onto recursivePrompt.
    const entries = [
      entry({ key: 'bridge', content: 'The bridge is out', comment: 'bridge note' }),
      entry({ key: '', alwaysActive: true, content: 'Cross the bridge at dawn', comment: 'road' }),
    ];

    const result = run(entries, { messages: [user('nothing relevant')] });

    expect(result.activated.map((lore) => lore.matchedBy)).toEqual(['recursive', 'constant']);
    expect(result.omitted).toEqual([]);
    // recursiveScanning: false stops the second activation entirely.
    expect(
      run(entries, {
        messages: [user('nothing relevant')],
        settings: { recursiveScanning: false },
      }).activated.map((lore) => lore.matchedBy)
    ).toEqual(['constant']);
  });
});

describe('decorators that decide activation', () => {
  test('@@activate_only_after compares against messages.length + 1 (:87,307-316)', () => {
    const messages = [user('alpha one'), user('alpha two')];
    const delayed = (n: number) => entry({ content: `@@activate_only_after ${n}\nBody` });

    // chatLength is 3 here: two messages plus the first message Risu counts but does not store.
    expect(activatedBodies([delayed(3)], { messages })).toEqual(['Body']);
    expect(activatedBodies([delayed(4)], { messages })).toEqual([]);
    expect(run([delayed(4)], { messages }).omitted).toEqual([{ index: 0, reason: 'decorator' }]);
  });

  test('@@probability rolls random() * 100 against the argument (:488-493)', () => {
    // random() is pinned at 0.5, so the roll is 50 > argument.
    expect(activatedBodies([entry({ content: '@@probability 100\nBody' })])).toEqual(['Body']);
    expect(activatedBodies([entry({ content: '@@probability 0\nBody' })])).toEqual([]);
    expect(run([entry({ content: '@@probability 0\nBody' })]).omitted).toEqual([
      { index: 0, reason: 'probability' },
    ]);
    // The comparison is `>`, so a roll of exactly 0 survives @@probability 0.
    expect(activatedBodies([entry({ content: '@@probability 0\nBody' })], { random: 0 })).toEqual([
      'Body',
    ]);
  });

  test('@@dont_activate wins over a matching key (:477-479,561-563)', () => {
    const result = run([entry({ content: '@@dont_activate\nBody' })]);

    expect(result.activated).toEqual([]);
    expect(result.omitted).toEqual([{ index: 0, reason: 'decorator' }]);
  });

  test('@@is_greeting compares (fmIndex ?? -1) + 1 (:374-383)', () => {
    const greeting = entry({ content: '@@is_greeting 2\nBody' });

    expect(activatedBodies([greeting], { fmIndex: 1 })).toEqual(['Body']);
    expect(activatedBodies([greeting], { fmIndex: 0 })).toEqual([]);
    expect(activatedBodies([entry({ content: '@@is_greeting 0\nBody' })])).toEqual(['Body']);
  });
});

describe('@@keep_activate_after_match', () => {
  test('an unset variable is written on activation (:327-336,583-585)', () => {
    const result = run([entry({ id: 'lore-1', content: '@@keep_activate_after_match\nBody' })]);

    expect(result.activated.map((lore) => lore.matchedBy)).toEqual(['key']);
    expect(result.variableWrites).toEqual([{ key: '__internal_ka_lore-1', value: 'true' }]);
  });

  test("a variable already 'true' forces activation without a key match (:327-336,558-560)", () => {
    const result = run([entry({ id: 'lore-1', content: '@@keep_activate_after_match\nBody' })], {
      messages: [user('nothing relevant')],
      chatVars: { __internal_ka_lore_1: 'true', '__internal_ka_lore-1': 'true' },
    });

    expect(result.activated.map((lore) => lore.matchedBy)).toEqual(['forced']);
    // keepActivateAfterMatch was never set, so nothing is written back.
    expect(result.variableWrites).toEqual([]);
  });

  test('the flag is never reset, so later entries are written too (:252-253,583-585)', () => {
    // Upstream declares keepActivateAfterMatch outside both loops. The snapshot reproduces the bug:
    // the second entry carries no decorator at all and still gets a write.
    const result = run([
      entry({ id: 'lore-1', content: '@@keep_activate_after_match\nFirst' }),
      entry({ id: 'lore-2', content: 'Second' }),
    ]);

    expect(result.variableWrites).toEqual([
      { key: '__internal_ka_lore-1', value: 'true' },
      { key: '__internal_ka_lore-2', value: 'true' },
    ]);
  });
});

describe('placement, priority and the token budget', () => {
  test('@@position, @@depth and @@role reach the result (:302-305,347-356,363-369,384-390)', () => {
    const result = run([
      entry({ key: 'alpha', content: '@@depth 3\n@@role user\nAt depth' }),
      entry({ key: 'alpha', content: '@@position after_desc\nAfter the description', insertorder: 200 }),
      entry({ key: 'alpha', content: '@@end\nAt the end', insertorder: 300 }),
    ]);

    expect(result.activated).toMatchObject([
      { body: 'At depth', position: 'depth', depth: 3, role: 'user' },
      // @@position writes `pos` only, and the entry set no depth, so depth stays 0.
      { body: 'After the description', position: 'after_desc', depth: 0, role: 'system' },
      // @@end is `pos = 'depth'; depth = 0`.
      { body: 'At the end', position: 'depth', depth: 0, role: 'system' },
    ]);
  });

  test('the budget drops the lowest @@priority and the rest come back in insertorder (:494-497,608-624)', () => {
    // estimateTokens is the body length, so each body costs 4 and a budget of 8 fits two of them.
    const result = run(
      [
        entry({ content: '@@priority 5\nAAAA', insertorder: 200 }),
        entry({ content: '@@priority 9\nBBBB', insertorder: 300 }),
        entry({ content: '@@priority 7\nCCCC', insertorder: 100 }),
      ],
      { settings: { tokenBudget: 8 } }
    );

    // Sorted by priority (9, 7, 5), filtered to the first two, then returned ascending by order.
    expect(result.activated.map((lore) => lore.body)).toEqual(['CCCC', 'BBBB']);
    expect(result.omitted).toEqual([{ index: 0, reason: 'budget' }]);
  });

  test('@@ignore_on_max_context makes the entry the first one dropped (:435-437)', () => {
    const result = run(
      [
        entry({ content: '@@ignore_on_max_context\nAAAA' }),
        entry({ content: 'BBBB', insertorder: 100 }),
      ],
      { settings: { tokenBudget: 4 } }
    );

    expect(result.activated.map((lore) => lore.priority)).toEqual([100]);
    expect(result.omitted).toEqual([{ index: 0, reason: 'budget' }]);
  });

  test('@@inject_lore merges into its target and leaves the result (:391-434,627-659)', () => {
    const result = run([
      entry({ key: 'alpha', comment: 'target', content: 'Target body' }),
      entry({ key: 'alpha', content: '@@inject_lore target\nextra', insertorder: 200 }),
    ]);

    expect(result.activated).toHaveLength(1);
    expect(result.activated[0]).toMatchObject({ source: 'target', body: 'Target body extra' });
    // The injected entry is neither returned nor reported as omitted; no omission reason applies.
    expect(result.omitted).toEqual([]);
  });
});
