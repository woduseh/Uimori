import { createHash } from 'node:crypto';
import { ExtensionProgramError, type ExtensionProgram } from '../core/extension-program.js';
import { HOST_TEXT_PAGE_DEFAULT, HOST_TEXT_PAGE_MAX, pageText } from '../core/paging.js';
import type { RuntimeValue } from '../core/prompt-values.js';
import type { ExtensionHostHandler } from './extension-runtime.js';

function fail(code: string): never {
  throw new ExtensionProgramError(code);
}

function exactArguments(value: RuntimeValue): Record<string, RuntimeValue> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.getOwnPropertySymbols(value).length
  )
    fail('BEHAVIOR_HOST_ARGUMENTS');
  const args = value as Record<string, RuntimeValue>;
  for (const key of Object.getOwnPropertyNames(args)) {
    if (!['offset', 'limit'].includes(key)) fail('BEHAVIOR_HOST_ARGUMENTS');
    const descriptor = Object.getOwnPropertyDescriptor(args, key)!;
    if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable)
      fail('BEHAVIOR_HOST_ARGUMENTS');
  }
  return args;
}

function integer(value: RuntimeValue | undefined, fallback: number, min: number, max: number) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    fail('BEHAVIOR_HOST_ARGUMENTS');
  return value;
}

/** Binds a program to a fixed copy of the just-completed response. */
export function createResponseExtensionHost(
  program: ExtensionProgram,
  text: string,
  assertCurrent: () => void
): ExtensionHostHandler {
  const permitted = program.capabilities?.includes('response.read.current') === true;
  const captured = text;
  const contentHash = createHash('sha256').update(captured).digest('hex');
  return async (method, value, signal): Promise<RuntimeValue> => {
    if (signal.aborted) fail('BEHAVIOR_HOST_ABORTED');
    if (!permitted || method !== 'response.read') fail('BEHAVIOR_HOST_DENIED');
    assertCurrent();
    if (signal.aborted) fail('BEHAVIOR_HOST_ABORTED');
    const args = exactArguments(value);
    const offset = integer(args.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = integer(args.limit, HOST_TEXT_PAGE_DEFAULT, 1, HOST_TEXT_PAGE_MAX);
    if (offset > captured.length) fail('BEHAVIOR_HOST_ARGUMENTS');
    return { ...pageText(captured, offset, limit), contentHash };
  };
}
