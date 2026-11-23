import type { ProcessableMessage } from '@a2ui/web_core';

export type StoryUiAction = {
  sourceRevision: string;
  sourceHash: string;
  blockId: string;
  surfaceId: string;
  componentId?: string;
  name: string;
  context: Record<string, unknown>;
  mode: 'short' | 'continue';
  roll?: { sides: number; results: number[] };
};
export type StoryUiMessage = ProcessableMessage;
export type StoryUiSegment =
  | { kind: 'prose' | 'invalid' | 'pending'; id: string; start: number; end: number; text: string }
  | {
      kind: 'ui';
      id: string;
      start: number;
      end: number;
      expression: string;
      messages: StoryUiMessage[];
      imageUrls?: Record<string, string>;
      surfaceId: string;
    };

const MAX_BLOCK = 400_000;
export const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export function isStoryUiImageUrl(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\/api\/(?:assets|package-image-blobs|illustration-images)\/[A-Za-z0-9_-]+$/.test(value)
  );
}

export function storyUiImageName(value: unknown): string | undefined {
  return typeof value === 'string'
    ? /^\s*\{\{\s*(?:img|image|asset|emotion|raw|path)::([^{}\r\n]+)\}\}\s*$/iu
        .exec(value)?.[1]
        .trim() || undefined
    : undefined;
}

const validImageUrls = (value: unknown): value is Record<string, string> =>
  record(value) && Object.values(value).every(isStoryUiImageUrl);

const storyUiOpening = /```uimori-ui\s*\r?\n|<a2ui>/;

export function untaggedStoryUiSegments(text: string): StoryUiSegment[] | null {
  if (storyUiOpening.test(text)) return null;
  return text ? [{ kind: 'prose', id: 'story-ui-0', start: 0, end: text.length, text }] : [];
}

export function storyUiEditableText(text: string): string {
  if (!storyUiOpening.test(text)) return text;
  return scanStoryUi(text, (value): value is StoryUiMessage[] => Array.isArray(value))
    .map((segment) => (segment.kind === 'ui' ? segment.expression : segment.text))
    .join('');
}

export function encodeStoryUi(
  expression: string,
  messages: StoryUiMessage[],
  imageUrls?: Record<string, string>
): string {
  return `\`\`\`uimori-ui\n${JSON.stringify({ version: 1, expression, messages, imageUrls })}\n\`\`\``;
}

function markdownCodeRanges(text: string, includeCanonical = false): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const lines = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)(?:\r?\n|$)/gm;
  let opening: { start: number; marker: string; canonical: boolean } | undefined;
  for (let match = lines.exec(text); match; match = lines.exec(text)) {
    if (!opening) {
      opening = {
        start: match.index,
        marker: match[1],
        canonical: match[1] === '```' && match[2].trim() === 'uimori-ui',
      };
    } else if (
      match[1][0] === opening.marker[0] &&
      match[1].length >= opening.marker.length &&
      !match[2].trim()
    ) {
      if (includeCanonical || !opening.canonical) ranges.push([opening.start, lines.lastIndex]);
      opening = undefined;
    }
  }
  if (opening && (includeCanonical || !opening.canonical))
    ranges.push([opening.start, text.length]);
  return ranges;
}

function inlineCodeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const fences = markdownCodeRanges(text, true);
  const excluded = (position: number) =>
    fences.find(([start, end]) => position >= start && position < end);
  let position = 0;
  while (position < text.length) {
    const fence = excluded(position);
    if (fence) {
      position = fence[1];
      continue;
    }
    if (text[position] === '\\') {
      position += 2;
      continue;
    }
    if (text[position] !== '`') {
      position++;
      continue;
    }
    const start = position;
    while (text[position] === '`') position++;
    const length = position - start;
    let scan = position;
    while (scan < text.length) {
      if (excluded(scan) || /^\r?\n[ \t]*\r?\n/.test(text.slice(scan))) break;
      if (text[scan] !== '`') {
        scan++;
        continue;
      }
      const endStart = scan;
      while (text[scan] === '`') scan++;
      if (scan - endStart === length) {
        ranges.push([start, scan]);
        position = scan;
        break;
      }
    }
  }
  return ranges;
}

export function scanStoryUi(
  text: string,
  validMessages: (value: unknown) => value is StoryUiMessage[]
): StoryUiSegment[] {
  const segments: StoryUiSegment[] = [];
  const pattern = new RegExp(storyUiOpening.source, 'g');
  let cursor = 0;
  const first = pattern.exec(text);
  const codeRanges = first ? [...markdownCodeRanges(text), ...inlineCodeRanges(text)] : [];
  const addText = (kind: 'prose' | 'invalid' | 'pending', start: number, end: number) => {
    if (end > start)
      segments.push({ kind, id: `story-ui-${start}`, start, end, text: text.slice(start, end) });
  };
  for (let match = first; match; match = pattern.exec(text)) {
    const start = match.index;
    const codeRange = codeRanges.find(([from, to]) => start >= from && start < to);
    if (codeRange) {
      pattern.lastIndex = codeRange[1];
      continue;
    }
    if (start < cursor) continue;
    addText('prose', cursor, start);
    const canonical = match[0].startsWith('```');
    const close = canonical ? /\r?\n```(?=\r?\n|$)/g : /<\/a2ui>/g;
    close.lastIndex = pattern.lastIndex;
    const ending = close.exec(text);
    if (!ending) {
      addText('pending', start, text.length);
      cursor = text.length;
      break;
    }
    const end = close.lastIndex;
    const block = text.slice(start, end);
    let valid = false;
    if (canonical && block.length <= MAX_BLOCK) {
      try {
        const parsed: unknown = JSON.parse(text.slice(pattern.lastIndex, ending.index));
        if (
          record(parsed) &&
          Object.keys(parsed).every((key) =>
            ['version', 'expression', 'messages', 'imageUrls'].includes(key)
          ) &&
          parsed.version === 1 &&
          typeof parsed.expression === 'string' &&
          parsed.expression.startsWith('<a2ui>') &&
          parsed.expression.endsWith('</a2ui>') &&
          (parsed.imageUrls === undefined || validImageUrls(parsed.imageUrls)) &&
          validMessages(parsed.messages)
        ) {
          segments.push({
            kind: 'ui',
            id: `story-ui-${start}`,
            start,
            end,
            expression: parsed.expression,
            messages: parsed.messages,
            ...(parsed.imageUrls && { imageUrls: parsed.imageUrls }),
            surfaceId: 'main',
          });
          valid = true;
        }
      } catch {}
    }
    if (!valid) addText('invalid', start, end);
    cursor = end;
    pattern.lastIndex = end;
  }
  addText('prose', cursor, text.length);
  return segments;
}
