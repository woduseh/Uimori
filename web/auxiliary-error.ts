export type AuxiliaryErrorDiagnostic = {
  code: string | null;
  message: string;
  action: string;
};

// Only exact local codes may reach the UI. Never echo remote text or an unknown code.
const diagnostics = new Map<string, Omit<AuxiliaryErrorDiagnostic, 'code'>>();
const define = (codes: string[], message: string, action: string) => {
  for (const code of codes) diagnostics.set(code, { message, action });
};

for (const [role, label] of [
  ['main', '본문'],
  ['translation', '번역'],
  ['status', '표시 상태'],
  ['image', '이미지'],
]) {
  define(
    [`MODEL_REQUIRED:${role}`],
    `${label} 모델이 지정되지 않았어요.`,
    role === 'status'
      ? '채팅 설정에서 표시 상태 모델을 선택하고 저장한 뒤 현재 설정으로 장면 상태를 새로 실행해 주세요.'
      : `채팅 설정에서 ${label} 모델을 선택하고 저장한 뒤 새 작업을 요청해 주세요.`
  );
}

define(
  [
    'AUXILIARY_PROVIDER_HTTP_401',
    'AUXILIARY_PROVIDER_HTTP_403',
    'AUXILIARY_PROVIDER_CREDENTIAL_UNAVAILABLE',
    'CONNECTION_NOT_AUTHORIZED',
  ],
  '모델 연결의 인증 또는 사용 권한을 확인하지 못했어요.',
  '모델 설정에서 연결 활성화, 인증 정보와 모델 접근 권한을 확인해 주세요.'
);
define(
  ['AUXILIARY_PROVIDER_HTTP_400', 'AUXILIARY_PROVIDER_HTTP_404', 'AUXILIARY_PROVIDER_HTTP_422'],
  '공급자가 모델 요청을 받아들이지 않았어요.',
  '연결 주소, 모델 ID와 해당 모델이 지원하는 요청 설정을 확인해 주세요.'
);
define(
  ['AUXILIARY_PROVIDER_HTTP_429'],
  '공급자의 요청 제한 또는 할당량 제한에 걸렸어요.',
  '공급자의 사용량과 할당량을 확인하고 잠시 후 다시 시도해 주세요.'
);
define(
  [
    'AUXILIARY_PROVIDER_HTTP_500',
    'AUXILIARY_PROVIDER_HTTP_502',
    'AUXILIARY_PROVIDER_HTTP_503',
    'AUXILIARY_PROVIDER_HTTP_504',
  ],
  '공급자 서버에서 요청을 처리하지 못했어요.',
  '공급자 상태를 확인해 주세요. 요청이 실행되었을 수 있으므로 확인 후 재시도해 주세요.'
);
define(
  [
    'AUXILIARY_PROVIDER_TIMEOUT',
    'AUXILIARY_PROVIDER_UND_ERR_HEADERS_TIMEOUT',
    'AUXILIARY_PROVIDER_UND_ERR_BODY_TIMEOUT',
    'AUXILIARY_PROVIDER_UND_ERR_CONNECT_TIMEOUT',
  ],
  '제한 시간 안에 모델 응답을 완료하지 못했어요.',
  '연결 상태와 작업 제한 시간을 확인해 주세요. 요청이 실행되었을 수 있으므로 확인 후 재시도해 주세요.'
);
define(
  [
    'AUXILIARY_PROVIDER_TRANSPORT_ERROR',
    'AUXILIARY_PROVIDER_UND_ERR_SOCKET',
    'AUXILIARY_PROVIDER_UNEXPECTED_EOF',
    'AUXILIARY_PROVIDER_PARTIAL',
  ],
  '모델 응답이 중간에 끝났거나 연결이 끊겼어요.',
  '연결 상태와 출력 토큰 한도를 확인해 주세요. 요청이 실행되었을 수 있으므로 확인 후 재시도해 주세요.'
);
define(
  ['AUXILIARY_PROVIDER_REFUSED'],
  '모델이 요청을 거절했어요.',
  '해당 작업의 프롬프트와 입력 내용을 확인해 주세요.'
);
define(
  ['AUXILIARY_PROVIDER_EMPTY_COMPLETION', 'AUXILIARY_PROVIDER_EMPTY_RESPONSE'],
  '모델이 사용할 수 있는 내용을 반환하지 않았어요.',
  '해당 작업의 프롬프트와 모델 설정을 확인해 주세요.'
);
define(
  [
    'OUTPUT_SCHEMA_INVALID',
    'CHUNK_COVERAGE_INVALID',
    'PROTECTED_SPAN_INVALID',
    'UNPROTECTED_SYNTAX_RETURNED',
    'SEGMENT_TRANSLATION_INVALID',
    'SEGMENT_TRANSLATION_COVERAGE',
    'SEGMENT_TRANSLATION_MARKERS',
  ],
  '모델 응답이 필요한 출력 형식 또는 원문 보존 조건을 충족하지 못했어요.',
  '해당 작업의 프롬프트가 지정된 출력 형식과 보호 표기를 유지하도록 확인한 뒤 다시 시도해 주세요.'
);
define(
  ['SOURCE_DEPENDENCY_MISMATCH'],
  '작업 결과가 가리키는 원문과 현재 작업의 원문이 일치하지 않아요.',
  '최신 원문을 확인한 뒤 새 작업을 요청해 주세요.'
);
define(
  ['AUXILIARY_CALL_BUDGET_EXHAUSTED', 'TOOL_CONTEXT_BUDGET_EXHAUSTED'],
  '작업의 호출 횟수 또는 도구 문맥 한도에 도달했어요.',
  '작업 한도와 프롬프트의 도구 사용 지침을 확인해 주세요.'
);
define(
  ['AUXILIARY_CANCELLED'],
  '보조 작업이 취소되었어요.',
  '다시 실행하려면 재시도를 선택해 주세요.'
);
define(
  ['AUXILIARY_INCOMPLETE', 'AUXILIARY_EXECUTION_FAILED'],
  '보조 작업을 완료하지 못했어요.',
  '작업 상세의 호출 상태와 모델 연결 설정을 확인해 주세요.'
);

export function auxiliaryErrorDiagnostic(error: unknown): AuxiliaryErrorDiagnostic {
  const diagnostic = typeof error === 'string' ? diagnostics.get(error) : undefined;
  if (diagnostic) return { code: error as string, ...diagnostic };
  return {
    code: null,
    message: '보조 작업을 완료하지 못했어요.',
    action: '작업 상세의 호출 상태와 모델 연결 설정을 확인해 주세요.',
  };
}
