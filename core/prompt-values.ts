/** JSON data supplied by the host. No methods, prototypes, accessors or ambient IO. */
export type RuntimeValue =
  | string
  | number
  | boolean
  | null
  | RuntimeValue[]
  | { [key: string]: RuntimeValue };
export type PromptEvaluationLimits = {
  maxSteps?: number;
  maxMilliseconds?: number;
  maxOutputChars?: number;
  maxValueChars?: number;
  maxValueNodes?: number;
  maxCollectionLength?: number;
};
const caps = {
  maxSteps: 100_000,
  maxMilliseconds: 1000,
  maxOutputChars: 1_500_000,
  maxValueChars: 1_000_000,
  maxValueNodes: 30_000,
  maxCollectionLength: 2000,
} as const;
export const UNSAFE_PROMPT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
export class PromptEvaluationError extends Error {
  readonly statusCode = 400;
  constructor(readonly code: string) {
    super(code);
    this.name = 'PromptEvaluationError';
  }
}
export function evaluationFail(code: string): never {
  throw new PromptEvaluationError(code);
}

/** Shared by a whole compilation, including nested maps and all message blocks. */
export class PromptBudget {
  readonly limits: Required<PromptEvaluationLimits>;
  private steps = 0;
  private readonly started = performance.now();
  constructor(input: PromptEvaluationLimits = {}) {
    this.limits = { ...caps };
    for (const key of Object.keys(input) as (keyof PromptEvaluationLimits)[]) {
      if (
        !Object.hasOwn(caps, key) ||
        !Number.isSafeInteger(input[key]) ||
        input[key]! < 1 ||
        input[key]! > caps[key]
      )
        evaluationFail('PROMPT_INVALID_BUDGET');
      this.limits[key] = input[key]!;
    }
  }
  step(amount = 1): void {
    this.steps += amount;
    if (this.steps > this.limits.maxSteps) evaluationFail('PROMPT_STEP_LIMIT');
    if (performance.now() - this.started > this.limits.maxMilliseconds)
      evaluationFail('PROMPT_TIME_LIMIT');
  }
  textLength(length: number, output = false): void {
    if (length > (output ? this.limits.maxOutputChars : this.limits.maxValueChars))
      evaluationFail(output ? 'PROMPT_OUTPUT_LIMIT' : 'PROMPT_VALUE_LIMIT');
  }
  collection(length: number): void {
    if (length > this.limits.maxCollectionLength) evaluationFail('PROMPT_COLLECTION_LIMIT');
  }
}

/** Exact JSON string size, including escaped controls and lone UTF-16 surrogates. */
export function jsonStringSize(text: string, budget?: PromptBudget): number {
  let size = 2;
  for (let i = 0; i < text.length; i++) {
    if (i % 256 === 0) budget?.step();
    const code = text.charCodeAt(i);
    if (
      code === 34 ||
      code === 92 ||
      code === 8 ||
      code === 9 ||
      code === 10 ||
      code === 12 ||
      code === 13
    )
      size += 2;
    else if (code < 32) size += 6;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        size += 2;
        i++;
      } else size += 6;
    } else if (code >= 0xdc00 && code <= 0xdfff) size += 6;
    else size++;
    budget?.textLength(size);
  }
  return size;
}

/** Validate before cloning/stringifying so hostile or huge data is never materialized first. */
export function inspectRuntimeValue(
  value: unknown,
  budget = new PromptBudget()
): { nodes: number; chars: number } {
  const active = new Set<object>();
  const pending: { value: unknown; depth: number; leave?: boolean }[] = [{ value, depth: 0 }];
  let nodes = 0,
    chars = 0;
  while (pending.length) {
    budget.step();
    const item = pending.pop()!,
      v = item.value;
    if (item.leave) {
      active.delete(v as object);
      continue;
    }
    if (++nodes > budget.limits.maxValueNodes || item.depth > 32)
      evaluationFail('PROMPT_VALUE_LIMIT');
    if (v === null || typeof v === 'boolean') chars += 5;
    else if (typeof v === 'number') {
      if (!Number.isFinite(v)) evaluationFail('PROMPT_INVALID_RUNTIME_VALUE');
      chars += String(v).length;
    } else if (typeof v === 'string') {
      budget.textLength(v.length);
      chars += jsonStringSize(v, budget);
    } else if (typeof v === 'object') {
      if (active.has(v)) evaluationFail('PROMPT_CYCLIC_VALUE');
      if (Object.getOwnPropertySymbols(v).length) evaluationFail('PROMPT_INVALID_RUNTIME_VALUE');
      const array = Array.isArray(v),
        prototype = Object.getPrototypeOf(v);
      if (!array && prototype !== Object.prototype && prototype !== null)
        evaluationFail('PROMPT_INVALID_RUNTIME_VALUE');
      const keys = Object.keys(v);
      budget.collection(keys.length);
      if (array && keys.length !== v.length) evaluationFail('PROMPT_INVALID_RUNTIME_VALUE');
      active.add(v);
      pending.push({ value: v, depth: item.depth, leave: true });
      chars += 2;
      for (let i = keys.length - 1; i >= 0; i--) {
        const key = keys[i],
          descriptor = Object.getOwnPropertyDescriptor(v, key)!;
        if (
          !Object.hasOwn(descriptor, 'value') ||
          (!array && UNSAFE_PROMPT_KEYS.has(key)) ||
          (array && key !== String(i))
        )
          evaluationFail('PROMPT_INVALID_RUNTIME_VALUE');
        chars += array ? 1 : jsonStringSize(key, budget) + 2;
        pending.push({ value: descriptor.value, depth: item.depth + 1 });
      }
    } else evaluationFail('PROMPT_INVALID_RUNTIME_VALUE');
    budget.textLength(chars);
  }
  return { nodes, chars };
}
export function validateRuntimeValue(
  value: unknown,
  limits?: PromptEvaluationLimits
): RuntimeValue {
  inspectRuntimeValue(value, new PromptBudget(limits));
  return structuredClone(value) as RuntimeValue;
}
