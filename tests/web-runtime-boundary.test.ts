import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { sourceFiles, sourceImports } from './fixtures/source-imports.js';

// Vite bundles everything a `web/` module loads at runtime, including dynamic imports, but type
// checks and unit tests run on Node, where these modules work. Erased `import type` edges are not
// followed. Bare package imports are not followed either; `node:*` builtins are the only ones flagged.
const root = fileURLToPath(new URL('../', import.meta.url));
const nodeOnlyModules = new Set(['core/local-tokenizers.ts']);

function isNodeOnly(module: string): boolean {
  return module.startsWith('node:') || module.startsWith('server/') || nodeOnlyModules.has(module);
}

function resolveSource(file: string, specifier: string): string | undefined {
  const base = relative(root, resolve(dirname(join(root, file)), specifier)).replaceAll('\\', '/');
  const stem = base.replace(/\.js$/, '');
  return [base, `${stem}.ts`, `${stem}.tsx`].find(
    (candidate) => /\.[cm]?[jt]sx?$/.test(candidate) && existsSync(join(root, candidate))
  );
}

function runtimeImports(file: string): string[] {
  return sourceImports(readFileSync(join(root, file), 'utf8'), file)
    .filter((item) => item.runtime)
    .flatMap(({ specifier }) => {
      if (specifier.startsWith('node:')) return [specifier];
      if (!specifier.startsWith('.')) return [];
      const resolved = resolveSource(file, specifier);
      return resolved ? [resolved] : [];
    });
}

function nodeOnlyChains(entries: string[]): string[] {
  const parent = new Map<string, string | undefined>(entries.map((entry) => [entry, undefined]));
  const queue = [...entries];
  const reached: string[] = [];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (isNodeOnly(next)) {
      reached.push(next);
      continue;
    }
    for (const imported of runtimeImports(next)) {
      if (parent.has(imported)) continue;
      parent.set(imported, next);
      queue.push(imported);
    }
  }
  return reached.sort().map((module) => {
    const chain = [module];
    for (let step = parent.get(module); step !== undefined; step = parent.get(step))
      chain.unshift(step);
    return chain.join(' -> ');
  });
}

test('web modules never load Node-only modules at runtime', () => {
  const chains = nodeOnlyChains(sourceFiles(root, 'web'));
  expect(
    chains,
    [
      'The browser bundle reaches Node-only code (node:* builtins, core/local-tokenizers.ts, server/):',
      ...chains.map((chain) => `  ${chain}`),
      'Move the values web/ needs into a small browser-safe core/ module and import that instead,',
      'as core/illustration-cuts.ts and core/novelai-settings.ts do. Use `import type` for types only.',
    ].join('\n')
  ).toEqual([]);
});
