import { randomUUID } from 'node:crypto';
import { providerFetchOptions, transportFailureCode } from '../core/provider-fetch.js';
import {
  detectImageMime,
  ILLUSTRATION_MAX_IMAGE_BYTES,
  IllustrationError,
  type ComfyWorkflow,
  type IllustrationDiagnostic,
  type IllustrationImageMime,
} from '../core/illustration.js';

/** ComfyUI usually runs on another PC; the server, never the browser, talks to it. */
export type ComfyUIConnection = { baseUrl: string; authorizationEnv: string };
export type ComfyUIRequestOptions = {
  signal: AbortSignal;
  resolveCredential?: (
    envReference: string,
    connection?: undefined,
    signal?: AbortSignal
  ) => string | undefined | Promise<string | undefined>;
};
export type ComfyUIGenerateOptions = ComfyUIRequestOptions & {
  timeoutMs: number;
  pollIntervalMs: number;
  maxImages?: number;
  onSubmitted?: (promptId: string) => void | Promise<void>;
};
export type ComfyUIImage = { mime: IllustrationImageMime; bytes: Buffer; filename: string };
type ComfyDiagnostic = NonNullable<IllustrationDiagnostic['comfyui']>;

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const bounded = (value: unknown, max = 300): string | undefined =>
  typeof value === 'string' && value.trim()
    ? Array.from(value.trim()).slice(0, max).join('')
    : undefined;

export function validateComfyBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new IllustrationError('COMFYUI_BASE_URL_INVALID');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.hostname ||
    value.length > 2000
  )
    throw new IllustrationError('COMFYUI_BASE_URL_INVALID');
  return url.href.replace(/\/+$/u, '');
}
export function comfyUIUrl(baseUrl: string, path: string, query?: Record<string, string>): string {
  const url = new URL(`${validateComfyBaseUrl(baseUrl)}/${path.replace(/^\/+/u, '')}`);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
  return url.href;
}
async function headers(
  connection: ComfyUIConnection,
  options: ComfyUIRequestOptions,
  json: boolean
): Promise<Record<string, string>> {
  const result: Record<string, string> = json ? { 'content-type': 'application/json' } : {};
  if (connection.authorizationEnv) {
    const secret = await (options.resolveCredential ?? ((name: string) => process.env[name]))(
      connection.authorizationEnv,
      undefined,
      options.signal
    );
    if (!secret) throw new IllustrationError('COMFYUI_CREDENTIAL_UNAVAILABLE');
    result.authorization = secret;
  }
  return result;
}
async function send(
  connection: ComfyUIConnection,
  options: ComfyUIRequestOptions,
  path: string,
  init: { method?: string; body?: unknown; query?: Record<string, string> } = {}
): Promise<Response> {
  const url = comfyUIUrl(connection.baseUrl, path, init.query);
  const requestHeaders = await headers(connection, options, init.body !== undefined);
  try {
    // Like the provider adapters, never follow a redirect: the approved base URL is the only target
    // and the Authorization header must not travel to another origin.
    return await fetch(
      url,
      providerFetchOptions({
        method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
        headers: requestHeaders,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: options.signal,
        redirect: 'error',
      })
    );
  } catch (error) {
    if (options.signal.aborted) throw new IllustrationError('ILLUSTRATION_CANCELLED');
    const cause =
      error instanceof Error ? (error.cause as { message?: unknown } | undefined) : undefined;
    if (/redirect/iu.test(String(cause?.message ?? (error instanceof Error ? error.message : ''))))
      throw new IllustrationError('COMFYUI_REDIRECT_REFUSED');
    throw new IllustrationError('COMFYUI_UNREACHABLE', true, {
      comfyui: { statusMessages: [transportFailureCode(error)] },
    });
  }
}
async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > 8_000_000) throw new IllustrationError('COMFYUI_RESPONSE_INVALID');
  try {
    return JSON.parse(text);
  } catch {
    throw new IllustrationError('COMFYUI_RESPONSE_INVALID', false, {
      comfyui: { httpStatus: response.status },
    });
  }
}
/** Node ids, node class names and bounded error messages from the user's own ComfyUI. */
function nodeErrors(value: unknown): ComfyDiagnostic['nodeErrors'] {
  if (!object(value)) return undefined;
  const result: NonNullable<ComfyDiagnostic['nodeErrors']> = [];
  for (const [nodeId, entry] of Object.entries(value).slice(0, 20)) {
    if (!object(entry)) continue;
    const messages = Array.isArray(entry.errors)
      ? entry.errors
          .slice(0, 5)
          .map((item) =>
            object(item)
              ? [bounded(item.message), bounded(item.details, 200)].filter(Boolean).join(' · ')
              : ''
          )
          .filter(Boolean)
      : [];
    result.push({
      nodeId: String(nodeId).slice(0, 80),
      classType: bounded(entry.class_type, 120) ?? 'unknown',
      messages,
    });
  }
  return result;
}
function statusMessages(status: unknown): string[] {
  if (!object(status) || !Array.isArray(status.messages)) return [];
  const result: string[] = [];
  for (const entry of status.messages.slice(0, 30)) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const [kind, detail] = entry;
    if (kind !== 'execution_error' && kind !== 'execution_interrupted') continue;
    const message = object(detail)
      ? [
          bounded(detail.node_type, 120),
          bounded(detail.exception_type, 120),
          bounded(detail.exception_message, 400),
        ]
          .filter(Boolean)
          .join(' · ')
      : '';
    result.push(message || String(kind));
  }
  return result.slice(0, 10);
}
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new IllustrationError('ILLUSTRATION_CANCELLED'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new IllustrationError('ILLUSTRATION_CANCELLED'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });

/** Connectivity check for the settings screen. Reads metadata only; never queues work. */
export async function comfyUISystemStats(
  connection: ComfyUIConnection,
  options: ComfyUIRequestOptions
): Promise<{
  system: { os: string | null; comfyuiVersion: string | null; pythonVersion: string | null };
  devices: { name: string; type: string | null; vramTotal: number | null }[];
}> {
  const response = await send(connection, options, 'system_stats');
  if (!response.ok)
    throw new IllustrationError(
      response.status >= 500 ? 'COMFYUI_HTTP_5XX' : 'COMFYUI_HTTP_ERROR',
      response.status >= 500,
      { comfyui: { httpStatus: response.status } }
    );
  const body = await readJson(response);
  if (!object(body) || !object(body.system))
    throw new IllustrationError('COMFYUI_RESPONSE_INVALID', false, {
      comfyui: { httpStatus: response.status },
    });
  const system = body.system;
  return {
    system: {
      os: bounded(system.os, 80) ?? null,
      comfyuiVersion: bounded(system.comfyui_version, 80) ?? null,
      pythonVersion: bounded(system.python_version, 80) ?? null,
    },
    devices: (Array.isArray(body.devices) ? body.devices.slice(0, 8) : [])
      .filter(object)
      .map((device) => ({
        name: bounded(device.name, 120) ?? 'device',
        type: bounded(device.type, 40) ?? null,
        vramTotal: Number.isSafeInteger(device.vram_total) ? Number(device.vram_total) : null,
      })),
  };
}

/** Is our prompt the one ComfyUI is executing right now? Unknown shapes answer false. */
async function isRunning(
  connection: ComfyUIConnection,
  options: ComfyUIRequestOptions,
  promptId: string
): Promise<boolean> {
  const response = await send(connection, options, 'queue');
  if (!response.ok) return false;
  const body = await readJson(response).catch(() => undefined);
  if (!object(body) || !Array.isArray(body.queue_running)) return false;
  return body.queue_running.some((entry) => Array.isArray(entry) && entry[1] === promptId);
}
/** Removes our pending prompt; interrupts only when our prompt is the one currently running. */
export async function cancelComfyUIPrompt(
  connection: ComfyUIConnection,
  promptId: string,
  options: ComfyUIRequestOptions = { signal: AbortSignal.timeout(3000) }
): Promise<{ removed: boolean; interrupted: boolean }> {
  const result = { removed: false, interrupted: false };
  try {
    if (await isRunning(connection, options, promptId)) {
      const stop = await send(connection, options, 'interrupt', { method: 'POST', body: {} });
      result.interrupted = stop.ok;
    }
  } catch {
    /* Cancellation is best effort; the local job state is already final. */
  }
  try {
    const removed = await send(connection, options, 'queue', { body: { delete: [promptId] } });
    result.removed = removed.ok;
  } catch {
    /* Same. */
  }
  return result;
}
export type ComfyUIResult =
  | { state: 'pending' }
  | { state: 'error'; statusMessages: string[] }
  | { state: 'completed'; images: ComfyUIImage[] };
/** One read of an accepted prompt: never resubmits, so it doubles as the reconcile path. */
export async function fetchComfyUIResult(
  connection: ComfyUIConnection,
  promptId: string,
  options: ComfyUIRequestOptions & { maxImages?: number }
): Promise<ComfyUIResult> {
  const response = await send(connection, options, `history/${encodeURIComponent(promptId)}`);
  if (!response.ok) {
    if (response.status >= 500)
      throw new IllustrationError('COMFYUI_HTTP_5XX', true, {
        comfyui: { promptId, httpStatus: response.status },
      });
    return { state: 'pending' };
  }
  const body = await readJson(response);
  if (!object(body) || !object(body[promptId])) return { state: 'pending' };
  const history = body[promptId] as Record<string, unknown>;
  const status = history.status;
  if (object(status) && status.status_str === 'error')
    return { state: 'error', statusMessages: statusMessages(status) };
  const outputs = object(history.outputs) ? Object.values(history.outputs) : [];
  const files: { filename: string; subfolder: string; type: string }[] = [];
  for (const output of outputs)
    if (object(output) && Array.isArray(output.images))
      for (const image of output.images)
        if (object(image) && typeof image.filename === 'string' && image.filename.trim())
          files.push({
            filename: image.filename,
            subfolder: typeof image.subfolder === 'string' ? image.subfolder : '',
            type: typeof image.type === 'string' ? image.type : 'output',
          });
  const finalOutputs = files.filter((file) => file.type === 'output');
  const selected = (finalOutputs.length ? finalOutputs : files).slice(0, options.maxImages ?? 4);
  if (!selected.length)
    throw new IllustrationError('COMFYUI_NO_IMAGE', false, {
      comfyui: { promptId, statusMessages: statusMessages(status) },
    });
  const images: ComfyUIImage[] = [];
  for (const file of selected) {
    const view = await send(connection, options, 'view', {
      query: { filename: file.filename, subfolder: file.subfolder, type: file.type },
    });
    if (!view.ok)
      throw new IllustrationError('COMFYUI_IMAGE_INVALID', false, {
        comfyui: { promptId, httpStatus: view.status },
      });
    const bytes = Buffer.from(await view.arrayBuffer());
    const mime = detectImageMime(bytes);
    if (!mime || bytes.length > ILLUSTRATION_MAX_IMAGE_BYTES)
      throw new IllustrationError('COMFYUI_IMAGE_INVALID', false, { comfyui: { promptId } });
    images.push({ mime, bytes, filename: file.filename });
  }
  return { state: 'completed', images };
}

/**
 * POST /prompt, poll GET /history/{id}, fetch GET /view. An explicit abort cancels our prompt;
 * a timeout leaves the remote render alone and reports the prompt_id for a later reconcile.
 */
export async function generateWithComfyUI(
  connection: ComfyUIConnection,
  workflow: ComfyWorkflow,
  options: ComfyUIGenerateOptions
): Promise<{ promptId: string; images: ComfyUIImage[]; elapsedMs: number }> {
  const started = Date.now();
  const clientId = randomUUID();
  const submitted = await send(connection, options, 'prompt', {
    body: { prompt: workflow, client_id: clientId },
  });
  if (!submitted.ok) {
    const body = await readJson(submitted).catch(() => undefined);
    const diagnostic: ComfyDiagnostic = {
      httpStatus: submitted.status,
      nodeErrors: object(body) ? nodeErrors(body.node_errors) : undefined,
      statusMessages:
        object(body) && object(body.error)
          ? [bounded(body.error.message, 400), bounded(body.error.details, 400)].filter(
              (item): item is string => !!item
            )
          : [],
    };
    throw new IllustrationError(
      submitted.status >= 500 ? 'COMFYUI_HTTP_5XX' : 'COMFYUI_PROMPT_REJECTED',
      submitted.status >= 500,
      { comfyui: diagnostic }
    );
  }
  const accepted = await readJson(submitted);
  if (!object(accepted) || typeof accepted.prompt_id !== 'string' || !accepted.prompt_id.trim())
    throw new IllustrationError('COMFYUI_RESPONSE_INVALID', false, {
      comfyui: { httpStatus: submitted.status },
    });
  const promptId = accepted.prompt_id;
  await options.onSubmitted?.(promptId);
  try {
    for (;;) {
      if (options.signal.aborted) throw new IllustrationError('ILLUSTRATION_CANCELLED');
      if (Date.now() - started > options.timeoutMs)
        throw new IllustrationError('COMFYUI_TIMEOUT', false, { comfyui: { promptId } });
      const result = await fetchComfyUIResult(connection, promptId, options);
      if (result.state === 'error')
        throw new IllustrationError('COMFYUI_EXECUTION_FAILED', true, {
          comfyui: { promptId, statusMessages: result.statusMessages },
        });
      if (result.state === 'completed')
        return { promptId, images: result.images, elapsedMs: Date.now() - started };
      await sleep(options.pollIntervalMs, options.signal);
    }
  } catch (error) {
    if (error instanceof IllustrationError && error.code === 'ILLUSTRATION_CANCELLED')
      await cancelComfyUIPrompt(connection, promptId);
    throw error;
  }
}
