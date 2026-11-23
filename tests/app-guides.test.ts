import { expect, test } from 'vitest';
import { readdirSync } from 'node:fs';
import { describeHelperTools, helperToolTraits } from '../server/helper-app-tools.js';
import { invokeHelperGuideTool as call } from '../server/helper-guide-tools.js';

test('the helper lists the user guides without developer documents', () => {
  const { guides } = call({}) as { guides: { name: string; title: string; chars: number }[] };
  const names = guides.map((guide) => guide.name);
  expect(names).toEqual(expect.arrayContaining(['READING', 'MODEL-PRICING', 'USAGE']));
  for (const developer of ['CODE-MAP', 'DEVELOPMENT', 'UI-PRINCIPLES', 'ORACLE-RELEASE'])
    expect(names).not.toContain(developer);
  expect(names.length).toBeLessThan(readdirSync('docs').length);
  expect(guides.every((guide) => guide.title && guide.chars > 0)).toBe(true);
});

test('a query finds the guide and section that describe an app behavior', () => {
  const found = call({ query: '도우미 생각 요약' }) as {
    matches: { name: string; section: string; text: string }[];
    totalMatches: number;
  };
  expect(found.totalMatches).toBeGreaterThan(0);
  expect(found.matches[0]).toMatchObject({ name: expect.any(String), section: expect.any(String) });
  expect(found.matches.every((match) => match.text.includes('생각 요약'))).toBe(true);
  expect(call({ query: 'no-such-term-zzz' })).toMatchObject({ matches: [], totalMatches: 0 });
});

test('a guide is read in pages that join back into the whole text', () => {
  const first = call({ name: 'reading.md', limit: 500 }) as {
    name: string;
    text: string;
    totalChars: number;
    nextOffset: number | null;
  };
  expect(first).toMatchObject({ name: 'READING', offset: 0 });
  let text = first.text;
  let next = first.nextOffset;
  while (next !== null) {
    const page = call({ name: 'READING', offset: next, limit: 20_000 }) as typeof first;
    text += page.text;
    next = page.nextOffset;
  }
  expect(text.length).toBe(first.totalChars);
  expect(() => call({ name: 'DEVELOPMENT' })).toThrow('GUIDE_NOT_FOUND');
  expect(() => call({ name: 'READING', query: 'x' })).toThrow('INVALID_ARGUMENTS');
});

test('guide.read is a read-only app operation available in a review', () => {
  expect(describeHelperTools({ names: ['guide.read'] }, true).tools[0]?.name).toBe('guide.read');
  expect(helperToolTraits('guide.read')).toMatchObject({ readOnly: true, direct: true });
});
