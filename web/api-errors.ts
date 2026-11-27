import {
  type AppErrorCode,
  appErrorTakesParams,
  isAppErrorCode,
  type ReceivedErrorWire,
} from '#contracts';
import {
  t,
  registerMessage,
  formatMessage,
  getLocale,
  type MessageValues,
  type UiLocale,
} from './i18n.js';
import ko from './locales/ko.js';
import { requestImageErrors } from './request-image-errors.js';
import { requestFileErrors } from './request-file-errors.js';
import { SOURCE_TEXT_MAX_CHARS } from '../core/content-limits.js';
import {
  RISU_IMPORT_MAX_UPLOAD_BYTES,
  RISU_IMPORT_MAX_PREPARED_BYTES,
} from '../core/risu-import.js';

type ApiErrorDiagnostic = { code: string | null; message: string };

const storyUiErrors: Record<string, string> = {
  OUTPUT_STORY_UI_INVALID: 'storyUi.errorTranslation.details',
};

export const appErrorMessages = {
  MAINTENANCE_CLOSED: 'errors.MAINTENANCE_CLOSED',
  STORY_UI_STALE_SOURCE: 'storyUi.errorStaleSource',
  STORY_UI_DISABLED: 'storyUi.errorDisabled',
  STORY_UI_INVALID_ACTION: 'storyUi.errorInvalidAction',
  INPUT_TRANSLATION_LANGUAGE_INVALID: 'errors.INPUT_TRANSLATION_LANGUAGE_INVALID',
  INPUT_TRANSLATION_CANCELLED: 'errors.INPUT_TRANSLATION_CANCELLED',
  INPUT_TRANSLATION_TIMEOUT: 'errors.INPUT_TRANSLATION_TIMEOUT',
  INPUT_TRANSLATION_REFUSED: 'errors.INPUT_TRANSLATION_REFUSED',
  INPUT_TRANSLATION_FAILED: 'errors.INPUT_TRANSLATION_FAILED',
  INPUT_TRANSLATION_TOO_LONG: 'errors.INPUT_TRANSLATION_TOO_LONG',
  SELECTION_REVISION_RANGE_INVALID: 'errors.SELECTION_REVISION_RANGE_INVALID',
  SELECTION_REVISION_STALE: 'errors.SELECTION_REVISION_STALE',
  SELECTION_REVISION_TRANSLATION_STALE: 'errors.SELECTION_REVISION_TRANSLATION_STALE',
  SELECTION_REVISION_TIMEOUT: 'errors.SELECTION_REVISION_TIMEOUT',
  SELECTION_REVISION_CANCELLED: 'errors.SELECTION_REVISION_CANCELLED',
  SELECTION_REVISION_REFUSED: 'errors.SELECTION_REVISION_REFUSED',
  SELECTION_REVISION_FAILED: 'errors.SELECTION_REVISION_FAILED',
  SELECTION_REVISION_TOO_LONG: 'errors.SELECTION_REVISION_TOO_LONG',
  REVISION_CONFLICT: 'errors.revisionConflict',
  CHAT_DEFAULT_PERSONA_DELETED: 'errors.CHAT_DEFAULT_PERSONA_DELETED',
  BOT_DEFAULT_PERSONA_REQUIRED: 'errors.BOT_DEFAULT_PERSONA_REQUIRED',
  CHAT_DELETE_HELPER_ACTIVE: 'errors.CHAT_DELETE_HELPER_ACTIVE',
  CHAT_DELETE_WORK_ACTIVE: 'errors.CHAT_DELETE_WORK_ACTIVE',
  CHAT_DELETE_PROVIDER_ACTIVE: 'errors.CHAT_DELETE_PROVIDER_ACTIVE',
  CHAT_COPY_REMOVED: 'errors.CHAT_COPY_REMOVED',
  CHAT_COPY_RECEIPT_UNVERIFIED: 'errors.CHAT_COPY_RECEIPT_UNVERIFIED',
  CHAT_BACKUP_INVALID: 'errors.CHAT_BACKUP_INVALID',
  CHAT_TRANSCRIPT_BOT_REQUIRED: 'errors.CHAT_TRANSCRIPT_BOT_REQUIRED',
  CHAT_OPTIONS_CHANGED: 'errors.CHAT_OPTIONS_CHANGED',
  CHAT_OPTIONS_PENDING_STALE: 'errors.CHAT_OPTIONS_PENDING_STALE',
  CHAT_OPTIONS_EMPTY: 'errors.CHAT_OPTIONS_EMPTY',
  SCENE_CONTEXT_RUN_ACTIVE: 'errors.SCENE_CONTEXT_RUN_ACTIVE',
  SCENE_DELETE_NOT_FOUND: 'errors.SCENE_DELETE_NOT_FOUND',
  SCENE_DELETE_REFERENCED: 'errors.SCENE_DELETE_REFERENCED',
  SCENE_DELETED_RETRY_UNAVAILABLE: 'errors.SCENE_DELETED_RETRY_UNAVAILABLE',
  READING_SCENE_NOT_FOUND: 'errors.READING_SCENE_NOT_FOUND',
  BOOKMARK_NOT_FOUND: 'errors.BOOKMARK_NOT_FOUND',
  RUN_RETRY_AUTHORED_FIRST_MESSAGE: 'errors.RUN_RETRY_AUTHORED_FIRST_MESSAGE',
  RUN_RETRY_REPLACE_LATEST_ONLY: 'errors.RUN_RETRY_REPLACE_LATEST_ONLY',
  RUN_RETRY_STORY_ADVANCED: 'errors.RUN_RETRY_STORY_ADVANCED',
  RUN_REJUDGE_UNAVAILABLE: 'errors.RUN_REJUDGE_UNAVAILABLE',
  PROMPT_PRESET_ROLE_IN_USE: 'errors.PROMPT_PRESET_ROLE_IN_USE',
  PROMPT_COMBINATION_MISMATCH: 'errors.PROMPT_COMBINATION_MISMATCH',
  PROMPT_COLLABORATION_MODEL_REQUIRED: 'errors.PROMPT_COLLABORATION_MODEL_REQUIRED',
  PINNED_PROMPT_UNAVAILABLE: 'errors.PINNED_PROMPT_UNAVAILABLE',
  PINNED_PROMPT_NOT_MAIN: 'errors.PINNED_PROMPT_NOT_MAIN',
  RESOURCE_CREATION_REMOVED: 'errors.RESOURCE_CREATION_REMOVED',
  RESOURCE_UNDO_UNAVAILABLE: 'errors.RESOURCE_UNDO_UNAVAILABLE',
  RESOURCE_BUNDLE_MODULE_CYCLE: 'errors.RESOURCE_BUNDLE_MODULE_CYCLE',
  NATIVE_TRANSFER_DRAFT_CHANGED: 'errors.NATIVE_TRANSFER_DRAFT_CHANGED',
  BACKUP_LIST_UNAVAILABLE: 'errors.BACKUP_LIST_UNAVAILABLE',
  BACKUP_UNAVAILABLE: 'errors.BACKUP_UNAVAILABLE',
  BACKUP_RUNNING: 'errors.BACKUP_RUNNING',
  NATIVE_TRANSFER_FORMAT: 'errors.NATIVE_TRANSFER_FORMAT',
  NATIVE_TRANSFER_MODULE_BINDINGS: 'errors.NATIVE_TRANSFER_MODULE_BINDINGS',
  NATIVE_TRANSFER_FILE_INVALID: 'errors.NATIVE_TRANSFER_FILE_INVALID',
  NATIVE_TRANSFER_EXPORT_TOO_LARGE: 'errors.NATIVE_TRANSFER_EXPORT_TOO_LARGE',
  NATIVE_TRANSFER_IMPORT_TOO_LARGE: 'errors.NATIVE_TRANSFER_IMPORT_TOO_LARGE',
  NATIVE_TRANSFER_EXPIRED: 'errors.NATIVE_TRANSFER_EXPIRED',
  PUSH_TEST_RATE_LIMITED: 'errors.PUSH_TEST_RATE_LIMITED',
  PUSH_ENDPOINT_UNSUPPORTED: 'errors.PUSH_ENDPOINT_UNSUPPORTED',
  IMAGE_TOO_LARGE: 'errors.IMAGE_TOO_LARGE',
  IMAGE_DIMENSIONS_TOO_LARGE: 'errors.IMAGE_DIMENSIONS_TOO_LARGE',
  IMAGE_FORMAT_UNSUPPORTED: 'errors.IMAGE_FORMAT_UNSUPPORTED',
  IMAGE_INVALID: 'errors.IMAGE_INVALID',
  IMAGE_NOT_FOUND: 'errors.IMAGE_NOT_FOUND',
  IMAGE_SELECTION_ROLE_REQUIRED: 'errors.IMAGE_SELECTION_ROLE_REQUIRED',
  REQUEST_IMAGE_COUNT_INVALID: 'errors.REQUEST_IMAGE_COUNT_INVALID',
  REQUEST_IMAGE_UPLOAD_INVALID: 'errors.REQUEST_IMAGE_UPLOAD_INVALID',
  REQUEST_IMAGE_CHANGED: 'errors.REQUEST_IMAGE_CHANGED',
  REQUEST_IMAGE_ANIMATED: 'errors.REQUEST_IMAGE_ANIMATED',
  REQUEST_IMAGE_FORMAT_INVALID: 'errors.REQUEST_IMAGE_FORMAT_INVALID',
  REQUEST_IMAGE_DIMENSIONS_INVALID: 'errors.REQUEST_IMAGE_DIMENSIONS_INVALID',
  REQUEST_IMAGE_TOO_LARGE: 'errors.REQUEST_IMAGE_TOO_LARGE',
  REQUEST_IMAGE_INVALID: 'errors.REQUEST_IMAGE_INVALID',
  REQUEST_IMAGE_MISSING: 'errors.REQUEST_IMAGE_MISSING',
  LIBRARY_PROMPT_IN_USE: 'errors.LIBRARY_PROMPT_IN_USE',
  SEARCH_CURSOR_STALE: 'errors.SEARCH_CURSOR_STALE',
  SEARCH_INTERRUPTED: 'errors.SEARCH_INTERRUPTED',
  SEARCH_BUSY: 'errors.SEARCH_BUSY',
  SEARCH_TIMEOUT: 'errors.SEARCH_TIMEOUT',
  SEARCH_FAILED: 'errors.SEARCH_FAILED',
  MANUSCRIPT_RANGE_CHANGED: 'errors.MANUSCRIPT_RANGE_CHANGED',
  MANUSCRIPT_EMPTY: 'errors.MANUSCRIPT_EMPTY',
  MANUSCRIPT_RANGE_INVALID: 'errors.MANUSCRIPT_RANGE_INVALID',
  FONT_NOT_FOUND: 'errors.FONT_NOT_FOUND',
  FONT_TOO_LARGE: 'errors.FONT_TOO_LARGE',
  FONT_INVALID: 'errors.FONT_INVALID',
  FONT_FORMAT_UNSUPPORTED: 'errors.FONT_FORMAT_UNSUPPORTED',
  FONT_STORAGE_FULL: 'errors.FONT_STORAGE_FULL',
  THEME_ASSET_STORAGE_FULL: 'errors.THEME_ASSET_STORAGE_FULL',
  THEME_ASSET_NOT_FOUND: 'errors.THEME_ASSET_NOT_FOUND',
  THEME_ASSET_MISSING: 'errors.THEME_ASSET_MISSING',
  OUTLINE_NODE_NOT_FOUND: 'errors.OUTLINE_NODE_NOT_FOUND',
  OUTLINE_RELATED_TOO_MANY: 'errors.OUTLINE_RELATED_TOO_MANY',
  OUTLINE_HIERARCHY_INVALID: 'errors.OUTLINE_HIERARCHY_INVALID',
  OUTLINE_SELECTION_STALE: 'errors.OUTLINE_SELECTION_STALE',
  OUTLINE_REVIEW_SOURCE_MISSING: 'errors.OUTLINE_REVIEW_SOURCE_MISSING',
  OUTLINE_NODE_WRITING: 'errors.OUTLINE_NODE_WRITING',
  OUTLINE_LEVEL_SCHEDULED: 'errors.OUTLINE_LEVEL_SCHEDULED',
  OUTLINE_NODE_WRITTEN: 'errors.OUTLINE_NODE_WRITTEN',
  OUTLINE_PLAN_CHANGED: 'errors.OUTLINE_PLAN_CHANGED',
  OUTLINE_WRITING_IN_PROGRESS: 'errors.OUTLINE_WRITING_IN_PROGRESS',
  OUTLINE_WRITING_SCHEDULED: 'errors.OUTLINE_WRITING_SCHEDULED',
  OUTLINE_WRITING_CANCELLED: 'errors.OUTLINE_WRITING_CANCELLED',
  MODEL_REQUIRED: 'errors.MODEL_REQUIRED',
  MODEL_UNAVAILABLE: 'errors.MODEL_UNAVAILABLE',
  MANUSCRIPT_TRANSLATION_MISSING: 'errors.MANUSCRIPT_TRANSLATION_MISSING',
  ILLUSTRATION_NOT_FOUND: 'errors.ILLUSTRATION_NOT_FOUND',
  ILLUSTRATION_GENERATOR_UNCONFIGURED: 'visuals.m176',
  ILLUSTRATION_CODEX_CONTENT_BLOCKED: 'visuals.m177',
  ILLUSTRATION_ACTIVE: 'visuals.m178',
  ILLUSTRATION_PLAN_ACTIVE: 'visuals.m179',
  ILLUSTRATION_TARGET_UNAVAILABLE: 'visuals.m182',
  ILLUSTRATION_TARGET_CONFLICT: 'visuals.m183',
  ILLUSTRATION_PRESENTATION_CHANGED: 'visuals.m184',
  ILLUSTRATION_LIMIT_REACHED: 'visuals.m185',
  ILLUSTRATION_MODEL_REQUIRED: 'visuals.m186',
  ILLUSTRATION_MODEL_UNAVAILABLE: 'visuals.m187',
  ILLUSTRATION_CODEX_CONNECTION_REQUIRED: 'visuals.m188',
  ILLUSTRATION_PROMPT_MODEL_REQUIRED: 'visuals.m189',
  ILLUSTRATION_SOURCE_CHANGED: 'visuals.m190',
  ILLUSTRATION_NOT_RETRYABLE: 'visuals.m195',
  ILLUSTRATION_RESERVATION_FAILED: 'visuals.m200',
  ILLUSTRATION_CONNECTION_DISABLED: 'visuals.m205',
  ILLUSTRATION_NOT_RECONCILABLE: 'visuals.m238',
  ILLUSTRATION_REFERENCE_UNAVAILABLE: 'errors.ILLUSTRATION_REFERENCE_UNAVAILABLE',
  ILLUSTRATION_REFERENCES_TOO_MANY: 'errors.ILLUSTRATION_REFERENCES_TOO_MANY',
  COMFYUI_UNCONFIGURED: 'visuals.m223',
  COMFYUI_WORKFLOW_MISSING: 'visuals.m224',
  COMFYUI_WORKFLOW_INVALID: 'visuals.m225',
  COMFYUI_BASE_URL_INVALID: 'visuals.m228',
  COMFYUI_RESULT_UNAVAILABLE: 'visuals.m236',
  NOVELAI_TOKEN_MISSING: 'visuals.novelaiTokenMissing',
  HELPER_CONVERSATION_NOT_FOUND: 'errors.HELPER_CONVERSATION_NOT_FOUND',
  HELPER_PROJECT_NOT_FOUND: 'errors.HELPER_PROJECT_NOT_FOUND',
  HELPER_TASK_NOT_FOUND: 'errors.HELPER_TASK_NOT_FOUND',
  HELPER_REFERENCE_NOT_FOUND: 'errors.HELPER_REFERENCE_NOT_FOUND',
  HELPER_ROLLBACK_UNIT_NOT_FOUND: 'errors.HELPER_ROLLBACK_UNIT_NOT_FOUND',
  HELPER_ARTIFACT_NOT_FOUND: 'errors.HELPER_ARTIFACT_NOT_FOUND',
  HELPER_TASK_ACTIVE: 'errors.HELPER_TASK_ACTIVE',
  HELPER_TASK_NO_LONGER_ACTIVE: 'errors.HELPER_TASK_NO_LONGER_ACTIVE',
  HELPER_EFFECTS_ALREADY_COMMITTED: 'errors.HELPER_EFFECTS_ALREADY_COMMITTED',
  HELPER_RESUME_UNAVAILABLE: 'errors.HELPER_RESUME_UNAVAILABLE',
  HELPER_ALREADY_RETRIED: 'errors.HELPER_ALREADY_RETRIED',
  HELPER_REQUEST_DELETED: 'errors.HELPER_REQUEST_DELETED',
  HELPER_CONFIRMATION_UNAVAILABLE: 'errors.HELPER_CONFIRMATION_UNAVAILABLE',
  HELPER_MODEL_EVALUATION_TOOLS: 'errors.HELPER_MODEL_EVALUATION_TOOLS',
  HELPER_SELECTION_STALE: 'errors.HELPER_SELECTION_STALE',
  HELPER_CONTEXT_DEPENDENCY_CHANGED: 'errors.HELPER_CONTEXT_DEPENDENCY_CHANGED',
  HELPER_COMPACTION_BUSY: 'errors.HELPER_COMPACTION_BUSY',
  HELPER_COMPACTION_CODEX_NATIVE: 'errors.HELPER_COMPACTION_CODEX_NATIVE',
  HELPER_SUMMARY_TOO_LARGE: 'errors.HELPER_SUMMARY_TOO_LARGE',
  HELPER_SUMMARY_EMPTY: 'errors.HELPER_SUMMARY_EMPTY',
} satisfies Record<AppErrorCode, string>;

const MIB = 1024 * 1024;

function sceneList(scenes: unknown, total: unknown, locale: UiLocale): string {
  const numbers = String(scenes).split(',').map(Number);
  const labels = numbers.map((scene) =>
    scene === 0
      ? formatMessage('errors.firstMessage', locale)
      : formatMessage('errors.scene', locale, { scene })
  );
  return `${labels.join(', ')}${typeof total === 'number' && total > numbers.length ? ', …' : ''}`;
}

function messageValues(
  code: AppErrorCode,
  params: ReceivedErrorWire['params'],
  locale: UiLocale
): MessageValues | undefined {
  if (!params) return undefined;
  const values: MessageValues = Object.fromEntries(
    Object.entries(params).map(([name, value]) => [
      name,
      name.endsWith('Bytes') && typeof value === 'number'
        ? `${Math.round((value / MIB) * 10) / 10} MiB`
        : value,
    ])
  );
  if (code === 'MANUSCRIPT_TRANSLATION_MISSING')
    values.scenes = sceneList(params.scenes, params.total, locale);
  return values;
}

function appErrorMessage(wire: ReceivedErrorWire): {
  code: AppErrorCode;
  key: string;
  values: (locale: UiLocale) => MessageValues | undefined;
} | null {
  const code = isAppErrorCode(wire.code)
    ? wire.code
    : isAppErrorCode(wire.error) && !appErrorTakesParams(wire.error)
      ? wire.error
      : null;
  if (!code) return null;
  const params = code === wire.code ? wire.params : undefined;
  return {
    code,
    key: appErrorMessages[code],
    values: (locale) => messageValues(code, params, locale),
  };
}

const messages: Record<string, string> = {
  ...requestImageErrors,
  ...requestFileErrors,
  RISU_NATIVE_TIMEOUT:
    'Risu 표시 스크립트가 제한 시간 안에 끝나지 않았어요. 카드나 모듈의 표시 스크립트를 확인해 주세요.',
  RISU_NATIVE_CBS_TIMEOUT:
    'Risu 표시 스크립트가 제한 시간 안에 끝나지 않았어요. 카드나 모듈의 표시 스크립트를 확인해 주세요.',
  RISU_LUA_PROGRAM_TIMEOUT:
    'Risu 표시 스크립트가 제한 시간 안에 끝나지 않았어요. 카드나 모듈의 표시 스크립트를 확인해 주세요.',
  STORY_GUIDE_STALE: '참고 설정이나 이야기가 바뀌었어요. 최신 내용으로 다시 집필해 주세요.',
  STORY_GUIDE_CANCELLED: '작품 및 원작 참고가 중단됐어요.',
  STORY_GUIDE_TIMEOUT: '작품 및 원작 참고가 제한 시간 안에 끝나지 않았어요. 다시 시도해 주세요.',
  STORY_GUIDE_FAILED:
    '작품 및 원작 참고를 준비하지 못했어요. 본문 모델과 프로바이더를 확인해 주세요.',
  STORY_GUIDE_REFUSED: '모델이 작품 및 원작 참고 요청을 거절했어요.',
  STORY_GUIDE_CALL_BUDGET_EXHAUSTED: '작품 및 원작 참고에 사용할 모델 호출 횟수가 부족해요.',
  STORY_GUIDE_OUTPUT_TOO_LARGE: '참고 분석이 너무 길어요. 참고 범위를 좁혀 주세요.',
  STORY_GUIDE_READ_CALL_LIMIT:
    '추가 자료를 더 읽어야 해서 분석을 마치지 못했어요. 참고 범위를 좁혀 주세요.',
  STORY_GUIDE_PROVIDER_FAILED:
    '작품 및 원작 참고를 준비하지 못했어요. 본문 모델과 프로바이더를 확인해 주세요.',
  RISU_PRESET_INVALID_FILE:
    '지원하는 Risu 프리셋 파일인지 확인해 주세요. 프로젝트 ZIP에는 preset.json, manifest.json과 분리된 텍스트 파일이 함께 있어야 해요.',
  RISU_PRESET_INVALID: '프리셋의 프롬프트 구성과 옵션 형식을 확인해 주세요.',
  RISU_PRESET_VERSION_UNSUPPORTED:
    '이 프리셋 바이너리 버전은 아직 지원하지 않아요. RisuToki에서 프로젝트로 추출한 ZIP도 가져올 수 있어요.',
  RISU_IMPORT_INVALID_FILE:
    'v3 CHARX, JPEG, PNG, JSON 또는 Risu 모듈 파일인지, 파일 구조와 처리 한도가 맞는지 확인해 주세요.',
  RISU_IMPORT_TOO_LARGE: `캐릭터 카드 파일은 ${RISU_IMPORT_MAX_UPLOAD_BYTES / 1024 / 1024} MiB 이하여야 해요.`,
  RISU_IMPORT_IMAGES_TOO_LARGE: `저장할 이미지 합계가 ${RISU_IMPORT_MAX_PREPARED_BYTES / 1024 / 1024} MiB를 넘어요. 첨부 이미지를 줄인 파일을 선택해 주세요.`,
  PACKAGE_START_CONVERSATION_STARTED:
    '대화가 진행됐거나 원래 봇의 첫 메시지를 사용할 수 없어 바꾸지 못했어요. 선택 창을 닫고 현재 대화를 확인해 주세요.',
  PACKAGE_START_OWNER_CHANGED: '채팅의 봇 설정이 바뀌었어요. 선택 창을 닫고 다시 열어 주세요.',
  PACKAGE_START_TEXT_TOO_LONG: `첫 메시지 하나가 ${SOURCE_TEXT_MAX_CHARS.toLocaleString('en-US')}자 저장 상한을 넘었어요. 기본 첫 메시지와 대체 첫 메시지의 길이를 확인해 주세요.`,
  UPLOAD_TOO_LARGE: `올릴 수 있는 파일은 ${RISU_IMPORT_MAX_UPLOAD_BYTES / 1024 / 1024} MiB 이하예요.`,
  RISU_IMPORT_V3_REQUIRED: 'Character Card v3 파일을 선택해 주세요. v2 카드는 지원하지 않아요.',
  RISU_IMPORT_V2_UNSUPPORTED: 'Character Card v3 파일을 선택해 주세요. v2 카드는 지원하지 않아요.',
  RISU_IMPORT_PREPARED_NOT_FOUND: '검토한 자료가 만료됐어요. 파일을 다시 선택해 주세요.',
  RISU_IMPORT_CANCELLED: '자료 확인을 취소했어요.',
  RISU_IMPORT_BUSY: '다른 자료를 준비하고 있어요. 완료 후 다시 시도해 주세요.',
  UPLOAD_EMPTY: '빈 파일은 올릴 수 없어요. 파일을 다시 선택해 주세요.',
  UPLOAD_NOT_FOUND:
    '올려 둔 파일을 찾을 수 없어요. 검토 시간이 길어져 정리됐을 수 있으니 파일을 다시 선택해 주세요.',
  UPLOAD_CONTENT_TYPE: '파일 업로드 형식이 올바르지 않아요.',
  RISU_IMPORT_KIND:
    '가져올 자료 종류를 확인해 주세요. 모듈 JSON과 프로젝트 ZIP은 모듈로만 가져올 수 있어요.',
  RISU_IMPORT_DRAFT_CHANGED: '확인한 파일이 달라졌어요. 파일을 다시 선택해 주세요.',
  RISU_IMPORT_PARTIAL_REQUIRED:
    '자동 이식할 수 없는 부분을 확인하고 부분 가져오기에 동의해 주세요.',
  CHAT_TRANSCRIPT_UNSUPPORTED_VERSION:
    '이 버전의 본문 파일은 가져올 수 없어요. 파일을 내보낸 앱과 현재 앱의 버전을 확인해 주세요.',
  CHAT_TRANSCRIPT_INVALID_REQUEST:
    '본문 파일의 요청 문장이 허용 길이를 넘었거나 형식이 잘못됐어요.',
  CHAT_TRANSCRIPT_INVALID_TEXT: '본문 파일에 비어 있거나 허용 길이를 넘은 응답이 있어요.',
  CHAT_TRANSCRIPT_INVALID_TRANSLATION: '본문 파일의 번역 형식이나 길이를 확인해 주세요.',
  CONTEXT_FIXED_INPUT_TOO_LARGE:
    '고정된 입력만으로 모델의 컨텍스트 한도를 넘었어요. 프롬프트와 첨부 자료를 줄이거나 입력 한도가 더 큰 모델을 선택해 주세요.',
};
for (const suffix of [
  'INVALID',
  'INVALID_SHAPE',
  'UNKNOWN_FIELD',
  'INVALID_FORMAT',
  'INVALID_TIME',
  'INVALID_TITLE',
  'INVALID_REFERENCE',
  'DUPLICATE_REFERENCE',
  'INVALID_ENTRIES',
  'INVALID_NOTES',
  'INVALID_NOTE_ANCHOR',
])
  messages[`CHAT_TRANSCRIPT_${suffix}`] =
    '본문 파일의 형식이 올바르지 않아요. 파일 내용을 확인해 주세요.';

const settingErrors = new Set([
  'Model disabled',
  'Connection disabled or authority changed',
  'Connection protocol changed; review and save the model settings',
  'Setting not found',
  'CONNECTION_NOT_AUTHORIZED',
  'CREDENTIAL_UNAVAILABLE',
  'ENDPOINT_NOT_APPROVED',
]);
const revisionErrors = new Set([
  'Revision conflict',
  'Profile revision conflict',
  'Folder revision conflict',
  'Organization revision conflict',
  'Model revision conflict',
  'Settings revision conflict',
  'Story settings revision conflict',
  'Source revision conflict',
  'Source hash conflict',
  'Source revision changed',
  'Translation revision conflict',
  'Current prompts changed; refresh before saving',
  'Prompt preset changed; refresh before saving',
  '초안이 변경됐어요. 현재 입력은 유지하고 변경 내용을 확인해 주세요.',
]);
const nativeActionConflict = /^RISU_NATIVE_ACTION_(?:FAILED|CANCELLED|INTERRUPTED|RUNNING)$/u;
const unavailable =
  '선택한 모델 또는 프로바이더를 사용할 수 없어요. 설정 > 역할별 모델과 설정 > 프로바이더와 모델에서 활성 상태, 인증과 지원 모델 설정을 확인해 주세요.';

export function apiErrorDiagnostic(
  wire: ReceivedErrorWire,
  status: number,
  method: string
): ApiErrorDiagnostic {
  const app = appErrorMessage(wire);
  if (app) return { code: app.code, message: formatMessage(app.key, 'ko', app.values('ko')) };
  return legacyErrorDiagnostic(wire.error, status, method);
}

function legacyErrorDiagnostic(error: unknown, status: number, method: string): ApiErrorDiagnostic {
  if (typeof error === 'string') {
    const code = error;
    if (Object.hasOwn(storyUiErrors, code)) return { code, message: ko[storyUiErrors[code]] };
    if (Object.hasOwn(messages, code)) return { code, message: messages[code] };
    if (status === 409 && nativeActionConflict.test(code))
      return {
        code,
        message:
          '현재 상태에서는 이 요청을 완료할 수 없어요. 설정과 작업 상태를 확인해 주세요. (409)',
      };
    if (/^STORY_GUIDE_[A-Z0-9_]{1,100}$/.test(code))
      return { code, message: messages.STORY_GUIDE_FAILED };
    if (settingErrors.has(code)) return { code: 'MODEL_UNAVAILABLE', message: unavailable };
    if (status === 409 && revisionErrors.has(code))
      return {
        code: 'REVISION_CONFLICT',
        message: formatMessage('errors.revisionConflict', 'ko'),
      };
    if (status === 409 && method === 'DELETE' && error.length <= 4000)
      return { code: null, message: error };
  }
  const message =
    status >= 500
      ? '서버 작업을 완료하지 못했어요.'
      : status === 409
        ? '현재 상태에서는 이 요청을 완료할 수 없어요. 설정과 작업 상태를 확인해 주세요.'
        : '요청을 처리할 수 없어요.';
  return { code: null, message: `${message} (${status})` };
}

export function apiErrorDisplay(wire: ReceivedErrorWire, status: number, method: string): string {
  const app = appErrorMessage(wire);
  if (app) {
    const render = () => t(app.key, app.values(getLocale()));
    registerMessage(formatMessage(app.key, 'ko', app.values('ko')), render);
    return render();
  }
  const error = wire.error;
  const diagnostic = legacyErrorDiagnostic(error, status, method);
  const code = diagnostic.code;
  const display = (key: string, values?: Record<string, string | number>) => {
    registerMessage(diagnostic.message, key, values);
    return t(key, values);
  };
  if (code && Object.hasOwn(storyUiErrors, code)) return display(storyUiErrors[code]);
  const limits: Record<string, number> = {
    PACKAGE_START_TEXT_TOO_LONG: SOURCE_TEXT_MAX_CHARS,
    RISU_IMPORT_TOO_LARGE: RISU_IMPORT_MAX_UPLOAD_BYTES / 1024 / 1024,
    UPLOAD_TOO_LARGE: RISU_IMPORT_MAX_UPLOAD_BYTES / 1024 / 1024,
    RISU_IMPORT_IMAGES_TOO_LARGE: RISU_IMPORT_MAX_PREPARED_BYTES / 1024 / 1024,
  };
  if (code === 'MODEL_UNAVAILABLE') return display('errors.modelUnavailable');
  if (code && Object.hasOwn(ko, 'errors.' + code))
    return display(
      'errors.' + code,
      Object.hasOwn(limits, code) ? { limit: limits[code] } : undefined
    );
  if (code === 'REVISION_CONFLICT') return display('errors.revisionConflict');
  if (status === 409 && code && nativeActionConflict.test(code))
    return display('errors.conflict', { status });
  if (code?.startsWith('CHAT_TRANSCRIPT_') && Object.hasOwn(messages, code))
    return display('errors.transcriptInvalid');
  if (code) return diagnostic.message;
  if (status === 409 && method === 'DELETE' && typeof error === 'string' && error.length <= 4000)
    return diagnostic.message;
  return display(
    status >= 500
      ? 'errors.serverFailed'
      : status === 409
        ? 'errors.conflict'
        : 'errors.requestFailed',
    { status }
  );
}
