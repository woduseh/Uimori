import { describe, expect, it } from 'vitest';
import {
  addNativeToggleLine,
  editNativeToggleLine,
  moveNativeToggleLine,
  nativeToggleGroupWarnings,
  nativeToggleTypes,
  parseNativeToggleLines,
  removeNativeToggleLine,
  serializeNativeToggleLines,
} from '../web/native-risu-toggle-editor.js';

describe('native toggle definition editor source preservation', () => {
  it('round-trips mixed newlines, whitespace, malformed lines and future syntax exactly', () => {
    for (const raw of [
      '',
      '\n',
      '  \r\n',
      'a=A\r\n\n# unknown\rb=B=future=opaque\nlast',
      'a=A\n',
    ]) {
      expect(serializeNativeToggleLines(parseNativeToggleLines(raw))).toBe(raw);
    }
  });

  it('recognizes all eight native forms and preserves select whitespace and empty options', () => {
    const raw =
      'on=Enabled\nmode=Mode=select= one,, two ,\nname=Name=text\nstory=Story=textarea\n=Section=divider\n=Help=caption\n=Group=group\n==groupEnd';
    const lines = parseNativeToggleLines(raw);
    expect(lines.map((line) => line.definition?.type)).toEqual(nativeToggleTypes);
    expect(lines[1]?.definition?.options).toBe(' one,, two ,');
    expect(editNativeToggleLine(raw, 1, { label: 'New mode' })).toBe(
      raw.replace('mode=Mode', 'mode=New mode')
    );
  });

  it('edits one known line without rewriting unrelated source or explicit structural keys', () => {
    const raw =
      'unknown\r\na=Label=text\ncustom=Group=group\r\nb=Title=select=x,, y\nopaque=Label=future=keep\n';
    expect(editNativeToggleLine(raw, 1, { label: 'Changed' })).toBe(
      raw.replace('a=Label', 'a=Changed')
    );
    expect(editNativeToggleLine(raw, 2, { label: 'Changed' })).toBe(
      raw.replace('custom=Group', 'custom=Changed')
    );
    expect(editNativeToggleLine(raw, 3, { label: 'Title' })).toBe(raw);
    expect(editNativeToggleLine(raw, 0, { label: 'Ignore' })).toBe(raw);
  });

  it('keeps ambiguous extra fields and unknown type suffixes raw instead of truncating', () => {
    const raw = '=Title=future\na=Name=text=metadata\na=Name=select=x=y\nnot a definition';
    expect(parseNativeToggleLines(raw).every((line) => line.definition === null)).toBe(true);
    expect(editNativeToggleLine(raw, 1, { label: 'Changed' })).toBe(raw);
  });

  it('rejects form edits that would silently change native grammar', () => {
    expect(() => editNativeToggleLine('a=Label', 0, { label: 'x=y' })).toThrow('등호');
    expect(() => editNativeToggleLine('a=Label', 0, { key: '' })).toThrow('변수 키');
    expect(() => editNativeToggleLine('a=Label', 0, { label: 'x\ny' })).toThrow('줄바꿈');
  });

  it('changes control kinds with the same key and label while preserving unrelated raw definitions', () => {
    const raw = 'unknown\r\nname=Name=text\nother=Other=future';
    const textarea = editNativeToggleLine(raw, 1, { type: 'textarea' });
    expect(textarea).toBe('unknown\r\nname=Name=textarea\nother=Other=future');
    expect(editNativeToggleLine(textarea, 1, { type: 'text' })).toBe(raw);
    expect(editNativeToggleLine(raw, 1, { type: 'toggle' })).toBe(
      'unknown\r\nname=Name\nother=Other=future'
    );
    expect(editNativeToggleLine(raw, 1, { type: 'select' })).toBe(
      'unknown\r\nname=Name=select=\nother=Other=future'
    );
    expect(editNativeToggleLine('=Section=divider', 0, { type: 'caption' })).toBe(
      '=Section=caption'
    );
  });

  it('adds every form without replacing preexisting malformed content and uses unique keys', () => {
    for (const type of nativeToggleTypes) {
      const next = addNativeToggleLine('new_toggle=Existing\r\nunknown', type);
      expect(next.startsWith('new_toggle=Existing\r\nunknown\r\n')).toBe(true);
      expect(parseNativeToggleLines(next).at(-1)?.definition?.type).toBe(type);
    }
    expect(addNativeToggleLine('new_toggle=Existing', 'toggle')).toContain('new_toggle_2=');
    expect(addNativeToggleLine('new_toggle=Existing=future', 'toggle')).toContain('new_toggle_2=');
    expect(addNativeToggleLine('a=A\n', 'text')).not.toContain('\n\n');
  });

  it('moves unknown lines and the unterminated final line without merging content', () => {
    const raw = 'a=A\r\nunknown\nb=B';
    expect(moveNativeToggleLine(raw, 2, -1)).toBe('a=A\r\nb=B\nunknown');
    expect(moveNativeToggleLine(moveNativeToggleLine(raw, 2, -1), 1, 1)).toBe(raw);
    expect(moveNativeToggleLine(raw, 0, -1)).toBe(raw);
    expect(removeNativeToggleLine(raw, 0)).toBe('unknown\nb=B');
  });

  it('reports group boundary problems without repairing or dropping their source', () => {
    const raw = '==groupEnd\n=One=group\n=Nested=group';
    const lines = parseNativeToggleLines(raw);
    expect(nativeToggleGroupWarnings(lines)).toHaveLength(3);
    expect(serializeNativeToggleLines(lines)).toBe(raw);
    expect(
      nativeToggleGroupWarnings(parseNativeToggleLines('=One=group\na=A\n==groupEnd'))
    ).toEqual([]);
  });
});
