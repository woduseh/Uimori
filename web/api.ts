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

export async function api<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const response = await fetch(
    `/api${path}`,
    body === undefined
      ? undefined
      : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );
  if (!response.ok) {
    if (
      response.status === 401 &&
      path.split('?')[0] !== '/session' &&
      typeof window !== 'undefined'
    )
      window.dispatchEvent(new Event(sessionRequiredEvent));
    if (response.status === 409) {
      const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
      const requiredRole =
        typeof payload?.error === 'string' &&
        /^MODEL_REQUIRED:(main|translation|status|image|state|memory)$/.test(payload.error)
          ? payload.error.split(':')[1]
          : null;
      if (requiredRole) {
        const roleNames: Record<string, string> = {
          main: '본문',
          translation: '번역',
          status: '표시 상태',
          image: '이미지 선택',
          state: '상태',
          memory: '기억',
        };
        throw new ApiError(
          `채팅 설정에서 ${roleNames[requiredRole]} 모델을 선택해 주세요.`,
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
  if (
    body !== undefined &&
    /^(?:\/library\/(?:folders|organization)|\/content(?:\/|$)|\/prompt-presets?(?:\/|$)|\/prompt-combinations?(?:\/|$))/.test(
      path
    )
  ) {
    try {
      localStorage.setItem(libraryChangedKey, `${Date.now()}:${Math.random()}`);
    } catch {
      /* A successful save does not depend on browser storage. */
    }
  }
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
