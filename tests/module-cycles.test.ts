import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

// Value-import cycles between `core/` and `server/` modules. Biome checks directory boundaries,
// not cycles, so this keeps the ones removed on 2026-09-10 (decision 6) from returning.
// Static `import`/`export ... from` statements only; `import type` and inline `type` specifiers
// are erased at runtime and are not edges here.
const root = fileURLToPath(new URL('../', import.meta.url));
const KNOWN_CYCLES = [['server/package-images.ts', 'server/source-editing.ts']];
const statement =
  /^import\s+(?!type\s)([\s\S]*?)from\s+'([^']+)';|^export\s+(?!type\s)\{[\s\S]*?\}\s+from\s+'([^']+)';/gm;

function valueImports(file: string): string[] {
  const edges: string[] = [];
  for (const match of readFileSync(join(root, file), 'utf8').matchAll(statement)) {
    const specifier = match[2] ?? match[3];
    if (!specifier.startsWith('.')) continue;
    const names = match[1]?.replace(/^[\s\S]*?\{|\}[\s\S]*$/g, '') ?? '';
    const parts = names
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    if (match[1] !== undefined && parts.length && parts.every((part) => part.startsWith('type ')))
      continue;
    edges.push(
      relative(root, resolve(dirname(join(root, file)), specifier))
        .replaceAll('\\', '/')
        .replace(/\.js$/, '.ts')
    );
  }
  return edges;
}

function stronglyConnected(graph: Map<string, string[]>): string[][] {
  let counter = 0;
  const index = new Map<string, number>(),
    low = new Map<string, number>(),
    onStack = new Set<string>(),
    stack: string[] = [],
    result: string[][] = [];
  const visit = (node: string) => {
    index.set(node, counter);
    low.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of graph.get(node) ?? []) {
      if (!graph.has(next)) continue;
      if (!index.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node)!, low.get(next)!));
      } else if (onStack.has(next)) low.set(node, Math.min(low.get(node)!, index.get(next)!));
    }
    if (low.get(node) !== index.get(node)) return;
    const component: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
    } while (member !== node);
    if (component.length > 1) result.push(component.sort());
  };
  for (const node of graph.keys()) if (!index.has(node)) visit(node);
  return result.sort((a, b) => a[0].localeCompare(b[0]));
}

test('core and server modules have no value-import cycles beyond the known list', () => {
  const files = ['core', 'server'].flatMap((dir) =>
    readdirSync(join(root, dir))
      .filter((name) => name.endsWith('.ts'))
      .map((name) => `${dir}/${name}`)
  );
  const graph = new Map(files.map((file) => [file, valueImports(file)]));
  expect(files.length).toBeGreaterThan(100);
  expect(stronglyConnected(graph)).toEqual(KNOWN_CYCLES);
});
