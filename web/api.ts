import { apiErrorDiagnostic } from './api-errors.js';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null
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
    const diagnostic = apiErrorDiagnostic(payload?.error, response.status, method);
    throw new ApiError(diagnostic.message, response.status, diagnostic.code);
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
