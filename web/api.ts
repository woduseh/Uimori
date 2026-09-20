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
export const maintenanceChangedEvent = 'uimori-maintenance-changed';
export type MaintenanceStatus = {
  status: 'open' | 'closed';
  epoch: number;
  reason?: string;
  forcedClosed: boolean;
};
let maintenance: MaintenanceStatus | null = null;
export const knownMaintenance = () => maintenance;
/** The session read already carries the gate, so no screen polls while the app is open. */
export function rememberMaintenance(next: MaintenanceStatus | undefined): void {
  if (!next) return;
  const previous = maintenance;
  maintenance = next;
  // An open workspace is the normal answer: only a closed gate or a real change wakes a screen.
  const changed =
    next.status === 'closed' ||
    (previous !== null && (previous.status !== next.status || previous.epoch !== next.epoch));
  if (changed && typeof window !== 'undefined')
    window.dispatchEvent(new Event(maintenanceChangedEvent));
}
export const libraryChangedKey = 'uimori:library-change';

/** JSON requests and binary uploads share response errors, not mutation side effects. */
async function readApiResponse<T>(
  response: Response,
  method: string,
  notifySession = true
): Promise<T> {
  if (response.ok) return (await response.json()) as T;
  if (response.status === 401 && notifySession && typeof window !== 'undefined')
    window.dispatchEvent(new Event(sessionRequiredEvent));
  const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
  if (
    response.status === 503 &&
    payload?.error === 'MAINTENANCE_CLOSED' &&
    typeof window !== 'undefined'
  )
    window.dispatchEvent(new Event(maintenanceChangedEvent));
  const diagnostic = apiErrorDiagnostic(payload?.error, response.status, method);
  throw new ApiError(diagnostic.message, response.status, diagnostic.code);
}

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
  const result = await readApiResponse<T>(response, method, path.split('?')[0] !== '/session');
  const providerSettingsChanged =
    body !== undefined && /^(?:\/model-presets|\/connections)(?:\/[^/]+)?$/.test(path);
  if (
    body !== undefined &&
    (providerSettingsChanged ||
      path === '/native-transfers/apply' ||
      path === '/risu-imports/apply' ||
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

/** Streams one chosen file as the request body, so a large container never becomes base64. */
export async function apiBinary<T>(path: string, body: Blob): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body,
  });
  return readApiResponse<T>(response, 'POST');
}

export const labels: Record<string, string> = {
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

export function saveDownload(name: string, data: unknown, compact = false) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, compact ? undefined : 2)], { type: 'application/json' })
  );
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
