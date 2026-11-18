import { readdirSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const scale = [0, 1, 2, 4, 6, 8, 10, 12, 14, 16, 20, 24, 28, 32];
const declaration =
  /(?:^|[;{\s])((?:row-|column-)?gap|padding(?:-[a-z-]+)?|margin(?:-[a-z-]+)?)\s*:\s*([^;{}]+)/g;

it('keeps app spacing on the shared 4px scale', () => {
  const offScale: string[] = [];
  for (const file of readdirSync('web').filter((name) => name.endsWith('.css'))) {
    const source = readFileSync(`web/${file}`, 'utf8');
    for (const [, property, value] of source.matchAll(declaration))
      for (const [, number] of value.matchAll(/(?<![\w.(-])-?(\d+(?:\.\d+)?)px/g)) {
        const size = Number(number);
        if (size <= 32 && !scale.includes(size)) offScale.push(`${file}: ${property}: ${value}`);
      }
  }
  expect(
    offScale,
    `Use ${scale.join(', ')}px for gaps, padding and margins up to 32px. Larger values are layout offsets tied to another dimension.`
  ).toEqual([]);
});
