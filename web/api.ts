import { MAINTENANCE_CLOSED, type MaintenanceStatus, readErrorWire } from '#contracts';
import { apiErrorDiagnostic, apiErrorDisplay } from './api-errors.js';
import { t } from './i18n.js';
import { writeOptionalStorage } from './optional-storage.js';
import { forgetBotStorage, forgetChatStorage, storageKeys } from './storage-keys.js';
import { promptWorkspaceChange } from './live-frames.js';
import { announceLocalChange } from './live-stream.js';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  private readonly display?: () => string;
  constructor(message: string, status: number, code: string | null = null, display?: () => string) {
    super(message);
    this.status = status;
    this.code = code;
    this.display = display;
    this.name = 'ApiError';
  }
  get displayMessage(): string {
    return this.display?.() ?? this.message;
  }
}
export function definiteRejection(error: unknown): boolean {
  return (
    error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408
  );
}
export const sessionRequiredEvent = 'uimori-session-required';
export const maintenanceChangedEvent = 'uimori-maintenance-changed';
let maintenance: MaintenanceStatus | null = null;
export const knownMaintenance = () => maintenance;
export function rememberMaintenance(next: MaintenanceStatus | undefined): void {
  if (!next) return;
  const previous = maintenance;
  maintenance = next;
  const changed =
    next.status === 'closed' ||
    (previous !== null && (previous.status !== next.status || previous.epoch !== next.epoch));
  if (changed && typeof window !== 'undefined')
    window.dispatchEvent(new Event(maintenanceChangedEvent));
}
export const libraryChangedKey = storageKeys.libraryChanged;

function forgetDeletedStorage(path: string) {
  const [, collection, id] = /^\/(chats|content)\/([^/?]+)$/u.exec(path) ?? [];
  if (!id) return;
  if (collection === 'chats') forgetChatStorage(decodeURIComponent(id));
  else forgetBotStorage(decodeURIComponent(id));
}

async function readApiResponse<T>(
  response: Response,
  method: string,
  notifySession = true
): Promise<T> {
  if (response.ok) return (await response.json()) as T;
  if (response.status === 401 && notifySession && typeof window !== 'undefined')
    window.dispatchEvent(new Event(sessionRequiredEvent));
  const payload = readErrorWire(await response.json().catch(() => null));
  if (
    response.status === 503 &&
    (payload.code ?? payload.error) === MAINTENANCE_CLOSED &&
    typeof window !== 'undefined'
  )
    window.dispatchEvent(new Event(maintenanceChangedEvent));
  const diagnostic = apiErrorDiagnostic(payload, response.status, method);
  apiErrorDisplay(payload, response.status, method);
  throw new ApiError(diagnostic.message, response.status, diagnostic.code, () =>
    apiErrorDisplay(payload, response.status, method)
  );
}

const runAdmission =
  /^(?:\/runs\/[^/]+\/(?:retry|rejudge|candidate|cancel)|\/chats\/[^/]+\/(?:runs|story-ui\/actions)|\/scene-commands\/[^/]+\/run)$/u;

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
          headers: {
            'Content-Type': 'application/json',
            ...(runAdmission.test(path) ? { Prefer: 'return=minimal' } : {}),
          },
          body: JSON.stringify(body),
        }
  );
  const result = await readApiResponse<T>(response, method, path.split('?')[0] !== '/session');
  if (method === 'DELETE' && body !== undefined) forgetDeletedStorage(path);
  const providerSettingsChanged =
    body !== undefined && /^(?:\/model-presets|\/connections)(?:\/[^/]+)?$/.test(path);
  if (
    body !== undefined &&
    (providerSettingsChanged ||
      path === '/native-transfers/apply' ||
      path === '/native-transfers/apply-archive' ||
      path === '/risu-imports/apply' ||
      /^(?:\/library\/(?:folders|organization)|\/content(?:\/|$)|\/prompt-presets?(?:\/|$)|\/(?:prompt-workspace|model-workspace)(?:\/|$)|\/prompt-combinations?(?:\/|$))/.test(
        path
      ))
  ) {
    writeOptionalStorage('local', libraryChangedKey, `${Date.now()}:${Math.random()}`);
  }
  if (
    body !== undefined &&
    (path.startsWith('/prompt-workspace') ||
      path.startsWith('/model-workspace') ||
      providerSettingsChanged)
  )
    announceLocalChange(promptWorkspaceChange, { echoed: !providerSettingsChanged });
  return result;
}

export async function apiBinary<T>(path: string, body: Blob, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body,
    signal,
  });
  return readApiResponse<T>(response, 'POST');
}

export const labels: Record<string, string> = {
  get queued() {
    return t('errors.status.queued');
  },
  get running() {
    return t('errors.status.running');
  },
  get completed() {
    return t('errors.status.completed');
  },
  get failed() {
    return t('errors.status.failed');
  },
  get cancelled() {
    return t('errors.status.cancelled');
  },
  get interrupted() {
    return t('errors.status.interrupted');
  },
  get stale() {
    return t('errors.status.stale');
  },
  get refused() {
    return t('errors.status.refused');
  },
  get partial() {
    return t('errors.status.partial');
  },
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
