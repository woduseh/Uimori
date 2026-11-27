import { parse } from '@babel/parser';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

export const appRoots = ['server', 'core', 'web', 'packages', 'dist'];
export const scannedDirectories = [
  'scripts',
  'tests',
  'runner',
  'deploy',
  '.githooks',
  '.claude/hooks',
];
export const exceptions = {
  'scripts/oracle-host-control.test.mjs': "release tooling is 재연님's",
  'scripts/oracle-smoke.test.mjs': "release tooling is 재연님's",
};
export const remedy = 'write it as .ts so tsc checks the call';

const javaScript = /\.(?:mjs|js|cjs)$/u;
const skippedDirectories = new Set(['node_modules', 'dist', 'output']);

function javaScriptFiles(directory, recursive = true) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory())
      return recursive && !skippedDirectories.has(entry.name) ? javaScriptFiles(path) : [];
    return javaScript.test(entry.name) ? [path] : [];
  });
}

function literal(node) {
  if (node?.type === 'StringLiteral') return node.value;
  if (node?.type === 'TemplateLiteral' && !node.expressions.length)
    return node.quasis[0].value.cooked;
  return undefined;
}

function specifiers(node, found = []) {
  if (!node || typeof node !== 'object') return found;
  if (Array.isArray(node)) {
    for (const item of node) specifiers(item, found);
    return found;
  }
  if (
    (node.type === 'ImportDeclaration' ||
      node.type === 'ExportAllDeclaration' ||
      node.type === 'ExportNamedDeclaration') &&
    node.source
  )
    found.push({ specifier: literal(node.source), line: node.loc.start.line });
  else if (node.type === 'ImportExpression')
    found.push({ specifier: literal(node.source), line: node.loc.start.line });
  for (const [key, value] of Object.entries(node))
    if (key !== 'loc' && key !== 'start' && key !== 'end' && typeof value === 'object')
      specifiers(value, found);
  return found;
}

export function appTarget(file, specifier) {
  if (specifier.startsWith('#')) return specifier;
  if (!specifier.startsWith('.')) return undefined;
  const target = posix.normalize(posix.join(posix.dirname(file), specifier));
  return appRoots.includes(target.split('/')[0]) ? target : undefined;
}

export function scriptImportErrors(directory = root, allowed = exceptions) {
  const files = [
    ...javaScriptFiles(directory, false),
    ...scannedDirectories.flatMap((name) => javaScriptFiles(join(directory, name))),
  ].map((file) => relative(directory, file).replaceAll('\\', '/'));
  const errors = [];
  const unused = new Set(Object.keys(allowed));
  for (const file of files.sort()) {
    let found;
    try {
      found = specifiers(
        parse(readFileSync(join(directory, file), 'utf8'), {
          sourceType: 'module',
          allowReturnOutsideFunction: true,
          allowAwaitOutsideFunction: true,
        }).program
      );
    } catch (error) {
      errors.push(`${file}: cannot read imports: ${error.message}`);
      continue;
    }
    const imports = found.filter(({ specifier }) => specifier && appTarget(file, specifier));
    if (!imports.length) continue;
    if (file in allowed) {
      unused.delete(file);
      continue;
    }
    for (const { specifier, line } of imports)
      errors.push(`${file}:${line}: imports ${specifier}; ${remedy}`);
  }
  for (const file of unused)
    errors.push(
      `${file}: listed as an exception but imports no app code; remove it from scripts/check-script-imports.mjs`
    );
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = scriptImportErrors();
  if (errors.length) {
    console.error(`${errors.join('\n')}\n\n${errors.length} JavaScript import(s) of app code.`);
    process.exitCode = 1;
  } else console.log('Script imports PASS');
}
