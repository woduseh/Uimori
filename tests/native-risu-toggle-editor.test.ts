import { describe, expect, it } from 'vitest';
import {
  nativeToggleGroupWarnings,
  nativeToggleTypes,
  parseNativeToggleLines,
  serializeNativeToggleDefinition,
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
    expect(lines.map((line) => serializeNativeToggleDefinition(line.definition!)).join('\n')).toBe(
      raw
    );
  });

  it('keeps ambiguous extra fields and unknown type suffixes raw instead of truncating', () => {
    const raw = '=Title=future\na=Name=text=metadata\na=Name=select=x=y\nnot a definition';
    expect(parseNativeToggleLines(raw).every((line) => line.definition === null)).toBe(true);
    expect(serializeNativeToggleLines(parseNativeToggleLines(raw))).toBe(raw);
  });

  it('rejects form edits that would silently change native grammar', () => {
    const item = { type: 'toggle' as const, key: 'a', label: 'Label', options: '' };
    expect(() => serializeNativeToggleDefinition({ ...item, label: 'x=y' })).toThrow('등호');
    expect(() => serializeNativeToggleDefinition({ ...item, key: '' })).toThrow('변수 키');
    expect(() => serializeNativeToggleDefinition({ ...item, label: 'x\ny' })).toThrow('줄바꿈');
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
