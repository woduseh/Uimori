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
import(workerData.module).then(async module => {
  const result = await module[workerData.method](workerData.input);
  parentPort.postMessage({ ok: true, result });
}).catch(error => parentPort.postMessage({ ok: false, code: String(error.message || error) }));
`;

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
    const worker = new Worker(bootstrap, {
      eval: true,
      env: {},
      execArgv: ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'],
      workerData: { module: module.href, method, input },
      resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    });
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
