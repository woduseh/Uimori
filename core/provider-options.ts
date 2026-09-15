/**
 * JSON options passed through to a provider-specific gateway. The host keeps this separate from
 * generation options so a model preset can carry native gateway settings without pretending that
 * every provider understands them.
 */
export type ProviderOptionValue =
  | null
  | boolean
  | number
  | string
  | ProviderOptionValue[]
  | { [key: string]: ProviderOptionValue };
export type ProviderOptions = { [key: string]: ProviderOptionValue };

export const PROVIDER_OPTIONS_MAX_CHARS = 100_000;

const sensitiveField =
  /^(authorization|api[_-]?key|credential|secret|password|access[_-]?token|refresh[_-]?token|bearer|private[_-]?key)$/iu;

export type ProviderOptionsErrorCode =
  | 'PROVIDER_OPTIONS_OBJECT'
  | 'PROVIDER_OPTIONS_JSON'
  | 'PROVIDER_OPTIONS_TOO_LARGE'
  | 'PROVIDER_OPTIONS_SENSITIVE_FIELD';

export class ProviderOptionsError extends Error {
  constructor(readonly code: ProviderOptionsErrorCode) {
    super(code);
    this.name = 'ProviderOptionsError';
  }
}

function fail(code: ProviderOptionsErrorCode): never {
  throw new ProviderOptionsError(code);
}

function safeObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  );
}

function visit(value: unknown, stack: WeakSet<object>, depth: number): void {
  if (depth > 32) fail('PROVIDER_OPTIONS_JSON');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('PROVIDER_OPTIONS_JSON');
    return;
  }
  if (typeof value !== 'object') fail('PROVIDER_OPTIONS_JSON');
  if (stack.has(value)) fail('PROVIDER_OPTIONS_JSON');
  stack.add(value);
  if (Array.isArray(value)) {
    for (const item of value) visit(item, stack, depth + 1);
  } else if (safeObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (sensitiveField.test(key)) fail('PROVIDER_OPTIONS_SENSITIVE_FIELD');
      visit(item, stack, depth + 1);
    }
  } else fail('PROVIDER_OPTIONS_JSON');
  stack.delete(value);
}

export function validateProviderOptions(value: unknown): asserts value is ProviderOptions {
  if (!safeObject(value)) fail('PROVIDER_OPTIONS_OBJECT');
  visit(value, new WeakSet<object>(), 0);
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    fail('PROVIDER_OPTIONS_JSON');
  }
  if (serialized.length > PROVIDER_OPTIONS_MAX_CHARS) fail('PROVIDER_OPTIONS_TOO_LARGE');
}

/** Empty advanced input means the Vercel request uses its normal routing policy. */
export function parseProviderOptionsText(text: string): ProviderOptions | undefined {
  if (!text.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('PROVIDER_OPTIONS_JSON');
  }
  validateProviderOptions(parsed);
  return structuredClone(parsed);
}
