import { readdirSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const allowed: Record<number, string> = {
  360: 'JEV provider navigation on the smallest phones',
  480: 'model pricing and scheduled backup fields stack',
  520: 'Codex account, content picker, manuscript search and prompt template dialogs tighten',
  540: 'draft discard actions stack',
  560: 'recovery archive cards tighten',
  600: 'bottom sheets (SHEET_MEDIA in web/ActionMenu.tsx)',
  620: 'context and story editor grids stack',
  640: 'lore context policy and Risu trigger headings wrap',
  680: 'Risu asset layout drops its side preview',
  700: 'Risu regex form tightens',
  760: 'narrow layout (web/useCompactLayout.ts)',
  800: 'native editor split narrows its rail',
  900: 'usage cards tighten',
  1000: 'workspace padding and navigation width tighten',
  1023: 'sidebar becomes the rail',
  1150: 'outline workspace stacks beside a docked helper',
};

const mediaWidth = /\((max|min)-width:\s*(\d+)px\)/g;

it('keeps media-query widths to the named layout boundaries', () => {
  const unknown: string[] = [];
  for (const file of readdirSync('web', { recursive: true, encoding: 'utf8' })) {
    if (!/\.(css|tsx?)$/.test(file)) continue;
    const source = readFileSync(`web/${file}`, 'utf8');
    const queries = file.endsWith('.css')
      ? [...source.matchAll(/@media([^{]*)\{/g)].map(([, prelude]) => prelude)
      : [source];
    for (const query of queries)
      for (const [match, bound, width] of query.matchAll(mediaWidth)) {
        const boundary = Number(width) - (bound === 'min' ? 1 : 0);
        if (!(boundary in allowed)) unknown.push(`${file}: ${match}`);
      }
  }
  expect(
    unknown,
    'Use an existing layout boundary (min-width is the boundary plus one), or add the width to the allowed list in this test with what it is for.'
  ).toEqual([]);
});
