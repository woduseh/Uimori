import variant from '@jitl/quickjs-wasmfile-release-sync';
import {
  DefaultIntrinsics,
  newQuickJSWASMModuleFromVariant,
  newVariant,
  type QuickJSHandle,
} from 'quickjs-emscripten-core';
import { parentPort, workerData } from 'node:worker_threads';

type SyncVariant = Extract<Parameters<typeof newVariant>[0], { type: 'sync' }>;
const releaseVariant = variant as unknown as SyncVariant;

const WASM_PAGES = 256;
const WASM_BYTES = WASM_PAGES * 65_536;
const QUICKJS_MEMORY_BYTES = 8 * 1024 * 1024;
const QUICKJS_STACK_BYTES = 256 * 1024;
const CPU_MS = 100;
const MAX_JSON_BYTES = 128 * 1024;

type WorkerInput = { source: string; inputJSON: string };
type WorkerReply = { ok: true; json: string } | { ok: false; code: string };

function reply(value: WorkerReply) {
  parentPort?.postMessage(value);
}

const HARNESS = `(() => {
  'use strict';
  const array = Array.isArray;
  const finite = Number.isFinite;
  const descriptors = Object.getOwnPropertyDescriptors;
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
      if (bytes > ${MAX_JSON_BYTES}) return bytes;
    }
    return bytes;
  }

  function check(value, seen, depth, budget) {
    if (depth > 32 || ++budget.nodes > 30000) throw 0;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number') {
      if (!finite(value)) throw 0;
      return;
    }
    if (typeof value !== 'object' || apply(setHas, seen, [value])) throw 0;
    apply(setAdd, seen, [value]);
    const keys = ownKeys(value);
    const props = descriptors(value);
    if (array(value)) {
      if (getPrototypeOf(value) !== arrayPrototype || value.length > 2000) throw 0;
      if (keys.some((key) => typeof key !== 'string')) throw 0;
      for (let index = 0; index < value.length; index++) {
        const key = String(index);
        if (!hasOwn(value, key)) throw 0;
        const descriptor = props[key];
        if (!descriptor || !hasOwn(descriptor, 'value') || !descriptor.enumerable) throw 0;
        check(descriptor.value, seen, depth + 1, budget);
      }
      if (keys.some((key) => key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key))) throw 0;
    } else {
      if (getPrototypeOf(value) !== objectPrototype && getPrototypeOf(value) !== null) throw 0;
      if (keys.length > 2000 || keys.some((key) => typeof key !== 'string')) throw 0;
      for (const key of keys) {
        const descriptor = props[key];
        if (!descriptor || !hasOwn(descriptor, 'value') || !descriptor.enumerable) throw 0;
        check(descriptor.value, seen, depth + 1, budget);
      }
    }
    apply(setDelete, seen, [value]);
  }

  return (fn, inputJSON) => {
    let value;
    try {
      value = fn(parse(inputJSON));
    } catch {
      return 'E';
    }
    try {
      if (
        value === null ||
        typeof value !== 'object' ||
        array(value) ||
        getPrototypeOf(value) !== objectPrototype
      ) return 'V';
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
      if (typeof json !== 'string' || utf8Bytes(json) > ${MAX_JSON_BYTES}) return 'L';
      return 'O' + json;
    } catch {
      return 'V';
    }
  };
})()`;

async function run() {
  const input = workerData as WorkerInput;
  if (
    !input ||
    typeof input.source !== 'string' ||
    typeof input.inputJSON !== 'string' ||
    Buffer.byteLength(input.source) > 256 * 1024 ||
    Buffer.byteLength(input.inputJSON) > MAX_JSON_BYTES
  ) {
    reply({ ok: false, code: 'BEHAVIOR_PROGRAM_INPUT_SIZE' });
    return;
  }

  const memory = new WebAssembly.Memory({ initial: WASM_PAGES, maximum: WASM_PAGES });
  const quickjs = await newQuickJSWASMModuleFromVariant(
    newVariant(releaseVariant, { wasmMemory: memory })
  );
  if (quickjs.getWasmMemory() !== memory || memory.buffer.byteLength !== WASM_BYTES)
    throw new Error('WASM_MEMORY_BOUNDARY');

  const deadline = performance.now() + CPU_MS;
  const runtime = quickjs.newRuntime({
    interruptHandler: () => performance.now() >= deadline,
    maxStackSizeBytes: QUICKJS_STACK_BYTES,
    memoryLimitBytes: QUICKJS_MEMORY_BYTES,
  });
  runtime.removeModuleLoader();
  const context = runtime.newContext({
    intrinsics: { ...DefaultIntrinsics, Date: false, Promise: false },
  });
  let harness: QuickJSHandle | undefined;
  let extension: QuickJSHandle | undefined;
  let json: QuickJSHandle | undefined;
  try {
    const hardened = context.evalCode(
      `Object.defineProperty(Math, 'random', { value: undefined });\n` +
        `Object.defineProperty(Function.prototype, 'constructor', { value: undefined });\n` +
        `Object.freeze(Function.prototype);\n` +
        `Object.defineProperty(globalThis, 'eval', { value: undefined });\n` +
        `Object.defineProperty(globalThis, 'Function', { value: undefined });\n` +
        `for (const value of [Object.prototype, Array.prototype, String.prototype, Number.prototype, Boolean.prototype, RegExp.prototype, Map.prototype, Set.prototype, JSON, Reflect, Math]) Object.freeze(value);`,
      'uimori-bootstrap.js'
    );
    if (hardened.error) {
      hardened.error.dispose();
      reply({ ok: false, code: 'BEHAVIOR_PROGRAM_RUNTIME_FAILED' });
      return;
    }
    hardened.value.dispose();

    const harnessResult = context.evalCode(HARNESS, 'uimori-harness.js');
    if (harnessResult.error) {
      harnessResult.error.dispose();
      reply({ ok: false, code: 'BEHAVIOR_PROGRAM_RUNTIME_FAILED' });
      return;
    }
    harness = harnessResult.value;

    const extensionResult = context.evalCode(
      `(function(api) { 'use strict';\n${input.source}\n})`,
      'package-extension.js'
    );
    if (extensionResult.error) {
      extensionResult.error.dispose();
      reply({ ok: false, code: 'BEHAVIOR_PROGRAM_FAILED' });
      return;
    }
    extension = extensionResult.value;
    json = context.newString(input.inputJSON);
    const called = context.callFunction(harness, context.undefined, extension, json);
    if (called.error) {
      called.error.dispose();
      reply({
        ok: false,
        code:
          performance.now() >= deadline ? 'BEHAVIOR_PROGRAM_TIMEOUT' : 'BEHAVIOR_PROGRAM_FAILED',
      });
      return;
    }
    if (context.typeof(called.value) !== 'string') {
      called.value.dispose();
      reply({ ok: false, code: 'BEHAVIOR_PROGRAM_RUNTIME_FAILED' });
      return;
    }
    const lengthHandle = context.getProp(called.value, 'length');
    const length = context.getNumber(lengthHandle);
    lengthHandle.dispose();
    if (!Number.isSafeInteger(length) || length < 1 || length > MAX_JSON_BYTES + 1) {
      called.value.dispose();
      reply({ ok: false, code: 'BEHAVIOR_PROGRAM_OUTPUT_SIZE' });
      return;
    }
    const encoded = context.getString(called.value);
    called.value.dispose();
    if (encoded === 'E') reply({ ok: false, code: 'BEHAVIOR_PROGRAM_FAILED' });
    else if (encoded === 'V') reply({ ok: false, code: 'BEHAVIOR_PROGRAM_RESULT_VALUE' });
    else if (encoded === 'L') reply({ ok: false, code: 'BEHAVIOR_PROGRAM_OUTPUT_SIZE' });
    else if (encoded.startsWith('O')) reply({ ok: true, json: encoded.slice(1) });
    else reply({ ok: false, code: 'BEHAVIOR_PROGRAM_RUNTIME_FAILED' });
  } finally {
    if (json?.alive) json.dispose();
    if (extension?.alive) extension.dispose();
    if (harness?.alive) harness.dispose();
    context.dispose();
    runtime.dispose();
  }
}

run().catch(() => reply({ ok: false, code: 'BEHAVIOR_PROGRAM_RUNTIME_FAILED' }));
