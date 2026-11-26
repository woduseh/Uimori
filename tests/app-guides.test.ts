import { expect, test } from 'vitest';
import { readdirSync } from 'node:fs';
import { invokeHelperGuideTool as call } from '../server/helper-guide-tools.js';

test('the helper lists the user guides under docs/ without docs/dev documents', () => {
  const { guides } = call({}) as { guides: { name: string; title: string; chars: number }[] };
  const names = guides.map((guide) => guide.name);
  const directGuideCount = readdirSync('docs', { withFileTypes: true }).filter(
    (entry) => entry.isFile() && entry.name.endsWith('.md')
  ).length;
  expect(names).toEqual(expect.arrayContaining(['READING', 'MODEL-PRICING', 'USAGE']));
  for (const developer of ['CODE-MAP', 'DEVELOPMENT', 'UI-PRINCIPLES', 'ORACLE-RELEASE'])
    expect(names).not.toContain(developer);
  expect(names.length).toBe(directGuideCount + 2);
  expect(guides.every((guide) => guide.title && guide.chars > 0)).toBe(true);
});

test('a Korean query finds the section that describes an app behavior and where to read it', () => {
  const found = call({ query: '도우미 생각 요약' }) as {
    matches: { name: string; section: string; offset: number; text: string }[];
    totalMatches: number;
  };
  expect(found.totalMatches).toBeGreaterThan(0);
  expect(found).not.toHaveProperty('guidance');
  const [first] = found.matches;
  expect(first).toMatchObject({ name: 'EXECUTION', section: '생각 요약' });
  const page = call({ name: first!.name, offset: first!.offset, limit: 2000 }) as { text: string };
  expect(page.text.startsWith('### 생각 요약')).toBe(true);
  const excerpt = first as unknown as { text: string; sectionChars: number };
  expect(excerpt.text.startsWith('### 생각 요약')).toBe(true);
  expect(page.text.startsWith(excerpt.text.slice(0, Math.min(excerpt.sectionChars, 1200)))).toBe(
    true
  );
  expect(found.matches.slice(3).every((match) => !('sectionChars' in match))).toBe(true);
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

test('the Story UI writer reference reads in the single call the helper contract asks for', () => {
  const page = call({ name: 'STORY-UI-REFERENCE', limit: 20_000 }) as {
    nextOffset: number | null;
    text: string;
  };
  expect(page.nextOffset).toBeNull();
  expect(page.text).toContain('## Rules');
});
