import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { sourceFiles, sourceImports } from './fixtures/source-imports.js';

const root = fileURLToPath(new URL('../', import.meta.url));

function rawTypeScriptWorkers(): string[] {
  const entries = new Set<string>();
  for (const file of sourceFiles(root, 'server')) {
    const source = readFileSync(join(root, file), 'utf8');
    for (const match of source.matchAll(
      /new URL\(\s*[`']\.\/([\w-]+)\.(?:ts|\$\{extension\})[`']/gu
    ))
      entries.add(`server/${match[1]}.ts`);
  }
  return [...entries].sort();
}

test('workers started from raw TypeScript load only builtins, packages, JSON, and erased types', () => {
  const workers = rawTypeScriptWorkers();
  expect(workers).toEqual([
    'server/backup-verify-worker.ts',
    'server/helper-data-worker.ts',
    'server/manuscript-search-worker.ts',
    'server/risu-lua-worker.ts',
  ]);
  const unresolvable = workers.flatMap((file) =>
    sourceImports(readFileSync(join(root, file), 'utf8'), file)
      .filter(
        (item) =>
          item.runtime && item.specifier.startsWith('.') && !item.specifier.endsWith('.json')
      )
      .map((item) => `${file} -> ${item.specifier}`)
  );
  expect(unresolvable).toEqual([]);
});
