import { parse } from '@babel/parser';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

export const allowlistPath = 'scripts/ui-message-allowlist.json';
export const exemptFiles = new Set(['web/ui-message.ts']);
const sourceExtension = /\.(?:ts|tsx|mts|cts|js|mjs)$/u;
const ignored = new Set([
  'loc',
  'extra',
  'comments',
  'tokens',
  'leadingComments',
  'trailingComments',
]);

export const remedy = [
  'Text read from `.message` can be English model or validator text or a raw descriptor, and it does not follow a language switch.',
  'Turn a caught error into a UiMessage with toUiMessage(cause) from web/api-errors.ts, keep the UiMessage in state, and render it',
  'through a component that accepts one (or formatUiMessage at render time). Throw UiError(uiMessage(key)) for your own failures.',
  'If the field is our own data rather than an error, rename it.',
].join('\n');

function walk(node, visit, parent) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') visit(node, parent);
  for (const [key, value] of Object.entries(node)) {
    if (ignored.has(key)) continue;
    if (Array.isArray(value)) for (const child of value) walk(child, visit, node);
    else if (value && typeof value === 'object') walk(value, visit, node);
  }
}

const named = (node) =>
  (node?.type === 'Identifier' && node.name === 'message') ||
  (node?.type === 'StringLiteral' && node.value === 'message');

export function messageReads(source, file = 'web/input.tsx') {
  const tree = parse(source, {
    sourceType: 'module',
    plugins: /\.[cm]?tsx?$/u.test(file)
      ? /x$/u.test(file)
        ? ['typescript', 'jsx']
        : ['typescript']
      : ['jsx'],
  });
  const lines = [];
  walk(tree, (node, parent) => {
    const member =
      (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') &&
      (node.computed ? node.property.type === 'StringLiteral' : true) &&
      named(node.property);
    const destructured =
      node.type === 'ObjectProperty' && parent?.type === 'ObjectPattern' && named(node.key);
    if (member || destructured) lines.push(node.loc.start.line);
  });
  return lines;
}

function sourceFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => (left.name < right.name ? -1 : 1))
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return entry.name === 'locales' ? [] : sourceFiles(path);
      return sourceExtension.test(entry.name) ? [path] : [];
    });
}

export function readAllowlist(directory = root) {
  const path = resolve(directory, allowlistPath);
  if (!existsSync(path)) return {};
  const entries = JSON.parse(readFileSync(path, 'utf8'));
  for (const [file, count] of Object.entries(entries))
    if (!Number.isInteger(count) || count < 1)
      throw new Error(`${allowlistPath}: "${file}" needs a positive whole count`);
  return entries;
}

export function scanUiMessages(directory = root) {
  const counts = new Map();
  for (const path of sourceFiles(resolve(directory, 'web'))) {
    const file = relative(directory, path).replaceAll('\\', '/');
    if (exemptFiles.has(file)) continue;
    const lines = messageReads(readFileSync(path, 'utf8'), file);
    if (lines.length) counts.set(file, lines);
  }
  return counts;
}

export function uiMessageErrors(directory = root, allowlist = readAllowlist(directory)) {
  const counts = scanUiMessages(directory);
  const errors = [];
  for (const [file, lines] of counts) {
    const allowed = allowlist[file] ?? 0;
    if (lines.length > allowed)
      errors.push(
        `${file}: ${lines.length} \`.message\` reads (lines ${lines.join(', ')}), ${allowed ? `${allowlistPath} allows ${allowed}` : 'none allowed'}`
      );
  }
  for (const [file, allowed] of Object.entries(allowlist)) {
    const found = counts.get(file)?.length ?? 0;
    if (found < allowed)
      errors.push(
        found
          ? `${allowlistPath}: ${file} now has ${found} \`.message\` reads; lower its entry from ${allowed} to ${found} (node scripts/check-ui-message.mjs --shrink)`
          : `${allowlistPath}: ${file} has no \`.message\` reads left; remove its entry (node scripts/check-ui-message.mjs --shrink)`
      );
  }
  return errors;
}

export function shrinkAllowlist(directory = root, allowlist = readAllowlist(directory)) {
  const counts = scanUiMessages(directory);
  const next = Object.fromEntries(
    Object.entries(allowlist)
      .map(([file, allowed]) => [file, Math.min(allowed, counts.get(file)?.length ?? 0)])
      .filter(([, count]) => count > 0)
      .sort(([left], [right]) => (left < right ? -1 : 1))
  );
  writeFileSync(resolve(directory, allowlistPath), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--shrink')) shrinkAllowlist();
  const errors = uiMessageErrors();
  if (errors.length) {
    console.error(`${errors.join('\n')}\n\n${remedy}`);
    process.exitCode = 1;
  } else {
    const allowlist = readAllowlist();
    const total = Object.values(allowlist).reduce((sum, count) => sum + count, 0);
    console.log(
      `UI messages PASS (${total} unconverted \`.message\` reads in ${Object.keys(allowlist).length} files)`
    );
  }
}
