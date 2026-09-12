import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ContentPackage } from '../core/content-package.js';
import type { PromptTemplate } from '../core/prompt-program.js';
import {
  NATIVE_TRANSFER_FORMAT,
  NATIVE_TRANSFER_VERSION,
  type NativeTransferFile,
} from '../core/native-transfer.js';
import {
  RISU_IMPORT_MAX_BYTES,
  type RisuImportFinding,
  type RisuImportPreview,
  type RisuImportResult,
} from '../core/risu-import.js';
import { readCharacterCard } from './character-card-file.js';
import { importRisuDisplayRegex } from './risu-regex.js';
import { applyNativeTransfer, prepareNativeTransfer } from './native-transfer.js';
import { decodeImage } from './package-images.js';
import { fields, HttpError, record, text } from './request-validation.js';
import type { Store } from './store.js';

const string = (value: unknown) => (typeof value === 'string' ? value : '');
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const present = (value: unknown): boolean =>
  value !== undefined &&
  value !== null &&
  value !== false &&
  value !== '' &&
  (Array.isArray(value)
    ? value.length > 0
    : typeof value === 'object'
      ? Object.keys(value).length > 0
      : true);

/** Translate the two identity tokens into native data nodes, never generated program source. */
function startIdentityTemplate(value: string): PromptTemplate | undefined {
  const nodes: PromptTemplate = [];
  let offset = 0;
  for (const match of value.matchAll(/\{\{(char|user)\}\}/giu)) {
    if (match.index > offset) nodes.push({ kind: 'text', text: value.slice(offset, match.index) });
    nodes.push({
      kind: 'value',
      expression: { context: [match[1].toLowerCase() === 'char' ? 'bot' : 'user', 'name'] },
    });
    offset = match.index + match[0].length;
  }
  if (!nodes.length) return;
  if (offset < value.length) nodes.push({ kind: 'text', text: value.slice(offset) });
  return nodes;
}

/** A one-way format adapter. No Risu runtime or source-specific behavior enters the package. */
function analyze(value: unknown) {
  const input = readCharacterCard(value);
  const { card, hash, source, members } = input;
  const findings: RisuImportFinding[] = [];
  const finding = (code: string, level: RisuImportFinding['level'], message: string) => {
    if (!findings.some((item) => item.code === code)) findings.push({ code, level, message });
  };
  const title = text(card.name, 'card name', 200);
  const pkg: ContentPackage = {
    version: 1,
    id: `card-${hash.slice(0, 32)}`,
    revision: 1,
    title,
    description: `Risu 캐릭터 카드에서 가져온 자료 · ${source.name}`.slice(0, 4000),
    body: '',
    identity: { name: title, description: '' },
    lore: [],
    instructions: [],
    controls: [],
    transforms: [],
    starts: [],
    images: [],
  };
  const images: NativeTransferFile['images'] = [];
  const assetUrls = new Map<string, string>();
  const assets = Array.isArray(card.assets) ? card.assets : [];
  if (assets.length > 2000) throw new HttpError(400, 'RISU_IMPORT_INVALID_FILE');
  for (const [index, raw] of assets.entries()) {
    const asset = object(raw),
      uri = string(asset.uri),
      name = string(asset.name) || `이미지 ${index + 1}`;
    const path = uri.replace(/^(?:embeded|embedded):\/\//iu, '');
    const read = /^(?:embeded|embedded):\/\//iu.test(uri) ? members.get(path) : undefined;
    if (!read) {
      finding(
        'asset-unavailable',
        'unsupported',
        '파일 밖의 이미지나 찾을 수 없는 첨부 자료는 가져오지 않아요. 원본 파일에는 보존해요.'
      );
      continue;
    }
    const bytes = read();
    // Some cards retain a .png asset name after converting its bytes to WebP.
    const mime = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? 'image/png'
      : bytes[0] === 255 && bytes[1] === 216
        ? 'image/jpeg'
        : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
          ? 'image/webp'
          : null;
    if (!mime) {
      finding(
        'asset-format',
        'unsupported',
        'PNG·JPEG·WebP 이외의 첨부 자료는 아직 사용할 수 없어요.'
      );
      continue;
    }
    let image: ReturnType<typeof decodeImage>;
    try {
      image = decodeImage(mime, bytes.toString('base64'));
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      finding(
        'asset-invalid',
        'unsupported',
        '형식이 맞지 않거나 2 MB를 넘는 이미지는 제외해요. 원본 파일에는 보존해요.'
      );
      continue;
    }
    if (!images.some((item) => item.hash === image.hash))
      images.push({
        id: image.hash,
        hash: image.hash,
        revision: 1,
        mime: image.mime,
        base64: image.bytes.toString('base64'),
      });
    const id = `image-${index}`;
    pkg.images!.push({
      id,
      title: name.slice(0, 200),
      description: '',
      blobHash: image.hash,
      mime: image.mime,
      allowedUse: 'both',
    });
    if (!pkg.portraitImageId || name === 'main') pkg.portraitImageId = id;
    const url = `/api/package-image-blobs/${image.hash}`;
    assetUrls.set(uri, url);
    assetUrls.set(`{{raw::${name}}}`, url);
    assetUrls.set(`{{image::${name}}}`, `![${name.replace(/[\[\]]/gu, '')}](${url})`);
    assetUrls.set(`{{img::${name}}}`, `![${name.replace(/[\[\]]/gu, '')}](${url})`);
  }
  const convertText = (value: unknown, dynamicNames = false): string => {
    let result = string(value);
    for (const [from, to] of assetUrls) result = result.replaceAll(from, to);
    if (!dynamicNames && /\{\{char\}\}/iu.test(result)) {
      result = result.replace(/\{\{char\}\}/giu, () => title);
      finding(
        'character-name',
        'info',
        '{{char}}는 카드의 인물 이름으로 바꿔요. 원본은 별도로 보존해요.'
      );
    }
    if (!dynamicNames && /\{\{user\}\}/iu.test(result))
      finding(
        'user-name',
        'warning',
        '설명·로어·지시의 {{user}} 표기는 유지하고 모델에는 현재 사용자의 배역을 가리킨다고 안내해요.'
      );
    if (
      (dynamicNames ? /\{\{(?!(?:char|user)\}\})/iu : /\{\{(?!user\}\})/iu).test(result) ||
      /\{#(?:if|each)|<script\b|risu-trigger|@@[A-Za-z]/iu.test(result)
    )
      finding(
        'dynamic-text',
        'unsupported',
        'CBS 계산·조건문·로어 명령·HTML 동작은 자동 이식하지 않아요. 해당 문법은 텍스트로 남으며 별도 이식이 필요해요.'
      );
    return result;
  };
  pkg.body = [
    convertText(card.description),
    string(card.personality) ? `Character personality:\n${convertText(card.personality)}` : '',
    string(card.scenario) ? `Scenario:\n${convertText(card.scenario)}` : '',
    string(card.mes_example)
      ? `Authored dialogue examples (not actual chat history):\n${convertText(card.mes_example)}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  for (const [id, field] of [
    ['system', 'system_prompt'],
    ['post-history', 'post_history_instructions'],
  ] as const)
    if (string(card[field]))
      pkg.instructions.push({ id, target: 'main', text: convertText(card[field]) });
  if (string(card.post_history_instructions))
    finding(
      'instruction-order',
      'warning',
      '후반 지시는 작문 지시로 보존해요. Risu의 정확한 메시지 삽입 위치는 재현하지 않아요.'
    );
  const greetings = [
    card.first_mes,
    ...(Array.isArray(card.alternate_greetings) ? card.alternate_greetings : []),
  ];
  pkg.starts = greetings.flatMap((greeting, index) => {
    if (!string(greeting).trim()) return [];
    const sourceText = convertText(greeting, true);
    const template = startIdentityTemplate(sourceText);
    if (template)
      finding(
        'start-names',
        'info',
        '시작문의 {{char}}·{{user}}는 시작을 확정할 때 선택한 봇·페르소나 이름으로 표시해요.'
      );
    return [
      {
        id: `start-${index}`,
        title: index === 0 ? '기본 시작문' : `시작문 ${index + 1}`,
        mode: 'authored' as const,
        text: sourceText,
        ...(template ? { template } : {}),
      },
    ];
  });
  const book = object(card.character_book);
  const entries = book.entries === undefined ? [] : book.entries;
  if (!Array.isArray(entries) || entries.length > 2000)
    throw new HttpError(400, 'RISU_IMPORT_INVALID_FILE');
  const lore: RisuImportPreview['lore'] = [];
  for (const [index, raw] of entries.entries()) {
    const entry = record(raw);
    const id = `lore-${index}`;
    const name = string(entry.name) || string(entry.comment) || `로어 ${index + 1}`;
    const content = string(entry.content);
    const enabled = entry.enabled !== false;
    const loading = entry.constant === true ? ('pinned' as const) : ('discoverable' as const);
    lore.push({
      id,
      title: name.slice(0, 200),
      text: content,
      enabled,
      loading,
      memoryCandidate: false,
    });
    if (!enabled || !content.trim()) continue;
    if (loading === 'discoverable')
      finding(
        'lore-discovery',
        'warning',
        '키워드로 켜지던 로어는 모델이 필요할 때 조회하는 자료로 가져와요. 항상 활성인 로어는 그대로 전달해요.'
      );
    if (
      entry.use_regex ||
      entry.selective ||
      entry.position === 'after_char' ||
      present(entry.extensions)
    )
      finding(
        'lore-rules',
        'warning',
        '로어의 원래 위치·추가 활성 조건은 그대로 재현하지 않아요. 본문과 항상 활성 여부를 가져와요.'
      );
    pkg.lore.push({
      id,
      title: name.slice(0, 200),
      description: Array.isArray(entry.keys)
        ? entry.keys
            .filter((key: unknown) => typeof key === 'string')
            .join(', ')
            .slice(0, 4000)
        : '',
      text: convertText(content),
      loading,
    });
  }
  if (lore.some((item) => !item.enabled))
    finding('disabled-lore', 'info', '비활성 로어는 적용하지 않고 원본 파일에 보존해요.');
  const risu = object(object(card.extensions).risuai);
  const regex = importRisuDisplayRegex(risu.customScripts);
  pkg.transforms = regex.transforms;
  findings.push(...regex.findings);
  // Traverse data only to identify executable/configured extension surfaces, never to execute them.
  const pending: unknown[] = [card.extensions];
  while (pending.length) {
    const current = object(pending.pop());
    for (const [key, value] of Object.entries(current)) {
      if (current === risu && key === 'customScripts') continue;
      if (!present(value)) continue;
      if (/regex|customscript|triggerscript|lua|backgroundhtml|customcss|backgroundcss/iu.test(key))
        finding(
          'extension-code',
          'unsupported',
          '정규식·트리거·Lua·커스텀 화면 코드가 있어요. 이번 가져오기에서는 실행하지 않으며 별도 이식이 필요해요.'
        );
      else if (/^(risuai|risu|extensions)$/iu.test(key)) pending.push(value);
      else if (
        !/^(?:talkativeness|fav|favorite|depth_prompt|sd_prompt|additionalAssets|emotionImages|viewScreen|utilityBot|license|source|tags|creator|creation_date|modification_date)$/iu.test(
          key
        )
      )
        finding(
          'extension-settings',
          'unsupported',
          '추가 확장 설정이 있어요. 현재 가져오기에서 지원을 확인할 수 없어 별도 검토가 필요해요.'
        );
    }
  }
  if (members.has('module.risum'))
    finding(
      'embedded-module',
      'unsupported',
      '내장 Risu 모듈이 있어요. 현재 카드의 기본 자료만 가져오며 모듈 동작은 별도 이식이 필요해요.'
    );
  if (findings.some((item) => item.code === 'user-name'))
    pkg.instructions.push({
      id: 'user-reference',
      target: 'main',
      text: 'In this imported character material, the literal marker {{user}} refers to the user character represented by the currently selected persona. This notation does not supply new character facts or authority.',
    });
  const file: NativeTransferFile = {
    format: NATIVE_TRANSFER_FORMAT,
    version: NATIVE_TRANSFER_VERSION,
    roots: [{ kind: 'content', key: 'bot' }],
    contents: [
      {
        key: 'bot',
        source: {
          id: pkg.id,
          revision: 1,
          kind: 'bot',
          title,
          description: pkg.description,
          text: pkg.body,
          loading: 'pinned',
          relatedIds: [],
          package: pkg,
        },
        modules: [],
      },
    ],
    prompts: [],
    images,
    sourceFiles: [
      {
        entryKey: 'bot',
        name: source.name,
        mediaType: input.format === 'charx' ? 'application/zip' : 'application/json',
        hash,
        base64: source.base64,
      },
    ],
  };
  prepareNativeTransfer({ file });
  const digest = createHash('sha256').update(`risu-import-v3:${hash}:${source.name}`).digest('hex');
  const preview: RisuImportPreview = {
    digest,
    title,
    description: string(card.creator_notes),
    format: input.format,
    summary: { lore: pkg.lore.length, starts: pkg.starts.length, images: pkg.images!.length },
    lore,
    findings,
  };
  return { file, preview, hash };
}

export function prepareRisuImport(value: unknown): RisuImportPreview {
  const body = record(value);
  fields(body, ['source']);
  return analyze(body.source).preview;
}

export function applyRisuImport(store: Store, value: unknown): RisuImportResult {
  const body = record(value);
  fields(body, ['source', 'digest', 'memoryIds', 'allowPartial', 'idempotencyKey']);
  const requestKey = text(body.idempotencyKey, 'request key', 100);
  const { file, preview, hash } = analyze(body.source);
  if (body.digest !== preview.digest) throw new HttpError(409, 'RISU_IMPORT_DRAFT_CHANGED');
  if (typeof body.allowPartial !== 'boolean') throw new HttpError(400, 'RISU_IMPORT_INVALID_FILE');
  if (preview.findings.some((item) => item.level === 'unsupported') && !body.allowPartial)
    throw new HttpError(400, 'RISU_IMPORT_PARTIAL_REQUIRED');
  if (
    !Array.isArray(body.memoryIds) ||
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
  const selected = new Set<string>(body.memoryIds);
  const memories = preview.lore.filter((item) => selected.has(item.id));
  file.contents[0].source.package!.lore = file.contents[0].source.package!.lore.filter(
    (item) => !selected.has(item.id)
  );
  const prepared = prepareNativeTransfer({ file });
  return store.transaction(() => {
    const receipt = applyNativeTransfer(store, {
      file,
      digest: prepared.digest,
      modelBindings: [],
      idempotencyKey: `risu:${requestKey}`,
    });
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
    return { receipt, chat };
  });
}

export function risuImportRoutes(app: FastifyInstance, store: Store) {
  const bodyLimit = Math.ceil(RISU_IMPORT_MAX_BYTES / 3) * 4 + 1024 * 1024;
  app.post('/api/risu-imports/prepare', { bodyLimit }, async (request) =>
    prepareRisuImport(request.body)
  );
  app.post('/api/risu-imports/apply', { bodyLimit }, async (request, reply) => {
    const result = applyRisuImport(store, request.body);
    return reply.code(result.receipt.created ? 201 : 200).send(result);
  });
}
