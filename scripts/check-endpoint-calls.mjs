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
  const tree = parseSource(source, file);
  const initial = declarations(tree);
  const found = [];
  const problems = [];
  let declared = 0;
  walk(tree, (node) => {
    if (node.type !== 'ObjectExpression') return;
    const values = Object.fromEntries(
      node.properties
        .filter((property) => property.type === 'ObjectProperty')
        .map((property) => [propertyName(property), property.value])
    );
    const operation = values.operation?.type === 'StringLiteral' && values.operation.value;
    if (!operation) return;
    declared++;
    const method = values.method?.type === 'StringLiteral' ? values.method.value : undefined;
    const path = resolvePath(values.path, initial);
    if (method && path !== undefined && !path.includes(wildcard))
      found.push({ operation, method, path, file });
    else
      problems.push(
        `${file}: ${operation} has a method or path this check cannot resolve; write the path as a string, a same-file const or a template of same-file consts`
      );
  });
  const listed = (source.match(/^\s*operation:/gmu) ?? []).length;
  if (listed !== declared)
    problems.push(
      `${file}: ${listed} operation: entries but ${declared} endpoint objects were read; every endpoint is written as an object with an operation, a method and a path`
    );
  return { found, problems };
}

function allEndpoints(directory) {
  const domains = resolve(directory, domainsPath);
  const result = { endpoints: [], problems: [] };
  if (!existsSync(domains)) return result;
  for (const entry of readdirSync(domains, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = `${domainsPath}/${entry.name}/endpoints.ts`;
    const path = resolve(directory, file);
    if (!existsSync(path)) continue;
    const { found, problems } = contractEndpoints(readFileSync(path, 'utf8'), file);
    result.endpoints.push(...found);
    result.problems.push(...problems);
  }
  return result;
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

export const limits =
  "Checked: api() and apiBinary() calls in web/ whose path is a literal, a template or a same-file const. Not checked: a path passed through a parameter, prop, lookup table, conditional or another file's helper. A local function named api is scanned too.";

export function endpointCallErrors(directory = root) {
  const { endpoints, problems } = allEndpoints(directory);
  const errors = [...problems];
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
    console.error([...errors, '', limits].join('\n'));
    process.exitCode = 1;
  } else console.log(`Endpoint calls PASS (${allEndpoints(root).endpoints.length} typed routes)`);
}
