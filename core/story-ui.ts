import {
  STORY_UI_CATALOG_ID,
  storyUiCatalog,
  storyUiDisplayValues,
  storyUiNestedTextKeys,
  storyUiTextKeys,
  storyUiTextLists,
} from './story-ui-catalog.js';
import { record, scanStoryUi, type StoryUiMessage, type StoryUiSegment } from './story-ui-scan.js';

export {
  encodeStoryUi,
  isStoryUiImageUrl,
  storyUiImageName,
  type StoryUiAction,
  type StoryUiMessage,
  type StoryUiSegment,
} from './story-ui-scan.js';

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

export function parseStoryUi(text: string): StoryUiSegment[] {
  return scanStoryUi(text, validateStoryUiMessages);
}

const projectedKeys = storyUiTextKeys.filter(
  (key) => key !== 'placeholder' && key !== 'description'
);

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
        const calendar = component.component === 'Calendar';
        for (const [collection, keys] of Object.entries(storyUiNestedTextKeys)) {
          const items = component[collection];
          if (collection === 'edges' || (calendar && collection === 'items')) continue;
          if (Array.isArray(items))
            for (const item of items) if (record(item)) for (const key of keys) append(item[key]);
        }
        if (calendar) {
          append(component.month);
          if (Array.isArray(component.items))
            for (const item of component.items.filter(record))
              values.push([item.date, item.time, item.title, item.text].filter(Boolean).join(' '));
        }
        if (Array.isArray(component.edges) && Array.isArray(component.nodes)) {
          const names = new Map<unknown, string>();
          for (const node of component.nodes.filter(record))
            if (!names.has(node.id)) names.set(node.id, String(node.label));
          for (const edge of component.edges.filter(record)) {
            if (edge.from === edge.to || !names.has(edge.from) || !names.has(edge.to)) continue;
            const ends = `${names.get(edge.from)} → ${names.get(edge.to)}`;
            values.push(edge.label === undefined ? ends : `${ends}: ${edge.label}`);
          }
        }
        for (const list of [...storyUiTextLists, 'rows'])
          if (Array.isArray(component[list])) append(component[list]);
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
