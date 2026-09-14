import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ContentPackage } from '../core/content-package.js';
import type { PromptTemplate } from '../core/prompt-program.js';
import { validatePackageIdentityTemplate } from '../core/package-identity.js';
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
  type RisuImportKind,
} from '../core/risu-import.js';
import { readCharacterCard } from './character-card-file.js';
import { importRisuDisplayRegex } from './risu-regex.js';
import { RisuCbs } from './risu-cbs.js';
import { importRisuVariableDefaults } from './risu-variable-defaults.js';
import { adaptRisuLuaTriggers } from './risu-lua-adapter.js';
import { applyNativeTransfer, prepareNativeTransfer } from './native-transfer.js';
import { decodeImage } from './package-images.js';
import { deleteUpload, readUpload } from './uploads.js';
import {
  parseRisuLoreContent,
  risuLoreAlwaysActivates,
  risuLoreNeverActivates,
} from './risu-lore-decorators.js';
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

/** A one-way format adapter. No Risu runtime or source-specific behavior enters the package. */
function analyze(
  value: unknown,
  requestedKind?: RisuImportKind,
  readStaged?: (uploadId: string) => Buffer
) {
  const input = readCharacterCard(value, requestedKind, readStaged);
  const { card, hash, source, members, kind } = input;
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
    description:
      kind === 'module'
        ? string(card.creator_notes).slice(0, 4000)
        : `Risu 캐릭터 카드에서 가져온 자료 · ${source.name}`.slice(0, 4000),
    body: '',
    ...(kind === 'bot' ? { identity: { name: title, description: '' } } : {}),
    lore: [],
    instructions: [],
    controls: [],
    transforms: [],
    starts: [],
    images: [],
  };
  if (source.base64 === undefined)
    finding(
      'source-file-not-retained',
      'warning',
      `원본 파일이 ${Math.ceil(RISU_IMPORT_MAX_BYTES / 1024 / 1024)} MiB를 넘어 앱에 사본을 보관하지 않아요. 가져온 자료만 저장하므로 원본 파일은 직접 보관해 주세요. 확인용 지문은 ${source.name} · SHA-256 ${hash}예요.`
    );
  const risu = object(object(card.extensions).risuai);
  try {
    const values = importRisuVariableDefaults(risu.defaultVariables);
    if (values !== undefined) {
      pkg.variableDefaults = { values, attachmentRoles: ['bot'] };
      finding(
        'variable-defaults',
        'warning',
        '기본 변수를 공통 템플릿의 읽기 기본값으로 가져와요. 이 자료를 봇으로 선택하면 프리셋보다 우선하며, 모듈·페르소나로 장착할 때는 이 기본값을 적용하지 않아요. 행동의 공유 변수 쓰기는 해당 채팅에서 허용해야 하며 코드 지원 범위는 별도로 안내해요.'
      );
    }
  } catch {
    finding(
      'variable-defaults-invalid',
      'unsupported',
      '기본 변수의 형식·이름·크기가 지원 범위를 벗어나 자동 적용하지 않아요. 원본 파일에 보존해요.'
    );
  }
  const cbs = new RisuCbs(new Map(), { names: 'context' });
  const importedTemplate = (value: string): PromptTemplate | undefined => {
    if (!value.includes('{{')) return;
    try {
      const template = validatePackageIdentityTemplate(cbs.template(value), [], () => {
        throw new Error('Unsupported imported context');
      });
      if (/\{\{(?!(?:char|user)\}\})/iu.test(value))
        finding(
          'template-cbs',
          'warning',
          '지원하는 CBS 읽기·계산·조건을 공통 템플릿으로 가져와요. 채팅의 공유 변수·자료 기본값·선택한 이름을 읽으며 템플릿 평가 자체는 변수를 쓰거나 코드를 실행하지 않아요. 원래 문법과 기본값은 자료에 보존해요.'
        );
      return template;
    } catch {
      finding(
        'dynamic-text',
        'unsupported',
        '지원하지 않는 CBS 또는 한도를 넘는 템플릿이 있어요. 해당 항목은 이름 치환만 적용하고 나머지 문법을 텍스트로 보존하며 별도 이식이 필요해요.'
      );
      return cbs.namesOnly(value);
    }
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
    if ((kind === 'bot' || asset.type === 'icon') && (!pkg.portraitImageId || name === 'main'))
      pkg.portraitImageId = id;
    const url = `/api/package-image-blobs/${image.hash}`;
    assetUrls.set(uri, url);
    assetUrls.set(`{{raw::${name}}}`, url);
    assetUrls.set(`{{image::${name}}}`, `![${name.replace(/[\[\]]/gu, '')}](${url})`);
    assetUrls.set(`{{img::${name}}}`, `![${name.replace(/[\[\]]/gu, '')}](${url})`);
  }
  const convertText = (value: unknown): string => {
    let result = string(value);
    for (const [from, to] of assetUrls) result = result.replaceAll(from, to);
    if (/\{\{(?:char|user)\}\}/iu.test(result)) {
      finding(
        'identity-names',
        'info',
        '{{char}}·{{user}}는 공통 템플릿으로 가져와 선택한 봇·페르소나 이름을 적용해요. 원래 표기도 보존해요.'
      );
    }
    if (/\{#(?:if|each)|<script\b|risu-trigger|@@[A-Za-z]/iu.test(result))
      finding(
        'dynamic-markup',
        'unsupported',
        '로어 명령·HTML 동작은 자동 이식하지 않아요. 해당 문법은 텍스트로 남으며 별도 이식이 필요해요.'
      );
    return result;
  };
  pkg.body = [
    convertText(card.description),
    string(card.mes_example)
      ? `Authored dialogue examples (not actual chat history):\n${convertText(card.mes_example)}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  const bodyTemplate = importedTemplate(pkg.body);
  if (bodyTemplate) pkg.bodyTemplate = bodyTemplate;
  if (string(card.personality) || string(card.scenario))
    finding(
      'legacy-character-fields',
      'info',
      '성격·시나리오 필드는 가져오기 대상에서 제외하며 원본 파일에 보존해요. 봇 설명이나 모델 입력에 합치지 않아요.'
    );
  if (string(card.system_prompt))
    finding(
      'main-prompt-override',
      'info',
      '낡은 메인 프롬프트 덮어쓰기 기능은 지원하지 않아요. 이 항목은 원본 파일에만 보존하며 선택한 작문 프롬프트를 유지해요.'
    );
  if (string(card.post_history_instructions)) {
    // The selected Uimori prompt already supplies its own instructions. A reference to the
    // replaced Risu note has no separate insertion target and must not duplicate that prompt.
    const text = convertText(string(card.post_history_instructions).replaceAll('{{original}}', ''));
    if (text.trim()) {
      const template = importedTemplate(text);
      pkg.instructions.push({
        id: 'writing-guidance',
        target: 'main',
        text,
        ...(template ? { template } : {}),
      });
    }
    finding(
      'global-note-as-guidance',
      'info',
      '글로벌 노트는 봇의 추가 작문 지침으로 가져와요. 기존 프롬프트나 전역 설정을 덮어쓰지 않으며, {{original}} 참조는 중복 삽입하지 않아요. 원래 내용과 삽입 위치는 원본 파일에 보존해요.'
    );
  }
  const greetings = [
    card.first_mes,
    ...(Array.isArray(card.alternate_greetings) ? card.alternate_greetings : []),
  ];
  pkg.starts = greetings.flatMap((greeting, index) => {
    if (!string(greeting).trim()) return [];
    const sourceText = convertText(greeting);
    const template = importedTemplate(sourceText);
    if (template && /\{\{(?:char|user)\}\}/iu.test(sourceText))
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
    const parsed = parseRisuLoreContent(string(entry.content));
    const content = parsed.text;
    // Risu never sends an entry it never activates; that content belongs to the material's own use.
    const executable = risuLoreNeverActivates(parsed);
    const enabled = entry.enabled !== false && !executable;
    const loading =
      entry.constant === true || risuLoreAlwaysActivates(parsed)
        ? ('pinned' as const)
        : ('discoverable' as const);
    lore.push({
      id,
      title: name.slice(0, 200),
      text: content,
      enabled,
      loading,
      memoryCandidate: false,
    });
    if (executable)
      finding(
        'lore-not-activated',
        'warning',
        '활성화하지 않는 로어는 모델에 보내지 않아요. 자료가 스스로 쓰는 자료·코드로 보고 원본 파일에만 보존해요.'
      );
    if (parsed.decorators.some((item) => !['dont_activate', 'activate'].includes(item.name)))
      finding(
        'lore-decorators',
        'warning',
        '로어의 `@@` 지시문 중 활성 여부 외의 위치·깊이·확률 규칙은 그대로 재현하지 않고 본문에서 제거해요.'
      );
    if (parsed.trailing)
      finding(
        'lore-decorator-position',
        'unsupported',
        '본문 중간의 `@@` 지시문은 해석하지 않고 그대로 남겨요. 원래 규칙과 다르게 동작할 수 있어요.'
      );
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
    const loreText = convertText(content),
      template = importedTemplate(loreText);
    pkg.lore.push({
      id,
      title: name.slice(0, 200),
      description: Array.isArray(entry.keys)
        ? entry.keys
            .filter((key: unknown) => typeof key === 'string')
            .join(', ')
            .slice(0, 4000)
        : '',
      text: loreText,
      ...(template ? { template } : {}),
      loading,
      ...(Number.isSafeInteger(entry.insertion_order) &&
      Math.abs(entry.insertion_order) <= 1_000_000
        ? { loreContext: { placement: 'background' as const, order: entry.insertion_order } }
        : {}),
    });
  }
  if (lore.some((item) => !item.enabled))
    finding('disabled-lore', 'info', '비활성 로어는 적용하지 않고 원본 파일에 보존해요.');
  const regex = importRisuDisplayRegex(risu.customScripts);
  pkg.transforms = regex.transforms;
  findings.push(...regex.findings);
  const lua = adaptRisuLuaTriggers(risu.triggerscript, {
    ...(risu.lowLevelAccess === true ? { lowLevelAccess: true } : {}),
  });
  if (lua.actions.length && lua.actions.length <= 100) {
    pkg.behavior = {
      revision: 1,
      schemaVersion: 1,
      stateSchema: { type: 'record', properties: {} },
      initialState: {},
      actions: lua.actions,
      outputParsers: [],
    };
    finding(
      'lua-actions',
      'warning',
      'Lua의 생성 전·응답 후·버튼 콜백을 격리된 행동으로 가져와요. 가져오기 중에는 코드를 실행하지 않아요. 공유 변수 변경과 추가 모델 호출은 채팅에서 각각 허용해야 하며 아직 연결되지 않은 이벤트·API는 아래 안내를 확인해 주세요.'
    );
  } else if (lua.actions.length > 100) {
    finding(
      'lua-actions-limit',
      'unsupported',
      'Lua 행동이 자료의 한도를 넘어 자동 연결하지 않아요. 원본 코드는 파일에 보존해요.'
    );
  }
  for (const issue of lua.findings)
    finding(
      `${issue.code}:${issue.triggerIndex}:${issue.effectIndex ?? 0}:${issue.event ?? ''}`,
      issue.code === 'RISU_LUA_FRESH_INVOCATION' ? 'warning' : 'unsupported',
      `트리거 ${issue.triggerIndex + 1}${issue.event ? ` · ${issue.event}` : ''}: ${issue.message}`
    );
  const unhandledTriggers = Array.isArray(risu.triggerscript)
    ? risu.triggerscript.some((raw) => {
        const effects = object(raw).effect;
        return (
          !Array.isArray(effects) || effects.some((effect) => object(effect).type !== 'triggerlua')
        );
      })
    : present(risu.triggerscript);
  if (unhandledTriggers)
    finding(
      'trigger-effects-unsupported',
      'unsupported',
      'Lua 외의 트리거 효과나 해석하지 못한 트리거가 있어요. 실행 순서를 임의로 바꾸지 않고 원본 파일에 보존해요.'
    );
  // Traverse data only to identify executable/configured extension surfaces, never to execute them.
  const pending: unknown[] = [card.extensions];
  while (pending.length) {
    const current = object(pending.pop());
    for (const [key, value] of Object.entries(current)) {
      if (current === risu && ['customScripts', 'defaultVariables', 'triggerscript'].includes(key))
        continue;
      if (!present(value)) continue;
      if (/regex|customscript|triggerscript|lua|backgroundhtml|customcss|backgroundcss/iu.test(key))
        finding(
          'extension-code',
          'unsupported',
          '정규식·트리거·Lua·커스텀 화면 코드가 있어요. 이번 가져오기에서는 실행하지 않으며 별도 이식이 필요해요.'
        );
      else if (/^(risuai|risu|extensions)$/iu.test(key)) pending.push(value);
      else if (
        !/^(?:talkativeness|fav|favorite|moduleNoneImage|depth_prompt|sd_prompt|additionalAssets|emotionImages|viewScreen|utilityBot|license|source|tags|creator|creation_date|modification_date)$/iu.test(
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
  if ('embeddedModule' in input && input.embeddedModule) {
    finding(
      'embedded-module',
      'info',
      'CharX 내부 모듈의 로어·정규식·트리거를 이 자료의 내용으로 읽어요. 카드에 중복된 로어를 다시 추가하지 않으며 실행 지원 여부는 각각 안내해요.'
    );
    if (input.embeddedModule.assetCount)
      finding(
        'embedded-module-assets',
        'unsupported',
        '카드 첨부와 별개인 내부 모듈 에셋은 원본에 보존하며 자동 연결하지 않아요.'
      );
  }
  const file: NativeTransferFile = {
    format: NATIVE_TRANSFER_FORMAT,
    version: NATIVE_TRANSFER_VERSION,
    roots: [{ kind: 'content', key: kind }],
    contents: [
      {
        key: kind,
        source: {
          id: pkg.id,
          revision: 1,
          kind,
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
    // A staged container stays outside the receipt; its identity is reported instead of copied.
    ...(source.base64 === undefined
      ? {}
      : {
          sourceFiles: [
            {
              entryKey: kind,
              name: source.name,
              mediaType:
                input.format === 'charx' || input.format === 'risu-module-project-zip'
                  ? 'application/zip'
                  : 'application/json',
              hash,
              base64: source.base64,
            },
          ],
        }),
  };
  const transfer = prepareNativeTransfer({ file });
  const digest = createHash('sha256')
    .update(JSON.stringify({ version: 8, transfer: transfer.digest, kind, findings, lore }))
    .digest('hex');
  const preview: RisuImportPreview = {
    kind,
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
  fields(body, ['source', 'kind', 'digest', 'memoryIds', 'allowPartial', 'idempotencyKey']);
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
    return { receipt, chat };
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
