import { parse } from '@babel/parser';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { sourceFiles } from './fixtures/source-imports.js';

type AstNode = { type: string; loc?: { start: { line: number } } } & Record<string, unknown>;

const root = fileURLToPath(new URL('../', import.meta.url));
const ignoredKeys = new Set(['loc', 'extra', 'comments', 'tokens']);
const remedy =
  'Wrap the call in `if (visualReview)` (from tests/fixtures/visual-review.ts) and write to `info.outputPath(...)`.';

const isNode = (value: unknown): value is AstNode =>
  Boolean(value) && typeof (value as { type?: unknown }).type === 'string';

function walk(
  node: AstNode,
  ancestors: AstNode[],
  visit: (node: AstNode, ancestors: AstNode[]) => void
) {
  visit(node, ancestors);
  const next = [...ancestors, node];
  for (const [key, value] of Object.entries(node)) {
    if (ignoredKeys.has(key)) continue;
    for (const child of Array.isArray(value) ? value : [value])
      if (isNode(child)) walk(child, next, visit);
  }
}

function requiresVisualReview(test: unknown): boolean {
  if (!isNode(test)) return false;
  if (test.type === 'Identifier') return test.name === 'visualReview';
  return (
    test.type === 'LogicalExpression' &&
    test.operator === '&&' &&
    (requiresVisualReview(test.left) || requiresVisualReview(test.right))
  );
}

function isGuarded(chain: AstNode[]): boolean {
  for (let index = chain.length - 2; index >= 0; index -= 1) {
    const parent = chain[index];
    if (parent.type === 'IfStatement' && parent.consequent === chain[index + 1])
      if (requiresVisualReview(parent.test)) return true;
  }
  return false;
}

function isScreenshotCall(node: AstNode): boolean {
  const callee = node.callee as AstNode | undefined;
  const property = callee?.property as AstNode | undefined;
  return (
    node.type === 'CallExpression' &&
    callee?.type === 'MemberExpression' &&
    property?.type === 'Identifier' &&
    property.name === 'screenshot'
  );
}

function usesOutputPath(value: unknown): boolean {
  if (!isNode(value) || value.type !== 'CallExpression') return false;
  const callee = value.callee as AstNode;
  const property = callee.property as AstNode | undefined;
  return (
    callee.type === 'MemberExpression' &&
    property?.type === 'Identifier' &&
    property.name === 'outputPath'
  );
}

function pathProperty(call: AstNode): AstNode | undefined {
  const options = (call.arguments as AstNode[])[0];
  if (!isNode(options) || options.type !== 'ObjectExpression') return undefined;
  return (options.properties as AstNode[]).find((property) => {
    const key = property.key as AstNode | undefined;
    return (
      property.type === 'ObjectProperty' &&
      (key?.type === 'Identifier' ? key.name === 'path' : key?.value === 'path')
    );
  });
}

function violations(file: string): string[] {
  const source = readFileSync(`${root}${file}`, 'utf8');
  if (!/\bscreenshot\s*\(/.test(source)) return [];
  const tree = parse(source, {
    sourceType: 'module',
    plugins: ['typescript', ...(file.endsWith('x') ? ['jsx' as const] : [])],
  }) as unknown as AstNode;
  const found: string[] = [];
  walk(tree, [], (node, ancestors) => {
    if (!isScreenshotCall(node)) return;
    const line = node.loc?.start.line ?? 0;
    if (!isGuarded([...ancestors, node]))
      found.push(`${file}:${line}: screenshot runs without \`if (visualReview)\`. ${remedy}`);
    const path = pathProperty(node);
    if (path && !usesOutputPath(path.value))
      found.push(
        `${file}:${line}: screenshot path is not built with \`info.outputPath(...)\`. ${remedy}`
      );
  });
  return found;
}

it('takes browser-spec screenshots only under UIMORI_VISUAL_REVIEW and writes them to the test output folder', () => {
  const files = sourceFiles(root, 'tests').filter((file) => !file.endsWith('.test.ts'));
  expect(files.flatMap(violations)).toEqual([]);
});
