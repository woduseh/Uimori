import { illustrationErrorMessage } from './illustration-labels.js';

type ApiErrorDiagnostic = { code: string | null; message: string };

const messages: Record<string, string> = {
  MAINTENANCE_CLOSED:
    '업데이트 유지보수 중이라 새 저장·생성을 잠시 받지 않아요. 작성한 내용은 그대로 두고 유지보수가 끝난 뒤 다시 보내 주세요.',
  RISU_PRESET_INVALID_FILE:
    '지원하는 Risu 프리셋 파일인지 확인해 주세요. 프로젝트 ZIP에는 preset.json·manifest.json과 분리된 텍스트 파일이 함께 있어야 해요.',
  RISU_PRESET_INVALID: '프리셋의 프롬프트 구성과 옵션 형식을 확인해 주세요.',
  RISU_PRESET_VERSION_UNSUPPORTED:
    '이 프리셋 바이너리 버전은 아직 지원하지 않아요. RisuToki에서 프로젝트로 추출한 ZIP도 가져올 수 있어요.',
  RISU_IMPORT_INVALID_FILE:
    '지원하는 캐릭터 카드·Risu 모듈 JSON 또는 올바른 .charx 파일인지 확인해 주세요.',
  RISU_IMPORT_TOO_LARGE: '캐릭터 카드 파일은 24 MiB 이하여야 해요.',
  RISU_IMPORT_KIND:
    '가져올 자료 종류를 확인해 주세요. 모듈 JSON·프로젝트 ZIP은 모듈로만 가져올 수 있어요.',
  RISU_IMPORT_DRAFT_CHANGED: '확인한 파일이 달라졌어요. 파일을 다시 선택해 주세요.',
  RISU_IMPORT_PARTIAL_REQUIRED:
    '자동 이식할 수 없는 부분을 확인하고 부분 가져오기에 동의해 주세요.',
  RISU_IMPORT_MEMORY_SELECTION:
    '기억으로 옮길 로어를 확인해 주세요. 비어 있거나 32,000자를 넘는 항목은 옮길 수 없어요.',
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
  DRAFT_BACKUP_REBASE_REQUIRED:
    '백업에서 가져온 전역 프롬프트 초안이에요. 현재 저장본과 비교한 뒤 초안을 유지하거나 저장본을 불러오는 방식으로 다시 연결해 주세요.',
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
  BEHAVIOR_UPGRADE_PREVIEW_EXPIRED: '변경 내용 확인이 만료됐어요. 다시 계산한 뒤 적용해 주세요.',
  BEHAVIOR_UPGRADE_NOT_REQUIRED: '이미 최신 상태 정의를 사용하고 있어요. 상태를 새로 읽어 주세요.',
  BEHAVIOR_UPGRADE_PROGRAM_UNAVAILABLE: '이 자료에는 사용할 수 있는 상태 변환 코드가 없어요.',
  BEHAVIOR_PACKAGE_STALE: '자료가 다시 변경됐어요. 창을 닫고 최신 자료에서 다시 확인해 주세요.',
  BEHAVIOR_PROGRAM_CONTEXT_CHANGED:
    '계산 중 자료나 채팅 상태가 바뀌어 결과를 반영하지 않았어요. 최신 상태에서 다시 실행해 주세요.',
  BEHAVIOR_RUN_ACTIVE: '이 채팅에서 요청이 진행 중이에요. 완료 후 행동을 다시 실행해 주세요.',
  EXTENSION_CANCELLED: '코드 계산을 취소했어요. 상태는 바꾸지 않았어요.',
  EXTENSION_OPERATION_ACTIVE:
    '이 자료의 코드 작업이 이미 진행 중이에요. 결과를 기다리거나 해당 작업을 취소해 주세요.',
  EXTENSION_OPERATION_NOT_FOUND: '자료 코드 작업을 찾지 못했어요. 채팅의 상태를 새로 읽어 주세요.',
  EXTENSION_OPERATION_FAILED: '자료 코드 작업을 완료하지 못했어요. 기존 상태와 채팅은 유지돼요.',
  EXTENSION_INTERRUPTED: '서버가 중단돼 자료 코드 작업을 멈췄어요. 자동으로 다시 실행하지 않아요.',
  BEHAVIOR_PROGRAM_ABORTED: '코드 계산을 취소했어요. 상태는 바꾸지 않았어요.',
  BEHAVIOR_PROGRAM_BUSY: '다른 코드 계산이 진행 중이에요. 잠시 후 다시 실행해 주세요.',
  BEHAVIOR_PROGRAM_FAILED:
    '자료의 코드 계산에 실패했어요. 상태는 유지되며 채팅은 계속할 수 있어요.',
  BEHAVIOR_PROGRAM_RUNTIME_FAILED:
    '코드 실행을 완료하지 못했어요. 상태는 유지되며 채팅은 계속할 수 있어요.',
  BEHAVIOR_PROGRAM_TIMEOUT: '자료의 코드 계산이 제한 시간을 넘었어요. 상태는 바꾸지 않았어요.',
  BEHAVIOR_PROGRAM_INPUT_SIZE:
    '코드에 전달할 상태와 입력이 실행 한도를 넘었어요. 상태는 바꾸지 않았어요.',
  BEHAVIOR_PROGRAM_OUTPUT_SIZE: '코드 계산 결과가 실행 한도를 넘었어요. 상태는 바꾸지 않았어요.',
  BEHAVIOR_PROGRAM_RESULT_VALUE: '코드가 반환한 결과의 형식이 맞지 않아요. 상태는 바꾸지 않았어요.',
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
  status: '장면 해설',
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
