import type { RuntimeValue } from './prompt-values.js';
import { inspectRuntimeValue, PromptBudget } from './prompt-values.js';

export const EXTENSION_PROGRAM_API = 'uimori-state-action-v1' as const;
export const EXTENSION_PROGRAM_MAX_SOURCE_CHARS = 512 * 1024;
export const EXTENSION_PROGRAM_MAX_RESULT_CHARS = 8_000;
/** JSON character cap; the guest runtime separately enforces a stricter 128 KiB UTF-8 cap. */
export const EXTENSION_PROGRAM_MAX_VALUE_CHARS = 128 * 1024;
export const EXTENSION_CAPABILITIES = [
  'materials.read.self',
  'model.generate',
  'response.read.current',
  'variables.read',
  'variables.write',
] as const;
export const EXTENSION_GRANT_CAPABILITIES = ['model.generate', 'variables.write'] as const;
export type ExtensionGrantCapability = (typeof EXTENSION_GRANT_CAPABILITIES)[number];

export interface ExtensionProgram {
  api: typeof EXTENSION_PROGRAM_API;
  /** Omitted in existing packages; JavaScript remains the default without rewriting old hashes. */
  language?: 'javascript' | 'lua';
  /** Requested native capabilities. The host independently binds their scope per invocation. */
  capabilities?: (typeof EXTENSION_CAPABILITIES)[number][];
  /** Function body evaluated by a host-owned isolated guest runtime. */
  source: string;
}

export interface ExtensionProgramResult {
  state: RuntimeValue;
  result: RuntimeValue;
}

/** Host-only execution result. The API is copied from the action into the durable receipt. */
export interface ResolvedExtensionProgram extends ExtensionProgramResult {
  programHash: string;
  engine: string;
  /** Added only by the Host broker; a guest cannot return effects or authority. */
  variables?: import('./chat-variables.js').ChatVariableMutation;
}

export interface ExtensionProgramReceipt extends ResolvedExtensionProgram {
  api: typeof EXTENSION_PROGRAM_API;
}

export class ExtensionProgramError extends Error {
  readonly statusCode = 400;
  constructor(readonly code: string) {
    super(code);
    this.name = 'ExtensionProgramError';
  }
}

function fail(code: string): never {
  throw new ExtensionProgramError(code);
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = []
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.getOwnPropertySymbols(value).length
  )
    fail('BEHAVIOR_PROGRAM_EXPECTED_RECORD');
  const record = value as Record<string, unknown>;
  const allowed = [...required, ...optional];
  const names = Object.getOwnPropertyNames(record);
  if (required.some((key) => !Object.hasOwn(record, key))) fail('BEHAVIOR_PROGRAM_FIELDS');
  for (const key of names) {
    if (!allowed.includes(key)) fail('BEHAVIOR_PROGRAM_FIELDS');
    const descriptor = Object.getOwnPropertyDescriptor(record, key)!;
    if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable)
      fail('BEHAVIOR_PROGRAM_EXPECTED_RECORD');
  }
  return record;
}

export function validateExtensionProgram(value: unknown): ExtensionProgram {
  const program = exactRecord(value, ['api', 'source'], ['capabilities', 'language']);
  if (program.api !== EXTENSION_PROGRAM_API) fail('BEHAVIOR_PROGRAM_API');
  if (
    Object.hasOwn(program, 'language') &&
    program.language !== 'javascript' &&
    program.language !== 'lua'
  )
    fail('BEHAVIOR_PROGRAM_LANGUAGE');
  if (
    typeof program.source !== 'string' ||
    !program.source.length ||
    program.source.length > EXTENSION_PROGRAM_MAX_SOURCE_CHARS
  )
    fail('BEHAVIOR_PROGRAM_SOURCE_SIZE');
  if (Object.hasOwn(program, 'capabilities')) {
    // Validate plain JSON before inspecting author-provided collections/getters.
    try {
      inspectRuntimeValue(program.capabilities, new PromptBudget({}, 'deterministic'));
    } catch {
      fail('BEHAVIOR_PROGRAM_CAPABILITIES');
    }
    if (
      !Array.isArray(program.capabilities) ||
      program.capabilities.length > EXTENSION_CAPABILITIES.length ||
      new Set(program.capabilities).size !== program.capabilities.length ||
      program.capabilities.some((capability) => !EXTENSION_CAPABILITIES.includes(capability))
    )
      fail('BEHAVIOR_PROGRAM_CAPABILITIES');
  }
  return structuredClone(program) as unknown as ExtensionProgram;
}

/** Validates guest output as bounded plain JSON. State-schema validation remains host-owned. */
export function validateExtensionProgramResult(value: unknown): ExtensionProgramResult {
  const output = exactRecord(value, ['state', 'result']);
  const budget = new PromptBudget(
    {
      maxValueChars: EXTENSION_PROGRAM_MAX_VALUE_CHARS,
      maxValueNodes: 30_000,
      maxCollectionLength: 2_000,
      maxSteps: 100_000,
    },
    'deterministic'
  );
  try {
    inspectRuntimeValue(output, budget);
    inspectRuntimeValue(
      output.result,
      new PromptBudget(
        {
          maxValueChars: EXTENSION_PROGRAM_MAX_RESULT_CHARS,
          maxValueNodes: 30_000,
          maxCollectionLength: 2_000,
          maxSteps: 100_000,
        },
        'deterministic'
      )
    );
  } catch {
    fail('BEHAVIOR_PROGRAM_RESULT_VALUE');
  }
  if (JSON.stringify(output.result).length > EXTENSION_PROGRAM_MAX_RESULT_CHARS)
    fail('BEHAVIOR_RESULT_SIZE');
  return structuredClone(output) as unknown as ExtensionProgramResult;
}
