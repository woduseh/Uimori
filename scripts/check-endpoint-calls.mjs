import { parse } from '@babel/parser';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

export const domainsPath = 'packages/contracts/src/domains';
export const remedyFor = (endpoint, path) =>
  `${path} is the typed route ${endpoint.method} /api${endpoint.path} (${endpoint.operation}); call it with callEndpoint and the endpoint named by that operation in ${endpoint.file} instead of api()`;

const wildcard = '\u0000';
const placeholder = '$' + '{…}';
const sourceExtension = /\.(?:ts|tsx|mts|cts|js|mjs)$/u;
const ignored = new Set([
  'loc',
  'extra',
  'comments',
  'tokens',
  'leadingComments',
  'trailingComments',
]);

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (ignored.has(key)) continue;
    if (Array.isArray(value)) for (const child of value) walk(child, visit);
    else if (value && typeof value === 'object') walk(value, visit);
  }
}

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

const propertyName = (property) =>
  property.key?.type === 'Identifier' ? property.key.name : property.key?.value;

export function contractEndpoints(source, file = `${domainsPath}/domain/endpoints.ts`) {
  const found = [];
  walk(parseSource(source, file), (node) => {
    if (node.type !== 'ObjectExpression') return;
    const values = Object.fromEntries(
      node.properties
        .filter((property) => property.type === 'ObjectProperty')
        .map((property) => [propertyName(property), property.value])
    );
    const text = (name) =>
      values[name]?.type === 'StringLiteral' ? values[name].value : undefined;
    if (text('operation') && text('method') && text('path'))
      found.push({
        operation: text('operation'),
        method: text('method'),
        path: text('path'),
        file,
      });
  });
  return found;
}

function allEndpoints(directory) {
  const domains = resolve(directory, domainsPath);
  if (!existsSync(domains)) return [];
  return readdirSync(domains, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const file = `${domainsPath}/${entry.name}/endpoints.ts`;
      const path = resolve(directory, file);
      return existsSync(path) ? contractEndpoints(readFileSync(path, 'utf8'), file) : [];
    });
}

function declarations(tree) {
  const initial = new Map();
  walk(tree, (node) => {
    if (node.type !== 'VariableDeclarator' || node.id.type !== 'Identifier' || !node.init) return;
    initial.set(node.id.name, initial.has(node.id.name) ? null : node.init);
  });
  return initial;
}

function resolvePath(node, initial, depth = 0) {
  if (!node || depth > 6) return undefined;
  const inner = (child) => resolvePath(child, initial, depth + 1);
  switch (node.type) {
    case 'StringLiteral':
      return node.value;
    case 'TemplateLiteral': {
      let text = '';
      for (const [index, quasi] of node.quasis.entries()) {
        text += quasi.value.cooked;
        if (index < node.expressions.length) text += inner(node.expressions[index]) ?? wildcard;
      }
      return text;
    }
    case 'BinaryExpression': {
      if (node.operator !== '+') return undefined;
      return `${inner(node.left) ?? wildcard}${inner(node.right) ?? wildcard}`;
    }
    case 'Identifier': {
      const value = initial.get(node.name);
      return value ? inner(value) : undefined;
    }
    case 'TSAsExpression':
    case 'TSNonNullExpression':
    case 'ParenthesizedExpression':
      return inner(node.expression);
    default:
      return undefined;
  }
}

function methodOf(callee, args) {
  if (callee === 'apiBinary') return 'POST';
  const method = args[2];
  if (method?.type === 'StringLiteral') return method.value.toUpperCase();
  if (method) return undefined;
  const body = args[1];
  return !body || (body.type === 'Identifier' && body.name === 'undefined') ? 'GET' : 'POST';
}

export function apiCalls(source, file = 'web/input.tsx') {
  const tree = parseSource(source, file);
  const initial = declarations(tree);
  const calls = [];
  walk(tree, (node) => {
    if (
      node.type !== 'CallExpression' ||
      node.callee.type !== 'Identifier' ||
      (node.callee.name !== 'api' && node.callee.name !== 'apiBinary')
    )
      return;
    const path = resolvePath(node.arguments[0], initial);
    if (path !== undefined)
      calls.push({
        path,
        method: methodOf(node.callee.name, node.arguments),
        line: node.loc.start.line,
      });
  });
  return calls;
}

const segmentMatches = (candidate, endpoint) => {
  if (endpoint.startsWith(':') || candidate === wildcard) return true;
  if (!candidate.includes(wildcard)) return candidate === endpoint;
  const pattern = candidate
    .split(wildcard)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
    .join('.+');
  return new RegExp(`^${pattern}$`, 'u').test(endpoint);
};

export function callsEndpoint(call, endpoint) {
  if (call.method !== undefined && call.method !== endpoint.method) return false;
  const text = call.path.split(/[?#]/u)[0];
  const candidate = text.split('/').filter((part, index) => index > 0 || part !== '');
  const open = !text.startsWith('/') && candidate[0]?.startsWith(wildcard);
  const fixed = open ? candidate.slice(1) : candidate;
  if (!fixed.some((part) => !part.includes(wildcard))) return false;
  const target = endpoint.path.split('/').filter(Boolean);
  if (open ? fixed.length >= target.length : fixed.length !== target.length) return false;
  const tail = open ? target.slice(target.length - fixed.length) : target;
  return (
    fixed.every((part, index) => segmentMatches(part, tail[index])) &&
    fixed.some((part, index) => part === tail[index])
  );
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

export function endpointCallErrors(directory = root) {
  const endpoints = allEndpoints(directory);
  const errors = [];
  for (const path of sourceFiles(resolve(directory, 'web'))) {
    const file = relative(directory, path).replaceAll('\\', '/');
    for (const call of apiCalls(readFileSync(path, 'utf8'), file)) {
      const endpoint = endpoints.find((item) => callsEndpoint(call, item));
      if (endpoint)
        errors.push(
          `${file}:${call.line}: ${remedyFor(endpoint, call.path.replaceAll(wildcard, placeholder))}`
        );
    }
  }
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = endpointCallErrors();
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else console.log(`Endpoint calls PASS (${allEndpoints(root).length} typed routes)`);
}
