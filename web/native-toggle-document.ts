import {
  type NativeToggleDefinition,
  type NativeToggleLine,
  type NativeToggleType,
  nativeToggleGroupWarnings,
  parseNativeToggleLines,
  serializeNativeToggleDefinition,
  serializeNativeToggleLines,
} from './native-risu-toggle-editor.js';

export type ToggleDocumentItem = {
  index: number;
  end: number;
  definition: NativeToggleDefinition | null;
  caption: string;
  raw: string;
};
export type ToggleDocumentGroup = {
  id: number;
  name: string;
  start: number;
  end: number;
  close: number;
  items: ToggleDocumentItem[];
};
const controls = new Set<NativeToggleType>(['toggle', 'select', 'text', 'textarea']);

/** A read-only projection: simply opening a view must never serialize the source. */
export function parseToggleDocument(source: string) {
  const lines = parseNativeToggleLines(source);
  const root: ToggleDocumentGroup = {
    id: -1,
    name: '그룹 없음',
    start: 0,
    end: lines.length,
    close: -1,
    items: [],
  };
  const groups: ToggleDocumentGroup[] = [root];
  let current = root;
  for (const [index, line] of lines.entries()) {
    const definition = line.definition;
    if (definition?.type === 'group') {
      current = {
        id: index,
        name: definition.label,
        start: index,
        end: lines.length,
        close: -1,
        items: [],
      };
      groups.push(current);
    } else if (definition?.type === 'groupEnd' && current !== root) {
      current.close = index;
      current.end = index + 1;
      current = root;
    } else {
      const previous = current.items.at(-1);
      if (
        definition?.type === 'caption' &&
        previous?.definition &&
        controls.has(previous.definition.type) &&
        previous.end === index
      ) {
        previous.caption += (previous.end > previous.index + 1 ? '\n' : '') + definition.label;
        previous.end = index + 1;
      } else {
        current.items.push({ index, end: index + 1, definition, caption: '', raw: line.raw });
      }
    }
  }
  return { lines, groups, warnings: nativeToggleGroupWarnings(lines) };
}

function structural(source: string) {
  const doc = parseToggleDocument(source);
  if (doc.warnings.length)
    throw new Error('그룹 경계가 올바르지 않아요. 원문에서 그룹 시작과 끝을 먼저 수정해 주세요.');
  return doc;
}
function eol(lines: NativeToggleLine[]) {
  return lines.find((line) => line.ending)?.ending ?? '\n';
}
function finish(source: string, lines: NativeToggleLine[]) {
  const ending = eol(parseNativeToggleLines(source));
  for (const line of lines.slice(0, -1)) if (!line.ending) line.ending = ending;
  const last = lines.at(-1);
  if (last && !/[\r\n]$/.test(source)) last.ending = '';
  return serializeNativeToggleLines(lines);
}
function fresh(raw: string, lines: NativeToggleLine[]): NativeToggleLine {
  return { raw, ending: eol(lines), definition: null };
}
function groupOf(doc: ReturnType<typeof parseToggleDocument>, id: number) {
  const group = doc.groups.find((entry) => entry.id === id);
  if (!group) throw new Error('그룹을 찾을 수 없어요.');
  return group;
}
function itemOf(doc: ReturnType<typeof parseToggleDocument>, index: number) {
  const item = doc.groups.flatMap((group) => group.items).find((entry) => entry.index === index);
  if (!item) throw new Error('항목을 찾을 수 없어요.');
  return item;
}
function namedGroup(doc: ReturnType<typeof parseToggleDocument>, id: number) {
  if (id === -1) throw new Error('그룹 없음에는 이 작업을 적용할 수 없어요.');
  return groupOf(doc, id);
}
function swap(
  lines: NativeToggleLine[],
  a: { index: number; end: number },
  b: { index: number; end: number }
) {
  if (a.index > b.index) [a, b] = [b, a];
  return [
    ...lines.slice(0, a.index),
    ...lines.slice(b.index, b.end),
    ...lines.slice(a.end, b.index),
    ...lines.slice(a.index, a.end),
    ...lines.slice(b.end),
  ];
}
function uniqueKey(lines: NativeToggleLine[], base = 'new_toggle') {
  const keys = new Set(lines.map((line) => line.raw.split('=')[0]));
  let key = base;
  for (let suffix = 2; keys.has(key); suffix++) key = `${base}_${suffix}`;
  return key;
}

export function addToggleGroup(source: string, name = '새 그룹') {
  const { lines } = structural(source);
  lines.push(
    fresh(
      serializeNativeToggleDefinition({ type: 'group', key: '', label: name, options: '' }),
      lines
    ),
    fresh('==groupEnd', lines)
  );
  return finish(source, lines);
}
export function renameToggleGroup(source: string, id: number, name: string) {
  const doc = parseToggleDocument(source);
  namedGroup(doc, id);
  const line = doc.lines[id];
  if (!line?.definition || line.definition.label === name) return source;
  line.raw = serializeNativeToggleDefinition({ ...line.definition, label: name });
  return serializeNativeToggleLines(doc.lines);
}
export function moveToggleGroup(source: string, id: number, delta: -1 | 1) {
  const doc = structural(source);
  const group = namedGroup(doc, id);
  const groups = doc.groups.filter((entry) => entry.id !== -1);
  const other = groups[groups.indexOf(group) + delta];
  return other
    ? finish(
        source,
        swap(
          doc.lines,
          { index: group.start, end: group.end },
          { index: other.start, end: other.end }
        )
      )
    : source;
}
export function ungroupToggleGroup(source: string, id: number) {
  const doc = structural(source);
  const group = namedGroup(doc, id);
  return finish(
    source,
    doc.lines.filter((_, index) => index !== group.start && index !== group.close)
  );
}
export function deleteToggleGroup(source: string, id: number) {
  const doc = structural(source);
  const group = namedGroup(doc, id);
  doc.lines.splice(group.start, group.end - group.start);
  return finish(source, doc.lines);
}
export function addToggleItem(source: string, groupId: number, type: NativeToggleType) {
  if (type === 'group' || type === 'groupEnd') throw new Error('그룹 추가 기능을 사용해 주세요.');
  const doc = structural(source);
  const group = groupOf(doc, groupId);
  const raw = serializeNativeToggleDefinition({
    type,
    key: controls.has(type) ? uniqueKey(doc.lines) : '',
    label: '새 항목',
    options: type === 'select' ? '선택 1,선택 2' : '',
  });
  doc.lines.splice(groupId === -1 ? doc.lines.length : group.close, 0, fresh(raw, doc.lines));
  return finish(source, doc.lines);
}
export function duplicateToggleItem(source: string, index: number) {
  const doc = structural(source);
  const item = itemOf(doc, index);
  const chunk = doc.lines.slice(index, item.end).map((line) => ({ ...line }));
  if (item.definition && controls.has(item.definition.type) && chunk[0])
    chunk[0].raw = serializeNativeToggleDefinition({
      ...item.definition,
      key: uniqueKey(doc.lines, item.definition.key),
    });
  doc.lines.splice(item.end, 0, ...chunk);
  return finish(source, doc.lines);
}
export function deleteToggleItem(source: string, index: number) {
  const doc = structural(source);
  const item = itemOf(doc, index);
  doc.lines.splice(index, item.end - index);
  return finish(source, doc.lines);
}
export function moveToggleItem(source: string, index: number, delta: -1 | 1) {
  const doc = structural(source);
  const item = itemOf(doc, index);
  const group = doc.groups.find((entry) => entry.items.includes(item));
  // Blank rows remain in the source, but are not displayed as movable UI items.
  const visibleItems = group?.items.filter((entry) => entry.raw.trim() || entry === item) ?? [];
  const other = visibleItems[visibleItems.indexOf(item) + delta];
  return other ? finish(source, swap(doc.lines, item, other)) : source;
}
export function moveToggleItemToGroup(source: string, index: number, groupId: number) {
  const doc = structural(source);
  const item = itemOf(doc, index);
  const group = groupOf(doc, groupId);
  if (group.items.includes(item)) return source;
  const insertion = groupId === -1 ? doc.lines.length : group.close;
  const chunk = doc.lines.splice(index, item.end - index);
  doc.lines.splice(insertion > index ? insertion - chunk.length : insertion, 0, ...chunk);
  return finish(source, doc.lines);
}
export function editToggleItem(
  source: string,
  index: number,
  patch: Partial<NativeToggleDefinition>,
  caption?: string
) {
  const doc = parseToggleDocument(source);
  const item = itemOf(doc, index);
  if (!item.definition) return source;
  const next = { ...item.definition, ...patch };
  if (next.type === 'group' || next.type === 'groupEnd')
    throw new Error('그룹 추가 기능을 사용해 주세요.');
  const line = doc.lines[index];
  if (!line) return source;
  if (
    Object.entries(patch).some(
      ([key, value]) => item.definition?.[key as keyof NativeToggleDefinition] !== value
    )
  )
    line.raw = serializeNativeToggleDefinition(next);
  if (caption !== undefined && caption !== item.caption) {
    if (!controls.has(next.type)) throw new Error('설명은 입력 항목에만 연결할 수 있어요.');
    const texts = caption ? caption.split(/\r\n|\r|\n/) : [];
    const captions = texts.map((label, offset) => {
      const previous = index + 1 + offset < item.end ? doc.lines[index + 1 + offset] : undefined;
      if (previous?.definition?.label === label) return { ...previous };
      return {
        ...fresh(
          serializeNativeToggleDefinition({
            type: 'caption',
            key: previous?.definition?.key ?? '',
            label,
            options: '',
          }),
          doc.lines
        ),
        ending: previous?.ending ?? eol(doc.lines),
      };
    });
    doc.lines.splice(index + 1, item.end - index - 1, ...captions);
    return finish(source, doc.lines);
  }
  return serializeNativeToggleLines(doc.lines);
}

export function parseDefaultVariableLines(source: string) {
  return parseNativeToggleLines(source).map((line, index) => {
    const at = line.raw.indexOf('=');
    const known = at > 0 && line.raw.slice(0, at).trim().length > 0;
    return {
      index,
      raw: line.raw,
      key: known ? line.raw.slice(0, at) : null,
      value: known ? line.raw.slice(at + 1) : null,
    };
  });
}
export function editDefaultVariable(
  source: string,
  index: number,
  patch: { key?: string; value?: string }
) {
  const entry = parseDefaultVariableLines(source)[index];
  if (!entry || entry.key === null || entry.value === null) return source;
  const key = patch.key ?? entry.key;
  const value = patch.value ?? entry.value;
  if (!key.trim()) throw new Error('변수 키를 입력해 주세요.');
  if (/[=\r\n]/.test(key)) throw new Error('변수 키에는 등호나 줄바꿈을 넣을 수 없어요.');
  if (/[\r\n]/.test(value)) throw new Error('변수 값에는 줄바꿈을 넣을 수 없어요.');
  const lines = parseNativeToggleLines(source);
  const line = lines[index];
  if (line) line.raw = `${key}=${value}`;
  return serializeNativeToggleLines(lines);
}
export function addDefaultVariable(source: string) {
  const lines = parseNativeToggleLines(source);
  lines.push(fresh(`${uniqueKey(lines, 'new_variable')}=`, lines));
  return finish(source, lines);
}
export function deleteDefaultVariable(source: string, index: number) {
  const lines = parseNativeToggleLines(source);
  if (!lines[index]) return source;
  lines.splice(index, 1);
  return finish(source, lines);
}
