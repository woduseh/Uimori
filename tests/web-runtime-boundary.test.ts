import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import {
  importedSource,
  repositorySources,
  sourceFiles,
  sourceImports,
  type ModuleSources,
} from './fixtures/source-imports.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const nodeOnlyModules = new Set(['core/local-tokenizers.ts']);

function isNodeOnly(module: string): boolean {
  return module.startsWith('node:') || module.startsWith('server/') || nodeOnlyModules.has(module);
}

function runtimeImports(sources: ModuleSources, file: string): string[] {
  return sourceImports(sources.read(file), file)
    .filter((item) => item.runtime)
    .flatMap(({ specifier }) => {
      if (specifier.startsWith('node:')) return [specifier];
      const resolved = importedSource(sources, file, specifier);
      return resolved ? [resolved] : [];
    });
}

function nodeOnlyChains(entries: string[], sources: ModuleSources): string[] {
  const parent = new Map<string, string | undefined>(entries.map((entry) => [entry, undefined]));
  const queue = [...entries];
  const reached: string[] = [];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (isNodeOnly(next)) {
      reached.push(next);
      continue;
    }
    for (const imported of runtimeImports(sources, next)) {
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
  const chains = nodeOnlyChains(sourceFiles(root, 'web'), repositorySources(root));
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

test('a Node builtin reached through a package.json subpath import is reported', () => {
  const files: Record<string, string> = {
    'web/banner.ts': "import { MAINTENANCE_CLOSED } from '#contracts';",
    'packages/contracts/src/index.ts': "export * from './maintenance.js';",
    'packages/contracts/src/maintenance.ts':
      "import { readFileSync } from 'node:fs';\nexport const MAINTENANCE_CLOSED = readFileSync;",
  };
  const sources: ModuleSources = {
    read: (file) => files[file]!,
    exists: (file) => file in files,
    imports: { '#contracts': './packages/contracts/src/index.js' },
  };
  expect(nodeOnlyChains(['web/banner.ts'], sources)).toEqual([
    'web/banner.ts -> packages/contracts/src/index.ts -> packages/contracts/src/maintenance.ts -> node:fs',
  ]);
});
