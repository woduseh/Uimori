export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
export const sessionRequiredEvent = 'uimori-session-required';
export const libraryChangedKey = 'uimori:library-change';

export async function api<T>(
  path: string,
  body?: unknown,
  method = 'POST',
  signal?: AbortSignal
): Promise<T> {
  const response = await fetch(
    `/api${path}`,
    body === undefined
      ? { signal }
      : {
          method,
          signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
  );
  if (!response.ok) {
    if (
      response.status === 401 &&
      path.split('?')[0] !== '/session' &&
      typeof window !== 'undefined'
    )
      window.dispatchEvent(new Event(sessionRequiredEvent));
    const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
    if (
      typeof payload?.error === 'string' &&
      /^MODEL_UNAVAILABLE:(main|translation|translation-refusal|status|image|context|helper):/.test(
        payload.error
      )
    )
      throw new ApiError(
        '선택한 모델 또는 연결을 사용할 수 없어요. 전역 모델 설정에서 역할별 모델을 확인하고 모델 프리셋·연결 관리에서 활성 상태, 인증과 지원 모델 설정을 확인해 주세요.',
        response.status
      );
    const settingErrors = new Set([
      'Model disabled',
      'Connection disabled or authority changed',
      'Connection protocol changed; review and save the model settings',
      'Setting not found',
      'CONNECTION_NOT_AUTHORIZED',
      'CREDENTIAL_UNAVAILABLE',
      'ENDPOINT_NOT_APPROVED',
    ]);
    if (typeof payload?.error === 'string' && settingErrors.has(payload.error))
      throw new ApiError(
        '선택한 모델 또는 연결을 사용할 수 없어요. 전역 모델 설정에서 역할별 모델을 확인하고 모델 프리셋·연결 관리에서 활성 상태, 인증과 지원 모델 설정을 확인해 주세요.',
        response.status
      );
    if (response.status === 409) {
      if (payload?.error === 'MODEL_REQUIRED:translation-refusal')
        throw new ApiError(
          '전역 모델 설정에서 번역 거절 판정 모델을 선택해 주세요.',
          response.status
        );
      const requiredRole =
        typeof payload?.error === 'string' &&
        /^MODEL_REQUIRED:(main|translation|status|image|state|context|helper)$/.test(payload.error)
          ? payload.error.split(':')[1]
          : null;
      if (requiredRole) {
        const roleNames: Record<string, string> = {
          main: '본문',
          translation: '번역',
          status: '표시 상태',
          image: '이미지 배치',
          state: '상태',
          context: '문맥 압축',
          helper: '도우미',
        };
        throw new ApiError(
          `${requiredRole === 'state' ? '상태와 문맥 설정' : '전역 모델 설정'}에서 ${roleNames[requiredRole]} 모델을 선택해 주세요.`,
          response.status
        );
      }
      if (method === 'DELETE') {
        if (typeof payload?.error === 'string' && payload.error.length <= 4000)
          throw new ApiError(payload.error, response.status);
      }
      throw new ApiError(
        '다른 요청이 먼저 반영됐어요. 최신 내용을 확인한 뒤 다시 시도해 주세요.',
        response.status
      );
    }
    const message =
      response.status >= 500 ? '서버 작업을 완료하지 못했어요.' : '요청을 처리할 수 없어요.';
    throw new ApiError(`${message} (${response.status})`, response.status);
  }
  const result = (await response.json()) as T;
  const providerSettingsChanged =
    body !== undefined && /^(?:\/model-presets|\/connections)(?:\/[^/]+)?$/.test(path);
  if (
    body !== undefined &&
    (providerSettingsChanged ||
      /^(?:\/library\/(?:folders|organization)|\/content(?:\/|$)|\/prompt-presets?(?:\/|$)|\/(?:prompt-workspace|model-workspace)(?:\/|$)|\/prompt-combinations?(?:\/|$))/.test(
        path
      ))
  ) {
    try {
      localStorage.setItem(libraryChangedKey, `${Date.now()}:${Math.random()}`);
    } catch {
      /* A successful save does not depend on browser storage. */
    }
  }
  if (
    body !== undefined &&
    (path.startsWith('/prompt-workspace') ||
      path.startsWith('/model-workspace') ||
      providerSettingsChanged)
  )
    dispatchEvent(new Event('prompt-workspace-changed'));
  return result;
}

export const labels: Record<string, string> = {
  waiting_for_state: '상태 확인 대기',
  queued: '대기',
  running: '진행 중',
  completed: '완료',
  failed: '실패',
  cancelled: '취소됨',
  interrupted: '서버 중단 · 자동 재생성 안 함',
  stale: '이전 자료의 결과',
  refused: '공급자 거절',
  partial: '부분 결과',
};

export function saveDownload(name: string, data: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  );
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
