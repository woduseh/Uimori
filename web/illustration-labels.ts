import type { Illustration } from '../core/illustration.js';

/** Error codes stay stable identifiers; remote provider messages are never shown verbatim. */
const messages: Record<string, string> = {
  ILLUSTRATION_GENERATOR_UNCONFIGURED: '설정 → 삽화에서 생성기를 선택해 주세요.',
  ILLUSTRATION_ACTIVE: '이 장면의 삽화가 아직 생성 중이에요. 끝난 뒤 다시 요청해 주세요.',
  ILLUSTRATION_LIMIT_REACHED:
    '이 장면의 삽화 개수 한도에 도달했어요. 삽화를 삭제하거나 설정 → 삽화에서 장면당 최대 개수를 늘려 주세요.',
  ILLUSTRATION_MODEL_REQUIRED: '설정 → 삽화에서 Codex 삽화 모델을 선택해 주세요.',
  ILLUSTRATION_MODEL_UNAVAILABLE:
    '삽화 모델 또는 연결을 사용할 수 없어요. 모델 프리셋과 연결 상태를 확인해 주세요.',
  ILLUSTRATION_CODEX_CONNECTION_REQUIRED: 'Codex 삽화 모델은 Codex 연결의 모델 프리셋이어야 해요.',
  ILLUSTRATION_PROMPT_MODEL_REQUIRED: '설정 → 삽화에서 ComfyUI용 프롬프트 모델을 선택해 주세요.',
  ILLUSTRATION_SOURCE_CHANGED: '원문이 바뀌었어요. 새로고침한 뒤 다시 요청해 주세요.',
  ILLUSTRATION_SOURCE_UNAVAILABLE: '요청 당시의 원문을 더 읽을 수 없어요.',
  ILLUSTRATION_NOT_RETRYABLE: '완료되거나 진행 중인 삽화는 다시 요청할 수 없어요.',
  ILLUSTRATION_CANCELLED: '삽화 생성을 취소했어요.',
  ILLUSTRATION_INTERRUPTED: '서버가 중단돼 결과를 확인할 수 없어요. 자동으로 다시 생성하지 않아요.',
  ILLUSTRATION_SUPERSEDED: '취소된 뒤 도착한 결과라 저장하지 않았어요.',
  ILLUSTRATION_FAILED: '삽화 생성을 완료하지 못했어요.',
  ILLUSTRATION_RESERVATION_FAILED: '삽화 작업을 예약하지 못했어요. 설정 → 삽화를 확인해 주세요.',
  ILLUSTRATION_PROMPT_REFUSED: '프롬프트 모델이 장면 설명 작성을 거절했어요.',
  ILLUSTRATION_PROMPT_INVALID: '프롬프트 모델의 응답을 해석할 수 없었어요.',
  CONNECTION_NOT_AUTHORIZED: '연결이 비활성화됐거나 설정이 바뀌었어요.',
  CODEX_IMAGE_NOT_GENERATED:
    'Codex가 이미지를 만들지 않았어요. 모델 선택과 Codex 로그인 상태를 확인하고 다시 요청해 주세요.',
  CODEX_IMAGE_USAGE_LIMIT: 'Codex 이미지 생성 사용량 한도에 도달했어요.',
  CODEX_IMAGE_INVALID_REFERENCE: '참조 이미지를 Codex에 보낼 수 없는 형식이에요.',
  CODEX_IMAGE_TOO_MANY_REFERENCES: '참조 이미지는 8개까지 보낼 수 있어요.',
  CODEX_LOGIN_REQUIRED: 'ChatGPT 구독으로 Codex에 로그인해 주세요.',
  CODEX_DISABLED: '서버에서 Codex 연결 기능을 활성화해 주세요.',
  CODEX_NOT_INSTALLED: '서버에 공식 Codex 실행기가 없어요.',
  CODEX_VERSION_UNSUPPORTED: '서버의 Codex 실행기 버전을 업데이트해 주세요.',
  CODEX_TURN_FAILED: 'Codex 작업이 실패했어요.',
  CODEX_EXECUTION_INTERRUPTED: 'Codex 작업이 중단됐어요.',
  CODEX_TOOL_NOT_ALLOWED: 'Codex가 허용되지 않은 도구를 실행하려 해 작업을 중단했어요.',
  CODEX_BUSY: 'Codex가 다른 작업을 처리하고 있어요. 잠시 후 다시 시도해 주세요.',
  CODEX_UNAVAILABLE: 'Codex 실행기를 사용할 수 없어요.',
  CODEX_INVALID_CONNECTION: 'Codex 연결 설정을 확인해 주세요.',
  TIMEOUT: '제한 시간 안에 완료되지 않았어요.',
  COMFYUI_UNCONFIGURED: '설정 → 삽화에서 ComfyUI 주소를 입력해 주세요.',
  COMFYUI_WORKFLOW_MISSING: '설정 → 삽화에서 ComfyUI 워크플로 JSON을 입력해 주세요.',
  COMFYUI_WORKFLOW_INVALID:
    'ComfyUI 워크플로 JSON이 API 형식(노드 ID → class_type/inputs)이 아니에요.',
  COMFYUI_WORKFLOW_UI_FORMAT:
    'UI용 워크플로 파일이에요. ComfyUI에서 "Export (API)"로 저장한 JSON을 사용해 주세요.',
  COMFYUI_WORKFLOW_PROMPT_PLACEHOLDER_MISSING: '워크플로에 {{prompt}} 자리표시자가 없어요.',
  COMFYUI_BASE_URL_INVALID:
    'ComfyUI 주소는 http:// 또는 https://로 시작하고 인증 정보·쿼리를 포함하지 않아야 해요.',
  COMFYUI_CREDENTIAL_UNAVAILABLE: 'ComfyUI 인증 환경변수를 서버에서 읽을 수 없어요.',
  COMFYUI_REDIRECT_REFUSED:
    'ComfyUI 주소가 다른 주소로 이동(redirect)하고 있어요. 이동 뒤의 최종 주소를 설정에 직접 입력해 주세요.',
  COMFYUI_UNREACHABLE:
    'ComfyUI 서버에 연결할 수 없어요. 주소와 원격 PC의 ComfyUI 실행 상태, 방화벽을 확인해 주세요.',
  COMFYUI_PROMPT_REJECTED: 'ComfyUI가 워크플로를 거절했어요. 아래 노드 오류를 확인해 주세요.',
  COMFYUI_EXECUTION_FAILED: 'ComfyUI 실행 중 오류가 났어요.',
  COMFYUI_TIMEOUT:
    'ComfyUI 응답을 제한 시간 안에 받지 못했어요. 원격 작업이 끝났으면 결과 확인으로 가져올 수 있어요.',
  COMFYUI_RESULT_PENDING: 'ComfyUI에 아직 결과가 없어요. 잠시 후 결과 확인을 다시 눌러 주세요.',
  ILLUSTRATION_NOT_RECONCILABLE:
    '기록된 ComfyUI 작업 ID가 있는 미완료 삽화만 결과를 확인할 수 있어요.',
  COMFYUI_NO_IMAGE: 'ComfyUI 실행은 끝났지만 출력 이미지가 없어요. SaveImage 노드를 확인해 주세요.',
  COMFYUI_IMAGE_INVALID:
    'ComfyUI가 보낸 이미지를 읽을 수 없어요. PNG·JPEG·WebP 8MB 이하만 저장해요.',
  COMFYUI_RESPONSE_INVALID: 'ComfyUI 응답 형식을 해석할 수 없어요.',
  COMFYUI_HTTP_5XX: 'ComfyUI 서버 오류가 났어요.',
  COMFYUI_HTTP_ERROR: 'ComfyUI 요청이 거절됐어요. 주소와 인증 설정을 확인해 주세요.',
  FIXTURE_FAILURE: '모의 실패예요.',
};
export function illustrationErrorMessage(code: string | null | undefined): string {
  if (!code) return '삽화 생성을 완료하지 못했어요.';
  if (messages[code]) return messages[code];
  if (code.startsWith('ILLUSTRATION_PROMPT_'))
    return '프롬프트 모델 호출이 실패했어요. 모델·연결 상태를 확인해 주세요.';
  if (code.startsWith('MODEL_UNAVAILABLE:'))
    return '삽화 모델 또는 연결을 사용할 수 없어요. 모델 프리셋과 연결 상태를 확인해 주세요.';
  return '삽화 생성을 완료하지 못했어요.';
}
export const illustrationStatusLabels: Record<Illustration['status'], string> = {
  queued: '대기',
  running: '생성 중',
  completed: '완료',
  failed: '실패',
  cancelled: '취소됨',
  interrupted: '서버 중단 · 자동 재생성 안 함',
};
export const illustrationGeneratorLabels: Record<Illustration['generator'], string> = {
  codex: 'Codex',
  comfyui: 'ComfyUI',
  fixture: '모의 생성기',
};
export const illustrationActive = (item: Pick<Illustration, 'status'>) =>
  item.status === 'queued' || item.status === 'running';
export const illustrationRetryable = (item: Pick<Illustration, 'status'>) =>
  ['failed', 'cancelled', 'interrupted'].includes(item.status);
/** An accepted remote prompt can be re-read without rendering again. */
export const illustrationReconcilable = (
  item: Pick<Illustration, 'status' | 'generator' | 'diagnostic'>
) =>
  item.generator === 'comfyui' &&
  !!item.diagnostic?.comfyui?.promptId &&
  illustrationRetryable(item);
export const illustrationSkipped = (item: Pick<Illustration, 'status' | 'images' | 'diagnostic'>) =>
  item.status === 'completed' &&
  !item.images.length &&
  typeof item.diagnostic?.skipped === 'string';
