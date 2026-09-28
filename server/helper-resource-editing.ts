import { isDeepStrictEqual } from 'node:util';
import {
  editableResource,
  type ResourceKind,
  type ResourceModel,
} from '../core/resource-editing.js';
import type { Content } from '../core/product.js';
import { validateTranslationGuide } from '../core/translation-guide.js';
import type { HelperEditor } from '../core/helper.js';
import type { Store } from './store.js';
import { HttpError, number, text } from './request-validation.js';
import { readResource, saveResource } from './resource-service.js';
import protectedFields from './helper-native-protected-fields.json' with { type: 'json' };

const MAX_RESULT = 24_000;
const MAX_PATH = 1_024;
const MAX_TEXT = 10_000;
const FORBIDDEN = new Set(protectedFields);
type JsonObject = Record<string, unknown>;
type Change = {
  path: string;
  op: 'set' | 'replaceText' | 'insert' | 'remove';
  value?: unknown;
  oldText?: string;
  newText?: string;
};

const object = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const type = (value: unknown): string =>
  value === null
    ? 'null'
    : Array.isArray(value)
      ? 'array'
      : typeof value === 'object'
        ? 'object'
        : typeof value;
const encode = (part: string) => part.replaceAll('~', '~0').replaceAll('/', '~1');
const joined = (path: string, part: string) => `${path}/${encode(part)}`;
function parts(path: unknown): string[] {
  if (path === '') return [];
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > MAX_PATH)
    throw new HttpError(400, '올바른 자료 경로가 필요해요.');
  const segments = path
    .slice(1)
    .split('/')
    .map((part) => {
      if (/~(?![01])/u.test(part)) throw new HttpError(400, '올바른 자료 경로가 필요해요.');
      return part.replaceAll('~1', '/').replaceAll('~0', '~');
    });
  if (segments.length > 80 || segments.some((part) => !part || part.length > 300))
    throw new HttpError(400, '자료 경로가 너무 길어요.');
  return segments;
}
function member(parent: unknown, part: string): { exists: boolean; value: unknown } {
  if (Array.isArray(parent)) {
    if (!/^(0|[1-9]\d*)$/u.test(part)) throw new HttpError(400, '배열 인덱스를 확인해 주세요.');
    const index = Number(part);
    return { exists: index < parent.length, value: parent[index] };
  }
  if (!object(parent)) throw new HttpError(400, '자료 경로가 존재하지 않아요.');
  return { exists: Object.hasOwn(parent, part), value: parent[part] };
}
function locate(
  root: unknown,
  segments: string[]
): { exists: boolean; value: unknown; parent: unknown } {
  let value = root;
  let parent: unknown = null;
  for (let i = 0; i < segments.length; i++) {
    parent = value;
    const item = member(value, segments[i]!);
    if (!item.exists && i < segments.length - 1)
      throw new HttpError(404, '자료 경로가 존재하지 않아요.');
    value = item.value;
    if (!item.exists) return { ...item, parent };
  }
  return { exists: true, value, parent };
}
function bounded(result: unknown): unknown {
  if (JSON.stringify(result).length > MAX_RESULT)
    throw new HttpError(413, '읽기 결과가 커요. 더 작은 범위로 읽어 주세요.');
  return result;
}
function optionalInt(value: unknown, name: string, maximum: number, defaultValue: number): number {
  return value === undefined ? defaultValue : number(value, name, 0, maximum);
}
function descriptor(path: string, value: unknown, exists = true) {
  if (!exists) return { path, exists: false };
  const result: JsonObject = { path, exists: true, type: type(value) };
  if (typeof value === 'string') result.length = value.length;
  if (Array.isArray(value)) result.count = value.length;
  if (object(value)) {
    result.count = Object.keys(value).length;
    const preview = Object.fromEntries(
      ['comment', 'title', 'name', 'key', 'keys', 'secondkey', 'secondary_keys']
        .filter((key) => {
          const item = value[key];
          return (
            (typeof item === 'string' && item.length <= 200) ||
            (Array.isArray(item) &&
              item.length <= 5 &&
              item.every(scalar) &&
              JSON.stringify(item).length <= 200)
          );
        })
        .map((key) => [key, value[key]])
    );
    if (Object.keys(preview).length) result.preview = preview;
  }
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    (typeof value === 'string' && JSON.stringify(value).length <= 1_000) ||
    (Array.isArray(value) && value.every(scalar) && JSON.stringify(value).length <= 1_000)
  )
    result.value = value;
  return result;
}
function sourceFor(content: Content) {
  const native = content.package.nativeRisu;
  if (!native) return null;
  const standaloneModule = !Object.keys(native.card).length && !!native.module;
  const path = standaloneModule ? '/package/nativeRisu/module' : '/package/nativeRisu/card';
  return {
    path,
    translationGuidePath: `${path}/extensions/uimori/translationGuide`,
    lorePath:
      standaloneModule || native.module?.lorebook != null
        ? '/package/nativeRisu/module/lorebook'
        : '/package/nativeRisu/card/character_book/entries',
  };
}
export function readHelperResource(store: Store, kind: ResourceKind, id: string, args: JsonObject) {
  const saved = readResource(store, kind, id);
  const model = editableResource(kind, saved);
  return readHelperModel(
    kind,
    id,
    saved.revision,
    'title' in saved ? saved.title : 'current',
    model,
    args
  );
}

/** Read the admitted editor model without replacing it with a later saved revision. */
export function readHelperEditor(editor: HelperEditor | undefined, args: JsonObject) {
  if (!editor?.model) return null;
  return readHelperModel(
    editor.kind,
    editor.targetId ?? 'unsaved',
    editor.revision,
    editor.title,
    editor.model,
    args,
    editor.source === 'saved' ? 'saved-editor-reservation' : 'unsaved-device-editor'
  );
}

function readHelperModel(
  kind: ResourceKind,
  id: string,
  revision: number | null,
  title: string,
  model: ResourceModel,
  args: JsonObject,
  inputOrigin?: string
) {
  const base = { kind, id, revision, ...(inputOrigin ? { inputOrigin } : {}) };
  const path = args.path === undefined ? undefined : text(args.path, 'path', MAX_PATH, true);
  if (path === undefined) {
    const source = kind === 'content' ? sourceFor(model as Content) : null;
    const readyPaths = source
      ? [source.path, source.lorePath, source.translationGuidePath]
      : kind === 'prompt-preset'
        ? ['/program', '/values']
        : Object.keys(model).map((key) => joined('', key));
    const regions = Object.keys(model).map((key) =>
      descriptor(joined('', key), (model as JsonObject)[key])
    );
    if (source) {
      const native = (model as Content).package.nativeRisu;
      regions.push(
        descriptor(source.path, source.path.endsWith('/module') ? native.module : native.card)
      );
      try {
        const lore = locate(model, parts(source.lorePath));
        if (lore.exists) regions.push(descriptor(source.lorePath, lore.value));
      } catch (error) {
        if (!(error instanceof HttpError && [400, 404].includes(error.statusCode))) throw error;
      }
    }
    return bounded({
      ...base,
      title,
      ...(source ? { source } : {}),
      regions,
      readyPaths,
    });
  }
  const segments = parts(path);
  const found = locate(model, segments);
  if (!found.exists) return bounded({ ...base, path, exists: false });
  const value = found.value;
  const head = { ...base, path, exists: true, type: type(value) };
  if (typeof value === 'string') {
    const requested = optionalInt(args.textOffset, 'text offset', value.length, 0);
    const limit = optionalInt(args.textLimit, 'text limit', MAX_TEXT, 4_000);
    if (limit === 0) throw new HttpError(400, '읽기 길이는 1 이상이어야 해요.');
    let start = requested;
    if (start > 0 && start < value.length && /[\uDC00-\uDFFF]/u.test(value[start]!)) start--;
    let low = start + 1;
    let high = Math.min(value.length, start + limit);
    let best = start;
    const page = (end: number) => ({
      ...head,
      length: value.length,
      text: value.slice(start, end),
      textOffset: start,
      nextOffset: end < value.length ? end : null,
    });
    if (start === value.length) return bounded(page(start));
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const end =
        middle < value.length && /[\uDC00-\uDFFF]/u.test(value[middle]!) ? middle - 1 : middle;
      if (end <= start) {
        low = middle + 1;
        continue;
      }
      if (JSON.stringify(page(end)).length <= MAX_RESULT) {
        best = end;
        low = middle + 1;
      } else high = middle - 1;
    }
    if (best === start && start + 1 < value.length && /[\uD800-\uDBFF]/u.test(value[start]!))
      best = start + 2;
    if (best === start) throw new HttpError(413, '읽기 결과가 커요. 더 좁은 경로를 지정해 주세요.');
    return bounded(page(best));
  }
  if (!object(value) && !Array.isArray(value)) return bounded({ ...head, value });
  const fields = args.fields;
  if (
    fields !== undefined &&
    (!object(value) ||
      !Array.isArray(fields) ||
      fields.length > 50 ||
      fields.some((field) => typeof field !== 'string' || !field || field.length > 300))
  )
    throw new HttpError(400, '읽을 필드 목록을 확인해 주세요.');
  const keys = Array.isArray(value)
    ? value.map((_item, index) => String(index))
    : fields === undefined
      ? Object.keys(value)
      : (fields as string[]);
  const offset = optionalInt(args.offset, 'offset', keys.length, 0);
  const limit = optionalInt(args.limit, 'limit', 50, 20);
  if (limit === 0) throw new HttpError(400, '읽기 개수는 1 이상이어야 해요.');
  const entries: unknown[] = [];
  let index = offset;
  for (; index < Math.min(keys.length, offset + limit); index++) {
    const key = keys[index]!;
    const item = member(value, key);
    const next = { name: key, ...descriptor(joined(path, key), item.value, item.exists) };
    const candidate = {
      ...head,
      count: keys.length,
      [Array.isArray(value) ? 'items' : 'fields']: [...entries, next],
      nextOffset: index + 1 < keys.length ? index + 1 : null,
    };
    if (JSON.stringify(candidate).length > MAX_RESULT) {
      if (!entries.length)
        throw new HttpError(413, '읽기 결과가 커요. 더 좁은 경로를 지정해 주세요.');
      break;
    }
    entries.push(next);
  }
  return bounded({
    ...head,
    count: keys.length,
    [Array.isArray(value) ? 'items' : 'fields']: entries,
    nextOffset: index < keys.length ? index : null,
  });
}

function scalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    typeof value === 'boolean'
  );
}
function allowedValue(value: unknown): boolean {
  return scalar(value) || (Array.isArray(value) && value.every(scalar));
}
function guidePath(segments: string[]): boolean {
  return (
    segments.length === 6 &&
    segments[0] === 'package' &&
    segments[1] === 'nativeRisu' &&
    ['card', 'module'].includes(segments[2]!) &&
    segments[3] === 'extensions' &&
    segments[4] === 'uimori' &&
    segments[5] === 'translationGuide'
  );
}
function listPath(segments: string[]): 'lore' | 'terms' | null {
  if (segments.length === 7 && guidePath(segments.slice(0, -1)) && segments[6] === 'terms')
    return 'terms';
  if (
    segments.length === 4 &&
    segments[0] === 'package' &&
    segments[1] === 'nativeRisu' &&
    segments[2] === 'module' &&
    segments[3] === 'lorebook'
  )
    return 'lore';
  if (
    segments.length === 5 &&
    segments[0] === 'package' &&
    segments[1] === 'nativeRisu' &&
    segments[2] === 'card' &&
    segments[3] === 'character_book' &&
    segments[4] === 'entries'
  )
    return 'lore';
  return null;
}
export function patchHelperResource(
  store: Store,
  kind: ResourceKind,
  id: string,
  revision: number,
  rawChanges: unknown
) {
  if (kind !== 'content' && kind !== 'prompt-preset')
    throw new HttpError(400, '부분 수정은 native 자료와 프리셋에만 지원해요.');
  if (!Array.isArray(rawChanges) || !rawChanges.length)
    throw new HttpError(400, '변경 목록이 필요해요.');
  const current = readResource(store, kind, id);
  if (current.revision !== revision)
    throw new HttpError(409, '저장된 자료가 변경됐어요. 최신 자료를 확인해 주세요.');
  const model = structuredClone(editableResource(kind, current)) as ResourceModel;
  if (kind === 'content' && !sourceFor(current as Content))
    throw new HttpError(400, 'native 원문이 없는 자료예요.');
  const changes = rawChanges as Change[];
  const changedPaths: string[] = [];
  for (const change of changes) {
    if (
      !object(change) ||
      typeof change.path !== 'string' ||
      !['set', 'replaceText', 'insert', 'remove'].includes(change.op)
    )
      throw new HttpError(400, '변경 형식을 확인해 주세요.');
    const segments = parts(change.path);
    const nativePath =
      segments.length >= 4 &&
      segments[0] === 'package' &&
      segments[1] === 'nativeRisu' &&
      ['card', 'module'].includes(segments[2]!);
    const presetPath =
      (segments.length >= 4 &&
        segments[0] === 'program' &&
        segments[1] === 'nativeRisuPreset' &&
        segments[2] === 'preset') ||
      (segments.length >= 2 && segments[0] === 'values');
    if (
      (kind === 'content' ? !nativePath : !presetPath) ||
      segments.some((part) => FORBIDDEN.has(part))
    )
      throw new HttpError(400, 'native 원문 필드만 수정할 수 있어요.');
    if (
      kind === 'content' &&
      segments[2] === 'module' &&
      !(current as Content).package.nativeRisu.module
    )
      throw new HttpError(400, '존재하는 모듈만 수정할 수 있어요.');
    if (change.op === 'insert' || change.op === 'remove') {
      if (kind !== 'content' || !/^(0|[1-9]\d*)$/u.test(segments.at(-1)!))
        throw new HttpError(400, '로어 또는 번역 표기 인덱스가 필요해요.');
      const parentSegments = segments.slice(0, -1);
      const list = listPath(parentSegments);
      if (!list) throw new HttpError(400, '로어와 번역 표기 목록만 수정할 수 있어요.');
      if (change.op === 'insert' && list === 'lore' && parentSegments[2] === 'card') {
        const card = (model as Content).package.nativeRisu.card;
        if (card.character_book == null) card.character_book = { entries: [] };
      }
      let parent = locate(model, parentSegments);
      if (!parent.exists && change.op === 'insert' && list === 'lore') {
        if (parentSegments[2] === 'module') {
          (parent.parent as JsonObject).lorebook = [];
        } else {
          const card = (model as Content).package.nativeRisu.card;
          (card.character_book as JsonObject).entries = [];
        }
        parent = locate(model, parentSegments);
      }
      if (!parent.exists || !Array.isArray(parent.value))
        throw new HttpError(400, '수정할 목록이 없어요.');
      const index = Number(segments.at(-1));
      if (index > parent.value.length || (change.op === 'remove' && index === parent.value.length))
        throw new HttpError(400, '목록 인덱스를 확인해 주세요.');
      if (change.op === 'insert') {
        if (!object(change.value)) throw new HttpError(400, '새 항목 객체가 필요해요.');
        if (list === 'terms') {
          validateTranslationGuide({ instructions: '', terms: [change.value] });
        } else if (
          typeof change.value.content !== 'string' ||
          (parentSegments[2] === 'card' &&
            (!Array.isArray(change.value.keys) ||
              change.value.keys.some((key) => typeof key !== 'string')))
        ) {
          throw new HttpError(400, '로어 항목의 내용과 키를 확인해 주세요.');
        }
        parent.value.splice(index, 0, structuredClone(change.value));
      } else parent.value.splice(index, 1);
      changedPaths.push(change.path);
      continue;
    }
    if (kind === 'content' && change.op === 'set' && guidePath(segments)) {
      const document =
        segments[2] === 'card'
          ? (model as Content).package.nativeRisu.card
          : (model as Content).package.nativeRisu.module!;
      const extensions = object(document.extensions) ? document.extensions : {};
      const uimori = object(extensions.uimori) ? extensions.uimori : {};
      if (uimori.translationGuide !== undefined)
        throw new HttpError(400, '기존 번역 지침은 개별 필드를 수정해 주세요.');
      const guide = validateTranslationGuide(change.value);
      document.extensions = { ...extensions, uimori: { ...uimori, translationGuide: guide } };
      changedPaths.push(change.path);
      continue;
    }
    const target = locate(model, segments);
    if (!target.exists && Array.isArray(target.parent))
      throw new HttpError(400, '새 배열 항목은 만들 수 없어요.');
    if (change.op === 'set') {
      if (
        !Object.hasOwn(change, 'value') ||
        !allowedValue(change.value) ||
        (target.exists && !allowedValue(target.value))
      )
        throw new HttpError(400, '기존의 단순 값만 수정할 수 있어요.');
      if (!isDeepStrictEqual(target.value, change.value)) {
        (target.parent as JsonObject)[segments.at(-1)!] = structuredClone(change.value);
        changedPaths.push(change.path);
      }
    } else {
      if (
        !target.exists ||
        typeof target.value !== 'string' ||
        typeof change.oldText !== 'string' ||
        !change.oldText ||
        typeof change.newText !== 'string'
      )
        throw new HttpError(400, '문자열과 찾을 문구가 필요해요.');
      const first = target.value.indexOf(change.oldText);
      if (first < 0 || target.value.indexOf(change.oldText, first + 1) >= 0)
        throw new HttpError(409, '문구가 정확히 한 번 나타나야 해요.');
      const next =
        target.value.slice(0, first) +
        change.newText +
        target.value.slice(first + change.oldText.length);
      if (next !== target.value) {
        (target.parent as JsonObject)[segments.at(-1)!] = next;
        changedPaths.push(change.path);
      }
    }
  }
  if (!changedPaths.length) return { id, revision, changedPaths };
  const saved = saveResource(store, { kind, id, expectedRevision: revision, model }).saved;
  return { id, revision: saved.revision, changedPaths: [...new Set(changedPaths)] };
}
