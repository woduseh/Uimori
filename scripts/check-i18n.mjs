import { parse } from '@babel/parser';
import { IntlMessageFormat } from 'intl-messageformat';
import { readFileSync, readdirSync } from 'node:fs';
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

/** Includes attributes, templates, hidden/status text and module constants, unlike verify:copy. */
export function scanI18nSource(source, file = 'input.tsx') {
  const candidates = [],
    calls = [],
    dynamicCalls = [];
  const tree = ast(source, file);
  const functions = new Map(
    ['t', 'message', 'retainedMessage', 'legacyMessage', 'formatMessage'].map((name) => [
      name,
      name,
    ])
  );
  for (const entry of tree.program.body) {
    if (entry.type !== 'ImportDeclaration' || !/\/i18n\.[jt]s$/u.test(entry.source.value)) continue;
    for (const item of entry.specifiers) {
      if (
        item.type === 'ImportSpecifier' &&
        ['t', 'message', 'legacyMessage', 'formatMessage'].includes(propertyName(item.imported))
      )
        functions.set(item.local.name, propertyName(item.imported));
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

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(resolve(directory, entry.name)) : [resolve(directory, entry.name)]
  );
}
export function checkI18n(root = resolve(fileURLToPath(new URL('..', import.meta.url)))) {
  const catalog = new Map(),
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
    if (call.args === null) continue; // Forwarded argument objects require runtime coverage.
    try {
      const required = messageArguments(pattern);
      if (JSON.stringify(required) !== JSON.stringify(call.args))
        errors.push(`${location}: ${call.key} requires [${required}], received [${call.args}]`);
    } catch {
      /* Catalog syntax is reported above. */
    }
  }
  const koreanMessages = new Set([...catalog.values()].map((entry) => entry.ko));
  const unregisteredCandidates = candidates.filter((entry) => !koreanMessages.has(entry.text));
  return {
    messages: catalog.size,
    calls: calls.length,
    errors,
    candidates,
    dynamicCalls,
    unregisteredCandidates,
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
  console.log(
    `REVIEW: ${report.unregisteredCandidates.length} candidates have no exact Korean catalog entry (authored content/contracts may be intentional).`
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
