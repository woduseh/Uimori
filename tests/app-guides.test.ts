import { expect, test } from 'vitest';
import { readdirSync } from 'node:fs';
import { describeHelperTools, helperToolTraits } from '../server/helper-app-tools.js';
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
});

test('a section that holds the query as a phrase ranks ahead of one that only holds its words', () => {
  const found = call({ query: '번역 결과 언어' }) as { matches: { name: string }[] };
  const phraseHolders = ['PWA', 'UPDATES'];
  expect(
    found.matches
      .slice(0, phraseHolders.length)
      .map((match) => match.name)
      .sort()
  ).toEqual(phraseHolders);
});

test('words spread over the lines of one section still match it', () => {
  const found = call({ query: '터치 막대 손잡이' }) as {
    matches: { name: string }[];
    totalMatches: number;
  };
  expect(found.totalMatches).toBeGreaterThan(0);
  expect(found.matches.map((match) => match.name)).toContain('EDITING');
});

test('a query without a complete match returns the closest sections and says it proves nothing', () => {
  const partial = call({ query: '가격 미정' }) as {
    matches: { name: string; matchedTerms: string[] }[];
    totalMatches: number;
    partialMatches: number;
    guidance: string;
  };
  expect(partial.totalMatches).toBe(0);
  expect(partial.partialMatches).toBeGreaterThan(0);
  expect(partial.matches[0]!.matchedTerms).toEqual(['가격']);
  expect(partial.guidance).toContain('does not show that a feature is absent');
  expect(call({ query: 'no-such-term-zzz' })).toMatchObject({
    matches: [],
    totalMatches: 0,
    partialMatches: 0,
    guidance: expect.stringContaining('Korean'),
  });
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

test('the Story UI writer reference reads in the single call the helper contract asks for', () => {
  const page = call({ name: 'STORY-UI-REFERENCE', limit: 20_000 }) as {
    nextOffset: number | null;
    text: string;
  };
  expect(page.nextOffset).toBeNull();
  expect(page.text).toContain('## Rules');
});
