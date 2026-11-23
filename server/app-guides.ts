import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HttpError } from './request-validation.js';
import { storyUiPrompt } from './story-ui.js';

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
const PARTIAL_MATCHES = 10;
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
    })
    .concat({
      name: 'STORY-UI-REFERENCE',
      title: 'Story UI block reference',
      text: [
        '# Story UI block reference',
        'The story writer receives this reference when Story UI is on. Read it before writing, repairing or previewing an <a2ui> block.',
        storyUiPrompt(),
      ].join('\n\n'),
    });
  return loaded;
}

export function listAppGuides() {
  return guides().map(({ name, title, text }) => ({ name, title, chars: text.length }));
}

type GuideSection = { name: string; section: string; offset: number; lines: string[] };

function sections(guide: AppGuide): GuideSection[] {
  const found: GuideSection[] = [];
  let current: GuideSection = { name: guide.name, section: guide.title, offset: 0, lines: [] };
  let offset = 0;
  for (const line of guide.text.split('\n')) {
    const heading = /^#{1,6}\s+(.+)$/u.exec(line);
    if (heading) {
      if (current.lines.length) found.push(current);
      current = { name: guide.name, section: heading[1]!.trim(), offset, lines: [] };
    }
    current.lines.push(line);
    offset += line.length + 1;
  }
  if (current.lines.length) found.push(current);
  return found;
}

const SEARCH_GUIDANCE =
  'The guides are written mostly in Korean, with English only for identifiers and file names. No match or a partial match does not show that a feature is absent: search again with the Korean wording the user or the interface uses, or a synonym, or list the guides and read the likely one.';

export function searchAppGuides(query: string) {
  const terms = [...new Set(query.toLowerCase().split(/\s+/u).filter(Boolean))];
  if (!terms.length) throw new HttpError(400, 'GUIDE_QUERY_REQUIRED');
  const phrase = query.toLowerCase().trim().split(/ +/u).join(' ');
  const scored = guides()
    .flatMap(sections)
    .map((section) => {
      const lines = section.lines.map((line) => line.toLowerCase());
      const matched = terms.filter((term) => lines.some((line) => line.includes(term)));
      const heading = section.section.toLowerCase();
      return {
        section,
        matched,
        lines,
        inHeading: terms.filter((term) => heading.includes(term)).length,
        phrase: lines.some((line) => line.includes(phrase)),
      };
    })
    .filter((item) => item.matched.length > 0)
    .sort(
      (a, b) =>
        b.matched.length - a.matched.length ||
        Number(b.phrase) - Number(a.phrase) ||
        b.inHeading - a.inHeading ||
        a.lines.length - b.lines.length
    );
  const complete = scored.filter((item) => item.matched.length === terms.length);
  const ranked = complete.length ? complete : scored;
  const partial = !complete.length;
  return {
    query,
    matches: ranked.slice(0, partial ? PARTIAL_MATCHES : MAX_MATCHES).map((item) => {
      const index = item.lines.findIndex(
        (line, at) => at > 0 && item.matched.some((term) => line.includes(term))
      );
      return {
        name: item.section.name,
        section: item.section.section,
        offset: item.section.offset,
        text: item.section.lines[index < 0 ? 0 : index]!.trim().slice(0, MATCH_CHARS),
        ...(partial ? { matchedTerms: item.matched } : {}),
      };
    }),
    totalMatches: complete.length,
    ...(partial ? { partialMatches: scored.length, guidance: SEARCH_GUIDANCE } : {}),
  };
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
