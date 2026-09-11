type AuxiliaryErrorDiagnostic = {
  code: string | null;
  message: string;
  action: string;
};

// Only exact local codes may reach the UI. Never echo remote text or an unknown code.
const diagnostics = new Map<string, Omit<AuxiliaryErrorDiagnostic, 'code'>>();
const define = (codes: string[], message: string, action: string) => {
  for (const code of codes) diagnostics.set(code, { message, action });
};

define(
  ['PROMPT_UNKNOWN_SLOT'],
  '번역 프롬프트를 구성하는 데 필요한 입력 슬롯을 찾지 못했어요.',
  '모델 전송 전 프롬프트 구성에서 중단됐어요. 작업 상세의 실패 기록에서 블록과 슬롯을 확인하고 프롬프트 또는 앱 버전을 점검해 주세요.'
);

for (const [role, label] of [
  ['main', '본문'],
  ['translation', '번역'],
  ['status', '장면 해설'],
  ['image', '이미지'],
]) {
  define(
    [`MODEL_REQUIRED:${role}`],
    `${label} 모델이 지정되지 않았어요.`,
    role === 'status'
      ? '전역 모델 설정에서 장면 해설 모델을 선택하고 저장한 뒤 현재 설정으로 장면 해설을 새로 실행해 주세요.'
      : `전역 모델 설정에서 ${label} 모델을 선택하고 저장한 뒤 새 작업을 요청해 주세요.`
  );
}

define(
  ['IMAGE_MODEL_UNAVAILABLE'],
  '번역은 완료됐지만 이미지 배치 모델을 사용할 수 없어요.',
  '전역 모델 설정에서 이미지 배치 모델을 확인한 뒤 장면 메뉴의 이미지 자동 배치를 눌러 주세요.'
);

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
  ['AUXILIARY_PROVIDER_INPUT_CONTEXT_LIMIT_EXCEEDED', 'AUXILIARY_PROVIDER_CONTEXT_WINDOW_EXCEEDED'],
  '요청이 모델의 입력 한도를 초과했어요.',
  '입력 한도가 더 큰 모델을 선택하거나 요청에 포함할 참고 자료를 줄여 주세요.'
);
define(
  ['AUXILIARY_PROVIDER_PARTIAL'],
  '모델 응답을 끝까지 받지 못했어요.',
  '작업 상세의 호출 기록에서 중단 원인을 확인해 주세요. 응답 제한 시간이나 출력 한도를 초과했을 수 있어요.'
);
define(
  [
    'AUXILIARY_PROVIDER_TRANSPORT_ERROR',
    'AUXILIARY_PROVIDER_UND_ERR_SOCKET',
    'AUXILIARY_PROVIDER_UNEXPECTED_EOF',
  ],
  '모델 응답이 중간에 끝났거나 연결이 끊겼어요.',
  '연결 상태와 출력 토큰 한도를 확인해 주세요. 요청이 실행되었을 수 있으므로 확인 후 재시도해 주세요.'
);
define(
  ['TRANSLATION_REFUSAL_MODEL_REQUIRED', 'MODEL_REQUIRED:translation-refusal'],
  '번역 거절 판정 모델이 지정되지 않았어요.',
  '전역 모델 설정에서 경량 판정 모델을 선택한 뒤 재번역해 주세요.'
);
define(
  ['TRANSLATION_REFUSAL_CHECK_FAILED'],
  '번역 거절 여부를 판정하는 모델 호출을 완료하지 못했어요.',
  '생성된 응답은 보존했고 번역을 자동으로 다시 호출하지 않았어요. 판정 모델의 연결과 설정을 확인해 주세요.'
);
define(
  ['TRANSLATION_REFUSAL_UNCERTAIN'],
  '판정 모델이 번역 응답의 거절 여부를 확정하지 못했어요.',
  '생성된 응답은 보존했고 번역을 자동으로 다시 호출하지 않았어요. 응답과 판정 모델 설정을 확인해 주세요.'
);
define(
  ['TRANSLATION_REFUSAL_RETRIES_EXHAUSTED'],
  '허용된 자동 재시도 범위에서 번역 거절이 해소되지 않았어요.',
  '자동 호출을 중단했어요. 번역 모델과 프롬프트, 자동 재시도 횟수를 확인한 뒤 필요한 경우 새 작업을 요청해 주세요.'
);
define(
  ['AUXILIARY_PROVIDER_REFUSED'],
  '모델이 요청을 거절했어요.',
  '모델이나 프롬프트를 변경한 뒤 수동으로 다시 요청할 수 있어요.'
);
define(
  [
    'AUXILIARY_PROVIDER_EMPTY_COMPLETION',
    'AUXILIARY_PROVIDER_EMPTY_RESPONSE',
    'AUXILIARY_PROVIDER_EMPTY',
  ],
  '모델이 사용할 수 있는 내용을 반환하지 않았어요.',
  '해당 작업의 프롬프트와 모델 설정을 확인해 주세요.'
);
define(
  ['OUTPUT_SCHEMA_INVALID'],
  '모델 응답이 해당 작업의 출력 형식을 충족하지 못했어요.',
  '해당 작업의 프롬프트와 모델 설정을 확인한 뒤 다시 시도해 주세요.'
);
define(
  ['SOURCE_DEPENDENCY_MISMATCH'],
  '작업 결과가 가리키는 원문과 현재 작업의 원문이 일치하지 않아요.',
  '최신 원문을 확인한 뒤 새 작업을 요청해 주세요.'
);
define(
  ['AUXILIARY_CALL_BUDGET_EXHAUSTED'],
  '작업의 전체 모델 호출 한도에 도달했어요.',
  '번역과 도구 후속 호출, 거절 판정은 같은 작업 한도를 사용해요. 호출 한도와 도구 사용 지침을 확인해 주세요.'
);
define(
  ['TOOL_CONTEXT_BUDGET_EXHAUSTED'],
  '도구에서 읽은 참고 자료가 작업의 문맥 한도에 도달했어요.',
  '필요한 참고 자료만 조회하도록 프롬프트의 도구 사용 지침을 확인해 주세요.'
);
define(
  ['TOOL_CORRECTION_EXHAUSTED'],
  '도구 조회 오류가 반복되어 작업을 중단했어요.',
  '참고 자료와 도구 사용 지침을 확인한 뒤 필요한 경우 새 작업을 요청해 주세요.'
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
