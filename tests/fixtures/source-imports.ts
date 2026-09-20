import { parse } from '@babel/parser';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export function sourceFiles(root: string, directory: string): string[] {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    return entry.isDirectory()
      ? sourceFiles(root, path)
      : /\.(?:[cm]?[jt]sx?)$/.test(entry.name) && !/\.d\.[cm]?ts$/.test(entry.name)
        ? [path]
        : [];
  });
}

/** Literal references; lazy imports are boundaries, but not eager cycle edges. */
export function sourceImports(source: string, file = 'input.ts') {
  const result: { specifier: string; runtime: boolean; eager: boolean }[] = [];
  const ast = parse(source, {
    sourceType: 'unambiguous',
    createImportExpressions: true,
    plugins: [
      'typescript',
      ...(file.endsWith('tsx') || file.endsWith('jsx') ? ['jsx' as const] : []),
    ],
  });
  for (const node of ast.program.body) {
    if (node.type === 'ImportDeclaration') {
      result.push({
        specifier: node.source.value,
        eager: true,
        runtime:
          node.importKind !== 'type' &&
          (node.specifiers.length === 0 ||
            node.specifiers.some(
              (item) => item.type !== 'ImportSpecifier' || item.importKind !== 'type'
            )),
      });
    } else if (node.type === 'ExportNamedDeclaration' && node.source) {
      result.push({
        specifier: node.source.value,
        eager: true,
        runtime:
          node.exportKind !== 'type' &&
          (node.specifiers.length === 0 ||
            node.specifiers.some(
              (item) => item.type !== 'ExportSpecifier' || item.exportKind !== 'type'
            )),
      });
    } else if (node.type === 'ExportAllDeclaration') {
      result.push({
        specifier: node.source.value,
        eager: true,
        runtime: node.exportKind !== 'type',
      });
    } else if (
      node.type === 'TSImportEqualsDeclaration' &&
      node.moduleReference.type === 'TSExternalModuleReference'
    ) {
      result.push({
        specifier: node.moduleReference.expression.value,
        eager: true,
        runtime: node.importKind !== 'type',
      });
    }
  }
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const node = value as Record<string, unknown>;
    const source = (
      node.type === 'ImportExpression'
        ? node.source
        : node.type === 'TSImportType'
          ? node.argument
          : undefined
    ) as { type?: string; value?: string } | undefined;
    if (source?.type === 'StringLiteral' && typeof source.value === 'string')
      result.push({ specifier: source.value, runtime: node.type !== 'TSImportType', eager: false });
    for (const [key, child] of Object.entries(node))
      if (!['loc', 'comments', 'tokens', 'errors'].includes(key)) visit(child);
  };
  visit(ast.program);
  return result;
}
