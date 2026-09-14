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
export const EXTENSION_LUA_RUNTIME_ENGINE = 'wasmoon@1.16.0';
export const EXTENSION_RUNTIME_LIMITS = Object.freeze({
  concurrent: 2,
  inputBytes: 128 * 1024,
  outputBytes: 128 * 1024,
  timeoutMs: 1_000,
  hostWaitMs: 1_800_000,
  hostMethodChars: 80,
  hostCalls: 32,
  hostPending: 8,
  hostValueBytes: 128 * 1024,
  hostResultBytes: 512 * 1024,
});

export type ExtensionHostHandler = (
  method: string,
  args: RuntimeValue,
  signal: AbortSignal
) => Promise<RuntimeValue>;

export type ExtensionRuntimeOptions = {
  waitForSlot?: boolean;
  /** Edit hooks return one bounded text; other programs keep the small projection limit. */
  maxResultChars?: number;
  host?: ExtensionHostHandler;
  hostWaitMs?: number;
  awaitHostSettlement?: boolean;
};

type WorkerResult =
  | { type: 'result'; ok: true; json: string }
  | { type: 'result'; ok: false; code: string };
type WorkerHostCall = { type: 'host-call'; id: number; method: string; argsJson: string };
type WorkerPhase = {
  type: 'phase';
  phase: 'active' | 'host-wait';
  sequence: number;
  hostIds: number[];
};
type HostReply =
  | { type: 'host-result'; id: number; ok: true; json: string }
  | { type: 'host-result'; id: number; ok: false; code: string };

const safeHostCodes = new Set([
  'BEHAVIOR_HOST_CALL_FAILED',
  'BEHAVIOR_HOST_DENIED',
  'BEHAVIOR_HOST_ARGUMENTS',
  'BEHAVIOR_HOST_MATERIAL_UNAVAILABLE',
  'BEHAVIOR_HOST_ABORTED',
  'BEHAVIOR_HOST_RESULT_LIMIT',
  'BEHAVIOR_HOST_MODEL_DENIED',
  'BEHAVIOR_HOST_MODEL_UNAVAILABLE',
  'BEHAVIOR_HOST_MODEL_BUDGET_EXHAUSTED',
  'BEHAVIOR_HOST_VARIABLES_DENIED',
  'BEHAVIOR_HOST_VARIABLES_LIMIT',
  'BEHAVIOR_HOST_CONVERSATION_DENIED',
  'BEHAVIOR_HOST_CONVERSATION_UNAVAILABLE',
]);
const workerResultCodes = new Set([
  'BEHAVIOR_PROGRAM_INPUT_SIZE',
  'BEHAVIOR_PROGRAM_RUNTIME_FAILED',
  'BEHAVIOR_PROGRAM_FAILED',
  'BEHAVIOR_PROGRAM_TIMEOUT',
  'BEHAVIOR_PROGRAM_RESULT_VALUE',
  'BEHAVIOR_PROGRAM_OUTPUT_SIZE',
]);
let active = 0;
const waiting: { wake: () => void }[] = [];

function fail(code: string): ExtensionProgramError {
  return new ExtensionProgramError(code);
}

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

function inspectJSON(value: unknown, maxBytes: number, code: string): string {
  let json: string;
  try {
    inspectRuntimeValue(
      value,
      new PromptBudget(
        {
          maxCollectionLength: 2_000,
          maxSteps: 100_000,
          maxValueChars: maxBytes,
          maxValueNodes: 30_000,
        },
        'deterministic'
      )
    );
    json = JSON.stringify(value);
  } catch {
    throw fail(code);
  }
  if (Buffer.byteLength(json) > maxBytes) throw fail(code);
  return json;
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

function exactRecord(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.getOwnPropertySymbols(value).length === 0 &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function validCode(value: unknown): value is string {
  return typeof value === 'string' && workerResultCodes.has(value);
}

function publicHostCode(error: unknown) {
  return error instanceof ExtensionProgramError && safeHostCodes.has(error.code)
    ? error.code
    : 'BEHAVIOR_HOST_CALL_FAILED';
}

function expectedHostCancellation(error: unknown, signal: AbortSignal) {
  return (
    signal.aborted &&
    (error === signal.reason || (error instanceof Error && error.name === 'AbortError'))
  );
}

/**
 * Runs one extension in a fresh Worker and bounded guest runtime. Host reads cross an
 * explicit JSON RPC boundary; neither the Worker nor a guest object enters the host broker.
 */
export async function executeExtensionProgram(
  value: ExtensionProgram,
  input: { state: RuntimeValue; input: RuntimeValue },
  signal?: AbortSignal,
  options: ExtensionRuntimeOptions = {}
): Promise<ExtensionProgramResult & { engine: string }> {
  const program = validateExtensionProgram(value);
  const encodedInput = inputJSON(input);
  const hostWaitMs = options.hostWaitMs ?? 0;
  const awaitHostSettlement = options.awaitHostSettlement ?? false;
  if (
    !Number.isSafeInteger(hostWaitMs) ||
    hostWaitMs < 0 ||
    hostWaitMs > EXTENSION_RUNTIME_LIMITS.hostWaitMs ||
    typeof awaitHostSettlement !== 'boolean'
  )
    throw fail('BEHAVIOR_PROGRAM_RUNTIME_FAILED');
  if (signal?.aborted) throw fail('BEHAVIOR_PROGRAM_ABORTED');
  await acquireSlot(signal, options.waitForSlot);
  try {
    if (signal?.aborted) throw fail('BEHAVIOR_PROGRAM_ABORTED');
    const workerName = program.language === 'lua' ? 'extension-lua-worker' : 'extension-worker';
    const engine =
      program.language === 'lua' ? EXTENSION_LUA_RUNTIME_ENGINE : EXTENSION_RUNTIME_ENGINE;
    const compiled = new URL(`./${workerName}.js`, import.meta.url);
    const source = existsSync(compiled) ? compiled : new URL(`./${workerName}.ts`, import.meta.url);
    const worker = new Worker(source, {
      execArgv: source.pathname.endsWith('.ts') ? ['--experimental-strip-types'] : undefined,
      // The guest never needs the host environment; do not inherit provider keys into the worker.
      env: {},
      workerData: {
        source: program.source,
        inputJSON: encodedInput,
        hostErrorCodes: [...safeHostCodes],
      },
      resourceLimits: {
        codeRangeSizeMb: 16,
        maxOldGenerationSizeMb: 32,
        maxYoungGenerationSizeMb: 8,
        stackSizeMb: 2,
      },
    });
    return await new Promise((resolve, reject) => {
      let settled = false;
      let hostCalls = 0;
      let hostResultBytes = 0;
      let activeRemainingMs = EXTENSION_RUNTIME_LIMITS.timeoutMs;
      let hostWaitRemainingMs = hostWaitMs;
      let watchdogPhase: 'active' | 'host-wait' = 'active';
      let watchdogStarted = performance.now();
      let phaseSequence = 0;
      let settlementFatalError: Error | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const hostPending = new Set<number>();
      const hostWork = new Set<Promise<void>>();
      const hostController = new AbortController();
      const post = (message: HostReply) => {
        if (!settled) worker.postMessage(message);
      };
      const finish = (outcome: { error: unknown } | { result: ExtensionProgramResult }) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        hostController.abort();
        const termination = worker.terminate();
        const hostSettlement = awaitHostSettlement
          ? Promise.allSettled([...hostWork])
          : Promise.resolve();
        void Promise.allSettled([termination, hostSettlement]).then(() => {
          worker.removeAllListeners();
          if (settlementFatalError) reject(settlementFatalError);
          else if ('error' in outcome) reject(outcome.error);
          else resolve({ ...outcome.result, engine });
        });
      };
      const finishError = (error: unknown) => finish({ error });
      const finishResult = (result: ExtensionProgramResult) => finish({ result });
      const abort = () => finishError(fail('BEHAVIOR_PROGRAM_ABORTED'));
      const armWatchdog = () => {
        if (timer) clearTimeout(timer);
        watchdogStarted = performance.now();
        const remaining = watchdogPhase === 'active' ? activeRemainingMs : hostWaitRemainingMs;
        timer = setTimeout(
          () => finishError(fail('BEHAVIOR_PROGRAM_TIMEOUT')),
          Math.max(0, remaining)
        );
      };
      const enterPhase = (next: 'active' | 'host-wait') => {
        if (watchdogPhase === next) return;
        const elapsed = performance.now() - watchdogStarted;
        if (watchdogPhase === 'active') activeRemainingMs -= elapsed;
        else hostWaitRemainingMs -= elapsed;
        watchdogPhase = next;
        armWatchdog();
      };
      armWatchdog();
      signal?.addEventListener('abort', abort, { once: true });
      worker.on('message', (message: WorkerResult | WorkerHostCall | WorkerPhase) => {
        if (settled) return;
        if (
          exactRecord(message, ['type', 'phase', 'sequence', 'hostIds']) &&
          message.type === 'phase'
        ) {
          if (
            (message.phase !== 'active' && message.phase !== 'host-wait') ||
            !Number.isSafeInteger(message.sequence) ||
            message.sequence <= phaseSequence ||
            !Array.isArray(message.hostIds) ||
            message.hostIds.some(
              (id) => !Number.isSafeInteger(id) || id < 1 || id > EXTENSION_RUNTIME_LIMITS.hostCalls
            ) ||
            new Set(message.hostIds).size !== message.hostIds.length ||
            (message.phase === 'active' && message.hostIds.length !== 0) ||
            (message.phase === 'host-wait' && message.hostIds.length === 0)
          ) {
            finishError(fail('BEHAVIOR_PROGRAM_RUNTIME_FAILED'));
            return;
          }
          phaseSequence = message.sequence;
          // No extra wait budget preserves the original one-second wall limit for all work,
          // including short asynchronous read brokers; it is not a zero-duration host timeout.
          if (hostWaitMs === 0) return;
          if (message.phase === 'host-wait' && !message.hostIds.some((id) => hostPending.has(id)))
            return;
          enterPhase(message.phase);
          return;
        }
        if (
          exactRecord(message, ['type', 'id', 'method', 'argsJson']) &&
          message.type === 'host-call'
        ) {
          const { id, method, argsJson } = message;
          if (
            !Number.isSafeInteger(id) ||
            id < 1 ||
            id > EXTENSION_RUNTIME_LIMITS.hostCalls ||
            hostPending.has(id) ||
            hostCalls >= EXTENSION_RUNTIME_LIMITS.hostCalls ||
            hostPending.size >= EXTENSION_RUNTIME_LIMITS.hostPending ||
            typeof method !== 'string' ||
            !method.length ||
            method.length > EXTENSION_RUNTIME_LIMITS.hostMethodChars ||
            typeof argsJson !== 'string' ||
            Buffer.byteLength(argsJson) > EXTENSION_RUNTIME_LIMITS.hostValueBytes
          ) {
            finishError(fail('BEHAVIOR_PROGRAM_RUNTIME_FAILED'));
            return;
          }
          let args: RuntimeValue;
          try {
            args = JSON.parse(argsJson) as RuntimeValue;
            inspectJSON(args, EXTENSION_RUNTIME_LIMITS.hostValueBytes, 'BEHAVIOR_HOST_CALL_FAILED');
          } catch {
            finishError(fail('BEHAVIOR_PROGRAM_RUNTIME_FAILED'));
            return;
          }
          hostCalls++;
          hostPending.add(id);
          const work = Promise.resolve().then(async () => {
            try {
              if (!options.host) throw fail('BEHAVIOR_HOST_CALL_FAILED');
              const result = await options.host(
                method,
                structuredClone(args),
                hostController.signal
              );
              const json = inspectJSON(
                result,
                EXTENSION_RUNTIME_LIMITS.hostValueBytes,
                'BEHAVIOR_HOST_RESULT_LIMIT'
              );
              hostResultBytes += Buffer.byteLength(json);
              if (hostResultBytes > EXTENSION_RUNTIME_LIMITS.hostResultBytes)
                throw fail('BEHAVIOR_HOST_RESULT_LIMIT');
              post({ type: 'host-result', id, ok: true, json });
            } catch (error) {
              if (error instanceof ExtensionProgramError && safeHostCodes.has(error.code))
                post({ type: 'host-result', id, ok: false, code: publicHostCode(error) });
              else if (!expectedHostCancellation(error, hostController.signal)) {
                const fatal =
                  error instanceof Error ? error : new Error('BEHAVIOR_HOST_RUNTIME_FAILED');
                if (settled && awaitHostSettlement) settlementFatalError ??= fatal;
                else finishError(fatal);
              }
            } finally {
              hostPending.delete(id);
            }
          });
          hostWork.add(work);
          void work.then(() => hostWork.delete(work));
          return;
        }
        if (
          exactRecord(message, ['type', 'ok', 'json']) &&
          message.type === 'result' &&
          message.ok === true
        ) {
          if (
            typeof message.json !== 'string' ||
            Buffer.byteLength(message.json) > EXTENSION_RUNTIME_LIMITS.outputBytes
          ) {
            finishError(fail('BEHAVIOR_PROGRAM_OUTPUT_SIZE'));
            return;
          }
          try {
            finishResult(
              validateExtensionProgramResult(JSON.parse(message.json), options.maxResultChars)
            );
          } catch (error) {
            finishError(
              error instanceof ExtensionProgramError ? error : fail('BEHAVIOR_PROGRAM_RESULT_VALUE')
            );
          }
          return;
        }
        if (
          exactRecord(message, ['type', 'ok', 'code']) &&
          message.type === 'result' &&
          message.ok === false &&
          validCode(message.code)
        ) {
          finishError(fail(message.code));
          return;
        }
        finishError(fail('BEHAVIOR_PROGRAM_RUNTIME_FAILED'));
      });
      worker.once('messageerror', () => finishError(fail('BEHAVIOR_PROGRAM_RUNTIME_FAILED')));
      worker.once('error', () => finishError(fail('BEHAVIOR_PROGRAM_RUNTIME_FAILED')));
      worker.once('exit', () => {
        if (!settled) finishError(fail('BEHAVIOR_PROGRAM_RUNTIME_FAILED'));
      });
    });
  } finally {
    releaseSlot();
  }
}
