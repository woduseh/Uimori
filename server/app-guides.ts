import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HttpError } from './request-validation.js';

const DIRECTORY = fileURLToPath(new URL('../docs/', import.meta.url));
const DEVELOPER_DOCUMENTS = new Set([
  'CODE-MAP',
  'DEVELOPMENT',
  'HELPER-EVALUATION',
  'ORACLE-RELEASE',
  'TOOL-CONTRACTS',
  'UI-GALLERY',
  'UI-PRINCIPLES',
]);
const PAGE_CHARS = 8000;
const MAX_PAGE_CHARS = 20_000;
const MAX_MATCHES = 30;
const MATCH_CHARS = 400;

type AppGuide = { name: string; title: string; text: string };

let loaded: AppGuide[] | undefined;
function guides(): AppGuide[] {
  loaded ??= readdirSync(DIRECTORY, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name.slice(0, -'.md'.length))
    .filter((name) => !DEVELOPER_DOCUMENTS.has(name))
    .sort()
    .map((name) => {
      const text = readFileSync(`${DIRECTORY}${name}.md`, 'utf8').replaceAll('\r\n', '\n');
      return { name, title: /^#\s+(.+)$/mu.exec(text)?.[1]?.trim() ?? name, text };
    });
  return loaded;
}

export function listAppGuides() {
  return guides().map(({ name, title, text }) => ({ name, title, chars: text.length }));
}

export function searchAppGuides(query: string) {
  const terms = query.toLowerCase().split(/\s+/u).filter(Boolean);
  if (!terms.length) throw new HttpError(400, 'GUIDE_QUERY_REQUIRED');
  const matches: { name: string; section: string; text: string }[] = [];
  let total = 0;
  for (const guide of guides()) {
    let section = guide.title;
    for (const line of guide.text.split('\n')) {
      const heading = /^#{1,6}\s+(.+)$/u.exec(line);
      if (heading) section = heading[1]!.trim();
      const lower = line.toLowerCase();
      if (!terms.every((term) => lower.includes(term))) continue;
      total++;
      if (matches.length < MAX_MATCHES)
        matches.push({ name: guide.name, section, text: line.trim().slice(0, MATCH_CHARS) });
    }
  }
  return { query, matches, totalMatches: total };
}

export function readAppGuide(name: string, offset = 0, limit = PAGE_CHARS) {
  const wanted = name.replace(/\.md$/iu, '').toUpperCase();
  const guide = guides().find((item) => item.name === wanted);
  if (!guide) throw new HttpError(404, `GUIDE_NOT_FOUND: ${name}. List the guides without a name.`);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > guide.text.length)
    throw new HttpError(400, 'GUIDE_OFFSET_INVALID');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_CHARS)
    throw new HttpError(400, 'GUIDE_LIMIT_INVALID');
  let end = Math.min(guide.text.length, offset + limit);
  if (end < guide.text.length && /[\uD800-\uDBFF]/u.test(guide.text[end - 1]!)) end--;
  return {
    name: guide.name,
    title: guide.title,
    text: guide.text.slice(offset, end),
    offset,
    totalChars: guide.text.length,
    nextOffset: end < guide.text.length ? end : null,
  };
}
