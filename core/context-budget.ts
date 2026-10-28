import { countTextTokens } from './text-tokens.js';
import { ProviderContractError } from './provider-errors.js';
import { modelCapability } from './model-capabilities.js';
import { isGeminiProtocol, type ProviderProtocol } from './product.js';
import { isTokenizerProfileId, type TokenizerProfileId } from './tokenizer-profiles.js';
import { plannedImageMetadata } from './provider-image-reference.js';
import { plannedFileMetadata } from './provider-file-reference.js';

export const DEFAULT_INPUT_TOKEN_LIMIT = 272_000;
export const MIN_INPUT_TOKEN_LIMIT = 8_192;
export const MAX_INPUT_TOKEN_LIMIT = 1_000_000;
export const CONTEXT_ESTIMATOR = 'o200k_base-v1' as const;
export const MODEL_CONTEXT_ESTIMATOR = 'model-local-v1' as const;
export type ContextBudget =
  | { inputTokenLimit: number; estimator: typeof CONTEXT_ESTIMATOR }
  | {
      inputTokenLimit: number;
      estimator: typeof MODEL_CONTEXT_ESTIMATOR;
      tokenizer: TokenizerProfileId;
    };

/** Host policy, never a provider generation parameter or an exact provider token count. */
export function validateContextBudget(value: unknown): ContextBudget {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    !Object.hasOwn(value, 'inputTokenLimit') ||
    !Object.hasOwn(value, 'estimator')
  ) {
    throw new ProviderContractError('INVALID_CONTEXT_BUDGET');
  }
  const budget = value as ContextBudget;
  if (
    !Number.isSafeInteger(budget.inputTokenLimit) ||
    budget.inputTokenLimit < MIN_INPUT_TOKEN_LIMIT ||
    budget.inputTokenLimit > MAX_INPUT_TOKEN_LIMIT
  ) {
    throw new ProviderContractError('INVALID_CONTEXT_BUDGET');
  }
  if (budget.estimator === CONTEXT_ESTIMATOR && Object.keys(value).length === 2)
    return { inputTokenLimit: budget.inputTokenLimit, estimator: CONTEXT_ESTIMATOR };
  if (
    budget.estimator === MODEL_CONTEXT_ESTIMATOR &&
    Object.keys(value).length === 3 &&
    Object.hasOwn(value, 'tokenizer') &&
    isTokenizerProfileId(budget.tokenizer)
  )
    return {
      inputTokenLimit: budget.inputTokenLimit,
      estimator: MODEL_CONTEXT_ESTIMATOR,
      tokenizer: budget.tokenizer,
    };
  throw new ProviderContractError('INVALID_CONTEXT_BUDGET');
}

export function contextBudgetForModel(model: {
  inputTokenLimit?: number;
  modelId?: string;
  maxOutputTokens?: number;
  tokenizer?: TokenizerProfileId;
  connection?: { protocol: ProviderProtocol };
}): ContextBudget {
  const configured = validateContextBudget({
    inputTokenLimit:
      model.inputTokenLimit === undefined ? DEFAULT_INPUT_TOKEN_LIMIT : model.inputTokenLimit,
    // Missing metadata belongs to a pre-tokenizer frozen snapshot. New snapshots
    // resolve auto when captured; never reinterpret an old continuation on replay.
    ...(model.tokenizer === undefined
      ? { estimator: CONTEXT_ESTIMATOR }
      : {
          estimator: MODEL_CONTEXT_ESTIMATOR,
          tokenizer: model.tokenizer,
        }),
  });
  const protocol = model.connection?.protocol;
  const capability =
    protocol && model.modelId ? modelCapability(protocol, model.modelId) : undefined;
  // These registered API families have reviewed windows. A routed/custom model or
  // the Codex app-server runtime never inherits a native API model's window.
  const window = isGeminiProtocol(capability?.protocol)
    ? 1_048_576
    : capability?.protocol === 'anthropic-messages-v1' ||
        capability?.protocol === 'deepseek-chat-v1'
      ? 1_000_000
      : capability?.protocol === 'openai-responses-v1' || capability?.protocol === 'openai-chat-v1'
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

/** Serialized request estimate plus 10% admission headroom, never billed usage.
 * An absent budget preserves the persisted o200k_base-v1 estimate.
 * Call countTextTokens for text-only sub-budgets so quoting and margin are not
 * charged per lore entry. The final request still passes this admission check.
 */
export function estimateContextTokens(value: unknown, budget?: ContextBudget): number {
  return estimateContextInput(value, budget).totalTokens;
}

/** Dimension-based admission allowance, not a documented model formula or billed token count. */
export function estimateContextInput(value: unknown, budget?: ContextBudget) {
  let serialized: string | undefined;
  let imageTokens = 0;
  let imageCount = 0;
  let knownFileTokens = 0;
  let fileCount = 0;
  let unknownFileCount = 0;
  try {
    serialized = JSON.stringify(value, (_key, item: unknown) => {
      const file = plannedFileMetadata(item);
      if (file) {
        fileCount++;
        if (file.tokenEstimate === undefined) unknownFileCount++;
        else knownFileTokens += Math.ceil((file.tokenEstimate * 11) / 10);
        return { type: 'file', kind: file.kind, bytes: file.bytes };
      }
      const image = plannedImageMetadata(item);
      if (!image) return item;
      imageCount++;
      imageTokens += Math.max(4096, Math.ceil((image.width * image.height * 2) / 750) + 1024);
      return { type: 'image', width: image.width, height: image.height };
    });
  } catch {
    throw new ProviderContractError('INVALID_CONTEXT_INPUT');
  }
  if (serialized === undefined) throw new ProviderContractError('INVALID_CONTEXT_INPUT');
  const checked = budget === undefined ? undefined : validateContextBudget(budget);
  const textTokens = Math.ceil(
    (countTextTokens(
      serialized,
      checked?.estimator === MODEL_CONTEXT_ESTIMATOR ? checked.tokenizer : undefined
    ) *
      11) /
      10
  );
  return {
    textTokens,
    imageTokens,
    imageCount,
    imageEstimate: imageCount ? ('conservative-dimensions-v1' as const) : null,
    fileTokens: unknownFileCount ? null : knownFileTokens,
    knownFileTokens,
    fileCount,
    unknownFileCount,
    fileTokensUnknown: unknownFileCount > 0,
    fileEstimate: fileCount
      ? unknownFileCount
        ? ('unknown' as const)
        : ('extracted-text-v1' as const)
      : null,
    totalTokens: textTokens + imageTokens + knownFileTokens,
  };
}

/** Fail before credentials, journaling or transmission; never edit a continuation to fit. */
export function assertContextBudget(body: unknown, budget?: ContextBudget): void {
  if (budget === undefined) return;
  const checked = validateContextBudget(budget);
  if (estimateContextTokens(body, checked) > checked.inputTokenLimit)
    throw new ProviderContractError('INPUT_CONTEXT_LIMIT_EXCEEDED');
}
