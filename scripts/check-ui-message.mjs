import { parse } from '@babel/parser';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, posix, relative, resolve } from 'node:path';
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

export const legacyDescriptorApis = {
  'web/i18n.js': ['message', 'messageRef', 'translateMessage'],
  'web/api-errors.js': ['errorDescriptor'],
  'web/ui-message.js': ['legacyMessageString'],
};
const legacyModules = new Set(['web/i18n.ts', 'web/ui-message.ts']);
export const legacyWrapperRemedy =
  'keep the state, prop or callback argument as a UiMessage (uiMessage(key), toUiMessage(caught)) instead of wrapping a string in legacyUiMessage';
export const legacyDescriptorRemedy =
  'build a UiMessage with uiMessage(key, values) or toUiMessage(caught) instead of a descriptor string';

const legacyExports = {
  ...legacyDescriptorApis,
  'web/ui-message.js': [...legacyDescriptorApis['web/ui-message.js'], 'legacyUiMessage'],
};
const exportName = (node) => node.name ?? node.value;
const memberName = (node) =>
  node.computed
    ? node.property.type === 'StringLiteral'
      ? node.property.value
      : null
    : node.property.name;
const isMember = (node) =>
  node?.type === 'MemberExpression' || node?.type === 'OptionalMemberExpression';
const bindingOnly = (node, parent) =>
  parent?.type === 'ImportSpecifier' ||
  parent?.type === 'ImportNamespaceSpecifier' ||
  parent?.type === 'ExportSpecifier' ||
  (parent?.type === 'VariableDeclarator' && parent.id === node) ||
  (isMember(parent) && parent.property === node && !parent.computed) ||
  (parent?.type === 'ObjectProperty' && parent.key === node && !parent.computed);

function legacyUses(tree, file) {
  const apis = new Set();
  const wrappers = new Set();
  const namespaces = new Map();
  let wrapperUses = 0;
  const resolveModule = (source) => posix.join(posix.dirname(file), source);
  const take = (module, name, local) => {
    if (!legacyExports[module]?.includes(name)) return;
    if (name === 'legacyUiMessage') {
      if (local) wrappers.add(local);
    } else apis.add(name);
  };
  for (const node of tree.program.body) {
    if (!node.source?.value?.startsWith('.')) continue;
    const module = resolveModule(node.source.value);
    if (node.type === 'ImportDeclaration')
      for (const specifier of node.specifiers) {
        if (specifier.type === 'ImportSpecifier')
          take(module, exportName(specifier.imported), specifier.local.name);
        else if (legacyExports[module]) namespaces.set(specifier.local.name, module);
      }
    if (node.type === 'ExportNamedDeclaration')
      for (const specifier of node.specifiers) {
        const name = exportName(specifier.local);
        take(module, name);
        if (name === 'legacyUiMessage' && legacyExports[module]?.includes(name)) wrapperUses++;
      }
    if (node.type === 'ExportAllDeclaration' && legacyExports[module]) {
      for (const name of legacyExports[module]) take(module, name);
      if (legacyExports[module].includes('legacyUiMessage')) wrapperUses++;
    }
  }
  const fromNamespace = (node) =>
    node?.type === 'Identifier' ? namespaces.get(node.name) : undefined;
  walk(tree, (node) => {
    if (node.type === 'VariableDeclarator' && node.init?.type === 'Identifier') {
      if (node.id.type === 'Identifier' && wrappers.has(node.init.name)) wrappers.add(node.id.name);
      const module = fromNamespace(node.init);
      if (module && node.id.type === 'ObjectPattern')
        for (const property of node.id.properties)
          if (property.type === 'ObjectProperty' && !property.computed)
            take(module, exportName(property.key), property.value.name);
    }
  });
  walk(tree, (node, parent) => {
    if (isMember(node)) {
      const module = fromNamespace(node.object);
      const name = module && memberName(node);
      if (name && legacyExports[module].includes(name)) {
        take(module, name);
        if (name === 'legacyUiMessage') wrapperUses++;
      }
    }
    if (node.type === 'Identifier' && wrappers.has(node.name) && !bindingOnly(node, parent))
      wrapperUses++;
  });
  return { apis: [...apis].sort(), wrappers: wrapperUses };
}

export function legacyMessageUses(source, file = 'web/input.tsx') {
  return legacyUses(parseSource(source, file), file);
}

export function readAllowlist(directory = root) {
  const path = resolve(directory, allowlistPath);
  const empty = { permanent: {}, debt: {}, legacyWrappers: {}, legacyDescriptors: [] };
  if (!existsSync(path)) return empty;
  const {
    permanent = {},
    debt = {},
    legacyWrappers = {},
    legacyDescriptors = [],
    ...rest
  } = JSON.parse(readFileSync(path, 'utf8'));
  if (Object.keys(rest).length)
    throw new Error(
      `${allowlistPath}: only "permanent", "debt", "legacyWrappers" and "legacyDescriptors" sections are allowed`
    );
  for (const [file, entry] of Object.entries(permanent))
    if (!Number.isInteger(entry?.count) || entry.count < 1 || !entry.reason?.trim())
      throw new Error(`${allowlistPath}: permanent "${file}" needs a positive count and a reason`);
  for (const [section, counts] of [
    ['debt', debt],
    ['legacyWrappers', legacyWrappers],
  ])
    for (const [file, count] of Object.entries(counts))
      if (!Number.isInteger(count) || count < 1)
        throw new Error(`${allowlistPath}: ${section} "${file}" needs a positive whole count`);
  if (
    !Array.isArray(legacyDescriptors) ||
    legacyDescriptors.some((file) => typeof file !== 'string')
  )
    throw new Error(`${allowlistPath}: legacyDescriptors is a list of files`);
  return { permanent, debt, legacyWrappers, legacyDescriptors };
}

function scanSources(directory) {
  const counts = new Map();
  const wrappers = new Map();
  const descriptors = new Map();
  const plain = [];
  for (const path of sourceFiles(resolve(directory, 'web'))) {
    const file = relative(directory, path).replaceAll('\\', '/');
    const tree = parseSource(readFileSync(path, 'utf8'), file);
    if (file !== jsonParseFile)
      for (const line of jsonParseLines(tree)) plain.push(`${file}:${line}: ${jsonParseRemedy}`);
    if (!legacyModules.has(file)) {
      const uses = legacyUses(tree, file);
      if (uses.wrappers) wrappers.set(file, uses.wrappers);
      if (uses.apis.length) descriptors.set(file, uses.apis);
    }
    if (exemptFiles.has(file)) continue;
    for (const line of plainErrorLines(tree)) plain.push(`${file}:${line}: ${plainErrorRemedy}`);
    const lines = errorTextLines(tree);
    if (lines.length) counts.set(file, lines);
  }
  return { counts, wrappers, descriptors, plain };
}

function legacyErrors({ legacyWrappers = {}, legacyDescriptors = [] }, { wrappers, descriptors }) {
  const errors = [];
  const shrink = '(node scripts/check-ui-message.mjs --shrink)';
  for (const file of new Set([...wrappers.keys(), ...Object.keys(legacyWrappers)])) {
    const found = wrappers.get(file) ?? 0;
    const allowed = legacyWrappers[file] ?? 0;
    if (found > allowed)
      errors.push(
        `${file}: ${found} legacyUiMessage uses, ${allowed ? `${allowlistPath} allows ${allowed}` : 'none allowed'}; ${legacyWrapperRemedy}`
      );
    else if (found < allowed)
      errors.push(
        found
          ? `${allowlistPath}: ${file} now has ${found} legacyUiMessage uses; lower legacyWrappers from ${allowed} to ${found} ${shrink}`
          : `${allowlistPath}: ${file} has no legacyUiMessage uses; remove its legacyWrappers entry ${shrink}`
      );
  }
  const listed = new Set(legacyDescriptors);
  for (const [file, apis] of descriptors)
    if (!listed.has(file))
      errors.push(
        `${file}: uses the legacy descriptor API (${apis.join(', ')}) but is not in legacyDescriptors; ${legacyDescriptorRemedy}`
      );
  for (const file of listed)
    if (!descriptors.has(file))
      errors.push(
        `${allowlistPath}: ${file} no longer uses a legacy descriptor API; remove it from legacyDescriptors ${shrink}`
      );
  return errors;
}

export function scanUiMessages(directory = root) {
  return scanSources(directory).counts;
}

export function uiMessageErrors(directory = root, allowlist = readAllowlist(directory)) {
  const { permanent, debt } = allowlist;
  const scan = scanSources(directory);
  const { counts, plain } = scan;
  const errors = [...plain, ...legacyErrors(allowlist, scan)];
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
  const { permanent, debt, legacyWrappers = {}, legacyDescriptors = [] } = allowlist;
  const { counts, wrappers, descriptors } = scanSources(directory);
  const sorted = (entries) =>
    Object.fromEntries(
      entries.filter(([, count]) => count > 0).sort(([left], [right]) => (left < right ? -1 : 1))
    );
  const keptWrappers = sorted(
    Object.entries(legacyWrappers).map(([file, allowed]) => [
      file,
      Math.min(allowed, wrappers.get(file) ?? 0),
    ])
  );
  const keptDescriptors = legacyDescriptors.filter((file) => descriptors.has(file)).sort();
  const next = {
    permanent,
    debt: sorted(
      Object.entries(debt).map(([file, owed]) => [
        file,
        Math.min(
          owed,
          Math.max(0, (counts.get(file)?.length ?? 0) - (permanent[file]?.count ?? 0))
        ),
      ])
    ),
    ...(Object.keys(keptWrappers).length ? { legacyWrappers: keptWrappers } : {}),
    ...(keptDescriptors.length ? { legacyDescriptors: keptDescriptors } : {}),
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
    const { permanent, debt, legacyWrappers, legacyDescriptors } = readAllowlist();
    const owed = Object.values(debt).reduce((sum, count) => sum + count, 0);
    const wrapped = Object.values(legacyWrappers).reduce((sum, count) => sum + count, 0);
    console.log(
      `UI messages PASS (${owed} unconverted error-text reads in ${Object.keys(debt).length} files; ${Object.keys(permanent).length} permanent exceptions; ${wrapped} legacyUiMessage uses in ${Object.keys(legacyWrappers).length} files; ${legacyDescriptors.length} files on legacy descriptors)`
    );
  }
}
