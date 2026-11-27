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

function eagerZodChains(entries: string[], sources: ModuleSources): string[] {
  const parent = new Map<string, string | undefined>(entries.map((entry) => [entry, undefined]));
  const queue = [...entries];
  const reached: string[] = [];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const { specifier } of sourceImports(sources.read(next), next).filter(
      (item) => item.runtime && item.eager
    )) {
      if (/^zod(?:\/|$)/u.test(specifier)) {
        const chain = [specifier, next];
        for (let step = parent.get(next); step !== undefined; step = parent.get(step))
          chain.push(step);
        reached.push(chain.reverse().join(' -> '));
        continue;
      }
      const resolved = importedSource(sources, next, specifier);
      if (!resolved || parent.has(resolved)) continue;
      parent.set(resolved, next);
      queue.push(resolved);
    }
  }
  return reached.sort();
}

test('#contracts and the web startup graph never load zod eagerly', () => {
  const chains = eagerZodChains(
    ['packages/contracts/src/index.ts', 'web/main.tsx'],
    repositorySources(root)
  );
  expect(
    chains,
    [
      'zod is reached through static value imports from #contracts or web/main.tsx:',
      ...chains.map((chain) => `  ${chain}`),
      'Schemas live in packages/contracts/src/domains/<domain>/operations.ts behind #contracts/operations;',
      'endpoints.ts and index.ts import them with `import type` / `export type *` only.',
    ].join('\n')
  ).toEqual([]);
});

test('a zod value import reached through #contracts is reported, and type-only and lazy imports are not', () => {
  const files: Record<string, string> = {
    'web/main.tsx': "import { fontEndpoints } from '#contracts';\nvoid import('./lazy.js');",
    'web/lazy.ts': "import { z } from 'zod/v4';",
    'packages/contracts/src/index.ts':
      "export * from './endpoints.js';\nexport type * from './operations.js';",
    'packages/contracts/src/endpoints.ts':
      "import type { ops } from './operations.js';\nimport { schema } from './leak.js';",
    'packages/contracts/src/operations.ts': "import { z } from 'zod/v4';",
    'packages/contracts/src/leak.ts': "export { z as schema } from 'zod';",
  };
  const sources: ModuleSources = {
    read: (file) => files[file]!,
    exists: (file) => file in files,
    imports: { '#contracts': './packages/contracts/src/index.js' },
  };
  expect(eagerZodChains(['web/main.tsx'], sources)).toEqual([
    'web/main.tsx -> packages/contracts/src/index.ts -> packages/contracts/src/endpoints.ts -> packages/contracts/src/leak.ts -> zod',
  ]);
});

test('web modules never load Node-only modules at runtime', () => {
  const chains = nodeOnlyChains(sourceFiles(root, 'web'), repositorySources(root));
  expect(
    chains,
    [
      'The browser bundle reaches Node-only code (node:* builtins, core/local-tokenizers.ts, server/):',
      ...chains.map((chain) => `  ${chain}`),
      'Move the values web/ needs into packages/contracts (wire shapes shared with the server) or a',
      'small browser-safe core/ module such as core/illustration-cuts.ts. Use `import type` for types only.',
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
