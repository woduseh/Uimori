import { countTextTokens, textTokenExcerpt } from '../core/text-tokens.js';
import { isDeepStrictEqual } from 'node:util';
import {
  editableResource,
  type PromptEditModel,
  type ResourceKind,
  type ResourceModel,
} from '../core/resource-editing.js';
import {
  promptControls,
  reconcilePromptValues,
  resolveControlValues,
  validateEditableRisuPrompt,
  type PromptControl,
} from '../core/risu-prompt.js';
import type { Content } from '../core/product.js';
import { RisuContentError } from '../core/risu-content.js';
import type { HelperEditor } from '../core/helper.js';
import type { Store } from './store.js';
import { HttpError, number, text } from './request-validation.js';
import { readResource, saveResource } from './resource-service.js';
import {
  HelperResourcePatchError,
  type HelperResourcePatchReason,
} from './helper-resource-patch-error.js';
import pathPolicy from './helper-resource-path-policy.json' with { type: 'json' };
import protectedFields from './helper-native-protected-fields.json' with { type: 'json' };

const MAX_RESULT_TOKENS = 12_000;
const MAX_PATH = pathPolicy.maxLength;
const MAX_TEXT = 10_000;
const FORBIDDEN = new Set(protectedFields);
type JsonObject = Record<string, unknown>;
type Change = {
  path: string;
  target?: string;
  op: 'set' | 'replaceText' | 'insert' | 'remove' | 'move';
  from?: string;
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
  if (
    segments.length > pathPolicy.maxSegments ||
    segments.some((part) => !part || part.length > pathPolicy.maxSegmentLength)
  )
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
function bounded(result: unknown, maximum = MAX_RESULT_TOKENS): unknown {
  if (countTextTokens(JSON.stringify(result)) > maximum)
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
const PRESET_TEMPLATE_PATH = '/program/nativeRisuPreset/preset/promptTemplate';
const PRESET_NAME_PATH = '/program/nativeRisuPreset/preset/name';
const BODY_FIELDS = ['text', 'innerFormat', 'defaultText'];
function promptBlock(value: unknown, path: string, includeBodies = false): JsonObject | undefined {
  if (!object(value)) return undefined;
  const block: JsonObject = {};
  const previews: JsonObject = {};
  for (const field of ['id', 'name', 'type', 'role', 'role2']) {
    const text = value[field];
    if (typeof text !== 'string') continue;
    if (text.length <= 200) block[field] = text;
    else
      previews[field] = {
        text: text.slice(0, 200).replace(/[\uD800-\uDBFF]$/u, ''),
        length: text.length,
        path: joined(path, field),
      };
  }
  return {
    ...block,
    ...(Object.keys(previews).length ? { previews } : {}),
    textLengths: Object.fromEntries(
      BODY_FIELDS.flatMap((field) =>
        typeof value[field] === 'string' ? [[field, value[field].length]] : []
      )
    ),
    ...(includeBodies
      ? {
          bodies: Object.fromEntries(
            BODY_FIELDS.flatMap((field) =>
              typeof value[field] === 'string' ? [[field, value[field]]] : []
            )
          ),
        }
      : {}),
  };
}
export function readHelperResource(
  store: Store,
  kind: ResourceKind,
  id: string,
  args: JsonObject,
  maximum = MAX_RESULT_TOKENS
) {
  const paths = args.paths;
  if (args.includeBodies !== undefined && typeof args.includeBodies !== 'boolean')
    throw new HttpError(400, '본문 포함 옵션을 확인해 주세요.');
  if (
    args.includeBodies &&
    (kind !== 'prompt-preset' || args.path !== PRESET_TEMPLATE_PATH || paths !== undefined)
  )
    throw new HttpError(400, '프롬프트 블록 목록에서만 본문을 함께 읽을 수 있어요.');
  if (paths !== undefined) {
    if (args.path !== undefined) throw new HttpError(400, 'path와 paths 중 하나만 지정해 주세요.');
    if (
      !Array.isArray(paths) ||
      !paths.length ||
      paths.length > 16 ||
      paths.some((path) => typeof path !== 'string' || path.length > MAX_PATH)
    )
      throw new HttpError(400, '읽을 경로를 1개에서 16개까지 지정해 주세요.');
  }
  const saved = readResource(store, kind, id);
  let model = editableResource(kind, saved);
  if (args.version !== undefined && args.version !== 'current' && args.version !== 'previous')
    throw new HttpError(400, '읽을 저장본을 확인해 주세요.');
  const previous = args.version === 'previous';
  if (previous) {
    const row = store.db
      .prepare('SELECT saved_revision,model FROM resource_undo WHERE kind=? AND id=?')
      .get(kind, id);
    if (!row) throw new HttpError(404, '직전 저장본이 없어요.');
    if (row.saved_revision !== saved.revision)
      throw new HttpError(409, '최근 저장 이후 자료가 변경됐어요.');
    try {
      const parsed: unknown = JSON.parse(String(row.model));
      if (!object(parsed)) throw new Error('Invalid previous model');
      model = parsed as ResourceModel;
    } catch {
      throw new HttpError(409, '직전 저장본을 읽을 수 없어요.');
    }
  }
  const read = (selection: JsonObject, limit = maximum) =>
    readHelperModel(
      kind,
      id,
      previous ? null : saved.revision,
      'title' in model ? String(model.title) : 'current',
      model,
      selection,
      undefined,
      limit,
      previous ? saved.revision : undefined
    );
  if (paths === undefined) return read(args);
  const items: unknown[] = [];
  // An individual page must also fit when enclosed by the batch response.
  const pageMaximum = maximum - countTextTokens(JSON.stringify({ items: [], nextIndex: null }));
  for (const path of paths) {
    let item: unknown;
    try {
      item = read({ ...args, path }, pageMaximum);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      item = { path, error: error.message };
    }
    const candidate = {
      items: [...items, item],
      nextIndex: items.length + 1 < paths.length ? items.length + 1 : null,
    };
    if (countTextTokens(JSON.stringify(candidate)) > maximum) break;
    items.push(item);
  }
  return bounded({ items, nextIndex: items.length < paths.length ? items.length : null }, maximum);
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
  inputOrigin?: string,
  maximum = MAX_RESULT_TOKENS,
  previousCurrentRevision?: number
) {
  const base = {
    kind,
    id,
    revision,
    ...(inputOrigin ? { inputOrigin } : {}),
    ...(previousCurrentRevision === undefined
      ? {}
      : { version: 'previous', currentRevision: previousCurrentRevision }),
  };
  const path = args.path === undefined ? undefined : text(args.path, 'path', MAX_PATH, true);
  if (path === undefined) {
    const source = kind === 'content' ? sourceFor(model as Content) : null;
    const readyPaths = source
      ? [source.path, source.lorePath, source.translationGuidePath, '/package/images']
      : kind === 'prompt-preset'
        ? [
            PRESET_TEMPLATE_PATH,
            PRESET_NAME_PATH,
            '/program/nativeRisuPreset/preset/customPromptTemplateToggle',
            '/program/nativeRisuPreset/preset/templateDefaultVariables',
            '/values',
          ]
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
    const nativeName =
      kind === 'prompt-preset'
        ? (model as PromptEditModel).program.nativeRisuPreset.preset.name
        : undefined;
    return bounded(
      {
        ...base,
        title,
        ...(typeof nativeName !== 'string'
          ? {}
          : nativeName.length <= 200
            ? { nativeName }
            : {
                nativeNamePreview: {
                  text: nativeName.slice(0, 200).replace(/[\uD800-\uDBFF]$/u, ''),
                  length: nativeName.length,
                  path: PRESET_NAME_PATH,
                },
              }),
        ...(source ? { source } : {}),
        regions,
        readyPaths,
      },
      maximum
    );
  }
  const segments = parts(path);
  const found = locate(model, segments);
  if (!found.exists) return bounded({ ...base, path, exists: false }, maximum);
  const value = found.value;
  const head = { ...base, path, exists: true, type: type(value) };
  if (typeof value === 'string') {
    const requested = optionalInt(args.textOffset, 'text offset', value.length, 0);
    let start = requested;
    if (start > 0 && start < value.length && /[\uDC00-\uDFFF]/u.test(value[start]!)) start--;
    const limit =
      args.textLimit === undefined
        ? textTokenExcerpt(value.slice(start), 2_000).text.length || 1
        : optionalInt(args.textLimit, 'text limit', MAX_TEXT, 4_000);
    if (limit === 0) throw new HttpError(400, '읽기 길이는 1 이상이어야 해요.');
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
    if (start === value.length) return bounded(page(start), maximum);
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const end =
        middle < value.length && /[\uDC00-\uDFFF]/u.test(value[middle]!) ? middle - 1 : middle;
      if (end <= start) {
        low = middle + 1;
        continue;
      }
      if (countTextTokens(JSON.stringify(page(end))) <= maximum) {
        best = end;
        low = middle + 1;
      } else high = middle - 1;
    }
    if (best === start && start + 1 < value.length && /[\uD800-\uDBFF]/u.test(value[start]!))
      best = start + 2;
    if (best === start) throw new HttpError(413, '읽기 결과가 커요. 더 좁은 경로를 지정해 주세요.');
    return bounded(page(best), maximum);
  }
  if (!object(value) && !Array.isArray(value)) return bounded({ ...head, value }, maximum);
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
  const withBodies =
    args.includeBodies === true && kind === 'prompt-preset' && path === PRESET_TEMPLATE_PATH;
  let index = offset;
  for (; index < Math.min(keys.length, offset + limit); index++) {
    const key = keys[index]!;
    const item = member(value, key);
    let next = {
      name: key,
      ...descriptor(joined(path, key), item.value, item.exists),
      ...(previousCurrentRevision === undefined &&
      inputOrigin === undefined &&
      Array.isArray(value) &&
      listPath(segments) &&
      object(item.value)
        ? { target: joined(path, key) }
        : {}),
      ...(kind === 'prompt-preset' && path === PRESET_TEMPLATE_PATH && Array.isArray(value)
        ? { block: promptBlock(item.value, joined(path, key), withBodies) }
        : {}),
    };
    const candidate = {
      ...head,
      count: keys.length,
      [Array.isArray(value) ? 'items' : 'fields']: [...entries, next],
      nextOffset: index + 1 < keys.length ? index + 1 : null,
    };
    if (countTextTokens(JSON.stringify(candidate)) > maximum) {
      if (!withBodies || entries.length) {
        if (entries.length) break;
        throw new HttpError(413, '읽기 결과가 커요. 더 좁은 경로를 지정해 주세요.');
      }
      // A single enormous block cannot fit. Return its full metadata and explicit
      // field paths rather than dropping it or claiming its text was read.
      const omittedBodyPaths = Object.fromEntries(
        BODY_FIELDS.flatMap((field) =>
          object(item.value) && typeof item.value[field] === 'string'
            ? [[field, joined(joined(path, key), field)]]
            : []
        )
      );
      next = {
        ...next,
        block: { ...promptBlock(item.value, joined(path, key)), omittedBodyPaths },
      };
      if (countTextTokens(JSON.stringify({ ...candidate, items: [next] })) > maximum)
        throw new HttpError(413, '읽기 결과가 커요. 더 좁은 경로를 지정해 주세요.');
    }
    entries.push(next);
  }
  return bounded(
    {
      ...head,
      count: keys.length,
      [Array.isArray(value) ? 'items' : 'fields']: entries,
      nextOffset: index < keys.length ? index : null,
    },
    maximum
  );
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
function listPath(segments: string[]): 'lore' | 'terms' | 'prompt' | null {
  if (
    segments.length === 4 &&
    segments[0] === 'program' &&
    segments[1] === 'nativeRisuPreset' &&
    segments[2] === 'preset' &&
    segments[3] === 'promptTemplate'
  )
    return 'prompt';
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
function patchFailure(
  changeIndex: number,
  change: unknown,
  error: unknown,
  reason: HelperResourcePatchReason = 'invalid_change',
  matchCount?: number
): never {
  if (error instanceof HelperResourcePatchError) throw error;
  const input = object(change) ? change : {};
  throw new HelperResourcePatchError(
    error instanceof HttpError ? error.statusCode : 400,
    error instanceof Error ? error.message : '변경 내용을 확인해 주세요.',
    {
      changeIndex,
      path: typeof input.path === 'string' ? input.path.slice(0, MAX_PATH) : null,
      op: typeof input.op === 'string' ? input.op.slice(0, 32) : null,
      reason,
      ...(typeof input.target === 'string' ? { target: input.target.slice(0, MAX_PATH) } : {}),
      ...(matchCount === undefined ? {} : { matchCount }),
    }
  );
}
function validationFailure(error: unknown): never {
  throw new HelperResourcePatchError(
    error instanceof HttpError ? error.statusCode : 400,
    error instanceof Error ? error.message : '변경 내용을 확인해 주세요.',
    { stage: 'validation', changeIndex: null, path: null, op: null, reason: 'invalid_change' }
  );
}
type BoundTarget = { list: string[]; item: JsonObject };
function bindTarget(model: ResourceModel, kind: ResourceKind, change: Change): BoundTarget | null {
  if (change.target === undefined) return null;
  if (
    !['set', 'replaceText', 'remove'].includes(change.op) ||
    (change.op === 'remove' && change.path !== '')
  )
    throw new HttpError(400, '대상 참조는 필드 수정 또는 항목 삭제에만 사용할 수 있어요.');
  const segments = parts(change.target);
  const list = segments.slice(0, -1);
  const listKind = listPath(list);
  if (
    !listKind ||
    (kind === 'prompt-preset' ? listKind !== 'prompt' : listKind === 'prompt') ||
    !/^(0|[1-9]\d*)$/u.test(segments.at(-1)!)
  )
    throw new HttpError(400, '원본 목록 항목의 대상 경로가 필요해요.');
  let target: ReturnType<typeof locate>;
  try {
    target = locate(model, segments);
  } catch {
    throw new HttpError(404, '원본 대상 항목이 존재하지 않아요.');
  }
  if (!target.exists || !object(target.value) || !Array.isArray(target.parent))
    throw new HttpError(404, '원본 대상 항목이 존재하지 않아요.');
  return { list, item: target.value };
}
function targetPath(model: ResourceModel, target: BoundTarget, relative: string): string {
  let list: unknown;
  try {
    list = locate(model, target.list).value;
  } catch {
    throw new HttpError(409, '앞선 변경에서 대상 항목이 삭제되거나 교체됐어요.');
  }
  const index = Array.isArray(list) ? list.indexOf(target.item) : -1;
  if (index < 0) throw new HttpError(409, '앞선 변경에서 대상 항목이 삭제되거나 교체됐어요.');
  return [...target.list, String(index), ...parts(relative)].reduce(joined, '');
}
function textMatches(value: string, needle: string): { first: number; count: number } {
  const first = value.indexOf(needle);
  let count = 0;
  for (let index = first; index >= 0; index = value.indexOf(needle, index + 1)) count++;
  return { first, count };
}
function normalizedText(value: string): { text: string; offsets: number[] } {
  let text = '';
  const offsets = [0];
  for (let index = 0; index < value.length; ) {
    if (value[index] === '\r' && value[index + 1] === '\n') {
      text += '\n';
      index += 2;
    } else text += value[index++]!;
    offsets.push(index);
  }
  return { text, offsets };
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
  const original = editableResource(kind, current);
  const model = structuredClone(original) as ResourceModel;
  if (kind === 'content' && !sourceFor(current as Content))
    throw new HttpError(400, 'native 원문이 없는 자료예요.');
  const changes = rawChanges as Change[];
  // Bind before any mutation: duplicate or missing native IDs do not affect identity.
  const targets = changes.map((change, changeIndex) => {
    if (
      !object(change) ||
      typeof change.path !== 'string' ||
      !['set', 'replaceText', 'insert', 'remove', 'move'].includes(change.op)
    )
      patchFailure(changeIndex, change, new HttpError(400, '변경 형식을 확인해 주세요.'));
    try {
      parts(change.path);
    } catch (error) {
      patchFailure(changeIndex, change, error);
    }
    try {
      return bindTarget(model, kind, change);
    } catch (error) {
      return patchFailure(
        changeIndex,
        change,
        error,
        error instanceof HttpError && error.statusCode === 404 ? 'target_missing' : 'invalid_target'
      );
    }
  });
  const changedPaths: string[] = [];
  const matches: { changeIndex: number; path: string; normalization: 'crlf-lf' }[] = [];
  const explicitValues = new Map<string, number>();
  for (const [changeIndex, input] of changes.entries()) {
    let path = input.path;
    const bound = targets[changeIndex];
    if (bound) {
      try {
        path = targetPath(model, bound, input.path);
      } catch (error) {
        patchFailure(changeIndex, input, error, 'target_removed');
      }
    }
    const change = { ...input, path };
    try {
      const segments = parts(change.path);
      if (kind === 'prompt-preset' && segments[0] === 'values' && segments[1])
        explicitValues.set(segments[1], changeIndex);
      const nativePath =
        segments.length >= 4 &&
        segments[0] === 'package' &&
        segments[1] === 'nativeRisu' &&
        ['card', 'module'].includes(segments[2]!);
      const presetPath = pathPolicy.presetPaths.some((rule) =>
        rule.endsWith('/') ? change.path.startsWith(rule) : change.path === rule
      );
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
      if (change.op === 'insert' || change.op === 'remove' || change.op === 'move') {
        if (!/^(0|[1-9]\d*)$/u.test(segments.at(-1)!))
          throw new HttpError(400, '목록 항목의 인덱스가 필요해요.');
        const parentSegments = segments.slice(0, -1);
        const list = listPath(parentSegments);
        if (!list || (kind === 'prompt-preset' ? list !== 'prompt' : list === 'prompt'))
          throw new HttpError(400, '로어, 번역 표기 또는 프롬프트 블록 목록만 수정할 수 있어요.');
        if (change.op === 'move' && list !== 'prompt')
          throw new HttpError(400, '프롬프트 블록만 이동할 수 있어요.');
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
        if (change.op === 'move') {
          const from = parts(change.from);
          if (
            from.length !== segments.length ||
            from.slice(0, -1).some((part, offset) => part !== parentSegments[offset]) ||
            !/^(0|[1-9]\d*)$/u.test(from.at(-1)!)
          )
            throw new HttpError(400, '같은 프롬프트 목록의 출발 인덱스가 필요해요.');
          const sourceIndex = Number(from.at(-1));
          // JSON Patch semantics: the destination index is evaluated after removal.
          if (sourceIndex >= parent.value.length || index >= parent.value.length)
            throw new HttpError(400, '목록 인덱스를 확인해 주세요.');
          if (sourceIndex === index) continue;
          const [moved] = parent.value.splice(sourceIndex, 1);
          parent.value.splice(index, 0, moved);
          changedPaths.push(change.from!, change.path);
          continue;
        }
        if (
          index > parent.value.length ||
          (change.op === 'remove' && index === parent.value.length)
        )
          throw new HttpError(400, '목록 인덱스를 확인해 주세요.');
        if (change.op === 'insert') {
          if (!object(change.value)) throw new HttpError(400, '새 항목 객체가 필요해요.');
          if (list === 'lore' && typeof change.value.content !== 'string')
            throw new HttpError(400, '로어 항목의 내용을 확인해 주세요.');
          parent.value.splice(index, 0, structuredClone(change.value));
        } else parent.value.splice(index, 1);
        changedPaths.push(change.path);
        continue;
      }
      if (kind === 'content' && change.op === 'set' && guidePath(segments)) {
        if (!object(change.value)) throw new HttpError(400, '번역 지침 객체가 필요해요.');
        const document =
          segments[2] === 'card'
            ? (model as Content).package.nativeRisu.card
            : (model as Content).package.nativeRisu.module!;
        if (document.extensions != null && !object(document.extensions))
          throw new HttpError(400, '기존 확장 필드를 확인해 주세요.');
        const extensions = object(document.extensions) ? document.extensions : {};
        if (extensions.uimori != null && !object(extensions.uimori))
          throw new HttpError(400, '기존 Uimori 확장 필드를 확인해 주세요.');
        const uimori = object(extensions.uimori) ? extensions.uimori : {};
        if (isDeepStrictEqual(uimori.translationGuide, change.value)) continue;
        document.extensions = {
          ...extensions,
          uimori: { ...uimori, translationGuide: structuredClone(change.value) },
        };
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
        let { first, count } = textMatches(target.value, change.oldText);
        let end = first + change.oldText.length;
        if (count === 0 && change.oldText.includes('\n')) {
          const normalized = normalizedText(target.value);
          const needle = change.oldText.replaceAll('\r\n', '\n');
          const equivalent = textMatches(normalized.text, needle);
          count = equivalent.count;
          if (count === 1) {
            first = normalized.offsets[equivalent.first]!;
            end = normalized.offsets[equivalent.first + needle.length]!;
            matches.push({ changeIndex, path: change.path, normalization: 'crlf-lf' });
          }
        }
        if (count !== 1)
          patchFailure(
            changeIndex,
            input,
            new HttpError(409, '문구가 정확히 한 번 나타나야 해요.'),
            count === 0 ? 'text_not_found' : 'text_ambiguous',
            count
          );
        const next = target.value.slice(0, first) + change.newText + target.value.slice(end);
        if (next !== target.value) {
          (target.parent as JsonObject)[segments.at(-1)!] = next;
          changedPaths.push(change.path);
        }
      }
    } catch (error) {
      patchFailure(changeIndex, input, error);
    }
  }
  const resetKeys: string[] = [];
  let reconciledValues: { removedKeys: string[]; resetKeys: string[] } | undefined;
  if (kind === 'prompt-preset') {
    const preset = model as PromptEditModel;
    const oldPreset = original as PromptEditModel;
    const values = preset.values ?? {};
    const programChanged = changes.some((change) =>
      (change.target ?? change.path).startsWith('/program/')
    );
    let controls: PromptControl[] | undefined;
    if (programChanged) {
      try {
        validateEditableRisuPrompt(preset.program);
        controls = promptControls(preset.program);
        resolveControlValues(controls);
      } catch (error) {
        validationFailure(error);
      }
    }
    for (const [key, changeIndex] of explicitValues) {
      try {
        resolveControlValues((controls ??= promptControls(preset.program)), {
          [key]: values[key]!,
        });
      } catch (error) {
        patchFailure(changeIndex, changes[changeIndex], error, 'invalid_value');
      }
    }
    if (
      !isDeepStrictEqual(
        preset.program.nativeRisuPreset.preset.customPromptTemplateToggle,
        oldPreset.program.nativeRisuPreset.preset.customPromptTemplateToggle
      )
    ) {
      const inherited = Object.fromEntries(
        Object.entries(values).filter(([key]) => !explicitValues.has(key))
      );
      const reconciled = reconcilePromptValues(
        (controls ??= promptControls(preset.program)),
        inherited
      );
      // Keep the existing combined report while also distinguishing removed values.
      resetKeys.push(...reconciled.resetKeys);
      const removedKeys = reconciled.resetKeys.filter(
        (key) => !Object.hasOwn(reconciled.values, key)
      );
      const resetValueKeys = reconciled.resetKeys.filter((key) =>
        Object.hasOwn(reconciled.values, key)
      );
      for (const key of explicitValues.keys()) reconciled.values[key] = values[key]!;
      if (!isDeepStrictEqual(preset.values, reconciled.values)) changedPaths.push('/values');
      preset.values = reconciled.values;
      if (removedKeys.length || resetValueKeys.length)
        reconciledValues = { removedKeys, resetKeys: resetValueKeys };
    }
  }
  if (!changedPaths.length || isDeepStrictEqual(original, model))
    return { id, revision, changedPaths: [], ...(matches.length ? { matches } : {}) };
  let saved: ReturnType<typeof saveResource>['saved'];
  try {
    saved = saveResource(store, { kind, id, expectedRevision: revision, model }).saved;
  } catch (error) {
    if (
      (error instanceof HttpError && error.statusCode === 400) ||
      error instanceof RisuContentError
    )
      validationFailure(error);
    throw error;
  }
  return {
    id,
    revision: saved.revision,
    changedPaths: [...new Set(changedPaths)],
    ...(matches.length ? { matches } : {}),
    ...(resetKeys.length ? { resetKeys } : {}),
    ...(reconciledValues ? { reconciledValues } : {}),
  };
}
