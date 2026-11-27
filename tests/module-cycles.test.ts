import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import {
  importedSource,
  repositorySources,
  sourceFiles,
  sourceImports,
} from './fixtures/source-imports.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const sources = repositorySources(root);
function valueImports(file: string): string[] {
  return sourceImports(sources.read(file), file)
    .filter((item) => item.runtime && item.eager)
    .flatMap(({ specifier }) => importedSource(sources, file, specifier) ?? []);
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

test('core, packages and server modules have no value-import cycles', () => {
  const files = ['core', 'packages', 'server'].flatMap((dir) => sourceFiles(root, dir));
  const graph = new Map(files.map((file) => [file, valueImports(file)]));
  expect(stronglyConnected(graph)).toEqual([]);
});
