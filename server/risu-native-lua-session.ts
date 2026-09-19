import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import type { ExtensionWorkerLimits, ExtensionWorkerMessage } from './extension-worker-protocol.js';

export const NATIVE_LUA_LIMITS: ExtensionWorkerLimits = {
  cpuMs: 1_000,
  guestJsonBytes: 2 * 1024 * 1024,
  sourceBytes: 1024 * 1024,
  hostMethodChars: 80,
  hostCalls: 128,
  hostPending: 1,
  hostResultBytes: 4 * 1024 * 1024,
  valueDepth: 32,
  valueNodes: 100_000,
  valueEntries: 10_000,
  quickjsMemoryBytes: 8 * 1024 * 1024,
  quickjsStackBytes: 256 * 1024,
  luaMemoryBytes: 8 * 1024 * 1024,
};
type Host = (method: string, args: unknown, signal: AbortSignal) => Promise<unknown>;
type Options = { signal?: AbortSignal; sessionKey?: string };
const failure = (code: string) => Object.assign(new Error(code), { code, statusCode: 400 });
const sessions = new Map<string, Session>();
const queues = new Map<string, Promise<unknown>>();
let executing = 0;
let queued = 0;
const json = (value: unknown) => {
  const encoded = JSON.stringify(value);
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > NATIVE_LUA_LIMITS.guestJsonBytes)
    throw failure('RISU_NATIVE_VALUE_LIMIT');
  return encoded;
};
interface Invocation {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  host: Host;
  signal?: AbortSignal;
  abort: () => void;
  controller: AbortController;
  hostFailure?: unknown;
}
class Session {
  worker?: Worker;
  current?: Invocation;
  waitingId?: number;
  hostId = 0;
  pending = false;
  closed = false;
  timer?: ReturnType<typeof setTimeout>;
  readonly work = new Set<Promise<void>>();
  constructor(
    readonly source: string,
    readonly fingerprint: string,
    readonly key?: string
  ) {}
  watch(ms: number, idle = false) {
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => this.dispose(idle ? undefined : failure('RISU_NATIVE_TIMEOUT')),
      ms
    );
    if (idle) this.timer.unref();
  }
  dispose(error: unknown = failure('RISU_NATIVE_SESSION_CLOSED')) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    if (this.key && sessions.get(this.key) === this) sessions.delete(this.key);
    const current = this.current;
    this.current = undefined;
    if (current) executing--;
    current?.signal?.removeEventListener('abort', current.abort);
    current?.controller.abort();
    const termination = this.worker?.terminate();
    void Promise.allSettled([termination, ...this.work]).then(() => current?.reject(error));
  }
  complete(result: unknown) {
    const current = this.current;
    if (!current) return this.dispose(failure('RISU_NATIVE_WORKER_PROTOCOL'));
    const value = result && typeof result === 'object' ? (result as Record<string, unknown>) : {};
    if (value.ok !== true) {
      const detail =
        typeof value.error === 'string' ? value.error.slice(0, 300) : 'RISU_NATIVE_LUA_FAILED';
      return this.dispose(current.hostFailure ?? failure(detail));
    }
    this.current = undefined;
    executing--;
    current.signal?.removeEventListener('abort', current.abort);
    current.controller.abort();
    if (!this.key) this.dispose();
    else {
      this.worker?.unref();
      this.watch(10 * 60 * 1000, true);
    }
    current.resolve(result);
  }
  message(value: ExtensionWorkerMessage) {
    if (this.closed) return;
    if (!value || typeof value !== 'object')
      return this.dispose(failure('RISU_NATIVE_WORKER_PROTOCOL'));
    if (value.type === 'phase') return;
    if (value.type === 'result')
      return this.dispose(failure(value.ok ? 'RISU_NATIVE_SESSION_ENDED' : value.code));
    if (
      value.type !== 'host-call' ||
      this.pending ||
      !this.current ||
      value.id !== this.hostId + 1 ||
      typeof value.method !== 'string' ||
      typeof value.argsJson !== 'string' ||
      Buffer.byteLength(value.argsJson) > NATIVE_LUA_LIMITS.guestJsonBytes
    )
      return this.dispose(failure('RISU_NATIVE_WORKER_PROTOCOL'));
    this.hostId = value.id;
    let args: unknown;
    try {
      args = JSON.parse(value.argsJson);
    } catch {
      return this.dispose(failure('RISU_NATIVE_WORKER_PROTOCOL'));
    }
    if (value.method === '__native.next') {
      this.waitingId = value.id;
      this.complete(args);
      return;
    }
    const current = this.current;
    this.pending = true;
    this.watch(300_000);
    const operation = (async () => {
      try {
        const result = await current.host(value.method, args, current.controller.signal);
        if (!this.closed)
          this.worker!.postMessage({
            type: 'host-result',
            id: value.id,
            ok: true,
            json: json(result),
          });
      } catch (error) {
        current.hostFailure = error;
        if (!this.closed)
          this.worker!.postMessage({
            type: 'host-result',
            id: value.id,
            ok: false,
            code: 'RISU_NATIVE_HOST_UNAVAILABLE',
          });
      } finally {
        this.pending = false;
        if (!this.closed) this.watch(5_000);
      }
    })();
    this.work.add(operation);
    void operation.finally(() => this.work.delete(operation));
  }
  invoke(input: unknown, options: Options, host: Host): Promise<unknown> {
    if (this.closed || this.current) return Promise.reject(failure('RISU_NATIVE_SESSION_BUSY'));
    if (options.signal?.aborted) return Promise.reject(failure('RISU_NATIVE_ABORTED'));
    if (executing >= 8) return Promise.reject(failure('RISU_NATIVE_BUSY'));
    executing++;
    return new Promise((resolve, reject) => {
      const abort = () => this.dispose(failure('RISU_NATIVE_ABORTED'));
      this.current = {
        resolve,
        reject,
        host,
        signal: options.signal,
        abort,
        controller: new AbortController(),
      };
      options.signal?.addEventListener('abort', abort, { once: true });
      this.watch(5_000);
      try {
        if (!this.worker) {
          const compiled = new URL('./extension-lua-worker.js', import.meta.url);
          const file = existsSync(compiled)
            ? compiled
            : new URL('./extension-lua-worker.ts', import.meta.url);
          this.worker = new Worker(file, {
            execArgv: file.pathname.endsWith('.ts') ? ['--experimental-strip-types'] : undefined,
            env: {},
            workerData: {
              source: this.source,
              inputJSON: json({ state: {}, input }),
              limits: NATIVE_LUA_LIMITS,
              hostErrorCodes: ['RISU_NATIVE_HOST_UNAVAILABLE'],
            },
            resourceLimits: {
              maxOldGenerationSizeMb: 48,
              maxYoungGenerationSizeMb: 8,
              stackSizeMb: 2,
            },
          });
          this.worker.on('message', (value: ExtensionWorkerMessage) => this.message(value));
          this.worker.once('error', () => this.dispose(failure('RISU_NATIVE_WORKER_FAILED')));
          this.worker.once('exit', () => this.dispose(failure('RISU_NATIVE_WORKER_EXIT')));
        } else {
          if (this.waitingId === undefined) throw failure('RISU_NATIVE_WORKER_PROTOCOL');
          this.worker.ref();
          this.worker.postMessage({
            type: 'host-result',
            id: this.waitingId,
            ok: true,
            json: json(input),
            resetBudget: true,
          });
          this.waitingId = undefined;
        }
      } catch (error) {
        this.dispose(error);
      }
    });
  }
}

export function disposeNativeRisuSession(key: string) {
  sessions.get(key)?.dispose();
}
export function disposeAllNativeRisuSessions() {
  for (const session of sessions.values()) session.dispose();
}

/** One sandbox per caller-owned chat/branch/revision session; invocations serialize per key. */
export async function runNativeRisuLua(
  source: string,
  input: unknown,
  options: Options,
  host: Host
): Promise<unknown> {
  if (Buffer.byteLength(source) > NATIVE_LUA_LIMITS.sourceBytes)
    throw failure('RISU_NATIVE_SOURCE_LIMIT');
  const fingerprint = createHash('sha256').update(source).digest('hex');
  const key = options.sessionKey;
  const run = async () => {
    let session = key ? sessions.get(key) : undefined;
    if (session && session.fingerprint !== fingerprint) {
      session.dispose();
      session = undefined;
    }
    if (!session) {
      if (sessions.size >= 32) {
        const idle = [...sessions.values()].find((candidate) => !candidate.current);
        if (!idle) throw failure('RISU_NATIVE_BUSY');
        idle.dispose();
      }
      session = new Session(source, fingerprint, key);
      if (key) sessions.set(key, session);
    }
    return session.invoke(input, options, host);
  };
  if (!key) return run();
  if (key.length > 1000) throw failure('RISU_NATIVE_SESSION_KEY');
  if (queued >= 256) throw failure('RISU_NATIVE_BUSY');
  queued++;
  const previous = queues.get(key) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(run);
  queues.set(key, operation);
  try {
    return await operation;
  } finally {
    queued--;
    if (queues.get(key) === operation) queues.delete(key);
  }
}
