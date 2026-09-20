import { Worker } from 'node:worker_threads';

// The source resolver is only for uncompiled development/tests. Production resolves built .js.
const bootstrap = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { registerHooks } = require('node:module');
const { existsSync } = require('node:fs');
const { fileURLToPath } = require('node:url');
registerHooks({ resolve(specifier, context, nextResolve) {
  if ((specifier.startsWith('.') || specifier.startsWith('file:')) && specifier.endsWith('.js')) {
    const url = new URL(specifier, context.parentURL);
    if (!existsSync(fileURLToPath(url))) return nextResolve(url.href.slice(0, -3) + '.ts', context);
  }
  return nextResolve(specifier, context);
}});
import(workerData.module).then(module => {
  const run = async input => {
    try {
      const result = await module[workerData.method](input);
      parentPort.postMessage({ ok: true, result });
    } catch (error) {
      parentPort.postMessage({ ok: false, code: String(error.message || error) });
    }
  };
  if (workerData.session) parentPort.on('message', run);
  else void run(workerData.input);
}).catch(error => parentPort.postMessage({ ok: false, code: String(error.message || error) }));
`;

function startWorker(module: URL, method: string, input: unknown, session = false) {
  return new Worker(bootstrap, {
    eval: true,
    env: {},
    execArgv: ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'],
    workerData: { module: module.href, method, input, session },
    resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
  });
}

/** Only trusted host module names enter here; authored content is structured workerData. */
export function runNativeRisuWorker<T>(
  module: URL,
  method: string,
  input: unknown,
  timeoutMs = 3000,
  signal?: AbortSignal
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 15_000)
    throw new Error('RISU_NATIVE_TIMEOUT_INVALID');
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('CANCELLED'));
    const worker = startWorker(module, method, input);
    let settled = false;
    const finish = (error?: Error, result?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      void worker.terminate().then(() => (error ? reject(error) : resolve(result!)), reject);
    };
    const timer = setTimeout(() => finish(new Error('RISU_NATIVE_TIMEOUT')), timeoutMs);
    const abort = () => finish(new Error('CANCELLED'));
    signal?.addEventListener('abort', abort, { once: true });
    worker.once('message', (message) =>
      message.ok ? finish(undefined, message.result) : finish(new Error(message.code))
    );
    worker.once('error', (error) =>
      finish(error instanceof Error ? error : new Error('RISU_NATIVE_WORKER_FAILED'))
    );
    worker.once('exit', () => {
      if (!settled) finish(new Error('RISU_NATIVE_WORKER_EXIT'));
    });
  });
}

/**
 * One request owns one lazy, serial worker. Only stateless trusted render methods use sessions;
 * Lua VMs and other one-shot execution remain isolated. Always close in a caller's finally.
 * Results are never cached and no worker survives its owning request. Each call keeps its budget.
 */
export function createNativeRisuWorkerSession<Input, Result>(
  module: URL,
  method: string,
  timeoutMs = 3000,
  signal?: AbortSignal
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 15_000)
    throw new Error('RISU_NATIVE_TIMEOUT_INVALID');
  let worker: Worker | undefined;
  let stopped: Error | undefined;
  let closing: Promise<void> | undefined;
  let pending:
    | {
        resolve: (result: Result) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  const stop = (error: Error): Promise<void> => {
    stopped ??= error;
    signal?.removeEventListener('abort', abort);
    const current = pending;
    pending = undefined;
    if (current) clearTimeout(current.timer);
    closing ??= worker ? worker.terminate().then(() => {}) : Promise.resolve();
    if (current) void closing.then(() => current.reject(stopped!), current.reject);
    return closing;
  };
  const fail = (error: Error) => {
    // A pending call receives the failure; close() also observes a failed termination.
    void stop(error).catch(() => {});
  };
  const abort = () => fail(new Error('CANCELLED'));
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  return {
    run(input: Input): Promise<Result> {
      if (stopped) return Promise.reject(stopped);
      // No queue: the caller must preserve authored display-hook/render ordering.
      if (pending) return Promise.reject(new Error('RISU_NATIVE_WORKER_BUSY'));
      return new Promise<Result>((resolve, reject) => {
        pending = {
          resolve,
          reject,
          timer: setTimeout(() => fail(new Error('RISU_NATIVE_TIMEOUT')), timeoutMs),
        };
        try {
          if (!worker) {
            worker = startWorker(module, method, undefined, true);
            worker.on('message', (message) => {
              const current = pending;
              if (!current || stopped) return;
              if (!message.ok) return fail(new Error(message.code));
              pending = undefined;
              clearTimeout(current.timer);
              current.resolve(message.result);
            });
            worker.once('error', (error) =>
              fail(error instanceof Error ? error : new Error('RISU_NATIVE_WORKER_FAILED'))
            );
            worker.once('exit', () => {
              if (!stopped) fail(new Error('RISU_NATIVE_WORKER_EXIT'));
            });
          }
          worker.postMessage(input);
        } catch (error) {
          fail(error instanceof Error ? error : new Error('RISU_NATIVE_WORKER_FAILED'));
        }
      });
    },
    close: () => stop(new Error('RISU_NATIVE_WORKER_CLOSED')),
  };
}
