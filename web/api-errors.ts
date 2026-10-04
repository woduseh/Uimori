import { illustrationErrorMessage } from './illustration-labels.js';
import { REQUEST_TEXT_MAX_CHARS, SOURCE_TEXT_MAX_CHARS } from '../core/content-limits.js';

type ApiErrorDiagnostic = { code: string | null; message: string };

const messages: Record<string, string> = {
  MANUSCRIPT_RANGE_CHANGED: '원고 범위가 바뀌었어요. 내보내기를 다시 열어 범위를 확인해 주세요.',
  MANUSCRIPT_EMPTY: '내보낼 원고가 아직 없어요.',
  MANUSCRIPT_RANGE_INVALID: '내보낼 장면 범위를 확인해 주세요.',
  PUSH_SETTINGS_CHANGED: '다른 창에서 알림 설정이 바뀌었어요. 연결을 다시 확인한 뒤 변경해 주세요.',
  SEARCH_CURSOR_STALE: '검색 조건이 바뀌었어요. 처음부터 다시 검색해 주세요.',
  BACKUP_SETTINGS_CHANGED: '다른 창에서 백업 설정이 바뀌었어요. 백업 설정을 다시 열어 주세요.',

  INPUT_TRANSLATION_LANGUAGE_INVALID: '입력 번역 언어를 다시 선택해 주세요.',
  SELECTION_REVISION_RANGE_INVALID: '원문에서 퇴고할 구절을 다시 선택해 주세요.',
  SELECTION_REVISION_STALE: '저장된 원문이 바뀌었어요. 초안을 확인한 뒤 다시 요청해 주세요.',
  SELECTION_REVISION_TIMEOUT:
    '퇴고 제안이 제한 시간 안에 끝나지 않았어요. 다시 요청하면 새 모델 호출이 발생해요.',
  SELECTION_REVISION_CANCELLED: '퇴고 제안 요청이 중단됐어요.',
  SELECTION_REVISION_REFUSED: '도우미 모델이 이 구절의 퇴고를 거절했어요.',
  SELECTION_REVISION_FAILED:
    '퇴고 제안을 완료하지 못했어요. 도우미 모델 설정과 연결을 확인해 주세요.',
  SELECTION_REVISION_TOO_LONG:
    '제안을 반영하면 원문 저장 한도를 넘어요. 더 짧은 구절로 요청해 주세요.',
  INPUT_TRANSLATION_CANCELLED: '입력 번역이 중단됐어요.',
  INPUT_TRANSLATION_TIMEOUT: '입력 번역이 제한 시간 안에 끝나지 않았어요. 다시 시도해 주세요.',
  INPUT_TRANSLATION_REFUSED: '번역 모델이 이 입력의 번역을 거절했어요.',
  INPUT_TRANSLATION_FAILED: '입력 번역을 완료하지 못했어요. 번역 모델 설정과 연결을 확인해 주세요.',
  INPUT_TRANSLATION_TOO_LONG: `번역문이 저장 한도인 ${REQUEST_TEXT_MAX_CHARS.toLocaleString('en-US')}자를 넘었어요. 초안을 나누어 번역해 주세요.`,
  MAINTENANCE_CLOSED:
    '업데이트 유지보수 중이라 새 저장·생성을 잠시 받지 않아요. 작성한 내용은 그대로 두고 유지보수가 끝난 뒤 다시 보내 주세요.',
  RISU_PRESET_INVALID_FILE:
    '지원하는 Risu 프리셋 파일인지 확인해 주세요. 프로젝트 ZIP에는 preset.json·manifest.json과 분리된 텍스트 파일이 함께 있어야 해요.',
  RISU_PRESET_INVALID: '프리셋의 프롬프트 구성과 옵션 형식을 확인해 주세요.',
  RISU_PRESET_VERSION_UNSUPPORTED:
    '이 프리셋 바이너리 버전은 아직 지원하지 않아요. RisuToki에서 프로젝트로 추출한 ZIP도 가져올 수 있어요.',
  RISU_IMPORT_INVALID_FILE:
    '지원하는 캐릭터 카드·Risu 모듈 JSON 또는 올바른 .charx 파일인지 확인해 주세요.',
  RISU_IMPORT_TOO_LARGE: '캐릭터 카드 파일은 256 MiB 이하여야 해요.',
  PACKAGE_START_TEXT_TOO_LONG: `시작문 하나가 ${SOURCE_TEXT_MAX_CHARS.toLocaleString('en-US')}자 저장 상한을 넘었어요. 기본 시작문과 대체 시작문의 길이를 확인해 주세요.`,
  UPLOAD_TOO_LARGE: '올릴 수 있는 파일은 256 MiB 이하예요.',
  UPLOAD_EMPTY: '빈 파일은 올릴 수 없어요. 파일을 다시 선택해 주세요.',
  UPLOAD_NOT_FOUND:
    '올려 둔 파일을 찾을 수 없어요. 검토 시간이 길어져 정리됐을 수 있으니 파일을 다시 선택해 주세요.',
  UPLOAD_CONTENT_TYPE: '파일 업로드 형식이 올바르지 않아요.',
  RISU_IMPORT_KIND:
    '가져올 자료 종류를 확인해 주세요. 모듈 JSON·프로젝트 ZIP은 모듈로만 가져올 수 있어요.',
  RISU_IMPORT_DRAFT_CHANGED: '확인한 파일이 달라졌어요. 파일을 다시 선택해 주세요.',
  RISU_IMPORT_PARTIAL_REQUIRED:
    '자동 이식할 수 없는 부분을 확인하고 부분 가져오기에 동의해 주세요.',
  NATIVE_TRANSFER_FORMAT:
    '지원하지 않는 자료 파일 형식이나 버전이에요. Uimori의 자료 파일 내보내기로 만든 파일을 선택해 주세요.',
  NATIVE_TRANSFER_TOO_LARGE:
    '자료 파일이 64 MB 한도를 넘었어요. 내보낼 자료를 나누어 선택해 주세요.',
  NATIVE_TRANSFER_MODEL_BINDINGS_REQUIRED: '프롬프트의 보조 모델을 모두 연결한 뒤 가져와 주세요.',
  NATIVE_TRANSFER_DRAFT_CHANGED:
    '확인한 파일 내용이 달라졌어요. 파일을 다시 선택해 내용을 확인해 주세요.',
  NATIVE_TRANSFER_IMPORT_CONFLICT:
    '같은 가져오기 요청에 다른 파일이나 모델 연결이 지정됐어요. 기존 요청의 결과를 먼저 확인해 주세요.',
  NATIVE_TRANSFER_MODULE_BINDINGS:
    '연결된 모듈 정보가 맞지 않아요. 필요한 모듈을 포함해 자료 파일을 다시 내보내 주세요.',
  NATIVE_TRANSFER_SOURCE_CHANGED:
    '자료의 개정이 달라졌어요. 최신 자료를 확인한 뒤 다시 내보내 주세요.',
  PINNED_PROMPT_UNAVAILABLE:
    '이 채팅에 고정한 작문 프롬프트를 사용할 수 없어요. 채팅 설정에서 사용 가능한 프롬프트를 다시 선택하거나 고정을 해제해 주세요.',
  HELPER_EFFECTS_ALREADY_COMMITTED:
    '이 요청의 변경 사항은 이미 저장됐어요. 저장된 결과를 확인하고 남은 작업만 새 요청으로 알려 주세요.',
  HELPER_TASK_NO_LONGER_ACTIVE: '도우미 작업이 이미 종료됐어요. 최신 결과를 확인해 주세요.',
  HELPER_CONTEXT_DEPENDENCY_CHANGED:
    '도우미 대화가 변경됐어요. 최신 대화를 확인한 뒤 새 요청을 보내 주세요.',
  EDITOR_WORKSPACE_UNAVAILABLE: '선택한 편집 초안을 사용할 수 없어요. 편집기를 다시 열어 주세요.',
  DRAFT_UNAPPLIED_FIELDS: '미적용 초안을 검증하고 적용한 뒤 저장해 주세요.',
  DRAFT_DISCARDED: '편집 초안이 폐기됐어요. 새 초안을 열어 주세요.',
  CHAT_TRANSCRIPT_UNSUPPORTED_VERSION:
    '이 버전의 본문 파일은 가져올 수 없어요. 파일을 내보낸 앱과 현재 앱의 버전을 확인해 주세요.',
  CHAT_TRANSCRIPT_BOT_REQUIRED: '본문을 가져올 봇을 선택해 주세요.',
  CHAT_TRANSCRIPT_IMPORT_CONFLICT:
    '같은 가져오기 요청의 본문이나 제목이 달라졌어요. 기존에 가져온 채팅을 먼저 확인해 주세요.',
  CHAT_TRANSCRIPT_IMPORT_UNVERIFIABLE:
    '과거 가져오기 기록으로는 같은 요청인지 확인할 수 없어요. 기존 채팅을 먼저 확인하고, 새 사본이 필요하면 파일을 다시 선택해 주세요.',
  CHAT_TRANSCRIPT_INVALID_REQUEST:
    '본문 파일의 요청 문장이 허용 길이를 넘었거나 형식이 잘못됐어요.',
  CHAT_TRANSCRIPT_INVALID_TEXT: '본문 파일에 비어 있거나 허용 길이를 넘은 응답이 있어요.',
  CHAT_TRANSCRIPT_INVALID_TRANSLATION: '본문 파일의 번역 형식이나 길이를 확인해 주세요.',
  CONTEXT_FIXED_INPUT_TOO_LARGE:
    '고정된 입력만으로 모델의 문맥 한도를 넘었어요. 프롬프트·첨부 자료를 줄이거나 입력 한도가 더 큰 모델을 선택해 주세요.',
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
  'Image selection revision conflict',
  'Model revision conflict',
  'Settings revision conflict',
  'Story settings revision conflict',
  'Source revision conflict',
  'Source revision changed',
  'Translation revision conflict',
  'Current prompts changed; refresh before saving',
  'Prompt preset changed; refresh before saving',
  '초안이 변경됐어요. 현재 입력은 유지하고 변경 내용을 확인해 주세요.',
]);
const roles: Record<string, string> = {
  main: '본문',
  translation: '번역',
  'translation-refusal': '번역 거절 판정',
  status: '장면 해설',
  image: '이미지 배치',
  context: '문맥 압축',
  helper: '도우미',
  illustration: '삽화',
};
const unavailable =
  '선택한 모델 또는 프로바이더를 사용할 수 없어요. 전역 모델 설정에서 역할별 모델을 확인하고 모델 프리셋·프로바이더 관리에서 활성 상태, 인증과 지원 모델 설정을 확인해 주세요.';

/** Preserve recognized local codes, never an arbitrary server/provider error or code suffix. */
export function apiErrorDiagnostic(
  error: unknown,
  status: number,
  method: string
): ApiErrorDiagnostic {
  if (typeof error === 'string') {
    const missing =
      status === 409
        ? /^MANUSCRIPT_TRANSLATION_MISSING:((?:0|[1-9]\d{0,9})(?:,(?:0|[1-9]\d{0,9})){0,19}):([1-9]\d{0,9})$/u.exec(
            error
          )
        : null;
    if (missing && missing[0] === error) {
      const scenes = missing[1].split(',').map(Number);
      const total = Number(missing[2]);
      if (
        total <= 1e9 &&
        total >= scenes.length &&
        scenes.every((scene, index) => scene <= 1e9 && (index === 0 || scene > scenes[index - 1]))
      ) {
        const labels = scenes.map((scene) => (scene === 0 ? '첫 메시지' : `장면 ${scene}`));
        const remaining = total > scenes.length ? ` 외 ${total - scenes.length}개` : '';
        return {
          code: 'MANUSCRIPT_TRANSLATION_MISSING',
          message: `저장된 유효 번역이 없는 장면: ${labels.join(', ')}${remaining}. 번역을 완료하거나 범위를 바꿔 주세요.`,
        };
      }
    }
    const code =
      error === 'PINNED_PROMPT_UNAVAILABLE' || error.startsWith('PINNED_PROMPT_UNAVAILABLE:')
        ? 'PINNED_PROMPT_UNAVAILABLE'
        : error === '미적용 초안을 검증하고 적용한 뒤 저장해 주세요.'
          ? 'DRAFT_UNAPPLIED_FIELDS'
          : ['편집 초안이 폐기됐어요.', '초안이 폐기됐어요. 새 초안을 열어 주세요.'].includes(error)
            ? 'DRAFT_DISCARDED'
            : error;
    if (Object.hasOwn(messages, code)) return { code, message: messages[code] };
    if (/^(?:ILLUSTRATION_|COMFYUI_|CODEX_IMAGE_)[A-Z0-9_]{1,100}$/.test(code))
      return { code, message: illustrationErrorMessage(code) };
    const required = /^MODEL_REQUIRED:([a-z-]+)$/.exec(code)?.[1];
    if (required && Object.hasOwn(roles, required))
      return {
        code,
        message: `전역 모델 설정에서 ${roles[required]} 모델을 선택해 주세요.`,
      };
    const unavailableRole = /^MODEL_UNAVAILABLE:([a-z-]+):/.exec(code)?.[1];
    if (unavailableRole && Object.hasOwn(roles, unavailableRole))
      return {
        code: `MODEL_UNAVAILABLE:${unavailableRole}`,
        message:
          unavailableRole === 'main'
            ? '본문 모델 또는 프로바이더를 사용할 수 없어요. 채팅 설정의 고정 모델과 전역 모델 설정, 모델·프로바이더의 활성 상태와 인증을 확인해 주세요.'
            : unavailable,
      };
    if (settingErrors.has(code)) return { code: 'MODEL_UNAVAILABLE', message: unavailable };
    if (status === 409 && revisionErrors.has(code))
      return {
        code: 'REVISION_CONFLICT',
        message: '다른 요청이 먼저 반영됐어요. 최신 내용을 확인한 뒤 다시 시도해 주세요.',
      };
    // Deletion conflicts already carry the local server's user-facing impact explanation.
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
