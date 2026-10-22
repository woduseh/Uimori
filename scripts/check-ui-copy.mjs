import { parse } from '@babel/parser';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scope =
  'SOURCE Korean UI copy review (including literal i18n keys); runtime visibility and usefulness are not evaluated.';
const normalize = (text) => text.replace(/\s+/gu, ' ').trim();
const tag = (node) => node.openingElement?.name?.name;
const attribute = (node, name) =>
  node.openingElement?.attributes.find(
    (item) => item.type === 'JSXAttribute' && item.name.name === name
  );
const expression = (attr) =>
  attr?.value?.type === 'JSXExpressionContainer' ? attr.value.expression : attr?.value;
const literal = (node) =>
  node?.type === 'StringLiteral'
    ? node.value
    : node?.type === 'TemplateLiteral' && !node.expressions.length
      ? node.quasis[0].value.cooked
      : null;
const value = (node, name) => literal(expression(attribute(node, name)));
const isTrue = (attr) =>
  !!attr && (!attr.value || expression(attr)?.value === true || expression(attr)?.value === 'true');
const isFalse = (attr) => expression(attr)?.value === false || expression(attr)?.value === 'false';
const ignoredKeys = new Set([
  'start',
  'end',
  'loc',
  'extra',
  'comments',
  'leadingComments',
  'trailingComments',
  'innerComments',
]);
const signature = (node) =>
  JSON.stringify(node, (key, item) => (ignoredKeys.has(key) ? undefined : item));

function excluded(node) {
  const name = tag(node);
  const classes = value(node, 'className') ?? '';
  return (
    ['LazyDiagnostics', 'Prose', 'RisuMessageSurface', 'Tooltip', 'pre', 'code'].includes(name) ||
    (name === 'details' && !isTrue(attribute(node, 'open'))) ||
    ['hidden', 'aria-hidden'].some((key) => isTrue(attribute(node, key))) ||
    (attribute(node, 'contentEditable') && !isFalse(attribute(node, 'contentEditable'))) ||
    !!attribute(node, 'dangerouslySetInnerHTML') ||
    ['alert', 'alertdialog', 'status', 'tooltip'].includes(value(node, 'role')) ||
    ['polite', 'assertive'].includes(value(node, 'aria-live')) ||
    /(?:^|[\s_-])(?:error|validation|status|notice|sr-only|visually-hidden|prose|source-text)(?:$|[\s_-])/u.test(
      classes
    ) ||
    ['source-text', 'source-raw'].includes(value(node, 'data-testid'))
  );
}

// JSX removes indentation, but does not insert spaces around inline elements.
function jsxText(text) {
  const lines = text.split(/\r\n|\n|\r/u);
  const last = lines.findLastIndex((line) => /\S/u.test(line));
  return lines
    .map((line, index) => {
      let part = line.replace(/\t/gu, ' ');
      if (index) part = part.trimStart();
      if (index < lines.length - 1) part = part.trimEnd();
      return part && index < last ? `${part} ` : part;
    })
    .join('');
}

// Only literal t('key') calls are resolved. ICU parameters and computed keys stay dynamic.
function translated(node, messages) {
  if (
    node?.type !== 'CallExpression' ||
    node.callee?.type !== 'Identifier' ||
    node.callee.name !== 't' ||
    node.arguments[0]?.type !== 'StringLiteral'
  )
    return null;
  const key = node.arguments[0].value;
  const text = messages[key];
  if (typeof text !== 'string') return null;
  return { text, messageKey: key, dynamic: node.arguments.length > 1 || /\{[^{}]*\}/u.test(text) };
}

/** Collect alternatives for human review, never treat them as exact visible text. */
function translationAlternatives(node, messages, found = new Map()) {
  if (!node || typeof node !== 'object') return [...found.values()];
  const translatedChunk = translated(node, messages);
  if (translatedChunk) found.set(translatedChunk.messageKey, translatedChunk);
  for (const [key, child] of Object.entries(node)) {
    if (ignoredKeys.has(key)) continue;
    for (const item of Array.isArray(child) ? child : [child])
      if (item && typeof item === 'object') translationAlternatives(item, messages, found);
  }
  return [...found.values()];
}

function parts(node, messages) {
  if (node.type === 'JSXText') return [{ text: jsxText(node.value) }];
  if (node.type === 'JSXExpressionContainer') {
    if (node.expression.type === 'JSXEmptyExpression') return [];
    const text = literal(node.expression);
    if (text !== null) return [{ text }];
    const translatedChunk = translated(node.expression, messages);
    return translatedChunk ? [translatedChunk] : [{ expression: signature(node.expression) }];
  }
  if (node.type === 'JSXElement') {
    if (
      excluded(node) ||
      !['p', 'small', 'span', 'em', 'strong', 'b', 'i', 'a', 'br'].includes(tag(node))
    )
      return null;
    if (tag(node) === 'br') return [{ text: ' ' }];
  } else if (node.type !== 'JSXFragment') return null;
  const children = node.children.map((child) => parts(child, messages));
  return children.some((child) => child === null) ? null : children.flat();
}

/** Deliberately local: no variable evaluation, component expansion, CSS or rendered-text scan. */
export function scanSource(source, file = 'input.tsx', messages = {}, review = []) {
  const ast = parse(source, { sourceType: 'unambiguous', plugins: ['typescript', 'jsx'] });
  const copies = [],
    fields = [],
    warnings = [],
    seen = new Set();
  const warn = (copy, rule, relatedLine) => {
    const key = `${rule}:${copy.node.start}`;
    if (seen.has(key)) return;
    seen.add(key);
    warnings.push({
      file,
      line: copy.node.loc.start.line,
      rule,
      text: copy.text,
      ...(copy.messageKeys.length ? { messageKeys: copy.messageKeys } : {}),
      ...(relatedLine ? { relatedLine } : {}),
    });
  };
  const visit = (node, parents = [], branches = [], mapped = false, parent = null) => {
    if (
      !node ||
      typeof node !== 'object' ||
      ['JSXAttribute', 'JSXSpreadAttribute'].includes(node.type)
    )
      return;
    if (node.type === 'JSXElement' && excluded(node)) return;
    if (
      ['ArrowFunctionExpression', 'FunctionExpression'].includes(node.type) &&
      parent?.type === 'CallExpression' &&
      parent.arguments[0] === node &&
      parent.callee.type === 'MemberExpression' &&
      parent.callee.property.name === 'map'
    )
      mapped = true;
    const nearest = parents.at(-1);
    const area = (owner) => `${owner?.start ?? node.start}:${branches.join('/')}`;
    const controls = [...parents, node].some(
      (item) =>
        ['button', 'summary', 'option', 'title'].includes(tag(item)) ||
        (tag(item) === 'label' && tag(node) !== 'small') ||
        ['button', 'tab', 'tooltip'].includes(value(item, 'role'))
    );
    if (node.type === 'JSXElement' && ['p', 'small'].includes(tag(node)) && !controls) {
      const chunks = parts(node, messages);
      if (chunks) {
        const text = normalize(chunks.map((chunk) => chunk.text ?? '{…}').join(''));
        const copy = {
          node,
          chunks,
          text,
          area: area(nearest),
          static: chunks.every((chunk) => 'text' in chunk && !chunk.dynamic),
          messageKeys: [...new Set(chunks.map((chunk) => chunk.messageKey).filter(Boolean))],
        };
        copies.push(copy);
        if (copy.text && copy.text !== '{…}')
          review.push({
            file,
            line: node.loc.start.line,
            text: copy.text,
            ...(copy.messageKeys.length ? { messageKeys: copy.messageKeys } : {}),
            static: copy.static,
          });
        // Conditional messages are reviewable, but never exactly matched as co-visible text.
        for (const child of node.children) {
          if (child.type !== 'JSXExpressionContainer') continue;
          if (translated(child.expression, messages)) continue;
          for (const alternative of translationAlternatives(child.expression, messages))
            review.push({
              file,
              line: node.loc.start.line,
              text: alternative.text,
              messageKeys: [alternative.messageKey],
              static: false,
              conditional: true,
            });
        }
        if (copy.static && [...text].length >= 100) warn(copy, 'long-help');
        if (copy.static && mapped && !branches.length && [...text].length >= 15)
          warn(copy, 'repeated-item-help');
      }
    }
    if (node.type === 'JSXElement' && ['input', 'textarea'].includes(tag(node))) {
      const placeholder = expression(attribute(node, 'placeholder'));
      if (placeholder) {
        const label = parents.findLastIndex((item) => tag(item) === 'label');
        fields.push({ node, placeholder, area: area(label >= 0 ? parents[label - 1] : nearest) });
      }
    }
    const nextParents = ['JSXElement', 'JSXFragment'].includes(node.type)
      ? [...parents, node]
      : parents;
    for (const [key, child] of Object.entries(node)) {
      if (ignoredKeys.has(key)) continue;
      const guarded =
        (node.type === 'ConditionalExpression' && ['consequent', 'alternate'].includes(key)) ||
        (node.type === 'LogicalExpression' && key === 'right') ||
        (node.type === 'IfStatement' && ['consequent', 'alternate'].includes(key));
      const nextBranches = guarded ? [...branches, `${node.start}:${key}`] : branches;
      for (const item of Array.isArray(child) ? child : [child])
        if (item && typeof item === 'object') visit(item, nextParents, nextBranches, mapped, node);
    }
  };
  visit(ast.program);
  const first = new Map();
  for (const copy of copies) {
    if (copy.static && [...copy.text].length >= 20) {
      const key = `${copy.area}:${copy.text}`;
      if (first.has(key)) warn(copy, 'duplicate-help', first.get(key).node.loc.start.line);
      else first.set(key, copy);
    }
    for (const field of fields.filter((item) => item.area === copy.area)) {
      const text =
        literal(field.placeholder) ?? translated(field.placeholder, messages)?.text ?? null;
      const matches =
        text === null
          ? copy.chunks.some((chunk) => chunk.expression === signature(field.placeholder))
          : copy.static &&
            [...normalize(text)].length >= 20 &&
            normalize(copy.chunks.map((chunk) => chunk.text ?? '\ufffc').join('')).includes(
              normalize(text)
            );
      if (matches) warn(copy, 'placeholder-help', field.node.loc.start.line);
    }
  }
  return warnings.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}

/** Read plain locale source syntax, without executing app modules or evaluating ICU expressions. */
function unwrapExpression(node) {
  return ['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression'].includes(node?.type)
    ? unwrapExpression(node.expression)
    : node;
}

function localeMessages(root) {
  const directory = resolve(root, 'web/locales');
  const messages = Object.create(null),
    errors = [];
  if (!existsSync(directory)) return { messages, errors };
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name === 'index.ts') continue;
    const file = relative(root, resolve(directory, entry.name)).replaceAll('\\', '/');
    try {
      const ast = parse(readFileSync(resolve(directory, entry.name), 'utf8'), {
        sourceType: 'module',
        plugins: ['typescript'],
      });
      const declaration = ast.program.body
        .filter((item) => item.type === 'ExportNamedDeclaration')
        .flatMap((item) => item.declaration?.declarations ?? [])
        .find((item) => item.id.type === 'Identifier' && item.id.name === 'messages');
      const body = unwrapExpression(declaration?.init);
      if (body?.type !== 'ObjectExpression')
        throw new Error('Expected an exported messages object.');
      for (const property of body.properties) {
        if (property.type !== 'ObjectProperty' || property.computed) continue;
        const key = literal(property.key) ?? property.key.name;
        const values = property.value;
        if (values.type !== 'ObjectExpression') continue;
        const korean = values.properties.find(
          (item) => item.type === 'ObjectProperty' && (literal(item.key) ?? item.key.name) === 'ko'
        );
        if (korean && typeof literal(korean.value) === 'string')
          messages[key] = literal(korean.value);
      }
    } catch (error) {
      errors.push({ file, message: error.message });
    }
  }
  return { messages, errors };
}

export function scanDirectory(root = process.cwd()) {
  const warnings = [],
    review = [],
    { messages, errors } = localeMessages(root);
  let count = 0;
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && /\.[jt]sx$/u.test(entry.name)) {
        const file = relative(root, path).replaceAll('\\', '/');
        count++;
        try {
          warnings.push(...scanSource(readFileSync(path, 'utf8'), file, messages, review));
        } catch (error) {
          errors.push({ file, message: error.message });
        }
      }
    }
  };
  try {
    walk(resolve(root, 'web'));
  } catch (error) {
    errors.push({ file: 'web', message: error.message });
  }
  if (!count && !errors.length) errors.push({ file: 'web', message: 'No JSX source files found.' });
  return {
    status: errors.length ? 'incomplete' : 'complete',
    scope,
    files: count,
    warnings,
    review,
    errors,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).some((arg) => arg !== '--json')) {
    console.error(
      'UI copy scan incomplete: supported option is --json. Run from the repository root.'
    );
    process.exitCode = 1;
  } else {
    const report = scanDirectory();
    if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(
        `UI copy SOURCE candidates: ${report.warnings.length} (${report.files} files, ${report.review.length} inspected explanations; ${report.status}). ${scope}`
      );
      for (const warning of report.warnings)
        console.log(
          `${warning.file}:${warning.line} [${warning.rule}] ${warning.text.slice(0, 120)}${warning.text.length > 120 ? '…' : ''}${warning.relatedLine ? ` (related line ${warning.relatedLine})` : ''}`
        );
      for (const error of report.errors)
        console.error(`${error.file}: scan incomplete: ${error.message}`);
    }
    if (report.status === 'incomplete') process.exitCode = 1;
  }
}
