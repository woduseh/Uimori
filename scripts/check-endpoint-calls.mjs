import { parse } from '@babel/parser';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

export const allowlistPath = 'scripts/legacy-api-allowlist.json';
export const apiModuleFile = 'web/api.ts';
const apiModuleStem = 'web/api';
const shrinkCommand = 'node scripts/check-endpoint-calls.mjs --shrink';
const sourceExtension = /\.(?:ts|tsx|mts|cts|js|mjs)$/u;
const legacyBindings = new Set(['api', 'apiBinary']);
const globalFetchReceivers = new Set(['window', 'self', 'globalThis']);
const callHelpers = new Set(['call', 'apply', 'bind']);
const permanentKinds = new Set(['fetch', 'apiBinary']);
const ignored = new Set([
  'loc',
  'extra',
  'comments',
  'tokens',
  'leadingComments',
  'trailingComments',
  'typeAnnotation',
  'typeParameters',
  'returnType',
]);
const typeNodeTypes = new Set([
  'TSTypeAnnotation',
  'TSTypeParameterInstantiation',
  'TSTypeParameterDeclaration',
  'TSTypeAliasDeclaration',
  'TSInterfaceDeclaration',
  'TSDeclareFunction',
  'TSQualifiedName',
  'TSTypeQuery',
]);

export const remedy = [
  'Call typed contract routes through callEndpoint(...) from web/api.ts instead of api() or direct fetch().',
  `When a file drops legacy api() calls, shrink its debt count with \`${shrinkCommand}\`.`,
  `A permanent binary or stream call (apiBinary() or direct fetch() outside web/api.ts) goes under "permanent" in ${allowlistPath} with its count, kind, and reason.`,
].join('\n');

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

const propertyName = (node) =>
  node?.type === 'Identifier' ? node.name : node?.type === 'StringLiteral' ? node.value : undefined;

const memberProperty = (node) =>
  node.computed
    ? node.property?.type === 'StringLiteral'
      ? node.property.value
      : undefined
    : node.property?.type === 'Identifier'
      ? node.property.name
      : undefined;

const unwrap = (node) =>
  node &&
  [
    'TSAsExpression',
    'TSSatisfiesExpression',
    'TSNonNullExpression',
    'ParenthesizedExpression',
  ].includes(node.type)
    ? unwrap(node.expression)
    : node;

function resolvesToApiModule(file, specifier) {
  if (typeof specifier !== 'string' || !specifier.startsWith('.')) return false;
  const resolved = posix
    .normalize(posix.join(posix.dirname(file), specifier))
    .replace(/\.(?:[cm]?[jt]sx?)$/u, '');
  return resolved === apiModuleStem;
}

function collectPatternNames(pattern, names) {
  if (!pattern || typeof pattern !== 'object') return;
  switch (pattern.type) {
    case 'Identifier':
      names.add(pattern.name);
      return;
    case 'RestElement':
      collectPatternNames(pattern.argument, names);
      return;
    case 'AssignmentPattern':
      collectPatternNames(pattern.left, names);
      return;
    case 'ArrayPattern':
      for (const item of pattern.elements) collectPatternNames(item, names);
      return;
    case 'ObjectPattern':
      for (const property of pattern.properties) {
        if (property.type === 'RestElement') collectPatternNames(property.argument, names);
        else collectPatternNames(property.value, names);
      }
      return;
    case 'TSParameterProperty':
      collectPatternNames(pattern.parameter, names);
      return;
  }
}

function collectBlockDecls(statements, names, includeVar = false) {
  for (const statement of statements ?? []) {
    if (!statement) continue;
    if (statement.type === 'VariableDeclaration') {
      if (includeVar || statement.kind !== 'var')
        for (const decl of statement.declarations) collectPatternNames(decl.id, names);
    } else if (
      (statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration') &&
      statement.id
    ) {
      names.add(statement.id.name);
    } else if (statement.type === 'ExportNamedDeclaration' && statement.declaration) {
      collectBlockDecls([statement.declaration], names, includeVar);
    } else if (statement.type === 'ExportDefaultDeclaration' && statement.declaration?.id) {
      if (
        statement.declaration.type === 'FunctionDeclaration' ||
        statement.declaration.type === 'ClassDeclaration'
      )
        names.add(statement.declaration.id.name);
    }
  }
}

function collectVarDecls(node, names) {
  if (!node || typeof node !== 'object') return;
  if (
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression' ||
    node.type === 'ClassMethod' ||
    node.type === 'ObjectMethod'
  )
    return;
  if (node.type === 'VariableDeclaration' && node.kind === 'var') {
    for (const decl of node.declarations) collectPatternNames(decl.id, names);
  }
  for (const [key, value] of Object.entries(node)) {
    if (ignored.has(key) || typeNodeTypes.has(node.type)) continue;
    if (Array.isArray(value)) for (const child of value) collectVarDecls(child, names);
    else if (value && typeof value === 'object') collectVarDecls(value, names);
  }
}

function scopeBindingsFor(node) {
  switch (node.type) {
    case 'BlockStatement': {
      const names = new Set();
      collectBlockDecls(node.body, names, false);
      return names;
    }
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
    case 'ClassMethod':
    case 'ObjectMethod': {
      const names = new Set();
      if (node.id?.type === 'Identifier' && node.type !== 'FunctionDeclaration')
        names.add(node.id.name);
      for (const param of node.params ?? []) collectPatternNames(param, names);
      if (node.body?.type === 'BlockStatement') {
        collectBlockDecls(node.body.body, names, true);
        collectVarDecls(node.body, names);
      }
      return names;
    }
    case 'CatchClause': {
      const names = new Set();
      collectPatternNames(node.param, names);
      return names;
    }
    case 'ForStatement':
    case 'ForInStatement':
    case 'ForOfStatement': {
      const names = new Set();
      const decl = node.init ?? node.left;
      if (decl?.type === 'VariableDeclaration' && decl.kind !== 'var')
        for (const item of decl.declarations) collectPatternNames(item.id, names);
      return names;
    }
    default:
      return null;
  }
}

export function scanLegacyApiSource(source, file = 'web/input.tsx') {
  const tree = parseSource(source, file);
  const importedDirect = new Map();
  const importedNamespaces = new Set();
  const issues = [];
  const topLevelDecls = new Set();

  collectBlockDecls(tree.program.body, topLevelDecls, true);

  for (const statement of tree.program.body) {
    if (statement.type === 'ImportDeclaration') {
      if (statement.importKind === 'type') continue;
      if (!resolvesToApiModule(file, statement.source.value)) continue;
      for (const specifier of statement.specifiers) {
        if (specifier.importKind === 'type') continue;
        if (specifier.type === 'ImportSpecifier') {
          const imported = propertyName(specifier.imported);
          if (legacyBindings.has(imported)) importedDirect.set(specifier.local.name, imported);
        } else if (specifier.type === 'ImportNamespaceSpecifier') {
          importedNamespaces.add(specifier.local.name);
        }
      }
    } else if (statement.type === 'ExportAllDeclaration' && statement.exportKind !== 'type') {
      if (resolvesToApiModule(file, statement.source.value))
        issues.push(
          `${file}:${statement.loc.start.line}: do not re-export web/api.ts; import callEndpoint directly`
        );
    } else if (
      statement.type === 'ExportNamedDeclaration' &&
      statement.exportKind !== 'type' &&
      statement.source &&
      resolvesToApiModule(file, statement.source.value)
    ) {
      for (const specifier of statement.specifiers) {
        if (specifier.exportKind === 'type') continue;
        const name = propertyName(specifier.local);
        if (legacyBindings.has(name))
          issues.push(
            `${file}:${statement.loc.start.line}: do not re-export ${name} from web/api.ts; import callEndpoint directly`
          );
      }
    }
  }

  const calls = { api: [], apiBinary: [], fetch: [] };
  const scopes = [];
  const countedRefNodes = new Set();

  const isShadowed = (name, includeTopLevel = false) =>
    (includeTopLevel && topLevelDecls.has(name)) || scopes.some((scope) => scope.has(name));

  const directKind = (node) => {
    const inner = unwrap(node);
    if (!inner) return null;
    if (inner.type === 'Identifier' && importedDirect.has(inner.name) && !isShadowed(inner.name)) {
      return { kind: importedDirect.get(inner.name), refs: [inner] };
    }
    if (
      (inner.type === 'MemberExpression' || inner.type === 'OptionalMemberExpression') &&
      unwrap(inner.object)?.type === 'Identifier'
    ) {
      const receiver = unwrap(inner.object);
      if (importedNamespaces.has(receiver.name) && !isShadowed(receiver.name)) {
        const name = memberProperty(inner);
        if (legacyBindings.has(name)) return { kind: name, refs: [inner, receiver] };
      }
    }
    return null;
  };

  const fetchTarget = (node) => {
    const inner = unwrap(node);
    if (!inner) return false;
    if (inner.type === 'Identifier' && inner.name === 'fetch' && !isShadowed('fetch', true))
      return true;
    if (
      (inner.type === 'MemberExpression' || inner.type === 'OptionalMemberExpression') &&
      unwrap(inner.object)?.type === 'Identifier'
    ) {
      const receiver = unwrap(inner.object);
      if (
        globalFetchReceivers.has(receiver.name) &&
        !isShadowed(receiver.name, true) &&
        memberProperty(inner) === 'fetch'
      )
        return true;
    }
    return false;
  };

  function visit(node, parent, parentKey) {
    if (!node || typeof node !== 'object' || typeNodeTypes.has(node.type)) return;

    if (node.type === 'ImportExpression') {
      const specifier =
        node.source?.type === 'StringLiteral'
          ? node.source.value
          : node.source?.type === 'TemplateLiteral' && !node.source.expressions.length
            ? node.source.quasis[0].value.cooked
            : undefined;
      if (resolvesToApiModule(file, specifier))
        issues.push(
          `${file}:${node.loc.start.line}: do not dynamically import web/api.ts; use static imports with callEndpoint`
        );
    }

    if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
      const callee = unwrap(node.callee);
      const direct = directKind(callee);
      if (direct) {
        calls[direct.kind].push(node.loc.start.line);
        for (const ref of direct.refs) countedRefNodes.add(ref);
      } else if (
        (callee?.type === 'MemberExpression' || callee?.type === 'OptionalMemberExpression') &&
        callHelpers.has(memberProperty(callee))
      ) {
        const helperTarget = directKind(callee.object);
        if (helperTarget) {
          calls[helperTarget.kind].push(node.loc.start.line);
          for (const ref of helperTarget.refs) countedRefNodes.add(ref);
        } else if (file !== apiModuleFile && fetchTarget(callee.object)) {
          calls.fetch.push(node.loc.start.line);
        }
      } else if (file !== apiModuleFile && fetchTarget(callee)) {
        calls.fetch.push(node.loc.start.line);
      }
    }

    if (
      (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') &&
      !countedRefNodes.has(node)
    ) {
      const target = directKind(node);
      if (target) {
        for (const ref of target.refs) countedRefNodes.add(ref);
        issues.push(
          `${file}:${node.loc.start.line}: do not alias or pass imported ${target.kind}() as a value; call callEndpoint(...) directly`
        );
      }
    }

    if (
      node.type === 'Identifier' &&
      (importedDirect.has(node.name) || importedNamespaces.has(node.name)) &&
      !isShadowed(node.name) &&
      !countedRefNodes.has(node)
    ) {
      const nonReference =
        parent?.type === 'ImportSpecifier' ||
        parent?.type === 'ImportNamespaceSpecifier' ||
        ((parent?.type === 'MemberExpression' || parent?.type === 'OptionalMemberExpression') &&
          ((parentKey === 'property' && !parent.computed) ||
            (importedNamespaces.has(node.name) && parentKey === 'object'))) ||
        (parent?.type === 'ObjectProperty' && parentKey === 'key' && !parent.computed) ||
        (parent?.type === 'JSXAttribute' && parentKey === 'name') ||
        (parent?.type === 'ClassProperty' && parentKey === 'key' && !parent.computed);
      if (!nonReference)
        issues.push(
          `${file}:${node.loc.start.line}: do not alias, pass, or re-export imported ${importedDirect.get(node.name) ?? 'web/api namespace'} as a value; call callEndpoint(...) directly`
        );
    }

    const pushed = scopeBindingsFor(node);
    if (pushed) scopes.push(pushed);
    for (const [key, value] of Object.entries(node)) {
      if (ignored.has(key)) continue;
      if (Array.isArray(value)) for (const child of value) visit(child, node, key);
      else if (value && typeof value === 'object') visit(value, node, key);
    }
    if (pushed) scopes.pop();
  }

  visit(tree.program, null, null);
  for (const list of Object.values(calls)) list.sort((left, right) => left - right);
  return { calls, issues };
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
  for (const [file, entry] of Object.entries(permanent)) {
    if (
      !Number.isInteger(entry?.count) ||
      entry.count < 1 ||
      !permanentKinds.has(entry?.kind) ||
      !entry?.reason?.trim() ||
      Object.keys(entry).some((key) => !['count', 'kind', 'reason'].includes(key))
    )
      throw new Error(
        `${allowlistPath}: permanent "${file}" needs only a positive count, kind ("fetch" or "apiBinary"), and reason`
      );
  }
  for (const [file, count] of Object.entries(debt)) {
    if (!Number.isInteger(count) || count < 1)
      throw new Error(`${allowlistPath}: debt "${file}" needs a positive whole count`);
  }
  return { permanent, debt };
}

export function scanWebLegacyApi(directory = root) {
  const found = new Map();
  const issues = [];
  for (const path of sourceFiles(resolve(directory, 'web'))) {
    const file = relative(directory, path).replaceAll('\\', '/');
    const result = scanLegacyApiSource(readFileSync(path, 'utf8'), file);
    issues.push(...result.issues);
    const { api, apiBinary, fetch } = result.calls;
    if (api.length || apiBinary.length || fetch.length) found.set(file, result.calls);
  }
  return { found, issues };
}

export function endpointCallErrors(directory = root, allowlist = readAllowlist(directory)) {
  const { permanent, debt } = allowlist;
  const { found, issues } = scanWebLegacyApi(directory);
  const errors = [...issues];

  const allFiles = [
    ...new Set([...found.keys(), ...Object.keys(permanent), ...Object.keys(debt)]),
  ].sort((left, right) => (left < right ? -1 : 1));

  for (const file of allFiles) {
    const calls = found.get(file) ?? { api: [], apiBinary: [], fetch: [] };
    const perm = permanent[file];
    const permFetch = perm?.kind === 'fetch' ? perm.count : 0;
    const permBinary = perm?.kind === 'apiBinary' ? perm.count : 0;
    const owed = debt[file] ?? 0;

    if (calls.fetch.length > permFetch)
      errors.push(
        `${file}: ${calls.fetch.length} direct fetch() call(s) (lines ${calls.fetch.join(', ')}), ${permFetch ? `${allowlistPath} permanent allows ${permFetch}` : 'none allowed'}; use callEndpoint(...) or pin binary/stream downloads under "permanent" in ${allowlistPath}`
      );
    else if (calls.fetch.length < permFetch)
      errors.push(
        `${allowlistPath}: ${file} has ${calls.fetch.length} direct fetch() call(s) but its permanent entry keeps ${permFetch}; correct the entry and its reason by hand`
      );

    if (calls.apiBinary.length < permBinary)
      errors.push(
        `${allowlistPath}: ${file} has ${calls.apiBinary.length} apiBinary() call(s) but its permanent entry keeps ${permBinary}; correct the entry and its reason by hand`
      );

    const apiTotalLines = [...calls.api, ...calls.apiBinary].sort((left, right) => left - right);
    const allowedApi = permBinary + owed;
    if (apiTotalLines.length > allowedApi)
      errors.push(
        `${file}: ${apiTotalLines.length} api() call(s) (lines ${apiTotalLines.join(', ')}), ${allowedApi ? `${allowlistPath} allows ${allowedApi}` : 'none allowed'}; use callEndpoint(...) instead of api()`
      );
    else if (apiTotalLines.length < allowedApi && calls.apiBinary.length >= permBinary) {
      const nextDebt = Math.max(0, apiTotalLines.length - permBinary);
      errors.push(
        nextDebt > 0
          ? `${allowlistPath}: ${file} now owes ${nextDebt} api() call(s); lower its debt from ${owed} to ${nextDebt} (${shrinkCommand})`
          : `${allowlistPath}: ${file} owes no api() calls; remove its debt entry (${shrinkCommand})`
      );
    }
  }

  return errors;
}

export function shrinkLegacyApiAllowlist(directory = root, allowlist = readAllowlist(directory)) {
  const { permanent, debt } = allowlist;
  const { found } = scanWebLegacyApi(directory);
  const sortedPermanent = Object.fromEntries(
    Object.entries(permanent).sort(([left], [right]) => (left < right ? -1 : 1))
  );
  const nextDebt = Object.fromEntries(
    Object.entries(debt)
      .map(([file, owed]) => {
        const calls = found.get(file);
        const totalApi = (calls?.api.length ?? 0) + (calls?.apiBinary.length ?? 0);
        const permBinary = permanent[file]?.kind === 'apiBinary' ? permanent[file].count : 0;
        return [file, Math.min(owed, Math.max(0, totalApi - permBinary))];
      })
      .filter(([, owed]) => owed > 0)
      .sort(([left], [right]) => (left < right ? -1 : 1))
  );
  const next = { permanent: sortedPermanent, debt: nextDebt };
  writeFileSync(resolve(directory, allowlistPath), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--shrink')) shrinkLegacyApiAllowlist(root);
  const allowlist = readAllowlist(root);
  const errors = endpointCallErrors(root, allowlist);
  if (errors.length) {
    console.error(`${errors.join('\n')}\n\n${remedy}`);
    process.exitCode = 1;
  } else {
    const debtCalls = Object.values(allowlist.debt).reduce((sum, count) => sum + count, 0);
    const permanentCalls = Object.values(allowlist.permanent).reduce(
      (sum, entry) => sum + entry.count,
      0
    );
    console.log(
      `Endpoint calls PASS (${debtCalls} legacy api() calls in ${Object.keys(allowlist.debt).length} debt files; ${permanentCalls} permanent calls in ${Object.keys(allowlist.permanent).length} files)`
    );
  }
}
