import { parse } from '@babel/parser';
import { IntlMessageFormat } from 'intl-messageformat';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const locales = ['ko', 'en', 'ja', 'zh'];
const ignored = new Set(['loc', 'extra', 'comments', 'tokens']);
function walk(node, visit, parent) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') visit(node, parent);
  for (const [key, value] of Object.entries(node)) {
    if (ignored.has(key)) continue;
    if (Array.isArray(value)) for (const child of value) walk(child, visit, node);
    else if (value && typeof value === 'object') walk(value, visit, node);
  }
}
const ast = (source, file) => {
  try {
    return parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] });
  } catch (error) {
    throw new Error(`${file ?? 'source'}: ${error.message}`, { cause: error });
  }
};
const propertyName = (node) => (node?.type === 'Identifier' ? node.name : node?.value);
const unwrap = (node) =>
  ['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression'].includes(node?.type)
    ? unwrap(node.expression)
    : node;
export function messageArguments(pattern, locale = 'ko') {
  const result = new Set();
  const visit = (items) => {
    for (const item of items) {
      if (item.type !== 0 && item.type !== 7 && item.value) result.add(item.value);
      if (item.options) for (const option of Object.values(item.options)) visit(option.value);
      if (item.children) visit(item.children);
    }
  };
  visit(new IntlMessageFormat(pattern, locale, undefined, { ignoreTag: true }).getAst());
  return [...result].sort();
}

export function scanI18nSource(source, file = 'input.tsx') {
  const candidates = [],
    calls = [],
    dynamicCalls = [];
  const tree = ast(source, file);
  const functions = new Map(
    ['t', 'message', 'retainedMessage', 'formatMessage'].map((name) => [name, name])
  );
  for (const entry of tree.program.body) {
    if (entry.type !== 'ImportDeclaration') continue;
    const imported = /\/i18n\.[jt]s$/u.test(entry.source.value)
      ? { t: 't', message: 'message', formatMessage: 'formatMessage' }
      : /\/ui-message\.[jt]s$/u.test(entry.source.value)
        ? { uiMessage: 'message' }
        : null;
    if (!imported) continue;
    for (const item of entry.specifiers) {
      const name = propertyName(item.imported);
      if (item.type === 'ImportSpecifier' && Object.hasOwn(imported, name))
        functions.set(item.local.name, imported[name]);
    }
  }
  walk(tree, (node) => {
    const text =
      node.type === 'StringLiteral' || node.type === 'JSXText'
        ? node.value
        : node.type === 'TemplateElement'
          ? node.value.cooked
          : null;
    if (typeof text === 'string' && /[\uac00-\ud7a3]/u.test(text)) {
      candidates.push({ file, line: node.loc.start.line, kind: node.type, text: text.trim() });
    }
    if (
      node.type !== 'CallExpression' ||
      node.callee.type !== 'Identifier' ||
      !functions.has(node.callee.name)
    )
      return;
    const key = node.arguments[0];
    if (key?.type !== 'StringLiteral') {
      dynamicCalls.push({
        file,
        line: node.loc.start.line,
        expression: source.slice(node.start, node.end),
      });
      return;
    }
    const values = node.arguments[functions.get(node.callee.name) === 'formatMessage' ? 2 : 1];
    const args =
      values?.type === 'ObjectExpression'
        ? values.properties
            .filter((item) => item.type === 'ObjectProperty')
            .map((item) => propertyName(item.key))
            .sort()
        : values
          ? null
          : [];
    if (args === null)
      dynamicCalls.push({
        file,
        line: node.loc.start.line,
        expression: source.slice(node.start, node.end),
      });
    calls.push({ key: key.value, args, file, line: node.loc.start.line });
  });
  return { candidates, calls, dynamicCalls };
}

const hangul = /[가-힣]/u;
const calleeName = (callee) =>
  propertyName(callee?.type === 'MemberExpression' ? callee.property : callee) ?? '';
const errorSite = (node) =>
  node.type === 'ThrowStatement' ||
  (node.type === 'NewExpression' && /Error$/u.test(calleeName(node.callee))) ||
  (node.type === 'CallExpression' && calleeName(node.callee) === 'reject');

export function findKoreanServerErrors(source, file = 'server/input.ts') {
  const found = [];
  const tree = parse(source, {
    sourceType: 'module',
    plugins: /x$/u.test(file) ? ['typescript', 'jsx'] : ['typescript'],
  });
  walk(tree, (node) => {
    if (!errorSite(node)) return;
    walk(node.type === 'ThrowStatement' ? node.argument : node.arguments, (inner) => {
      const text =
        inner.type === 'StringLiteral'
          ? inner.value
          : inner.type === 'TemplateElement'
            ? inner.value.cooked
            : null;
      if (typeof text === 'string' && hangul.test(text))
        found.push(
          `${file}:${inner.loc.start.line}: Korean text in a thrown error; give it a catalog code (packages/contracts) and a message in web/locales, then throw an AppError from server/ or a ValidationError with English model-facing text from core/, so the web renders it in the reader's language`
        );
    });
  });
  return [...new Set(found)];
}

const keyLikeStart = /^[A-Za-z][\w-]*\./u;
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

export function scanMessageReferences(source, file = 'input.ts') {
  const literals = new Set(),
    patterns = new Set();
  const tree = parse(source, {
    sourceType: 'unambiguous',
    errorRecovery: true,
    plugins: /\.[jt]sx$|\.m?js$/u.test(file) ? ['typescript', 'jsx'] : ['typescript'],
  });
  walk(tree, (node) => {
    if (node.type === 'StringLiteral' || node.type === 'JSXText') literals.add(node.value);
    else if (node.type === 'TemplateLiteral') {
      const parts = node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw);
      if (parts.length === 1) literals.add(parts[0]);
      else if (keyLikeStart.test(parts[0])) patterns.add(`^${parts.map(escapeRegExp).join('.+')}$`);
    } else if (
      node.type === 'BinaryExpression' &&
      node.operator === '+' &&
      node.left.type === 'StringLiteral' &&
      keyLikeStart.test(node.left.value)
    )
      patterns.add(`^${escapeRegExp(node.left.value)}.+$`);
  });
  return { literals, patterns };
}

export const retainedMessagePrefixes = [
  {
    prefix: 'errors.auxiliary.',
    reason: 'web/auxiliary-error.ts derives each .details key from its .message key',
  },
];

export function findUnusedMessages(catalog, sources) {
  const literals = new Set(),
    patterns = new Set();
  for (const { file, source } of sources) {
    const scanned = scanMessageReferences(source, file);
    for (const item of scanned.literals) literals.add(item);
    for (const item of scanned.patterns) patterns.add(item);
  }
  const expressions = [...patterns].map((pattern) => new RegExp(pattern, 'u'));
  return [...catalog.keys()].filter(
    (key) =>
      !literals.has(key) &&
      !retainedMessagePrefixes.some(({ prefix }) => key.startsWith(prefix)) &&
      !expressions.some((expression) => expression.test(key))
  );
}

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(resolve(directory, entry.name)) : [resolve(directory, entry.name)]
  );
}
export function checkI18n(root = resolve(fileURLToPath(new URL('..', import.meta.url)))) {
  const catalog = new Map(),
    catalogFiles = new Map(),
    errors = [],
    candidates = [],
    calls = [],
    dynamicCalls = [];
  for (const file of files(resolve(root, 'web/locales')).filter((path) => path.endsWith('.ts'))) {
    walk(ast(readFileSync(file, 'utf8'), relative(root, file)), (node) => {
      if (
        node.type !== 'VariableDeclarator' ||
        node.id.name !== 'messages' ||
        unwrap(node.init)?.type !== 'ObjectExpression'
      )
        return;
      for (const entry of unwrap(node.init).properties) {
        if (entry.type !== 'ObjectProperty') continue;
        const key = propertyName(entry.key);
        if (catalog.has(key))
          errors.push(`${key}: duplicate catalog key (${relative(root, file)})`);
        if (entry.value.type !== 'ObjectExpression') continue;
        const values = Object.fromEntries(
          entry.value.properties
            .filter((item) => item.type === 'ObjectProperty')
            .map((item) => [propertyName(item.key), item.value.value])
        );
        const signatures = [];
        for (const locale of locales) {
          if (typeof values[locale] !== 'string' || !values[locale].trim()) {
            errors.push(`${key}: missing ${locale}`);
            continue;
          }
          try {
            signatures.push(JSON.stringify(messageArguments(values[locale], locale)));
          } catch (error) {
            errors.push(`${key}/${locale}: invalid ICU (${error.message})`);
          }
        }
        if (new Set(signatures).size > 1) errors.push(`${key}: locale argument mismatch`);
        catalog.set(key, values);
        catalogFiles.set(key, relative(root, file));
      }
    });
  }
  for (const file of files(resolve(root, 'web')).filter(
    (path) => /\.[cm]?[jt]sx?$/u.test(path) && !path.includes(`${resolve(root, 'web/locales')}`)
  )) {
    const scanned = scanI18nSource(readFileSync(file, 'utf8'), relative(root, file));
    candidates.push(...scanned.candidates);
    calls.push(...scanned.calls);
    dynamicCalls.push(...scanned.dynamicCalls);
  }
  for (const call of calls) {
    const pattern = catalog.get(call.key)?.ko;
    const location = `${call.file}:${call.line}`;
    if (!pattern) {
      errors.push(`${location}: unknown message ${call.key}`);
      continue;
    }
    if (call.args === null) continue;
    try {
      const required = messageArguments(pattern);
      if (JSON.stringify(required) !== JSON.stringify(call.args))
        errors.push(`${location}: ${call.key} requires [${required}], received [${call.args}]`);
    } catch {}
  }
  const localeDirectory = resolve(root, 'web/locales');
  const sources = ['web', 'core', 'packages', 'server', 'scripts', 'tests']
    .filter((directory) => existsSync(resolve(root, directory)))
    .flatMap((directory) => files(resolve(root, directory)))
    .filter((path) => /\.[cm]?[jt]sx?$|\.mts$/u.test(path) && !path.startsWith(localeDirectory))
    .map((path) => ({
      file: relative(root, path).replaceAll('\\', '/'),
      source: readFileSync(path, 'utf8'),
    }));
  for (const { file, source } of sources)
    if (/^(?:server|core)\//u.test(file)) errors.push(...findKoreanServerErrors(source, file));
  const unused = findUnusedMessages(catalog, sources);
  for (const key of unused)
    errors.push(
      `${key}: unused message (${catalogFiles.get(key)}); remove it from all four languages, or register its dynamic prefix in scripts/check-i18n.mjs`
    );
  return {
    messages: catalog.size,
    unused,
    calls: calls.length,
    errors,
    candidates,
    dynamicCalls,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = checkI18n();
  for (const error of report.errors) console.error(error);
  console.log(
    `i18n: ${report.messages} messages, ${report.calls} literal calls, ${report.errors.length} errors.`
  );
  console.log(
    `REVIEW: ${report.candidates.length} Korean static candidates (includes authored defaults/contracts; candidate count is not a completeness assertion).`
  );
  console.log(
    `REVIEW: ${report.dynamicCalls.length} dynamic message calls require branch/runtime review.`
  );
  if (process.argv.includes('--candidates'))
    for (const item of report.candidates)
      console.log(
        `${item.file}:${item.line} ${item.kind}: ${item.text.replace(/\s+/gu, ' ').slice(0, 180)}`
      );
  if (process.argv.includes('--candidates'))
    for (const item of report.dynamicCalls)
      console.log(
        `${item.file}:${item.line} DynamicCall: ${item.expression.replace(/\s+/gu, ' ').slice(0, 180)}`
      );
  process.exitCode = report.errors.length ? 1 : 0;
}
