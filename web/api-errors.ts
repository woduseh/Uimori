import { illustrationErrorMessage } from './illustration-labels.js';

type ApiErrorDiagnostic = { code: string | null; message: string };

const messages: Record<string, string> = {
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
  DRAFT_BACKUP_REBASE_REQUIRED:
    '백업에서 가져온 전역 프롬프트 초안이에요. 현재 저장본과 비교한 뒤 초안을 유지하거나 저장본을 불러오는 방식으로 다시 연결해 주세요.',
  CHAT_TRANSCRIPT_UNSUPPORTED_VERSION:
    '이 버전의 본문 파일은 가져올 수 없어요. 파일을 내보낸 앱과 현재 앱의 버전을 확인해 주세요.',
  CHAT_TRANSCRIPT_BOT_REQUIRED: '본문을 가져올 봇을 선택해 주세요.',
  CHAT_TRANSCRIPT_INVALID_REQUEST:
    '본문 파일의 요청 문장이 허용 길이를 넘었거나 형식이 잘못됐어요.',
  CHAT_TRANSCRIPT_INVALID_TEXT: '본문 파일에 비어 있거나 허용 길이를 넘은 응답이 있어요.',
  CHAT_TRANSCRIPT_INVALID_TRANSLATION: '본문 파일의 번역 형식이나 길이를 확인해 주세요.',
  CHAT_BACKUP_UNSUPPORTED_VERSION:
    '이 버전의 채팅 백업은 가져올 수 없어요. 백업을 내보낸 앱과 현재 앱의 버전을 확인해 주세요.',
  CHAT_BACKUP_TOO_LARGE:
    '채팅 백업이 허용 크기를 넘었어요. 백업 크기와 앱의 가져오기 한도를 확인해 주세요.',
  CHAT_BACKUP_IMPORT_CONFLICT:
    '같은 가져오기 요청에 다른 백업이 선택됐어요. 파일을 다시 선택한 뒤 가져와 주세요.',
  CHAT_BACKUP_LIBRARY_CONFLICT:
    '같은 ID와 개정 번호의 자료 내용이 현재 서재와 달라요. 기존 자료를 덮어쓰지 않았어요. 충돌한 자료를 확인한 뒤 다른 작업공간에 가져와 주세요.',
  CONTEXT_FIXED_INPUT_TOO_LARGE:
    '고정된 입력만으로 모델의 문맥 한도를 넘었어요. 프롬프트·첨부 자료를 줄이거나 입력 한도가 더 큰 모델을 선택해 주세요.',
  BEHAVIOR_STATE_STALE: '다른 요청이 먼저 반영됐어요. 최신 내용을 확인한 뒤 다시 시도해 주세요.',
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
for (const suffix of [
  'INVALID_FORMAT',
  'INVALID_TIME',
  'INVALID_COLLECTION',
  'MISSING_FIELD',
  'INVALID_FIELD',
  'INVALID_CHAT',
  'INVALID_GRAPH',
])
  messages[`CHAT_BACKUP_${suffix}`] =
    '채팅 백업의 형식이나 분기 연결이 올바르지 않아요. 백업 파일을 확인해 주세요.';

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
  status: '표시 상태',
  image: '이미지 배치',
  state: '상태',
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
        message: `${required === 'state' ? '상태와 문맥 설정' : '전역 모델 설정'}에서 ${roles[required]} 모델을 선택해 주세요.`,
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
