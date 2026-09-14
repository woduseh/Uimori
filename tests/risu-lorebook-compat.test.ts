import { describe, expect, test } from 'vitest';
import {
  type LoreDecorators,
  convertCharbook,
  interpretLoreDecorators,
} from '../third_party/risuai/cad8595a/lorebook.js';
import type {
  CharacterBook,
  charBookEntry,
  loreBook,
} from '../third_party/risuai/cad8595a/types.js';

// Pins the snapshotted RisuAI lorebook normalization. Every expected string here was derived by reading
// RisuAI at cad8595a (src/ts/characterCards.ts:1038-1143 and src/ts/process/lorebook.svelte.ts:300-515)
// and @risuai/ccardlib 0.4.2's decorator parser, not by running RisuAI.

function entry(partial: Partial<charBookEntry> = {}): charBookEntry {
  return {
    keys: ['key'],
    content: 'Body text',
    extensions: {},
    enabled: true,
    insertion_order: 100,
    ...partial,
  };
}

function book(entries: charBookEntry[], extensions: Record<string, any> = {}): CharacterBook {
  return { extensions, entries };
}

function convert(charbook: CharacterBook) {
  return convertCharbook({ lorebook: [], charbook, loresettings: undefined, loreExt: undefined });
}

function convertOne(partial: Partial<charBookEntry>): loreBook {
  return convert(book([entry(partial)])).lorebook[0];
}

describe('convertCharbook: book level', () => {
  test('extracts loresettings only when all three spec fields are present', () => {
    const source = book([], { risu_fullWordMatching: true });
    source.recursive_scanning = true;
    source.scan_depth = 3;
    source.token_budget = 1024;

    const converted = convert(source);

    expect(converted.loresettings).toEqual({
      tokenBudget: 1024,
      scanDepth: 3,
      recursiveScanning: true,
      fullWordMatching: true,
    });
    // loreExt is the book's own extensions object, assigned unconditionally.
    expect(converted.loreExt).toBe(source.extensions);
  });

  test('leaves loresettings untouched when a spec field is missing', () => {
    const source = book([], {});
    source.recursive_scanning = true;
    source.scan_depth = 3;

    const converted = convert(source);

    expect(converted.loresettings).toBeUndefined();
    expect(converted.loreExt).toEqual({});
  });
});

describe('convertCharbook: entry fields', () => {
  test('maps a constant entry onto alwaysActive with comma-space joined keys', () => {
    const converted = convertOne({
      keys: ['alpha', 'beta'],
      constant: true,
      name: 'Alpha note',
      insertion_order: 42,
      case_sensitive: true,
    });

    expect(converted).toMatchObject({
      key: 'alpha, beta',
      secondkey: '',
      insertorder: 42,
      comment: 'Alpha note',
      content: 'Body text',
      mode: 'normal',
      alwaysActive: true,
      selective: false,
      useRegex: false,
      loreCache: null,
    });
    expect(converted.extentions).toEqual({ risu_case_sensitive: true });
  });

  test('drops use_regex when the first key is not a regex literal, keeps it when it is', () => {
    expect(convertOne({ keys: ['plain'], use_regex: true }).useRegex).toBe(false);
    expect(convertOne({ keys: ['/plain/i'], use_regex: true }).useRegex).toBe(true);
  });
});

describe('convertCharbook: extension migration', () => {
  test('writes @@probability only for a used, non-100 probability', () => {
    expect(convertOne({ extensions: { useProbability: true, probability: 50 } }).content).toBe(
      '@@probability 50\nBody text'
    );
    expect(convertOne({ extensions: { useProbability: true, probability: 100 } }).content).toBe(
      'Body text'
    );
    expect(convertOne({ extensions: { useProbability: false, probability: 50 } }).content).toBe(
      'Body text'
    );
  });

  test('writes @@depth and @@role for position 4, mapping the role index', () => {
    const converted = convertOne({ extensions: { position: 4, depth: 5, role: 2 } });

    expect(converted.content).toBe('@@depth 5\n@@role assistant\nBody text');
    // position, depth and role are deleted from the extensions Risu carries over.
    expect(converted.extentions).toEqual({ risu_case_sensitive: undefined });
  });

  test.each([
    [0, 'Body text', true],
    [1, '@@exclude_keys_all x,y\nBody text', false],
    [2, '@@exclude_keys y\n@@exclude_keys x\nBody text', false],
    [3, '@@additional_keys y\n@@additional_keys x\nBody text', false],
  ])('selectiveLogic %i writes its keys and clears selective', (logic, content, selective) => {
    const converted = convertOne({
      secondary_keys: ['x', 'y'],
      selective: true,
      extensions: { selectiveLogic: logic },
    });

    // Each secondary key is prepended in turn, so the last key ends up on the first line.
    expect(converted.content).toBe(content);
    expect(converted.selective).toBe(selective);
    expect(converted.secondkey).toBe('x, y');
  });

  test('ignores selectiveLogic when there are no secondary keys', () => {
    expect(convertOne({ selective: true, extensions: { selectiveLogic: 3 } }).content).toBe(
      'Body text'
    );
  });

  test('writes @@activate_only_after only for a positive delay', () => {
    expect(convertOne({ extensions: { delay: 3 } }).content).toBe(
      '@@activate_only_after 3\nBody text'
    );
    expect(convertOne({ extensions: { delay: 0 } }).content).toBe('Body text');
  });

  test('maps match_whole_words onto the matching word decorator', () => {
    expect(convertOne({ extensions: { match_whole_words: true } }).content).toBe(
      '@@match_full_word\nBody text'
    );
    expect(convertOne({ extensions: { match_whole_words: false } }).content).toBe(
      '@@match_partial_word\nBody text'
    );
  });

  test('prepends every migrated block in Risu order', () => {
    const converted = convertOne({
      keys: ['alpha'],
      secondary_keys: ['x', 'y'],
      selective: true,
      case_sensitive: false,
      extensions: {
        useProbability: true,
        probability: 50,
        position: 4,
        depth: 5,
        role: 2,
        selectiveLogic: 3,
        delay: 3,
        match_whole_words: true,
      },
    });

    expect(converted.content).toBe(
      [
        '@@match_full_word',
        '@@activate_only_after 3',
        '@@additional_keys y',
        '@@additional_keys x',
        '@@depth 5',
        '@@role assistant',
        '@@probability 50',
        'Body text',
      ].join('\n')
    );
    // selectiveLogic is the one migrated key Risu does not delete.
    expect(converted.extentions).toEqual({ selectiveLogic: 3, risu_case_sensitive: false });
  });
});

describe('interpretLoreDecorators: block and body', () => {
  test('strips the leading decorator block and trims the body', () => {
    const result = interpretLoreDecorators('@@depth 3\n\nBody text\n');

    expect(result.body).toBe('Body text');
    expect(result.decorators.depth).toBe(3);
  });

  test('leaves mid-body @@ lines in the body', () => {
    const result = interpretLoreDecorators('@@depth 3\nBody text\n@@role user\nMore');

    expect(result.body).toBe('Body text\n@@role user\nMore');
    expect(result.decorators.role).toBeNull();
  });

  test('reports unknown decorators and keeps them out of the body', () => {
    const result = interpretLoreDecorators('@@no_such_thing 1\n@@depth 3\nBody text');

    expect(result.unknown).toEqual(['no_such_thing']);
    expect(result.body).toBe('Body text');
  });

  test('does not lowercase decorator names, so @@Depth is unknown', () => {
    const result = interpretLoreDecorators('@@Depth 3\nBody text');

    expect(result.unknown).toEqual(['Depth']);
    expect(result.decorators.depth).toBeNull();
  });

  test('runs an @@@ fallback only after the previous decorator was rejected', () => {
    expect(interpretLoreDecorators('@@role nobody\n@@@role user\nBody').decorators.role).toBe(
      'user'
    );
    expect(interpretLoreDecorators('@@role user\n@@@role assistant\nBody').decorators.role).toBe(
      'user'
    );
    // @@@end is rewritten to @@end before the fallback test, so it always runs.
    expect(interpretLoreDecorators('@@role user\n@@@end\nBody').decorators.end).toBe(true);
  });

  test('a known decorator with a bad argument is rejected, not reported as unknown', () => {
    const result = interpretLoreDecorators('@@role nobody\n@@depth abc\nBody');

    expect(result.unknown).toEqual([]);
    expect(result.decorators.role).toBeNull();
    expect(result.decorators.depth).toBeNull();
  });
});

describe('interpretLoreDecorators: arguments', () => {
  test.each<[string, Partial<LoreDecorators>]>([
    ['@@depth 3', { depth: 3 }],
    ['@@reverse_depth 3', { reverse_depth: 3 }],
    ['@@end', { end: true, depth: 0 }],
    ['@@role assistant', { role: 'assistant' }],
    ['@@position after_desc', { position: 'after_desc' }],
    ['@@position pt_custom', { position: 'pt_custom' }],
    ['@@additional_keys a,b', { additional_keys: [['a', 'b']] }],
    ['@@additional_keys a, b', { additional_keys: [['a', 'b']] }],
    ['@@exclude_keys a', { exclude_keys: [['a']] }],
    ['@@exclude_keys_all a,b', { exclude_keys_all: [['a', 'b']] }],
    ['@@probability 50', { probability: 50 }],
    ['@@priority 7', { priority: 7 }],
    ['@@ignore_on_max_context', { ignore_on_max_context: true, priority: -1000 }],
    ['@@activate_only_after 4', { activate_only_after: 4 }],
    ['@@activate_only_every 2', { activate_only_every: 2 }],
    ['@@is_greeting 1', { is_greeting: 1 }],
    ['@@scan_depth 6', { scan_depth: 6 }],
    ['@@keep_activate_after_match', { keep_activate_after_match: true }],
    ['@@dont_activate_after_match', { dont_activate_after_match: true }],
    ['@@activate', { activate: true }],
    ['@@dont_activate', { dont_activate: true }],
    ['@@match_full_word', { match_full_word: true }],
    ['@@match_partial_word', { match_partial_word: true }],
    ['@@recursive', { recursive: true }],
    ['@@unrecursive', { unrecursive: true }],
    ['@@no_recursive_search', { no_recursive_search: true }],
    ['@@is_user_icon', { is_user_icon: true }],
    ['@@instruct_depth 3', { instruct_depth: true }],
    ['@@disable_ui_prompt system_prompt', { disable_ui_prompt: ['system_prompt'] }],
    ['@@inject_lore some place', { inject_lore: 'some place' }],
    ['@@inject_at some place', { inject_at: 'some place' }],
    ['@@inject_replace token', { inject_replace: 'token' }],
    ['@@inject_prepend token', { inject_prepend: 'token' }],
  ])('%s', (line, expected) => {
    const result = interpretLoreDecorators(`${line}\nBody`);

    expect(result.body).toBe('Body');
    expect(result.unknown).toEqual([]);
    expect(result.decorators).toMatchObject(expected);
  });

  test('rejects arguments Risu does not accept', () => {
    expect(interpretLoreDecorators('@@role nobody\nB').decorators.role).toBeNull();
    expect(interpretLoreDecorators('@@position nowhere\nB').decorators.position).toBeNull();
    expect(interpretLoreDecorators('@@position\nB').decorators.position).toBeNull();
    expect(
      interpretLoreDecorators('@@disable_ui_prompt description\nB').decorators.disable_ui_prompt
    ).toEqual([]);
  });

  test('stores an unchecked parseInt result, NaN included', () => {
    expect(interpretLoreDecorators('@@scan_depth abc\nB').decorators.scan_depth).toBeNaN();
    expect(interpretLoreDecorators('@@priority abc\nB').decorators.priority).toBeNaN();
    expect(interpretLoreDecorators('@@probability abc\nB').decorators.probability).toBeNaN();
  });
});

describe('interpretLoreDecorators: shared upstream slots', () => {
  test('the last writer of pos and depth wins', () => {
    const afterPosition = interpretLoreDecorators('@@depth 3\n@@position after_desc\nB').decorators;
    expect(afterPosition).toMatchObject({ depth: 3, position: 'after_desc' });

    const afterDepth = interpretLoreDecorators('@@position after_desc\n@@depth 3\nB').decorators;
    expect(afterDepth).toMatchObject({ depth: 3, position: null });

    const afterReverse = interpretLoreDecorators('@@depth 3\n@@reverse_depth 4\nB').decorators;
    expect(afterReverse).toMatchObject({ depth: null, reverse_depth: 4 });
  });

  test('the last writer of the opposing flag pairs wins', () => {
    const words = interpretLoreDecorators('@@match_full_word\n@@match_partial_word\nB').decorators;
    expect(words).toMatchObject({ match_full_word: false, match_partial_word: true });

    const force = interpretLoreDecorators('@@dont_activate\n@@activate\nB').decorators;
    expect(force).toMatchObject({ activate: true, dont_activate: false });

    const recursion = interpretLoreDecorators('@@recursive\n@@unrecursive\nB').decorators;
    expect(recursion).toMatchObject({ recursive: false, unrecursive: true });
  });

  test('the priority slot holds the last written value', () => {
    expect(
      interpretLoreDecorators('@@ignore_on_max_context\n@@priority 7\nB').decorators
    ).toMatchObject({ priority: 7, ignore_on_max_context: true });
    expect(
      interpretLoreDecorators('@@priority 7\n@@ignore_on_max_context\nB').decorators
    ).toMatchObject({ priority: -1000, ignore_on_max_context: true });
  });

  test('the four inject decorators resolve to one injection', () => {
    const both = interpretLoreDecorators('@@inject_at slot\n@@inject_prepend token\nB').decorators;
    expect(both).toMatchObject({
      inject_at: 'slot',
      inject_lore: null,
      inject_prepend: 'token',
      inject_replace: null,
    });

    const relocated = interpretLoreDecorators('@@inject_lore a\n@@inject_at b\nB').decorators;
    expect(relocated).toMatchObject({ inject_lore: null, inject_at: 'b' });
  });

  test('repeated key decorators accumulate in order', () => {
    const result = interpretLoreDecorators('@@additional_keys a\n@@additional_keys b,c\nB');

    expect(result.decorators.additional_keys).toEqual([['a'], ['b', 'c']]);
  });
});

describe('convertCharbook output feeds interpretLoreDecorators', () => {
  test('a migrated entry reads back as the decorators Risu wrote', () => {
    const converted = convertOne({
      secondary_keys: ['x', 'y'],
      selective: true,
      extensions: {
        useProbability: true,
        probability: 50,
        position: 4,
        depth: 5,
        role: 2,
        selectiveLogic: 3,
        delay: 3,
        match_whole_words: true,
      },
    });

    const result = interpretLoreDecorators(converted.content);

    expect(result.body).toBe('Body text');
    expect(result.unknown).toEqual([]);
    expect(result.decorators).toMatchObject({
      match_full_word: true,
      activate_only_after: 3,
      additional_keys: [['y'], ['x']],
      depth: 5,
      role: 'assistant',
      probability: 50,
    });
  });
});
