import { describe, expect, it } from 'vitest';
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
  moveToggleItemToGroup,
  parseDefaultVariableLines,
  parseToggleDocument,
  renameToggleGroup,
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
  it('does not attach captions through blank, unknown, or divider rows', () => {
    const doc = parseToggleDocument(
      'a=A\n\n=alone=caption\n# raw\n=also alone=caption\n=Break=divider\n=last=caption'
    );
    expect(doc.groups[0]?.items).toHaveLength(7);
    expect(doc.groups[0]?.items.every((item) => item.caption === '')).toBe(true);
  });
  it('moves between visible rows while preserving intervening blank source rows', () => {
    expect(moveToggleItem('a=A\r\n  \r\n\r\nb=B', 0, 1)).toBe('b=B\r\n  \r\n\r\na=A');
    expect(moveToggleItem('a=A\n\n# unknown\nb=B', 0, 1)).toBe('# unknown\n\na=A\nb=B');
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
  it('moves items between earlier and later groups and out to the ungrouped tail', () => {
    const source = '=One=group\na=A\n=help=caption\n==groupEnd\n=Two=group\nb=B\n==groupEnd';
    expect(moveToggleItemToGroup(source, 1, 4)).toBe(
      '=One=group\n==groupEnd\n=Two=group\nb=B\na=A\n=help=caption\n==groupEnd'
    );
    expect(moveToggleItemToGroup(source, 5, 0)).toBe(
      '=One=group\na=A\n=help=caption\nb=B\n==groupEnd\n=Two=group\n==groupEnd'
    );
    expect(moveToggleItemToGroup(source, 1, -1)).toBe(
      '=One=group\n==groupEnd\n=Two=group\nb=B\n==groupEnd\na=A\n=help=caption'
    );
  });
  it('edits fields and multi-line captions while preserving unrelated raw content and empty options', () => {
    const source = '# unknown\r\na=A=select=,one,,\r\n=first=caption\r\n=second=caption';
    expect(editToggleItem(source, 1, { label: 'New' })).toBe(source.replace('a=A', 'a=New'));
    expect(editToggleItem(source, 1, {}, 'first\nsecond')).toBe(source);
    expect(editToggleItem(source, 1, {}, 'new\nmore\nlast')).toBe(
      '# unknown\r\na=A=select=,one,,\r\n=new=caption\r\n=more=caption\r\n=last=caption'
    );
    expect(editToggleItem(source, 1, {}, '')).toBe('# unknown\r\na=A=select=,one,,');
    expect(() => editToggleItem(source, 1, {}, 'x=y')).toThrow('등호');
  });
  it('adds bounded groups and controls while reserving keys from unknown rows', () => {
    expect(addToggleGroup('opaque', 'G')).toBe('opaque\n=G=group\n==groupEnd');
    expect(renameToggleGroup('special=Old=group\r\n==groupEnd', 0, 'New')).toBe(
      'special=New=group\r\n==groupEnd'
    );
    expect(addToggleItem('=G=group\r\nnew_toggle=Future=unknown\r\n==groupEnd', 0, 'text')).toBe(
      '=G=group\r\nnew_toggle=Future=unknown\r\nnew_toggle_2=새 항목=text\r\n==groupEnd'
    );
    expect(addToggleItem('', -1, 'select')).toBe('new_toggle=새 항목=select=선택 1,선택 2');
  });
  it('preserves explicit caption keys and untouched caption bytes during a description edit', () => {
    const source = 'a=A\r\nfirst=Old=caption\nsecond=Keep=caption\r\nb=B';
    expect(editToggleItem(source, 0, {}, 'New\nKeep')).toBe(
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
      expect(() => addToggleGroup(source)).toThrow('그룹 경계');
      expect(() => addToggleItem(source, -1, 'toggle')).toThrow('그룹 경계');
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
    expect(() => editDefaultVariable('a=x', 0, { value: 'x\ny=2' })).toThrow('줄바꿈');
    expect(() => editDefaultVariable('a=x', 0, { key: 'x=y' })).toThrow('등호');
    expect(() => editDefaultVariable('a=x', 0, { key: '   ' })).toThrow('변수 키');
    expect(editDefaultVariable(' spaced key =x', 0, { value: '000' })).toBe(' spaced key =000');
  });
});
