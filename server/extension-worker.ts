import variant from '@jitl/quickjs-wasmfile-release-sync';
import {
  DefaultIntrinsics,
  newQuickJSWASMModuleFromVariant,
  newVariant,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
} from 'quickjs-emscripten-core';
import { parentPort, workerData } from 'node:worker_threads';
import type {
  ExtensionGuestHostErrorCode,
  ExtensionHostReply,
  ExtensionWorkerInput,
  ExtensionWorkerLimits,
  ExtensionWorkerMessage,
  ExtensionWorkerPhase,
  ExtensionWorkerResultCode,
} from './extension-worker-protocol.js';

type SyncVariant = Extract<Parameters<typeof newVariant>[0], { type: 'sync' }>;
const releaseVariant = variant as unknown as SyncVariant;
const WASM_PAGES = 256;
const WASM_BYTES = WASM_PAGES * 65_536;
const LIMIT_KEYS: (keyof ExtensionWorkerLimits)[] = [
  'cpuMs',
  'guestJsonBytes',
  'sourceBytes',
  'hostMethodChars',
  'hostCalls',
  'hostPending',
  'hostResultBytes',
  'valueDepth',
  'valueNodes',
  'valueEntries',
  'quickjsMemoryBytes',
  'quickjsStackBytes',
  'luaMemoryBytes',
];
/** The runtime owns every bound; this worker refuses to start rather than invent a fallback. */
function validLimits(value: unknown): value is ExtensionWorkerLimits {
  if (!value || typeof value !== 'object') return false;
  const limits = value as Record<string, unknown>;
  return LIMIT_KEYS.every((key) => {
    const limit = limits[key];
    return typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0;
  });
}

let replied = false;
function reply(value: ExtensionWorkerMessage) {
  if (value.type === 'result') {
    if (replied) return;
    replied = true;
  } else if (replied) return;
  parentPort?.postMessage(value);
}

function exactRecord(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

/** Builds the in-guest harness. Every bound is interpolated from the runtime-owned limits. */
function harnessSource(limits: ExtensionWorkerLimits, hostErrorCodes: string[]) {
  return `(() => {
  'use strict';
  const array = Array.isArray;
  const finite = Number.isFinite;
  const descriptors = Object.getOwnPropertyDescriptors;
  const defineProperty = Object.defineProperty;
  const freeze = Object.freeze;
  const getPrototypeOf = Object.getPrototypeOf;
  const hasOwn = Object.hasOwn;
  const ownKeys = Reflect.ownKeys;
  const parse = JSON.parse;
  const stringify = JSON.stringify;
  const objectPrototype = Object.prototype;
  const arrayPrototype = Array.prototype;
  const SetCtor = Set;
  const setAdd = Set.prototype.add;
  const setDelete = Set.prototype.delete;
  const setHas = Set.prototype.has;
  const apply = Reflect.apply;
  const charCodeAt = String.prototype.charCodeAt;
  const ErrorCtor = Error;
  const hostErrorCodes = new SetCtor(${JSON.stringify(hostErrorCodes)});
  let hostCalls = 0;
  let hostPending = 0;
  let hostResultBytes = 0;

  function hostError(code) {
    const error = new ErrorCtor(code);
    defineProperty(error, 'code', { value: code, enumerable: true, writable: false, configurable: false });
    return error;
  }

  function utf8Bytes(text) {
    let bytes = 0;
    for (let index = 0; index < text.length; index++) {
      const code = apply(charCodeAt, text, [index]);
      if (code <= 0x7f) bytes += 1;
      else if (code <= 0x7ff) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
        const next = apply(charCodeAt, text, [index + 1]);
        if (next >= 0xdc00 && next <= 0xdfff) {
          bytes += 4;
          index++;
        } else bytes += 3;
      } else bytes += 3;
      if (bytes > ${limits.hostResultBytes}) return bytes;
    }
    return bytes;
  }

  function check(value, seen, depth, budget) {
    if (depth > ${limits.valueDepth} || ++budget.nodes > ${limits.valueNodes}) throw hostError('BEHAVIOR_HOST_ARGUMENTS');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number') {
      if (!finite(value)) throw hostError('BEHAVIOR_HOST_ARGUMENTS');
      return;
    }
    if (typeof value !== 'object' || apply(setHas, seen, [value]))
      throw hostError('BEHAVIOR_HOST_ARGUMENTS');
    apply(setAdd, seen, [value]);
    const names = ownKeys(value);
    const props = descriptors(value);
    if (array(value)) {
      if (getPrototypeOf(value) !== arrayPrototype || value.length > ${limits.valueEntries})
        throw hostError('BEHAVIOR_HOST_ARGUMENTS');
      if (names.some((key) => typeof key !== 'string'))
        throw hostError('BEHAVIOR_HOST_ARGUMENTS');
      for (let index = 0; index < value.length; index++) {
        const key = String(index);
        if (!hasOwn(value, key)) throw hostError('BEHAVIOR_HOST_ARGUMENTS');
        const descriptor = props[key];
        if (!descriptor || !hasOwn(descriptor, 'value') || !descriptor.enumerable)
          throw hostError('BEHAVIOR_HOST_ARGUMENTS');
        check(descriptor.value, seen, depth + 1, budget);
      }
      if (names.some((key) => key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key)))
        throw hostError('BEHAVIOR_HOST_ARGUMENTS');
    } else {
      if (getPrototypeOf(value) !== objectPrototype && getPrototypeOf(value) !== null)
        throw hostError('BEHAVIOR_HOST_ARGUMENTS');
      if (names.length > ${limits.valueEntries} || names.some((key) => typeof key !== 'string'))
        throw hostError('BEHAVIOR_HOST_ARGUMENTS');
      for (const key of names) {
        const descriptor = props[key];
        if (!descriptor || !hasOwn(descriptor, 'value') || !descriptor.enumerable)
          throw hostError('BEHAVIOR_HOST_ARGUMENTS');
        check(descriptor.value, seen, depth + 1, budget);
      }
    }
    apply(setDelete, seen, [value]);
  }

  async function hostCall(nativeCall, method, args) {
    if (typeof method !== 'string' || !method.length || method.length > ${limits.hostMethodChars})
      throw hostError('BEHAVIOR_HOST_ARGUMENTS');
    if (++hostCalls > ${limits.hostCalls}) throw hostError('BEHAVIOR_HOST_CALL_LIMIT');
    if (hostPending >= ${limits.hostPending}) throw hostError('BEHAVIOR_HOST_PENDING_LIMIT');
    check(args, new SetCtor(), 0, { nodes: 0 });
    const argsJson = stringify(args);
    if (typeof argsJson !== 'string' || utf8Bytes(argsJson) > ${limits.guestJsonBytes})
      throw hostError('BEHAVIOR_HOST_ARGUMENTS');
    hostPending++;
    try {
      const resultJson = await nativeCall(method, argsJson);
      if (typeof resultJson !== 'string') throw hostError('BEHAVIOR_HOST_CALL_FAILED');
      const bytes = utf8Bytes(resultJson);
      hostResultBytes += bytes;
      if (bytes > ${limits.guestJsonBytes} || hostResultBytes > ${limits.hostResultBytes})
        throw hostError('BEHAVIOR_HOST_RESULT_LIMIT');
      const result = parse(resultJson);
      check(result, new SetCtor(), 0, { nodes: 0 });
      return result;
    } catch (error) {
      const code = error && typeof error.message === 'string' && hostErrorCodes.has(error.message)
        ? error.message
        : 'BEHAVIOR_HOST_CALL_FAILED';
      throw hostError(code);
    } finally {
      hostPending--;
    }
  }

  return async (fn, inputJSON, nativeCall) => {
    const api = parse(inputJSON);
    const host = freeze({ call: (method, args) => hostCall(nativeCall, method, args) });
    defineProperty(api, 'host', { value: host, enumerable: false, writable: false, configurable: false });
    let value;
    try {
      value = await fn(api);
    } catch {
      return 'E';
    }
    try {
      if (value === null || typeof value !== 'object' || array(value) || getPrototypeOf(value) !== objectPrototype)
        return 'V';
      const root = descriptors(value);
      const rootKeys = ownKeys(value);
      if (
        rootKeys.length !== 2 ||
        !hasOwn(root, 'state') ||
        !hasOwn(root, 'result') ||
        !root.state.enumerable ||
        !root.result.enumerable ||
        !hasOwn(root.state, 'value') ||
        !hasOwn(root.result, 'value')
      ) return 'V';
      check(value, new SetCtor(), 0, { nodes: 0 });
      const json = stringify(value);
      if (typeof json !== 'string' || utf8Bytes(json) > ${limits.guestJsonBytes}) return 'L';
      return 'O' + json;
    } catch {
      return 'V';
    }
  };
})()`;
}

async function run() {
  const input = workerData as ExtensionWorkerInput;
  if (
    !input ||
    typeof input !== 'object' ||
    !validLimits(input.limits) ||
    typeof input.source !== 'string' ||
    typeof input.inputJSON !== 'string' ||
    !Array.isArray(input.hostErrorCodes) ||
    Buffer.byteLength(input.source) > input.limits.sourceBytes ||
    Buffer.byteLength(input.inputJSON) > input.limits.guestJsonBytes
  ) {
    reply({ type: 'result', ok: false, code: 'BEHAVIOR_PROGRAM_INPUT_SIZE' });
    return;
  }
  const limits = input.limits;
  const guestHostErrorCodes: ExtensionGuestHostErrorCode[] = [
    'BEHAVIOR_HOST_CALL_LIMIT',
    'BEHAVIOR_HOST_PENDING_LIMIT',
  ];
  const hostErrorCodes = [...input.hostErrorCodes, ...guestHostErrorCodes];

  const memory = new WebAssembly.Memory({ initial: WASM_PAGES, maximum: WASM_PAGES });
  const quickjs = await newQuickJSWASMModuleFromVariant(
    newVariant(releaseVariant, { wasmMemory: memory })
  );
  if (quickjs.getWasmMemory() !== memory || memory.buffer.byteLength !== WASM_BYTES)
    throw new Error('WASM_MEMORY_BOUNDARY');

  let cpuUsed = 0;
  let cpuStarted = 0;
  let cpuActive = false;
  let cpuTimedOut = false;
  const runtime = quickjs.newRuntime({
    interruptHandler: () => {
      if (!cpuActive) return false;
      if (cpuUsed + performance.now() - cpuStarted < limits.cpuMs) return false;
      cpuTimedOut = true;
      return true;
    },
    maxStackSizeBytes: limits.quickjsStackBytes,
    memoryLimitBytes: limits.quickjsMemoryBytes,
  });
  runtime.removeModuleLoader();
  const context = runtime.newContext({
    intrinsics: { ...DefaultIntrinsics, Date: false, Promise: true },
  });
  const cpu = <T>(operation: () => T): T => {
    cpuStarted = performance.now();
    cpuActive = true;
    try {
      return operation();
    } finally {
      cpuUsed += performance.now() - cpuStarted;
      cpuActive = false;
    }
  };
  let harness: QuickJSHandle | undefined;
  let extension: QuickJSHandle | undefined;
  let json: QuickJSHandle | undefined;
  let nativeHostCall: QuickJSHandle | undefined;
  let promise: QuickJSHandle | undefined;
  let fatalCode: ExtensionWorkerResultCode | undefined;
  let wake: (() => void) | undefined;
  let hostResultBytes = 0;
  const hostPending = new Map<number, QuickJSDeferredPromise>();
  let phase: ExtensionWorkerPhase = 'active';
  let phaseSequence = 0;
  const enterPhase = (next: ExtensionWorkerPhase) => {
    if (phase === next) return;
    phase = next;
    reply({
      type: 'phase',
      phase,
      sequence: ++phaseSequence,
      hostIds: phase === 'host-wait' ? [...hostPending.keys()] : [],
    });
  };
  const notify = () => {
    const current = wake;
    wake = undefined;
    current?.();
  };
  const protocolFailure = () => {
    fatalCode = 'BEHAVIOR_PROGRAM_RUNTIME_FAILED';
    notify();
  };
  const onHostReply = (message: unknown) => {
    if (replied) return;
    if (
      exactRecord(message, ['type', 'id', 'ok', 'json']) &&
      message.type === 'host-result' &&
      message.ok === true &&
      Number.isSafeInteger(message.id) &&
      Number(message.id) >= 1
    ) {
      const response = message as unknown as Extract<ExtensionHostReply, { ok: true }>;
      const deferred = hostPending.get(response.id);
      if (!deferred) {
        protocolFailure();
        return;
      }
      hostPending.delete(response.id);
      if (
        typeof response.json !== 'string' ||
        Buffer.byteLength(response.json) > limits.guestJsonBytes ||
        (hostResultBytes += Buffer.byteLength(response.json)) > limits.hostResultBytes
      ) {
        protocolFailure();
        return;
      }
      enterPhase('active');
      const resultJson = context.newString(response.json);
      deferred.resolve(resultJson);
      resultJson.dispose();
      notify();
      return;
    }
    if (
      exactRecord(message, ['type', 'id', 'ok', 'code']) &&
      message.type === 'host-result' &&
      message.ok === false &&
      Number.isSafeInteger(message.id) &&
      Number(message.id) >= 1
    ) {
      const response = message as unknown as Extract<ExtensionHostReply, { ok: false }>;
      const deferred = hostPending.get(response.id);
      if (!deferred) {
        protocolFailure();
        return;
      }
      hostPending.delete(response.id);
      if (typeof response.code !== 'string' || !hostErrorCodes.includes(response.code)) {
        protocolFailure();
        return;
      }
      enterPhase('active');
      const error = context.newError(response.code);
      deferred.reject(error);
      error.dispose();
      notify();
      return;
    }
    protocolFailure();
  };
  parentPort?.on('message', onHostReply);
  try {
    const hardened = context.evalCode(
      `const __AsyncFunctionPrototype = Object.getPrototypeOf(async function(){});
       const __GeneratorFunctionPrototype = Object.getPrototypeOf(function*(){});
       const __AsyncGeneratorFunctionPrototype = Object.getPrototypeOf(async function*(){});
       Object.defineProperty(Math, 'random', { value: undefined });
       for (const prototype of [Function.prototype, __AsyncFunctionPrototype, __GeneratorFunctionPrototype, __AsyncGeneratorFunctionPrototype]) {
         Object.defineProperty(prototype, 'constructor', { value: undefined });
         Object.freeze(prototype);
       }
       Object.defineProperty(globalThis, 'eval', { value: undefined });
       Object.defineProperty(globalThis, 'Function', { value: undefined });
       for (const value of [Object.prototype, Array.prototype, String.prototype, Number.prototype, Boolean.prototype, RegExp.prototype, Map.prototype, Set.prototype, Promise.prototype, Promise, JSON, Reflect, Math]) Object.freeze(value);`,
      'uimori-bootstrap.js'
    );
    if (hardened.error) {
      hardened.error.dispose();
      reply({ type: 'result', ok: false, code: 'BEHAVIOR_PROGRAM_RUNTIME_FAILED' });
      return;
    }
    hardened.value.dispose();

    const harnessResult = context.evalCode(
      harnessSource(limits, hostErrorCodes),
      'uimori-harness.js'
    );
    if (harnessResult.error) {
      harnessResult.error.dispose();
      reply({ type: 'result', ok: false, code: 'BEHAVIOR_PROGRAM_RUNTIME_FAILED' });
      return;
    }
    harness = harnessResult.value;

    const extensionResult = cpu(() =>
      context.evalCode(
        `(async function(api) { 'use strict';\n${input.source}\n})`,
        'package-extension.js'
      )
    );
    if (extensionResult.error) {
      extensionResult.error.dispose();
      reply({
        type: 'result',
        ok: false,
        code: cpuTimedOut ? 'BEHAVIOR_PROGRAM_TIMEOUT' : 'BEHAVIOR_PROGRAM_FAILED',
      });
      return;
    }
    extension = extensionResult.value;
    json = context.newString(input.inputJSON);
    let nextHostId = 0;
    nativeHostCall = context.newFunction('uimoriHostCall', (methodHandle, argsHandle) => {
      if (
        context.typeof(methodHandle) !== 'string' ||
        context.typeof(argsHandle) !== 'string' ||
        hostPending.size >= limits.hostPending ||
        nextHostId >= limits.hostCalls
      ) {
        const rejected = context.newPromise();
        const error = context.newError('BEHAVIOR_HOST_CALL_FAILED');
        rejected.reject(error);
        error.dispose();
        return rejected.handle;
      }
      const method = context.getString(methodHandle);
      const argsJson = context.getString(argsHandle);
      if (
        !method.length ||
        method.length > limits.hostMethodChars ||
        Buffer.byteLength(argsJson) > limits.guestJsonBytes
      ) {
        const rejected = context.newPromise();
        const error = context.newError('BEHAVIOR_HOST_CALL_FAILED');
        rejected.reject(error);
        error.dispose();
        return rejected.handle;
      }
      const id = ++nextHostId;
      const deferred = context.newPromise();
      hostPending.set(id, deferred);
      reply({ type: 'host-call', id, method, argsJson });
      return deferred.handle;
    });
    const called = cpu(() =>
      context.callFunction(harness!, context.undefined, extension!, json!, nativeHostCall!)
    );
    if (called.error) {
      called.error.dispose();
      reply({
        type: 'result',
        ok: false,
        code: cpuTimedOut ? 'BEHAVIOR_PROGRAM_TIMEOUT' : 'BEHAVIOR_PROGRAM_FAILED',
      });
      return;
    }
    promise = called.value;

    while (!fatalCode) {
      const jobs = cpu(() => runtime.executePendingJobs());
      if (jobs.error) {
        jobs.error.dispose();
        fatalCode = cpuTimedOut ? 'BEHAVIOR_PROGRAM_TIMEOUT' : 'BEHAVIOR_PROGRAM_FAILED';
        break;
      }
      const state = context.getPromiseState(promise);
      if (state.type === 'fulfilled') {
        if (cpuTimedOut) {
          state.value.dispose();
          fatalCode = 'BEHAVIOR_PROGRAM_TIMEOUT';
          break;
        }
        if (context.typeof(state.value) !== 'string') {
          state.value.dispose();
          fatalCode = 'BEHAVIOR_PROGRAM_RUNTIME_FAILED';
          break;
        }
        const lengthHandle = context.getProp(state.value, 'length');
        const length = context.getNumber(lengthHandle);
        lengthHandle.dispose();
        if (!Number.isSafeInteger(length) || length < 1 || length > limits.guestJsonBytes + 1) {
          state.value.dispose();
          fatalCode = 'BEHAVIOR_PROGRAM_OUTPUT_SIZE';
          break;
        }
        const encoded = context.getString(state.value);
        state.value.dispose();
        if (encoded === 'E') fatalCode = 'BEHAVIOR_PROGRAM_FAILED';
        else if (encoded === 'V') fatalCode = 'BEHAVIOR_PROGRAM_RESULT_VALUE';
        else if (encoded === 'L') fatalCode = 'BEHAVIOR_PROGRAM_OUTPUT_SIZE';
        else if (encoded.startsWith('O'))
          reply({ type: 'result', ok: true, json: encoded.slice(1) });
        else fatalCode = 'BEHAVIOR_PROGRAM_RUNTIME_FAILED';
        break;
      }
      if (state.type === 'rejected') {
        state.error.dispose();
        fatalCode = cpuTimedOut ? 'BEHAVIOR_PROGRAM_TIMEOUT' : 'BEHAVIOR_PROGRAM_FAILED';
        break;
      }
      if (hostPending.size && !runtime.hasPendingJob()) enterPhase('host-wait');
      else enterPhase('active');
      await new Promise<void>((resolve) => {
        wake = resolve;
        if (!hostPending.size) setImmediate(notify);
      });
    }
    if (fatalCode && !replied) reply({ type: 'result', ok: false, code: fatalCode });
  } finally {
    parentPort?.off('message', onHostReply);
    if (promise?.alive) promise.dispose();
    if (nativeHostCall?.alive) nativeHostCall.dispose();
    if (json?.alive) json.dispose();
    if (extension?.alive) extension.dispose();
    if (harness?.alive) harness.dispose();
    context.dispose();
    runtime.dispose();
  }
}

run().catch(() => reply({ type: 'result', ok: false, code: 'BEHAVIOR_PROGRAM_RUNTIME_FAILED' }));
