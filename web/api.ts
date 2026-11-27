import {
  type Endpoint,
  type EndpointInput,
  type EndpointOutput,
  endpointRequest,
  type Invalidation,
  MAINTENANCE_CLOSED,
  type MaintenanceStatus,
  readErrorWire,
} from '#contracts';
import { apiErrorMessage } from './api-errors.js';
import { t } from './i18n.js';
import { UiError, type UiMessage } from './ui-message.js';
import { writeOptionalStorage } from './optional-storage.js';
import { storageKeys } from './storage-keys.js';
import { promptWorkspaceChange } from './live-frames.js';
import { announceLocalChange } from './live-stream.js';

export class ApiError extends UiError {
  readonly status: number;
  readonly code: string | null;
  constructor(uiMessage: UiMessage, status: number, code: string | null = null) {
    super(uiMessage);
    this.status = status;
    this.code = code;
    this.name = 'ApiError';
  }
}
export function definiteRejection(error: unknown): boolean {
  return (
    error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408
  );
}
const receiptCheckedFailures = new Set([
  'RISU_IMPORT_DRAFT_CHANGED',
  'NATIVE_TRANSFER_DRAFT_CHANGED',
  'NATIVE_TRANSFER_EXPIRED',
]);
export function definiteImportFailure(error: unknown, uncertain: boolean): boolean {
  return (
    definiteRejection(error) &&
    (!uncertain || receiptCheckedFailures.has((error as ApiError).code ?? ''))
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

async function readApiResponse<T>(response: Response, notifySession = true): Promise<T> {
  if (response.ok) return (await response.json()) as T;
  return throwApiError(response, { notifySession });
}

export async function throwApiError(
  response: Response,
  { notifySession = true, emptyMessage }: { notifySession?: boolean; emptyMessage?: UiMessage } = {}
): Promise<never> {
  if (response.status === 401 && notifySession && typeof window !== 'undefined')
    window.dispatchEvent(new Event(sessionRequiredEvent));
  const payload = readErrorWire(await response.json().catch(() => null));
  if (emptyMessage !== undefined && payload.code === undefined && payload.error === undefined)
    throw new ApiError(emptyMessage, response.status);
  if (
    response.status === 503 &&
    (payload.code ?? payload.error) === MAINTENANCE_CLOSED &&
    typeof window !== 'undefined'
  )
    window.dispatchEvent(new Event(maintenanceChangedEvent));
  const { uiMessage, code } = apiErrorMessage(payload, response.status);
  throw new ApiError(uiMessage, response.status, code);
}

const runAdmission =
  /^(?:\/runs\/[^/]+\/(?:retry|rejudge|candidate|cancel)|\/chats\/[^/]+\/(?:runs|story-ui\/actions)|\/scene-commands\/[^/]+\/run)$/u;

const minimal = { Prefer: 'return=minimal' };

async function requestJson<T>(
  path: string,
  body: unknown,
  method: string,
  signal: AbortSignal | undefined,
  headers: Record<string, string> = {}
): Promise<T> {
  const response = await fetch(
    `/api${path}`,
    body === undefined
      ? { signal }
      : {
          method,
          signal,
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify(body),
        }
  );
  return readApiResponse<T>(response, path.split('?')[0] !== '/session');
}

function announceChanges(invalidates: readonly Invalidation[]) {
  const providerSettings = invalidates.includes('provider-settings');
  if (providerSettings || invalidates.includes('library'))
    writeOptionalStorage('local', libraryChangedKey, `${Date.now()}:${Math.random()}`);
  if (providerSettings || invalidates.includes('prompt-workspace'))
    announceLocalChange(promptWorkspaceChange, { echoed: !providerSettings });
}

const legacyLibraryWrites = new Set([
  '/risu-imports/apply',
  '/prompt-presets',
  '/prompt-combinations',
]);

function legacyInvalidation(path: string): Invalidation[] {
  if (/^\/(?:model-presets|connections)(?:\/[^/]+(?:\/move)?)?$/u.test(path))
    return ['provider-settings'];
  return legacyLibraryWrites.has(path) ? ['library'] : [];
}

export async function api<T>(
  path: string,
  body?: unknown,
  method = 'POST',
  signal?: AbortSignal
): Promise<T> {
  const result = await requestJson<T>(
    path,
    body,
    method,
    signal,
    runAdmission.test(path) ? minimal : {}
  );
  if (body !== undefined) announceChanges(legacyInvalidation(path));
  return result;
}

export async function callEndpoint<E extends Endpoint>(
  endpoint: E,
  ...[input, signal]: Record<string, never> extends EndpointInput<E>
    ? [input?: EndpointInput<E>, signal?: AbortSignal]
    : [input: EndpointInput<E>, signal?: AbortSignal]
): Promise<EndpointOutput<E>> {
  const { path, body } = endpointRequest(endpoint, input as Record<string, unknown> | undefined);
  const result = await requestJson<EndpointOutput<E>>(
    path,
    body,
    endpoint.method,
    signal,
    endpoint.preferMinimal ? minimal : {}
  );
  if (endpoint.invalidates) announceChanges(endpoint.invalidates);
  return result;
}

export async function apiBinary<T>(path: string, body: Blob, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body,
    signal,
  });
  return readApiResponse<T>(response);
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
