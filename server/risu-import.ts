import type { FastifyInstance } from 'fastify';
import type { ContentPackage } from '../core/content-package.js';
import {
  RISU_IMPORT_MAX_BYTES,
  type RisuImportPreview,
  type RisuImportResult,
  type RisuImportKind,
} from '../core/risu-import.js';
import { readCharacterCard } from './character-card-file.js';
import { applyNativeTransfer, prepareNativeTransfer } from './native-transfer.js';
import { deleteUpload, readUpload } from './uploads.js';
import { fields, HttpError, record, text } from './request-validation.js';
import { createRisuImportFindings } from './risu-import-findings.js';
import { analyzeNativeRisuImport } from './risu-native-import.js';
import { buildRisuTransfer } from './risu-import-transfer.js';
import { adaptRisuPlugin } from './risu-plugin-adapter.js';
import { readRisuPluginFile } from './risu-plugin-import.js';
import type { Store } from './store.js';
import { createPackageStart } from './package-start.js';
import type { Content } from '../core/product.js';

/**
 * A plugin file becomes one module package whose behavior actions wrap the preserved plugin source
 * in the `risuai` shim. Nothing runs here: the adapter only builds sources, options and findings.
 */
function analyzePlugin(value: unknown, requestedKind?: RisuImportKind) {
  if (requestedKind === 'bot') throw new HttpError(400, 'RISU_IMPORT_KIND');
  const { preview: plugin, code, file: envelope, aliases } = readRisuPluginFile(value);
  const adapted = adaptRisuPlugin(plugin, code, aliases);
  const findings = createRisuImportFindings();
  findings.append(plugin.findings);
  const links = plugin.links.map((link) => link.url).join(' ');
  const description = [
    `Risu 플러그인 ${plugin.displayName}에서 가져온 자료예요.`,
    plugin.pluginVersion ? `플러그인 버전 ${plugin.pluginVersion}.` : '',
    `API ${plugin.apiVersion}.`,
    links ? `링크: ${links}` : '',
  ]
    .filter(Boolean)
    .join(' ')
    .slice(0, 4000);
  const pkg: ContentPackage = {
    version: 1,
    id: `plugin-${plugin.sha256.slice(0, 32)}`,
    revision: 1,
    title: plugin.displayName || plugin.name,
    description,
    // The native transfer binds the content text to the package body, so the module keeps an
    // empty one: a plugin declares no prose of its own.
    body: '',
    lore: [],
    instructions: [],
    controls: adapted.controls,
    transforms: [],
    starts: [],
    images: [],
  };
  if (adapted.actions.length && adapted.actions.length <= 100) {
    pkg.behavior = {
      revision: 1,
      schemaVersion: 1,
      stateSchema: { type: 'record', properties: {} },
      initialState: {},
      actions: adapted.actions,
      outputParsers: [],
    };
    findings.add(
      'plugin-actions',
      'warning',
      '플러그인이 등록하는 입력·요청·출력·표시 편집과 응답 이벤트를 격리된 자료 행동으로 가져와요. 가져오기 중에는 코드를 실행하지 않아요. 공유 변수 변경·대화 읽기·추가 모델 호출은 채팅에서 각각 허용해야 해요.'
    );
  } else if (adapted.actions.length > 100)
    findings.add(
      'plugin-actions-limit',
      'unsupported',
      '플러그인 행동이 자료의 한도를 넘어 자동 연결하지 않아요. 원본 코드는 파일에 보존해요.'
    );
  for (const issue of adapted.findings) findings.add(issue.code, issue.level, issue.message);
  const { file, preview } = buildRisuTransfer({
    input: {
      hash: plugin.sha256,
      source: envelope.source,
      kind: 'module',
      format: 'risu-plugin-js',
    },
    card: { creator_notes: description },
    pkg,
    title: pkg.title,
    images: [],
    lore: [],
    findings,
    plugin,
  });
  return { file, preview, hash: plugin.sha256 };
}

function analyze(
  value: unknown,
  requestedKind?: RisuImportKind,
  readStaged?: (uploadId: string) => Buffer
) {
  // A plugin declares its format in its name, and its reader owns the 4 MiB limit and `.js` rule.
  if (/\.js$/iu.test(String(record(value).name))) return analyzePlugin(value, requestedKind);
  return analyzeNativeRisuImport(readCharacterCard(value, requestedKind, readStaged));
}

export function prepareRisuImport(
  value: unknown,
  readStaged?: (uploadId: string) => Buffer
): RisuImportPreview {
  const body = record(value);
  fields(body, ['source', 'kind']);
  return analyze(body.source, body.kind as RisuImportKind | undefined, readStaged).preview;
}

export function applyRisuImport(
  store: Store,
  value: unknown,
  readStaged?: (uploadId: string) => Buffer
): RisuImportResult {
  const body = record(value);
  fields(body, [
    'source',
    'kind',
    'digest',
    'memoryIds',
    'imageHandoffIds',
    'allowPartial',
    'idempotencyKey',
  ]);
  const requestKey = text(body.idempotencyKey, 'request key', 100);
  const { file, preview, hash } = analyze(
    body.source,
    body.kind as RisuImportKind | undefined,
    readStaged
  );
  if (body.digest !== preview.digest) throw new HttpError(409, 'RISU_IMPORT_DRAFT_CHANGED');
  if (typeof body.allowPartial !== 'boolean') throw new HttpError(400, 'RISU_IMPORT_INVALID_FILE');
  if (preview.findings.some((item) => item.level === 'unsupported') && !body.allowPartial)
    throw new HttpError(400, 'RISU_IMPORT_PARTIAL_REQUIRED');
  if (
    !Array.isArray(body.memoryIds) ||
    (preview.kind === 'module' && body.memoryIds.length > 0) ||
    new Set(body.memoryIds).size !== body.memoryIds.length ||
    body.memoryIds.some(
      (id: unknown) =>
        typeof id !== 'string' ||
        !preview.lore.some(
          (item) => item.id === id && item.enabled && item.text.trim() && item.text.length <= 32000
        )
    )
  )
    throw new HttpError(400, 'RISU_IMPORT_MEMORY_SELECTION');
  if (body.imageHandoffIds !== undefined) {
    const policy = file.contents[0].source.package!.imageHandoff;
    if (
      !Array.isArray(body.imageHandoffIds) ||
      body.imageHandoffIds.length > 64 ||
      body.imageHandoffIds.some(
        (id: unknown) => typeof id !== 'string' || !policy?.ranges.some((range) => range.id === id)
      )
    )
      throw new HttpError(400, 'RISU_IMPORT_IMAGE_HANDOFF_SELECTION');
    if (policy)
      policy.ranges = policy.ranges.map((range) => ({
        ...range,
        enabled: body.imageHandoffIds.includes(range.id),
      }));
  }
  const selected = new Set<string>(body.memoryIds);
  const memories = preview.lore.filter((item) => selected.has(item.id));
  file.contents[0].source.package!.lore = file.contents[0].source.package!.lore.filter(
    (item) => !selected.has(item.id)
  );
  const native = file.contents[0].source.package!.nativeRisu;
  if (native && selected.size) {
    const entries =
      native.module?.lorebook ??
      (native.card.character_book as { entries?: unknown[] } | undefined)?.entries;
    if (Array.isArray(entries)) {
      const updated = entries.map((entry, index) =>
        selected.has(`lore-${index}`) ? { ...record(entry), enabled: false } : entry
      );
      if (native.module?.lorebook != null) native.module.lorebook = updated;
      else native.card.character_book = { ...record(native.card.character_book), entries: updated };
    }
  }
  const prepared = prepareNativeTransfer({ file });
  return store.transaction(() => {
    const receipt = applyNativeTransfer(store, {
      file,
      digest: prepared.digest,
      modelBindings: [],
      idempotencyKey: `risu:${requestKey}`,
    });
    if (preview.kind === 'module') return { receipt, chat: null };
    if (!receipt.created) {
      const exists = store.db.prepare('SELECT id FROM chats WHERE id=?').get(receipt.id);
      return { receipt, chat: exists ? store.chat(receipt.id) : null };
    }
    const botId = receipt.items.find((item) => item.key === 'bot')!.id;
    const chat = store.createChat(preview.title, undefined, { botId }, receipt.id);
    for (const [index, memory] of memories.entries())
      store.story.notes.write(chat.id, {
        kind: 'imported-memory',
        origin: { fileHash: hash, entryId: memory.id, title: memory.title },
        text: memory.text,
        author: '가져온 자료',
        branchId: `main:${chat.id}`,
        expectedRevision: index,
        expectedHeadRevision: null,
        idempotencyKey: `import:${memory.id}`,
      });
    const content = store.product.get<Content>('content', botId);
    const first =
      content.package?.nativeRisu &&
      content.package.starts?.find(
        (start) => start.id === 'start-0' && start.mode === 'authored' && start.text.trim()
      );
    if (first)
      createPackageStart(store, chat.id, {
        packageId: content.id,
        packageRevision: content.revision,
        startId: first.id,
        expectedSettingsRevision: chat.settingsRevision,
        expectedProfileRevision: store.product.profile(chat.id).revision,
        idempotencyKey: `risu-start:${requestKey}`,
      });
    return { receipt, chat: store.chat(chat.id) };
  });
}

export function risuImportRoutes(app: FastifyInstance, store: Store) {
  const bodyLimit = Math.ceil(RISU_IMPORT_MAX_BYTES / 3) * 4 + 1024 * 1024;
  const readStaged = (uploadId: string) => readUpload(store.path, uploadId);
  app.post('/api/risu-imports/prepare', { bodyLimit }, async (request) =>
    prepareRisuImport(request.body, readStaged)
  );
  app.post('/api/risu-imports/apply', { bodyLimit }, async (request, reply) => {
    const result = applyRisuImport(store, request.body, readStaged);
    const source = record(record(request.body).source);
    // The staged file has served its purpose once the material is registered.
    if (result.receipt.created && typeof source.uploadId === 'string')
      deleteUpload(store.path, source.uploadId);
    return reply.code(result.receipt.created ? 201 : 200).send(result);
  });
}
