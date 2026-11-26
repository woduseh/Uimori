import { parse } from '@babel/parser';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

export const checkedDirectories = ['web', 'core', 'server', 'scripts', 'tests', 'runner'];
export const allowlistPath = 'scripts/comment-allowlist.json';

const sourceExtension = /\.(?:ts|tsx|mts|cts|js|mjs|cjs|css)$/u;
const skippedDirectories = new Set(['node_modules', 'dist', 'output']);

const directivePattern =
  /^(?:biome-ignore(?:-all|-start|-end)?\s|@ts-expect-error\b|@vitest-environment\s|@vite-ignore\b|<reference\s)/u;
const licensePattern = /\b(?:SPDX-License-Identifier|@license|Copyright \(c\)|Copyright ©)/iu;
const sourcePattern = /^https?:\/\/\S/u;

export const remedy = [
  'Delete it. Put the reason for a change in the commit body, and state an invariant in a name, a type, an assertion, or a test.',
  'Keep a comment only for an external-system or platform constraint, written as `// <URL> (<YYYY-MM-DD>): <fact>`,',
  `or, when no public source exists, add its file, exact text, and external system to ${allowlistPath}.`,
].join('\n');

function sourceFiles(directory, recursive = true) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => (left.name < right.name ? -1 : 1))
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory())
        return recursive && !skippedDirectories.has(entry.name) ? sourceFiles(path) : [];
      return sourceExtension.test(entry.name) ? [path] : [];
    });
}

function lineAt(text, offset) {
  let line = 1;
  for (let index = 0; index < offset; index++) if (text.charCodeAt(index) === 10) line++;
  return line;
}

function cssComments(text) {
  const comments = [];
  let quote = '';
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quote) {
      if (character === '\\') index++;
      else if (character === quote) quote = '';
    } else if (character === '"' || character === "'") quote = character;
    else if (character === '/' && text[index + 1] === '*') {
      const close = text.indexOf('*/', index + 2);
      const end = close === -1 ? text.length : close + 2;
      comments.push({
        start: index,
        end,
        value: text.slice(index + 2, close === -1 ? end : close),
      });
      index = end - 1;
    }
  }
  return comments;
}

function scriptComments(file, text) {
  const plugins = /\.tsx$/u.test(file)
    ? ['typescript', 'jsx']
    : /\.[mc]?ts$/u.test(file)
      ? ['typescript']
      : ['jsx'];
  return parse(text, {
    sourceType: 'module',
    plugins,
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
  }).comments.map((comment) => ({
    start: comment.start,
    end: comment.end,
    value: comment.value,
    line: comment.type === 'CommentLine',
  }));
}

function commentBody(value) {
  return value
    .split('\n')
    .map((line) => line.replace(/^\s*\*?\s?/u, '').replace(/^\/\s*/u, ''))
    .join('\n')
    .trim();
}

export function extractComments(file, text) {
  const comments = file.endsWith('.css') ? cssComments(text) : scriptComments(file, text);
  const groups = [];
  for (const comment of comments) {
    const body = commentBody(comment.value);
    const previous = groups.at(-1);
    if (
      comment.line &&
      previous?.line &&
      !directivePattern.test(body) &&
      !directivePattern.test(previous.body) &&
      /^[^\S\n]*\n[^\S\n]*$/u.test(text.slice(previous.end, comment.start))
    ) {
      previous.end = comment.end;
      previous.body = `${previous.body}\n${body}`;
      continue;
    }
    groups.push({ start: comment.start, end: comment.end, line: comment.line, body });
  }
  return groups.map((group) => ({
    line: lineAt(text, group.start),
    text: text.slice(group.start, group.end),
    body: group.body,
  }));
}

export function commentKind(body) {
  if (directivePattern.test(body)) return 'directive';
  if (licensePattern.test(body)) return 'license';
  if (sourcePattern.test(body)) return 'source';
  return undefined;
}

function normalized(text) {
  return text.replace(/\s+/gu, ' ').trim();
}

export function readAllowlist(directory = root) {
  const path = resolve(directory, allowlistPath);
  if (!existsSync(path)) return [];
  const entries = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(entries)) throw new Error(`${allowlistPath} must be an array`);
  for (const entry of entries) {
    if (
      typeof entry?.file !== 'string' ||
      typeof entry.comment !== 'string' ||
      typeof entry.system !== 'string' ||
      !entry.system.trim()
    )
      throw new Error(
        `${allowlistPath}: every entry needs "file", "comment", and the external "system" it describes`
      );
  }
  return entries;
}

function checkedPath(path) {
  const segments = path.split('/');
  return (
    sourceExtension.test(path) &&
    (segments.length === 1 ||
      (checkedDirectories.includes(segments[0]) &&
        !segments.slice(1, -1).some((segment) => skippedDirectories.has(segment))))
  );
}

export function commentErrors(directory = root, allowlist = readAllowlist(directory), selected) {
  const selectedPaths = selected && new Set(selected.map((path) => path.replaceAll('\\', '/')));
  const unused = new Map(
    allowlist
      .filter((entry) => !selectedPaths || selectedPaths.has(entry.file))
      .map((entry) => [`${entry.file}\n${normalized(entry.comment)}`, entry])
  );
  const allowed = new Set(unused.keys());
  const errors = [];
  const files = selectedPaths
    ? [...selectedPaths]
        .filter((path) => checkedPath(path) && existsSync(join(directory, path)))
        .map((path) => join(directory, path))
    : [
        ...sourceFiles(directory, false),
        ...checkedDirectories.flatMap((name) => sourceFiles(join(directory, name))),
      ];
  for (const file of files) {
    const path = relative(directory, file).replaceAll('\\', '/');
    const text = readFileSync(file, 'utf8');
    let comments;
    try {
      comments = extractComments(file, text);
    } catch (error) {
      errors.push(`${path}: cannot read comments: ${error.message}`);
      continue;
    }
    for (const comment of comments) {
      if (commentKind(comment.body)) continue;
      const key = `${path}\n${normalized(comment.body)}`;
      if (allowed.has(key)) {
        unused.delete(key);
        continue;
      }
      errors.push(`${path}:${comment.line}: ${comment.text.split('\n')[0].slice(0, 120)}`);
    }
  }
  for (const entry of unused.values())
    errors.push(
      `${allowlistPath}: no matching comment in ${entry.file}; remove the entry: ${normalized(entry.comment).slice(0, 120)}`
    );
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const selected = process.argv.slice(2);
  const errors = commentErrors(root, readAllowlist(), selected.length ? selected : undefined);
  if (errors.length) {
    console.error(`${errors.join('\n')}\n\n${errors.length} comment(s) not allowed.\n${remedy}`);
    process.exitCode = 1;
  } else console.log('Comments PASS');
}
