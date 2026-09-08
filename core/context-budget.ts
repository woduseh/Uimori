import { get_encoding, type Tiktoken } from 'tiktoken';
import { ProviderContractError } from './provider-errors.js';
import { modelCapability } from './model-capabilities.js';
import type { ProviderProtocol } from './product.js';

export const DEFAULT_INPUT_TOKEN_LIMIT = 272_000;
export const MIN_INPUT_TOKEN_LIMIT = 8_192;
export const MAX_INPUT_TOKEN_LIMIT = 1_000_000;
export const CONTEXT_ESTIMATOR = 'o200k_base-v1' as const;
export type ContextBudget = { inputTokenLimit: number; estimator: typeof CONTEXT_ESTIMATOR };

/** Host policy, never a provider generation parameter or an exact provider token count. */
export function validateContextBudget(value: unknown): ContextBudget {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, 'inputTokenLimit') ||
    !Object.hasOwn(value, 'estimator')
  ) {
    throw new ProviderContractError('INVALID_CONTEXT_BUDGET');
  }
  const budget = value as ContextBudget;
  if (
    budget.estimator !== CONTEXT_ESTIMATOR ||
    !Number.isSafeInteger(budget.inputTokenLimit) ||
    budget.inputTokenLimit < MIN_INPUT_TOKEN_LIMIT ||
    budget.inputTokenLimit > MAX_INPUT_TOKEN_LIMIT
  ) {
    throw new ProviderContractError('INVALID_CONTEXT_BUDGET');
  }
  return { inputTokenLimit: budget.inputTokenLimit, estimator: CONTEXT_ESTIMATOR };
}

export function contextBudgetForModel(model: {
  inputTokenLimit?: number;
  modelId?: string;
  maxOutputTokens?: number;
  connection?: { protocol: ProviderProtocol };
}): ContextBudget {
  const configured = validateContextBudget({
    inputTokenLimit:
      model.inputTokenLimit === undefined ? DEFAULT_INPUT_TOKEN_LIMIT : model.inputTokenLimit,
    estimator: CONTEXT_ESTIMATOR,
  });
  const protocol = model.connection?.protocol;
  const capability =
    protocol && model.modelId ? modelCapability(protocol, model.modelId) : undefined;
  // These registered API families have reviewed windows. A routed/custom model or
  // the Codex app-server runtime never inherits a native API model's window.
  const window =
    capability?.protocol === 'vertex-gemini-v1'
      ? 1_048_576
      : capability?.protocol === 'anthropic-messages-v1' ||
          capability?.protocol === 'deepseek-chat-v1'
        ? 1_000_000
        : capability?.protocol === 'openai-responses-v1' ||
            capability?.protocol === 'openai-chat-v1'
          ? 1_050_000
          : undefined;
  if (window === undefined) return configured;
  const reservedOutput = model.maxOutputTokens ?? capability!.maxOutputTokens;
  if (
    !Number.isSafeInteger(reservedOutput) ||
    reservedOutput < 1 ||
    reservedOutput > capability!.maxOutputTokens
  )
    throw new ProviderContractError('INVALID_CONTEXT_BUDGET');
  return validateContextBudget({
    ...configured,
    inputTokenLimit: Math.min(
      configured.inputTokenLimit,
      window - reservedOutput,
      MAX_INPUT_TOKEN_LIMIT
    ),
  });
}

let tokenizer: Tiktoken | undefined;
/** Offline o200k estimate of the serialized final body, with 10% host safety margin.
 * Provider framing and other model tokenizers can differ. This is not billable usage.
 */
export function estimateContextTokens(value: unknown): number {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new ProviderContractError('INVALID_CONTEXT_INPUT');
  }
  if (serialized === undefined) throw new ProviderContractError('INVALID_CONTEXT_INPUT');
  tokenizer ??= get_encoding('o200k_base');
  // Special-token spellings in authored text are ordinary text, not tokenizer controls.
  // BPE on a single huge repeated word can be quadratic even in the native tokenizer.
  // Bounded UTF-16 spans keep admission responsive; boundary differences remain an estimate.
  const pieces = new Map<string, number>();
  let tokens = 0;
  for (let start = 0; start < serialized.length; ) {
    let end = Math.min(serialized.length, start + 4096);
    if (
      end < serialized.length &&
      /[\uD800-\uDBFF]/u.test(serialized[end - 1]) &&
      /[\uDC00-\uDFFF]/u.test(serialized[end])
    )
      end--;
    const piece = serialized.slice(start, end);
    let count = pieces.get(piece);
    if (count === undefined) {
      count = tokenizer.encode(piece, [], []).length;
      pieces.set(piece, count);
    }
    tokens += count;
    start = end;
  }
  return Math.ceil((tokens * 11) / 10);
}

/** Fail before credentials, journaling or transmission; never edit a continuation to fit. */
export function assertContextBudget(body: unknown, budget?: ContextBudget): void {
  if (budget === undefined) return;
  const checked = validateContextBudget(budget);
  if (estimateContextTokens(body) > checked.inputTokenLimit)
    throw new ProviderContractError('INPUT_CONTEXT_LIMIT_EXCEEDED');
}
