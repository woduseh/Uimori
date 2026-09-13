import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import {
  ExtensionProgramError,
  validateExtensionProgram,
  validateExtensionProgramResult,
  type ExtensionProgram,
  type ExtensionProgramResult,
} from '../core/extension-program.js';
import { inspectRuntimeValue, PromptBudget, type RuntimeValue } from '../core/prompt-values.js';

export const EXTENSION_RUNTIME_ENGINE = 'quickjs-emscripten@0.32.0';
export const EXTENSION_RUNTIME_LIMITS = Object.freeze({
  concurrent: 2,
  inputBytes: 128 * 1024,
  outputBytes: 128 * 1024,
  timeoutMs: 1_000,
});

type WorkerReply = { ok: true; json: string } | { ok: false; code: string };
let active = 0;
const waiting: { wake: () => void }[] = [];
async function acquireSlot(signal?: AbortSignal, wait = false) {
  if (signal?.aborted) throw fail('BEHAVIOR_PROGRAM_ABORTED');
  if (active < EXTENSION_RUNTIME_LIMITS.concurrent) {
    active++;
    return;
  }
  if (!wait || waiting.length >= 32) throw fail('BEHAVIOR_PROGRAM_BUSY');
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      const at = waiting.indexOf(item);
      if (at >= 0) waiting.splice(at, 1);
      reject(fail('BEHAVIOR_PROGRAM_ABORTED'));
    };
    const item = {
      wake: () => {
        signal?.removeEventListener('abort', abort);
        active++;
        resolve();
      },
    };
    waiting.push(item);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
function releaseSlot() {
  active--;
  waiting.shift()?.wake();
}

function fail(code: string): ExtensionProgramError {
  return new ExtensionProgramError(code);
}

function inputJSON(value: { state: RuntimeValue; input: RuntimeValue }) {
  let json: string;
  try {
    inspectRuntimeValue(
      value,
      new PromptBudget(
        {
          maxCollectionLength: 2_000,
          maxSteps: 100_000,
          maxValueChars: EXTENSION_RUNTIME_LIMITS.inputBytes,
          maxValueNodes: 30_000,
        },
        'deterministic'
      )
    );
    json = JSON.stringify(value);
  } catch {
    throw fail('BEHAVIOR_PROGRAM_INPUT_VALUE');
  }
  if (Buffer.byteLength(json) > EXTENSION_RUNTIME_LIMITS.inputBytes)
    throw fail('BEHAVIOR_PROGRAM_INPUT_SIZE');
  return json;
}

/**
 * Runs one data-only extension in a fresh Worker and a fresh fixed-memory QuickJS module.
 * The worker returns a bounded JSON string; this process never inspects guest objects.
 */
export async function executeExtensionProgram(
  value: ExtensionProgram,
  input: { state: RuntimeValue; input: RuntimeValue },
  signal?: AbortSignal,
  options?: { waitForSlot?: boolean }
): Promise<ExtensionProgramResult & { engine: string }> {
  const program = validateExtensionProgram(value);
  const encodedInput = inputJSON(input);
  if (signal?.aborted) throw fail('BEHAVIOR_PROGRAM_ABORTED');
  await acquireSlot(signal, options?.waitForSlot);
  try {
    if (signal?.aborted) throw fail('BEHAVIOR_PROGRAM_ABORTED');
    const compiled = new URL('./extension-worker.js', import.meta.url);
    const source = existsSync(compiled)
      ? compiled
      : new URL('./extension-worker.ts', import.meta.url);
    const worker = new Worker(source, {
      execArgv: source.pathname.endsWith('.ts') ? ['--experimental-strip-types'] : undefined,
      workerData: { source: program.source, inputJSON: encodedInput },
      resourceLimits: {
        codeRangeSizeMb: 16,
        maxOldGenerationSizeMb: 32,
        maxYoungGenerationSizeMb: 8,
        stackSizeMb: 2,
      },
    });
    return await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: ExtensionProgramError, result?: ExtensionProgramResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        void worker
          .terminate()
          .catch(() => undefined)
          .finally(() => {
            worker.removeAllListeners();
            if (error) reject(error);
            else resolve({ ...result!, engine: EXTENSION_RUNTIME_ENGINE });
          });
      };
      const abort = () => finish(fail('BEHAVIOR_PROGRAM_ABORTED'));
      const timer = setTimeout(
        () => finish(fail('BEHAVIOR_PROGRAM_TIMEOUT')),
        EXTENSION_RUNTIME_LIMITS.timeoutMs
      );
      signal?.addEventListener('abort', abort, { once: true });
      worker.once('message', (message: WorkerReply) => {
        if (!message || typeof message !== 'object' || typeof message.ok !== 'boolean') {
          finish(fail('BEHAVIOR_PROGRAM_RUNTIME_FAILED'));
          return;
        }
        if (!message.ok) {
          finish(fail(typeof message.code === 'string' ? message.code : 'BEHAVIOR_PROGRAM_FAILED'));
          return;
        }
        if (
          typeof message.json !== 'string' ||
          Buffer.byteLength(message.json) > EXTENSION_RUNTIME_LIMITS.outputBytes
        ) {
          finish(fail('BEHAVIOR_PROGRAM_OUTPUT_SIZE'));
          return;
        }
        try {
          finish(undefined, validateExtensionProgramResult(JSON.parse(message.json)));
        } catch (error) {
          finish(
            error instanceof ExtensionProgramError ? error : fail('BEHAVIOR_PROGRAM_RESULT_VALUE')
          );
        }
      });
      worker.once('messageerror', () => finish(fail('BEHAVIOR_PROGRAM_RUNTIME_FAILED')));
      worker.once('error', () => finish(fail('BEHAVIOR_PROGRAM_RUNTIME_FAILED')));
      worker.once('exit', () => {
        if (!settled) finish(fail('BEHAVIOR_PROGRAM_RUNTIME_FAILED'));
      });
    });
  } finally {
    releaseSlot();
  }
}
