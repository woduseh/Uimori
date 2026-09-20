import { describe, expect, it } from 'vitest';
import {
  parseNativeRegexJson,
  patchNativeRegex,
  readNativeRegexFlags,
  setNativeRegexOrder,
  toggleNativeRegexAction,
  toggleNativeRegexFlag,
} from '../web/native-risu-regex.js';

describe('native regex editor source preservation', () => {
  it('edits native fields and existing aliases without changing unknown source metadata', () => {
    const entry = {
      in: 'native',
      find: 'alias',
      out: 'old',
      replace: 'other',
      type: 'editdisplay',
      ableFlag: false,
      extra: { nested: ['keep'] },
    };
    expect(patchNativeRegex(entry, { in: '', out: '$1 {{getvar::place}}' })).toEqual({
      ...entry,
      in: '',
      find: '',
      out: '$1 {{getvar::place}}',
      replace: '$1 {{getvar::place}}',
    });
    expect(entry.find).toBe('alias');
    expect(patchNativeRegex({ in: 'a', out: 'b' }, { in: 'c' })).toEqual({ in: 'c', out: 'b' });
    expect(patchNativeRegex(entry, { comment: 'Changed' })).toMatchObject({
      find: 'alias',
      replace: 'other',
      ableFlag: false,
    });
  });

  it('keeps tag text intact when toggling normal flags', () => {
    const flag = 'gi<move_top><custom_i><cbs,order -3>y';
    expect(toggleNativeRegexFlag(flag, 'i')).toBe('g<move_top><custom_i><cbs,order -3>y');
    expect(toggleNativeRegexFlag('g<custom_i>', 'i')).toBe('g<custom_i>i');
    expect(readNativeRegexFlags(flag)).toEqual({
      flags: 'giy',
      actions: ['move_top', 'custom_i', 'cbs', 'order -3'],
      order: -3,
    });
  });

  it('updates the requested action or priority without dropping unknown extensions', () => {
    const flag = 'gi<custom, cbs, order 2><repeat_back><order -1>';
    expect(toggleNativeRegexAction(flag, 'cbs')).toBe('gi<custom, order 2><repeat_back><order -1>');
    expect(toggleNativeRegexAction('g<custom>', 'no_end_nl')).toBe('g<custom><no_end_nl>');
    const reordered = setNativeRegexOrder(flag, 5);
    expect(reordered).toBe('gi<custom, cbs><repeat_back><order 5>');
    expect(readNativeRegexFlags(reordered).order).toBe(5);
  });

  it('requires a rule array but preserves unknown fields and unsupported stages', () => {
    const value = [{ type: 'future-mode', in: 'x', out: '', mystery: { keep: true } }];
    expect(parseNativeRegexJson(JSON.stringify(value))).toEqual(value);
    expect(() => parseNativeRegexJson('{"in":"x"}')).toThrow('배열');
    expect(() => parseNativeRegexJson('[null]')).toThrow('배열');
    expect(() => parseNativeRegexJson('[unfinished')).toThrow();
  });
});
