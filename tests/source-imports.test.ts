import { expect, test } from 'vitest';
import { sourceImports, sourceFiles } from './fixtures/source-imports.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('reads real module syntax, excludes erased types from eager runtime edges and ignores comments', () => {
  const imports = sourceImports(`
    // import fake from './fake.js';
    import './side.js';
    import { type T, value } from "./mixed.js";
    export * from './all.js';
    export type { T } from './types.js';
    import type X from './only-type.js';
    import { type Y } from './inline-type.js';
    const lazy = () => import('./lazy.js');
    type Z = import('./query.js').Z;
    const text = "import bogus from './string.js'";
  `);
  expect(
    imports.filter((item) => item.runtime && item.eager).map((item) => item.specifier)
  ).toEqual(['./side.js', './mixed.js', './all.js']);
  expect(imports.map((item) => item.specifier)).toEqual([
    './side.js',
    './mixed.js',
    './all.js',
    './types.js',
    './only-type.js',
    './inline-type.js',
    './lazy.js',
    './query.js',
  ]);
});
test('discovers nested source directories without treating declaration files as runtime modules', () => {
  const root = mkdtempSync(join(tmpdir(), 'uimori-imports-'));
  try {
    mkdirSync(join(root, 'server', 'nested'), { recursive: true });
    writeFileSync(join(root, 'server', 'nested', 'value.ts'), 'export const value = 1;');
    writeFileSync(join(root, 'server', 'types.d.ts'), 'declare const value: number;');
    expect(sourceFiles(root, 'server')).toEqual(['server/nested/value.ts']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
