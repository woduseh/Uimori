import { encodeStoryUi, parseStoryUi, validateStoryUiMessages } from './story-ui.js';
import { ExpressionParser } from '@a2ui/web_core/expressions';

type Slot = {
  owner: Record<string, unknown> | unknown[];
  key: string | number;
  text: string;
  format?: boolean;
};
const expressionParser = new ExpressionParser();
const visibleFields = ['text', 'label', 'title', 'unit', 'placeholder', 'description'];
const dynamicExpressions = (text: string) =>
  expressionParser
    .parse(text)
    .filter((part) => typeof part !== 'string')
    .map((part) => JSON.stringify(part))
    .sort();
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const humanText = (value: unknown): value is string =>
  typeof value === 'string' &&
  !!value.trim() &&
  !/^[+-]?(?:\d[\d,.]*)(?:\s*%|\s*[a-zA-Z]+)?$/u.test(value.trim()) &&
  !/^(?:https?:\/\/|\/|\$\/)/iu.test(value.trim());

/** Collect only catalog fields whose meaning is visible wording. All other wire values stay host-owned. */
function textSlots(messages: unknown): Slot[] {
  const result: Slot[] = [];
  const add = (owner: Record<string, unknown> | unknown[], key: string | number) => {
    if (!Object.hasOwn(owner, key)) return;
    const value = (owner as Record<string | number, unknown>)[key];
    if (humanText(value)) result.push({ owner, key, text: value });
  };
  if (!Array.isArray(messages) || !record(messages[0]) || !record(messages[0].createSurface))
    return result;
  const components = messages[0].createSurface.components;
  if (!Array.isArray(components)) return result;
  for (const component of components) {
    if (!record(component)) continue;
    for (const key of visibleFields) add(component, key);
    for (const collection of ['tabs', 'options', 'items']) {
      const items = component[collection];
      if (Array.isArray(items))
        for (const item of items)
          if (record(item)) add(item, collection === 'tabs' ? 'title' : 'label');
    }
    if (component.component === 'DataTable') {
      if (Array.isArray(component.columns))
        component.columns.forEach((_, i) => {
          add(component.columns as unknown[], i);
        });
      if (Array.isArray(component.rows))
        for (const row of component.rows)
          if (Array.isArray(row))
            row.forEach((_, i) => {
              add(row, i);
            });
    }
  }
  // Resolve each component in its actual template scope. A binding that also
  // feeds an action or editable input must retain its original data value.
  const visiblePaths = new Map<string, string[]>();
  const protectedPaths = new Map<string, string[]>();
  protectedPaths.set(JSON.stringify(['_uimori', 'style']), ['_uimori', 'style']);
  const formatted = new Set<Record<string, unknown>>();
  const dataModel = messages[0].createSurface.dataModel;
  const resolve = (path: string, scope: string[]) => {
    const relative = path.replace(/^\//u, '');
    return [
      ...(path.startsWith('/') ? [] : scope),
      ...(relative
        ? relative.split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
        : []),
    ];
  };
  const keyOf = (path: string[]) => JSON.stringify(path);
  const read = (path: string[]) => {
    let current: unknown = dataModel;
    for (const part of path) {
      if ((!record(current) && !Array.isArray(current)) || !Object.hasOwn(current, part))
        return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  };
  const bindings = (value: unknown, visible: boolean, scope: string[]) => {
    if (Array.isArray(value)) {
      for (const item of value) bindings(item, visible, scope);
      return;
    }
    if (!record(value)) return;
    if (
      visible &&
      (value['@call'] === 'formatString' || value.call === 'formatString') &&
      record(value.args) &&
      typeof value.args.value === 'string'
    ) {
      const args = value.args;
      if (!formatted.has(args) && humanText(args.value)) {
        try {
          dynamicExpressions(args.value);
          result.push({ owner: args, key: 'value', text: args.value, format: true });
          formatted.add(args);
        } catch {
          /* Invalid expressions remain untouched. */
        }
      }
      return;
    }
    if (
      !visible &&
      (value['@call'] === 'formatString' || value.call === 'formatString') &&
      record(value.args) &&
      typeof value.args.value === 'string'
    ) {
      try {
        for (const part of expressionParser.parse(value.args.value)) bindings(part, false, scope);
      } catch {
        protectedPaths.set(keyOf([]), []);
      }
      return;
    }
    const path =
      typeof value['@path'] === 'string'
        ? value['@path']
        : typeof value.path === 'string'
          ? value.path
          : undefined;
    if (path !== undefined) {
      const resolved = resolve(path, scope);
      (visible ? visiblePaths : protectedPaths).set(keyOf(resolved), resolved);
      return;
    }
    for (const [key, item] of Object.entries(value))
      bindings(item, visibleFields.includes(key), scope);
  };
  const byId = new Map(components.filter(record).map((component) => [component.id, component]));
  const visited = new Set<string>();
  const walk = (id: string, scope: string[]) => {
    const visitKey = JSON.stringify([id, scope]);
    if (visited.has(visitKey)) return;
    visited.add(visitKey);
    const component = byId.get(id);
    if (!component) return;
    for (const [key, value] of Object.entries(component)) {
      if (key !== 'children') bindings(value, visibleFields.includes(key), scope);
    }
    const refs: string[] = [];
    for (const key of ['child', 'trigger', 'content'])
      if (typeof component[key] === 'string') refs.push(component[key] as string);
    if (Array.isArray(component.tabs))
      for (const tab of component.tabs)
        if (record(tab) && typeof tab.child === 'string') refs.push(tab.child);
    if (Array.isArray(component.children))
      refs.push(
        ...component.children.filter((child): child is string => typeof child === 'string')
      );
    for (const ref of refs) walk(ref, scope);
    if (
      record(component.children) &&
      typeof component.children.componentId === 'string' &&
      typeof component.children.path === 'string'
    ) {
      const collectionPath = resolve(component.children.path, scope);
      const collection = read(collectionPath);
      const templateId = component.children.componentId;
      if (Array.isArray(collection))
        collection.forEach((_, index) => {
          walk(templateId, [...collectionPath, String(index)]);
        });
    }
  };
  walk('root', []);
  const overlaps = (left: string[], right: string[]) =>
    left
      .slice(0, Math.min(left.length, right.length))
      .every((part, index) => part === right[index]);
  for (const parts of visiblePaths.values()) {
    if (!parts.length || [...protectedPaths.values()].some((other) => overlaps(parts, other)))
      continue;
    const parent = read(parts.slice(0, -1));
    if (record(parent) || Array.isArray(parent)) add(parent, parts[parts.length - 1]);
  }
  return result;
}

/** Replace each UI block with a host-owned placeholder and a list of translatable strings. */
export function prepareStoryUiTranslation(source: string) {
  const segments = parseStoryUi(source);
  let prefix = 'UIMORI_UI_TRANSLATION';
  while (source.includes(prefix)) prefix += '_X';
  const blocks: {
    marker: string;
    original: string;
    expression?: string;
    messages?: unknown;
    count: number;
  }[] = [];
  const text = segments
    .map((segment) => {
      if (segment.kind === 'prose') return segment.text;
      const marker = `${prefix}_${blocks.length}`;
      const original = source.slice(segment.start, segment.end);
      const messages = segment.kind === 'ui' ? structuredClone(segment.messages) : undefined;
      const slots = messages ? textSlots(messages) : [];
      blocks.push({
        marker,
        original,
        ...(segment.kind === 'ui' ? { expression: segment.expression, messages } : {}),
        count: slots.length,
      });
      return `<${marker}>${JSON.stringify(slots.map((slot) => slot.text))}</${marker}>`;
    })
    .join('');
  return {
    text,
    protected: blocks.length > 0,
    restore(output: string): string {
      let restored = output;
      let previous = -1;
      for (const block of blocks) {
        const position = output.indexOf(`<${block.marker}>`);
        if (position <= previous) throw new Error('OUTPUT_STORY_UI_INVALID');
        previous = position;
      }
      for (const block of blocks) {
        const startTag = `<${block.marker}>`,
          endTag = `</${block.marker}>`;
        const start = restored.indexOf(startTag),
          end = restored.indexOf(endTag, start + startTag.length);
        if (
          start < 0 ||
          end < 0 ||
          restored.indexOf(startTag, start + startTag.length) >= 0 ||
          restored.indexOf(endTag, end + endTag.length) >= 0
        )
          throw new Error('OUTPUT_STORY_UI_INVALID');
        let values: unknown;
        try {
          values = JSON.parse(restored.slice(start + startTag.length, end));
        } catch {
          throw new Error('OUTPUT_STORY_UI_INVALID');
        }
        if (
          !Array.isArray(values) ||
          values.length !== block.count ||
          values.some((value) => typeof value !== 'string' || !value.trim())
        )
          throw new Error('OUTPUT_STORY_UI_INVALID');
        let replacement = block.original;
        if (block.messages && block.expression) {
          const messages = structuredClone(block.messages);
          const slots = textSlots(messages);
          slots.forEach((slot, index) => {
            if (slot.format) {
              try {
                if (
                  JSON.stringify(dynamicExpressions(slot.text)) !==
                  JSON.stringify(dynamicExpressions(values[index]))
                )
                  throw new Error();
              } catch {
                throw new Error('OUTPUT_STORY_UI_INVALID');
              }
            }
            (slot.owner as Record<string | number, unknown>)[slot.key] = values[index];
          });
          if (!validateStoryUiMessages(messages)) throw new Error('OUTPUT_STORY_UI_INVALID');
          replacement = encodeStoryUi(block.expression, messages);
        }
        restored = restored.slice(0, start) + replacement + restored.slice(end + endTag.length);
      }
      if (restored.includes(`<${prefix}_`) || restored.includes(`</${prefix}_`))
        throw new Error('OUTPUT_STORY_UI_INVALID');
      return restored;
    },
  };
}
