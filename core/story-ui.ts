import type { ProcessableMessage } from '@a2ui/web_core';
import {
  STORY_UI_CATALOG_ID,
  storyUiCatalog,
  storyUiDisplayValues,
  storyUiNestedTextKeys,
  storyUiTextKeys,
  storyUiTextLists,
} from './story-ui-catalog.js';

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

// Canonical storage includes both the <=100k expression and its compiled wire payload.
const MAX_BLOCK = 400_000;
const record = (value: unknown): value is Record<string, unknown> =>
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

// Validate the source-owned surface shape. The SDK catalog owns callable functions;
// resolved image sources are checked by the renderer.
export function validateStoryUiMessages(value: unknown): value is StoryUiMessage[] {
  if (!Array.isArray(value) || value.length !== 1 || !record(value[0])) return false;
  const message = value[0];
  if (
    Object.keys(message).some((key) => key !== 'version' && key !== 'createSurface') ||
    message.version !== '1.0' ||
    !record(message.createSurface)
  )
    return false;
  const surface = message.createSurface;
  if (
    Object.keys(surface).some(
      (key) => !['surfaceId', 'catalogId', 'components', 'dataModel'].includes(key)
    ) ||
    surface.catalogId !== STORY_UI_CATALOG_ID ||
    surface.surfaceId !== 'main' ||
    !Array.isArray(surface.components) ||
    !surface.components.length ||
    surface.components.length > 200
  )
    return false;
  const components = new Map<string, Record<string, unknown>>();
  for (const component of surface.components) {
    if (
      !record(component) ||
      typeof component.id !== 'string' ||
      !component.id ||
      component.id.length > 200 ||
      typeof component.component !== 'string' ||
      components.has(component.id)
    )
      return false;
    const api = storyUiCatalog.components.get(component.component);
    if (!api) return false;
    const { id: _id, component: _component, ...properties } = component;
    if (!api.schema.safeParse(properties).success) return false;
    components.set(component.id, component);
  }
  if (!components.has('root')) return false;
  function safe(value: unknown, depth: number): boolean {
    if (depth > 30) return false;
    if (Array.isArray(value))
      return value.length <= 200 && value.every((item) => safe(item, depth + 1));
    if (record(value))
      return (
        Object.keys(value).length <= 200 &&
        Object.values(value).every((item) => safe(item, depth + 1))
      );
    return typeof value !== 'string' || value.length <= 10_000;
  }
  if (
    !safe(surface.components, 0) ||
    (surface.dataModel !== undefined && (!record(surface.dataModel) || !safe(surface.dataModel, 0)))
  )
    return false;
  const visited = new Set<string>();
  const active = new Set<string>();
  function walk(id: string): boolean {
    if (active.has(id)) return false;
    if (visited.has(id)) return true;
    const component = components.get(id);
    if (!component) return false;
    active.add(id);
    const refs: unknown[] = [];
    if (typeof component.child === 'string') refs.push(component.child);
    if (typeof component.trigger === 'string') refs.push(component.trigger);
    if (typeof component.content === 'string') refs.push(component.content);
    if (Array.isArray(component.children)) refs.push(...component.children);
    else if (record(component.children) && typeof component.children.componentId === 'string')
      refs.push(component.children.componentId);
    else if (component.children !== undefined) return false;
    if (Array.isArray(component.tabs))
      for (const tab of component.tabs) if (record(tab)) refs.push(tab.child);
    const valid = refs.every((ref) => typeof ref === 'string' && walk(ref));
    active.delete(id);
    visited.add(id);
    return valid;
  }
  return walk('root') && visited.size === components.size;
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

// Backtick code spans may cross a line, but not a Markdown paragraph boundary.
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

export function parseStoryUi(text: string): StoryUiSegment[] {
  const segments: StoryUiSegment[] = [];
  const pattern = /```uimori-ui\s*\r?\n|<a2ui>/g;
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
          validateStoryUiMessages(parsed.messages)
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
      } catch {
        /* Invalid content stays visible. */
      }
    }
    if (!valid) addText('invalid', start, end);
    cursor = end;
    pattern.lastIndex = end;
  }
  addText('prose', cursor, text.length);
  return segments;
}

const projectedKeys = storyUiTextKeys.filter(
  (key) => key !== 'placeholder' && key !== 'description'
);

/**
 * Replace stored blocks with what a model should read. `text` keeps story-bearing values
 * only, for summaries, translation references and chats with Story UI off. `expression`
 * returns the model's own `<a2ui>` source, so a writer continuing the story sees where and
 * how earlier scenes used the interface.
 */
export function projectStoryUiText(text: string, mode: 'text' | 'expression' = 'text'): string {
  return parseStoryUi(text)
    .map((segment) => {
      if (segment.kind !== 'ui') return segment.text;
      if (mode === 'expression') return segment.expression;
      const message = segment.messages[0] as unknown as {
        createSurface: { components: Record<string, unknown>[] };
      };
      const components = message.createSurface.components;
      const values: string[] = [];
      const dataModel = (message.createSurface as { dataModel?: unknown }).dataModel;
      if (dataModel !== undefined) {
        if (record(dataModel) && record(dataModel._uimori)) {
          const { style: _style, css: _css, ...metadata } = dataModel._uimori;
          const { _uimori: _original, ...rest } = dataModel;
          if (Object.keys(metadata).length) rest._uimori = metadata;
          if (Object.keys(rest).length) values.push(JSON.stringify(rest));
        } else values.push(JSON.stringify(dataModel));
      }
      const append = (value: unknown) => {
        if (typeof value === 'string' || typeof value === 'number') values.push(String(value));
        else if (Array.isArray(value)) value.forEach(append);
        else if (
          record(value) &&
          (value['@call'] ?? value.call) === 'formatString' &&
          record(value.args) &&
          typeof value.args.value === 'string'
        )
          append(value.args.value);
      };
      for (const component of components) {
        for (const key of projectedKeys) append(component[key]);
        if (storyUiDisplayValues.has(String(component.component))) append(component.value);
        for (const [collection, keys] of Object.entries(storyUiNestedTextKeys)) {
          const items = component[collection];
          if (Array.isArray(items))
            for (const item of items) if (record(item)) for (const key of keys) append(item[key]);
        }
        for (const list of storyUiTextLists) append(component[list]);
        append(component.rows);
      }
      return values.join('\n');
    })
    .join('');
}

export function validateStoryUiAction(
  text: string,
  blockId: string,
  eventName: string,
  context: unknown,
  componentId?: string
): { name: string; context: Record<string, unknown> } | null {
  const segment = parseStoryUi(text).find((item) => item.kind === 'ui' && item.id === blockId);
  if (
    !segment ||
    segment.kind !== 'ui' ||
    !record(context) ||
    JSON.stringify(context).length > 10_000
  )
    return null;
  const { createSurface } = segment.messages[0] as unknown as {
    createSurface: { components: Record<string, unknown>[] };
  };
  const matches = createSurface.components.some((component) => {
    if (
      component.component !== 'Button' ||
      (componentId !== undefined && component.id !== componentId) ||
      !record(component.action) ||
      !record(component.action.event) ||
      component.action.event.name !== eventName
    )
      return false;
    const expected = component.action.event.context ?? {};
    if (
      !record(expected) ||
      Object.keys(expected).length !== Object.keys(context).length ||
      !Object.keys(expected).every((key) => Object.hasOwn(context, key))
    )
      return false;
    if (eventName !== 'roll') return true;
    const { sides, count = 1 } = expected;
    return (
      typeof sides === 'number' &&
      Number.isInteger(sides) &&
      sides >= 2 &&
      sides <= 1000 &&
      typeof count === 'number' &&
      Number.isInteger(count) &&
      count >= 1 &&
      count <= 20 &&
      context.sides === sides &&
      (expected.count === undefined || context.count === count)
    );
  });
  return matches ? { name: eventName, context } : null;
}
