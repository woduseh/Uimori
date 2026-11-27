import { describe, expect, it } from 'vitest';
import { shownThrow } from './shown-error.js';
import {
  addDefaultVariable,
  addToggleGroup,
  addToggleItem,
  deleteDefaultVariable,
  deleteToggleGroup,
  deleteToggleItem,
  duplicateToggleItem,
  editDefaultVariable,
  editToggleItem,
  moveToggleGroup,
  moveToggleItem,
  parseDefaultVariableLines,
  parseToggleDocument,
  ungroupToggleGroup,
} from '../web/native-toggle-document.js';
import { serializeNativeToggleLines } from '../web/native-risu-toggle-editor.js';

describe('grouped toggle document', () => {
  it('projects groups and consecutive captions without rewriting any source bytes', () => {
    const source =
      'opaque\r\n\r\n=G=group\na=A=select=, one,,\r\n=first=caption\n=second=caption\r\n# future\n==groupEnd';
    const doc = parseToggleDocument(source);
    expect(serializeNativeToggleLines(doc.lines)).toBe(source);
    expect(doc.groups[1]).toMatchObject({ id: 2, name: 'G', start: 2, end: 8, close: 7 });
    expect(doc.groups[1]?.items[0]).toMatchObject({
      index: 3,
      end: 6,
      caption: 'first\nsecond',
      definition: { options: ', one,,' },
    });
    expect(doc.groups[1]?.items[1]?.raw).toBe('# future');
  });
  it('moves and duplicates an item together with all attached captions at an unterminated tail', () => {
    const source = 'a=A\r\n=first=caption\r\n=second=caption\r\nb=B';
    expect(moveToggleItem(source, 3, -1)).toBe('b=B\r\na=A\r\n=first=caption\r\n=second=caption');
    expect(duplicateToggleItem(source, 0)).toBe(
      'a=A\r\n=first=caption\r\n=second=caption\r\na_2=A\r\n=first=caption\r\n=second=caption\r\nb=B'
    );
    expect(deleteToggleItem(source, 0)).toBe('b=B');
  });
  it('moves complete groups while retaining interstitial unknown source and closed boundaries', () => {
    const source =
      '=One=group\r\na=A\r\n==groupEnd\r\n# between\r\n=Two=group\r\nb=B\r\n==groupEnd';
    const moved = moveToggleGroup(source, 4, -1);
    expect(moved).toBe(
      '=Two=group\r\nb=B\r\n==groupEnd\r\n# between\r\n=One=group\r\na=A\r\n==groupEnd'
    );
    expect(parseToggleDocument(moved).warnings).toEqual([]);
    expect(ungroupToggleGroup(source, 0)).toBe(
      'a=A\r\n# between\r\n=Two=group\r\nb=B\r\n==groupEnd'
    );
    expect(deleteToggleGroup(source, 4)).toBe('=One=group\r\na=A\r\n==groupEnd\r\n# between');
  });
  it('edits fields and multi-line captions while preserving unrelated raw content and empty options', () => {
    const source = '# unknown\r\na=A=select=,one,,\r\n=first=caption\r\n=second=caption';
    expect(editToggleItem(source, 1, { label: 'New' })).toBe(source.replace('a=A', 'a=New'));
    expect(editToggleItem(source, 1, {}, 'first\nsecond')).toBe(source);
    expect(editToggleItem(source, 1, {}, 'new\nmore\nlast')).toBe(
      '# unknown\r\na=A=select=,one,,\r\n=new=caption\r\n=more=caption\r\n=last=caption'
    );
    expect(editToggleItem(source, 1, {}, '')).toBe('# unknown\r\na=A=select=,one,,');
    expect(shownThrow(() => editToggleItem(source, 1, {}, 'x=y'))).toContain('등호');
    const keyed = 'a=A\r\nfirst=Old=caption\nsecond=Keep=caption\r\nb=B';
    expect(editToggleItem(keyed, 0, {}, 'New\nKeep')).toBe(
      'a=A\r\nfirst=New=caption\nsecond=Keep=caption\r\nb=B'
    );
  });
  it('leaves malformed boundaries visible and rejects ambiguous structural operations', () => {
    for (const source of [
      '=Open=group\na=A',
      '==groupEnd\na=A',
      '=One=group\n=Nested=group\na=A\n==groupEnd',
    ]) {
      expect(parseToggleDocument(source).warnings.length).toBeGreaterThan(0);
      expect(serializeNativeToggleLines(parseToggleDocument(source).lines)).toBe(source);
      expect(shownThrow(() => addToggleGroup(source))).toContain('그룹 경계');
      expect(shownThrow(() => addToggleItem(source, -1, 'toggle'))).toContain('그룹 경계');
    }
  });
});

describe('default variable source table', () => {
  it('keeps values as exact strings, including equals, whitespace, leading zeroes and duplicate keys', () => {
    const source = '# unknown\r\na=001\r\n\r\na= false = yes \nempty=\n=opaque';
    expect(parseDefaultVariableLines(source).map(({ key, value }) => [key, value])).toEqual([
      [null, null],
      ['a', '001'],
      [null, null],
      ['a', ' false = yes '],
      ['empty', ''],
      [null, null],
    ]);
    expect(editDefaultVariable(source, 1, { value: 'true=001' })).toBe(
      source.replace('a=001', 'a=true=001')
    );
    expect(editDefaultVariable(source, 3, { key: 'renamed' })).toBe(
      source.replace('a= false', 'renamed= false')
    );
    expect(editDefaultVariable(source, 0, { value: 'ignored' })).toBe(source);
    expect(deleteDefaultVariable(source, 1)).toBe(
      '# unknown\r\n\r\na= false = yes \nempty=\n=opaque'
    );
  });
  it('adds unique keys without merging the final line and prevents line injection', () => {
    expect(addDefaultVariable('new_variable=x\r\nopaque')).toBe(
      'new_variable=x\r\nopaque\r\nnew_variable_2='
    );
    expect(shownThrow(() => editDefaultVariable('a=x', 0, { value: 'x\ny=2' }))).toContain(
      '줄바꿈'
    );
    expect(shownThrow(() => editDefaultVariable('a=x', 0, { key: 'x=y' }))).toContain('등호');
    expect(shownThrow(() => editDefaultVariable('a=x', 0, { key: '   ' }))).toContain('변수 키');
    expect(editDefaultVariable(' spaced key =x', 0, { value: '000' })).toBe(' spaced key =000');
  });
});
