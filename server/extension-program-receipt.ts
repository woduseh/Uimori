import { isDeepStrictEqual } from 'node:util';
import {
  EXTENSION_PROGRAM_API,
  validateExtensionProgramResult,
  type ExtensionProgramReceipt,
  type ExtensionProgramResult,
} from '../core/extension-program.js';
import { validateBehaviorValue, type BehaviorSchema } from '../core/package-behavior.js';
import type { RuntimeValue } from '../core/prompt-program.js';

export class ExtensionProgramReceiptError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ExtensionProgramReceiptError';
  }
}

function fail(code: string): never {
  throw new ExtensionProgramReceiptError(code);
}

function exactReceipt(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.getOwnPropertySymbols(value).length
  )
    fail('BEHAVIOR_PROGRAM_RECEIPT');
  const record = value as Record<string, unknown>;
  const fields = ['api', 'programHash', 'engine', 'state', 'result'];
  const names = Object.getOwnPropertyNames(record);
  if (names.length !== fields.length || fields.some((field) => !Object.hasOwn(record, field)))
    fail('BEHAVIOR_PROGRAM_RECEIPT_FIELDS');
  for (const name of names) {
    if (!fields.includes(name)) fail('BEHAVIOR_PROGRAM_RECEIPT_FIELDS');
    const descriptor = Object.getOwnPropertyDescriptor(record, name)!;
    if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable)
      fail('BEHAVIOR_PROGRAM_RECEIPT');
  }
  return record;
}

/**
 * Validates a host execution receipt against its frozen action and run entry.
 * This is deliberately structural: archive and commit paths never execute guest source.
 */
export function validateExtensionProgramReceipt(
  value: unknown,
  binding: {
    programHash: string;
    stateSchema: BehaviorSchema;
    state: RuntimeValue;
    result: RuntimeValue;
  }
): ExtensionProgramReceipt {
  const receipt = exactReceipt(value);
  if (receipt.api !== EXTENSION_PROGRAM_API) fail('BEHAVIOR_PROGRAM_RECEIPT_API');
  const programHash = receipt.programHash;
  if (typeof programHash !== 'string') fail('BEHAVIOR_PROGRAM_RECEIPT_HASH');
  if (!/^[a-f0-9]{64}$/u.test(programHash) || programHash !== binding.programHash)
    fail('BEHAVIOR_PROGRAM_RECEIPT_HASH');
  const engine = receipt.engine;
  if (typeof engine !== 'string') fail('BEHAVIOR_PROGRAM_RECEIPT_ENGINE');
  if (!engine.length || engine.length > 200) fail('BEHAVIOR_PROGRAM_RECEIPT_ENGINE');
  let output: ExtensionProgramResult;
  try {
    output = validateExtensionProgramResult({ state: receipt.state, result: receipt.result });
    validateBehaviorValue(binding.stateSchema, output.state);
  } catch {
    fail('BEHAVIOR_PROGRAM_RECEIPT_VALUE');
  }
  if (!isDeepStrictEqual(output!.state, binding.state)) fail('BEHAVIOR_PROGRAM_RECEIPT_STATE');
  if (!isDeepStrictEqual(output!.result, binding.result)) fail('BEHAVIOR_PROGRAM_RECEIPT_RESULT');
  return {
    api: EXTENSION_PROGRAM_API,
    programHash,
    engine,
    state: output!.state,
    result: output!.result,
  };
}
