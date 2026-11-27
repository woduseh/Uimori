import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

const read = (file: string) =>
  JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')) as {
    imports?: Record<string, string>;
    compilerOptions?: { paths?: Record<string, string[]> };
  };

test('every package.json subpath import has a tsconfig path to its TypeScript source', () => {
  const imports = read('package.json').imports ?? {};
  const paths = read('tsconfig.json').compilerOptions?.paths ?? {};
  const expected = Object.fromEntries(
    Object.entries(imports).map(([key, target]) => [key, [target.replace(/\.js$/u, '.ts')]])
  );
  expect(
    paths,
    'Playwright loads specs from source and resolves "#…" imports only through tsconfig paths; add the matching entry'
  ).toEqual(expected);
  for (const [source] of Object.values(expected))
    expect(existsSync(new URL(`../${source}`, import.meta.url)), source).toBe(true);
});
