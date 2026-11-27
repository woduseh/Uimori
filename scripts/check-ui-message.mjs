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
  "An error's own text (its `.message`, `String(caught)`, a template literal holding it or `caught.toString()`) can be English model or validator text",
  'or a raw descriptor, and it does not follow a language switch.',
  'Turn a caught error into a UiMessage with toUiMessage(cause) from web/api-errors.ts, keep the UiMessage in state, and render it',
  'through a component that accepts one (or formatUiMessage at render time). Throw UiError(uiMessage(key)) for your own failures.',
  'If the field is our own data rather than an error, rename it. A field a library or stored data names `message` goes under',
  '"permanent" in scripts/ui-message-allowlist.json with its reason.',
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
const called = (node, parent) =>
  (parent?.type === 'CallExpression' || parent?.type === 'OptionalCallExpression') &&
  parent.callee === node;
const caughtName = (node, names) => node?.type === 'Identifier' && names.has(node.name);

function caughtText(node, names) {
  if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
    const { callee } = node;
    if (callee.type === 'Identifier' && callee.name === 'String')
      return caughtName(node.arguments[0], names);
    return (
      (callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') &&
      !callee.computed &&
      callee.property.name === 'toString' &&
      caughtName(callee.object, names)
    );
  }
  return (
    node.type === 'TemplateLiteral' &&
    node.expressions.some((expression) => caughtName(expression, names))
  );
}

export const plainErrorRemedy =
  'an Error built from non-literal text; throw new UiError(uiMessage(key)) for a failure someone may see, or give a developer-only Error a string literal';

const errorTypes = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'DOMException',
  'AggregateError',
]);
const literalText = (node) =>
  !node ||
  node.type === 'StringLiteral' ||
  (node.type === 'TemplateLiteral' && !node.expressions.length);

function parseSource(source, file) {
  return parse(source, {
    sourceType: 'module',
    plugins: /\.[cm]?tsx?$/u.test(file)
      ? /x$/u.test(file)
        ? ['typescript', 'jsx']
        : ['typescript']
      : ['jsx'],
  });
}

const isClass = (node) => node.type === 'ClassDeclaration' || node.type === 'ClassExpression';
const errorText = (type, args) => args[type === 'AggregateError' ? 1 : 0];

function ownSuperCalls(body, visit) {
  for (const [key, value] of Object.entries(body)) {
    if (ignored.has(key) || !value || typeof value !== 'object') continue;
    for (const child of Array.isArray(value) ? value : [value]) {
      if (!child || typeof child !== 'object') continue;
      if (child.type === 'CallExpression' && child.callee.type === 'Super') visit(child);
      if (!isClass(child)) ownSuperCalls(child, visit);
    }
  }
}

function plainErrorLines(tree) {
  const lines = [];
  walk(tree, (node) => {
    if (
      (node.type === 'NewExpression' || node.type === 'CallExpression') &&
      node.callee.type === 'Identifier' &&
      errorTypes.has(node.callee.name) &&
      !literalText(errorText(node.callee.name, node.arguments))
    )
      lines.push(node.loc.start.line);
    if (
      isClass(node) &&
      node.superClass?.type === 'Identifier' &&
      errorTypes.has(node.superClass.name)
    )
      ownSuperCalls(node.body, (call) => {
        if (!literalText(errorText(node.superClass.name, call.arguments)))
          lines.push(call.loc.start.line);
      });
    if (
      node.type === 'ThrowStatement' &&
      (node.argument.type === 'StringLiteral' || node.argument.type === 'TemplateLiteral')
    )
      lines.push(node.loc.start.line);
  });
  return lines.sort((left, right) => left - right);
}

export const jsonParseFile = 'web/json.ts';
export const jsonParseRemedy = [
  'a raw JSON.parse throws a SyntaxError the screen shows as errors.unexpected; call one of these instead:',
  'parseJsonInput or readJsonFile (web/json-input.ts) for text or a file someone supplied,',
  `tryParseJson (${jsonParseFile}) with a fallback for browser storage and other text that may be stale or corrupt,`,
  `or parseOwnJson (${jsonParseFile}) for JSON this build serialized itself, such as a server event frame or a memo key`,
].join(' ');

function jsonParseLines(tree) {
  const lines = [];
  walk(tree, (node) => {
    if (
      (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') &&
      node.object.type === 'Identifier' &&
      node.object.name === 'JSON' &&
      (node.computed
        ? node.property.type === 'StringLiteral' && node.property.value === 'parse'
        : node.property.name === 'parse')
    )
      lines.push(node.loc.start.line);
  });
  return lines.sort((left, right) => left - right);
}

export function jsonParseCalls(source, file = 'web/input.tsx') {
  return jsonParseLines(parseSource(source, file));
}

export function plainErrorTexts(source, file = 'web/input.tsx') {
  return plainErrorLines(parseSource(source, file));
}

export function errorTextReads(source, file = 'web/input.tsx') {
  return errorTextLines(parseSource(source, file));
}

function errorTextLines(tree) {
  const lines = [];
  walk(tree, (node, parent) => {
    const member =
      (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') &&
      (node.computed ? node.property.type === 'StringLiteral' : true) &&
      named(node.property) &&
      !called(node, parent);
    const destructured =
      node.type === 'ObjectProperty' && parent?.type === 'ObjectPattern' && named(node.key);
    if (member || destructured) lines.push(node.loc.start.line);
    if (node.type === 'CatchClause' && node.param?.type === 'Identifier') {
      const names = new Set([node.param.name]);
      walk(node.body, (inner) => {
        if (caughtText(inner, names)) lines.push(inner.loc.start.line);
      });
    }
  });
  return lines.sort((left, right) => left - right);
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
  if (!existsSync(path)) return { permanent: {}, debt: {} };
  const { permanent = {}, debt = {}, ...rest } = JSON.parse(readFileSync(path, 'utf8'));
  if (Object.keys(rest).length)
    throw new Error(`${allowlistPath}: only "permanent" and "debt" sections are allowed`);
  for (const [file, entry] of Object.entries(permanent))
    if (!Number.isInteger(entry?.count) || entry.count < 1 || !entry.reason?.trim())
      throw new Error(`${allowlistPath}: permanent "${file}" needs a positive count and a reason`);
  for (const [file, count] of Object.entries(debt))
    if (!Number.isInteger(count) || count < 1)
      throw new Error(`${allowlistPath}: debt "${file}" needs a positive whole count`);
  return { permanent, debt };
}

function scanSources(directory) {
  const counts = new Map();
  const plain = [];
  for (const path of sourceFiles(resolve(directory, 'web'))) {
    const file = relative(directory, path).replaceAll('\\', '/');
    const tree = parseSource(readFileSync(path, 'utf8'), file);
    if (file !== jsonParseFile)
      for (const line of jsonParseLines(tree)) plain.push(`${file}:${line}: ${jsonParseRemedy}`);
    if (exemptFiles.has(file)) continue;
    for (const line of plainErrorLines(tree)) plain.push(`${file}:${line}: ${plainErrorRemedy}`);
    const lines = errorTextLines(tree);
    if (lines.length) counts.set(file, lines);
  }
  return { counts, plain };
}

export function scanUiMessages(directory = root) {
  return scanSources(directory).counts;
}

export function uiMessageErrors(directory = root, allowlist = readAllowlist(directory)) {
  const { permanent, debt } = allowlist;
  const { counts, plain } = scanSources(directory);
  const errors = [...plain];
  for (const [file, lines] of counts) {
    const allowed = (permanent[file]?.count ?? 0) + (debt[file] ?? 0);
    if (lines.length > allowed)
      errors.push(
        `${file}: ${lines.length} error-text reads (lines ${lines.join(', ')}), ${allowed ? `${allowlistPath} allows ${allowed}` : 'none allowed'}`
      );
  }
  for (const file of new Set([...Object.keys(permanent), ...Object.keys(debt)])) {
    const found = counts.get(file)?.length ?? 0;
    const kept = permanent[file]?.count ?? 0;
    const owed = debt[file] ?? 0;
    if (found < kept)
      errors.push(
        `${allowlistPath}: ${file} has ${found} error-text reads but its permanent entry keeps ${kept}; correct the entry and its reason by hand`
      );
    else if (found < kept + owed)
      errors.push(
        found > kept
          ? `${allowlistPath}: ${file} now owes ${found - kept} error-text reads; lower its debt from ${owed} to ${found - kept} (node scripts/check-ui-message.mjs --shrink)`
          : `${allowlistPath}: ${file} owes no error-text reads; remove its debt entry (node scripts/check-ui-message.mjs --shrink)`
      );
  }
  return errors;
}

export function shrinkAllowlist(directory = root, allowlist = readAllowlist(directory)) {
  const { permanent, debt } = allowlist;
  const counts = scanUiMessages(directory);
  const next = {
    permanent,
    debt: Object.fromEntries(
      Object.entries(debt)
        .map(([file, owed]) => [
          file,
          Math.min(
            owed,
            Math.max(0, (counts.get(file)?.length ?? 0) - (permanent[file]?.count ?? 0))
          ),
        ])
        .filter(([, count]) => count > 0)
        .sort(([left], [right]) => (left < right ? -1 : 1))
    ),
  };
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
    const { permanent, debt } = readAllowlist();
    const owed = Object.values(debt).reduce((sum, count) => sum + count, 0);
    console.log(
      `UI messages PASS (${owed} unconverted error-text reads in ${Object.keys(debt).length} files; ${Object.keys(permanent).length} permanent exceptions)`
    );
  }
}
