import {
  MAX_HELPER_REFERENCES,
  type HelperContextReference,
  type HelperReferenceKind,
  type HelperReferencePointer,
  type HelperScope,
} from '../core/helper.js';
import type { Json } from '../core/transport.js';
import { AppError } from './app-errors.js';
import { HttpError, fields, record, text } from './request-validation.js';
import { outlineSceneTitles, sceneTitles } from './scene-titles.js';
import type { Store } from './store.js';

const REFERENCE_KINDS = new Set<HelperReferenceKind>([
  'scene',
  'outline',
  'content',
  'prompt-preset',
]);

const normalizeQuery = (value: string) => value.normalize('NFC').trim().toLocaleLowerCase();

function visibleLibraryItems(store: Store) {
  const rows = store.db
    .prepare(
      `SELECT v.kind, v.id, json_extract(v.body,'$.title') AS title, json_extract(v.body,'$.kind') AS role
       FROM versions v
       WHERE v.kind IN ('content','prompt-preset')
         AND v.revision=(SELECT MAX(v2.revision) FROM versions v2 WHERE v2.kind=v.kind AND v2.id=v.id)
         AND NOT EXISTS (SELECT 1 FROM library_hidden h WHERE h.kind=v.kind AND h.id=v.id)
       ORDER BY v.rowid DESC`
    )
    .all() as { kind: string; id: string; title: unknown; role: unknown }[];
  return rows.map((row): HelperContextReference => {
    const kind = row.kind === 'prompt-preset' ? 'prompt-preset' : 'content';
    const role =
      kind === 'content' && (row.role === 'bot' || row.role === 'persona' || row.role === 'module')
        ? row.role
        : undefined;
    return {
      kind,
      id: String(row.id),
      title: typeof row.title === 'string' ? row.title : '',
      ...(role ? { role } : {}),
    };
  });
}

function visibleScenes(store: Store, chatId: string): HelperContextReference[] {
  const chat = store.db.prepare('SELECT head_revision FROM chats WHERE id=?').get(chatId) as
    | { head_revision: string | null }
    | undefined;
  if (!chat?.head_revision) return [];
  const history = store.history(chat.head_revision);
  const customTitles = sceneTitles(store, chatId);
  const plannedTitles = outlineSceneTitles(store, chatId);
  const scenes: HelperContextReference[] = [];
  let sceneNumber = 0;
  for (const item of history) {
    const enabled = item.sceneContext?.sceneEnabled !== false;
    if (enabled) sceneNumber++;
    scenes.push({
      kind: 'scene',
      id: item.revision,
      chatId,
      ...(enabled ? { sceneNumber } : {}),
      title: customTitles.get(item.revision) || plannedTitles.get(item.revision) || '',
    });
  }
  return scenes;
}

export function searchHelperReferences(
  store: Store,
  scope: HelperScope,
  rawQuery = '',
  limit = 20
): HelperContextReference[] {
  const query = normalizeQuery(rawQuery);
  const matches = (item: HelperContextReference) => {
    if (!query) return true;
    const haystacks = [item.title];
    if (item.kind === 'scene' && item.sceneNumber !== undefined) {
      haystacks.push(
        String(item.sceneNumber),
        `#${item.sceneNumber}`,
        `장면 ${item.sceneNumber}`,
        `장면${item.sceneNumber}`,
        `scene ${item.sceneNumber}`,
        `シーン ${item.sceneNumber}`,
        `场景 ${item.sceneNumber}`
      );
    }
    return haystacks.some((entry) => normalizeQuery(entry).includes(query));
  };
  const results: HelperContextReference[] = [];
  if (scope.kind === 'chat') {
    for (const scene of visibleScenes(store, scope.chatId).reverse()) {
      if (matches(scene)) results.push(scene);
      if (results.length >= limit) return results;
    }
    for (const node of store.outline.nodes(scope.chatId)) {
      const ref: HelperContextReference = {
        kind: 'outline',
        id: node.id,
        chatId: scope.chatId,
        title: node.title,
      };
      if (matches(ref)) results.push(ref);
      if (results.length >= limit) return results;
    }
  }
  for (const item of visibleLibraryItems(store)) {
    if (matches(item)) results.push(item);
    if (results.length >= limit) return results;
  }
  return results;
}

export function parseHelperReferencePointers(value: unknown): HelperReferencePointer[] {
  if (!Array.isArray(value) || value.length > MAX_HELPER_REFERENCES)
    throw new HttpError(400, 'Invalid helper references');
  const seen = new Set<string>();
  const pointers: HelperReferencePointer[] = [];
  for (const entry of value) {
    const item = record(entry);
    fields(item, ['kind', 'id']);
    const kind = text(item.kind, 'reference kind', 32) as HelperReferenceKind;
    if (!REFERENCE_KINDS.has(kind)) throw new HttpError(400, 'Invalid helper reference kind');
    const id = text(item.id, 'reference ID', 100);
    const key = `${kind}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pointers.push({ kind, id });
  }
  return pointers;
}

export function validateHelperReferences(
  store: Store,
  scope: HelperScope,
  pointers: HelperReferencePointer[]
): HelperReferencePointer[] {
  if (!pointers.length) return [];
  const scenes = scope.kind === 'chat' ? visibleScenes(store, scope.chatId) : [];
  const sceneIds = new Set(scenes.map((item) => item.id));
  const outlineIds =
    scope.kind === 'chat'
      ? new Set(store.outline.nodes(scope.chatId).map((node) => node.id))
      : new Set<string>();
  for (const pointer of pointers) {
    if (pointer.kind === 'scene') {
      if (scope.kind !== 'chat') throw new HttpError(403, 'REFERENCE_OUTSIDE_SCOPE');
      if (!sceneIds.has(pointer.id)) throw new AppError(404, 'HELPER_REFERENCE_NOT_FOUND');
    } else if (pointer.kind === 'outline') {
      if (scope.kind !== 'chat') throw new HttpError(403, 'REFERENCE_OUTSIDE_SCOPE');
      if (!outlineIds.has(pointer.id)) throw new AppError(404, 'HELPER_REFERENCE_NOT_FOUND');
    } else {
      const exists = store.db
        .prepare(
          `SELECT 1 FROM versions v WHERE v.kind=? AND v.id=?
           AND NOT EXISTS (SELECT 1 FROM library_hidden h WHERE h.kind=v.kind AND h.id=v.id)
           LIMIT 1`
        )
        .get(pointer.kind, pointer.id);
      if (!exists) throw new AppError(404, 'HELPER_REFERENCE_NOT_FOUND');
    }
  }
  return pointers;
}

export function resolveHelperReferences(
  store: Store,
  scope: HelperScope,
  pointers: HelperReferencePointer[] | undefined
): HelperContextReference[] {
  if (!pointers?.length) return [];
  const sceneMap =
    scope.kind === 'chat'
      ? new Map(visibleScenes(store, scope.chatId).map((scene) => [scene.id, scene]))
      : new Map<string, HelperContextReference>();
  const outlineMap =
    scope.kind === 'chat'
      ? new Map(store.outline.nodes(scope.chatId).map((node) => [node.id, node]))
      : new Map<string, { id: string; title: string }>();
  const resolved: HelperContextReference[] = [];
  for (const pointer of pointers) {
    if (pointer.kind === 'scene') {
      const scene = sceneMap.get(pointer.id);
      if (scene) resolved.push(scene);
    } else if (pointer.kind === 'outline') {
      const node = outlineMap.get(pointer.id);
      if (node && scope.kind === 'chat')
        resolved.push({ kind: 'outline', id: node.id, chatId: scope.chatId, title: node.title });
    } else {
      const row = store.db
        .prepare(
          `SELECT json_extract(v.body,'$.title') AS title, json_extract(v.body,'$.kind') AS role
           FROM versions v WHERE v.kind=? AND v.id=?
           AND NOT EXISTS (SELECT 1 FROM library_hidden h WHERE h.kind=v.kind AND h.id=v.id)
           ORDER BY v.revision DESC LIMIT 1`
        )
        .get(pointer.kind, pointer.id) as { title: unknown; role: unknown } | undefined;
      if (!row) continue;
      const role =
        pointer.kind === 'content' &&
        (row.role === 'bot' || row.role === 'persona' || row.role === 'module')
          ? row.role
          : undefined;
      resolved.push({
        kind: pointer.kind,
        id: pointer.id,
        title: typeof row.title === 'string' ? row.title : '',
        ...(role ? { role } : {}),
      });
    }
  }
  return resolved;
}

export function helperModelReferences(
  store: Store,
  scope: HelperScope,
  pointers: HelperReferencePointer[] | undefined
): Json[] {
  return resolveHelperReferences(store, scope, pointers).map((ref) => {
    if (ref.kind === 'scene')
      return {
        kind: 'scene',
        sourceId: ref.id,
        ...(ref.chatId ? { chatId: ref.chatId } : {}),
        ...(ref.sceneNumber !== undefined ? { sceneNumber: ref.sceneNumber } : {}),
        ...(ref.title ? { title: ref.title } : {}),
        readTool: 'scene.read',
      };
    if (ref.kind === 'outline')
      return {
        kind: 'outline',
        nodeId: ref.id,
        ...(ref.chatId ? { chatId: ref.chatId } : {}),
        title: ref.title,
        readTool: 'outline.read',
      };
    return {
      kind: ref.kind,
      id: ref.id,
      ...(ref.role ? { role: ref.role } : {}),
      title: ref.title,
      readTool: 'resource.read',
    };
  });
}
