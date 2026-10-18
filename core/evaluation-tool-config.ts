import type { ProviderProtocol } from './product.js';

export type EvaluationMetadataProfile = 'openai' | 'anthropic' | 'deepmind' | 'neutral';

export function automaticEvaluationMetadataProfile(
  protocol: ProviderProtocol
): EvaluationMetadataProfile | undefined {
  switch (protocol) {
    case 'openai-responses-v1':
      return 'openai';
    case 'anthropic-messages-v1':
      return 'anthropic';
    case 'vertex-gemini-v1':
    case 'google-gemini-v1':
      return 'deepmind';
    default:
      return undefined;
  }
}

export function resolveEvaluationMetadataProfile(
  protocol: ProviderProtocol,
  manual: EvaluationMetadataProfile
): EvaluationMetadataProfile {
  return automaticEvaluationMetadataProfile(protocol) ?? manual;
}

/** Model-preset-owned evaluation tool settings. They do not select or configure a provider. */
export type EvaluationToolOptions = {
  contextMode: 'model-selected' | 'preloaded';
  approvalReasoningMode: 'configured' | 'economized';
  metadataProfile?: EvaluationMetadataProfile;
};

/** Nonterminal tool exchanges; a valid final submission is accepted after this limit. */
export const EVALUATION_TOOL_ROUND_LIMIT = 10;

export function defaultEvaluationToolOptions(): EvaluationToolOptions {
  return {
    contextMode: 'model-selected',
    approvalReasoningMode: 'configured',
    metadataProfile: 'neutral',
  };
}

export function validateEvaluationToolOptions(value: unknown): EvaluationToolOptions {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new Error('INVALID_EVALUATION_TOOL_OPTIONS');
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some(
      (key) =>
        ![
          'contextMode',
          'approvalReasoningMode',
          'maximumToolRounds',
          'terminalLateCorrections',
          'outputRecovery',
          'metadataProfile',
        ].includes(key)
    )
  )
    throw new Error('INVALID_EVALUATION_TOOL_OPTIONS');
  if (!['model-selected', 'preloaded'].includes(String(input.contextMode)))
    throw new Error('INVALID_EVALUATION_TOOL_OPTIONS');
  if (!['configured', 'economized'].includes(String(input.approvalReasoningMode)))
    throw new Error('INVALID_EVALUATION_TOOL_OPTIONS');
  if (
    Object.hasOwn(input, 'metadataProfile') &&
    !['openai', 'anthropic', 'deepmind', 'neutral'].includes(String(input.metadataProfile))
  )
    throw new Error('INVALID_EVALUATION_TOOL_OPTIONS');
  if (
    Object.hasOwn(input, 'maximumToolRounds') &&
    (!Number.isSafeInteger(input.maximumToolRounds) ||
      Number(input.maximumToolRounds) < 0 ||
      Number(input.maximumToolRounds) > 32)
  )
    throw new Error('INVALID_EVALUATION_TOOL_OPTIONS');
  if (
    (Object.hasOwn(input, 'terminalLateCorrections') &&
      typeof input.terminalLateCorrections !== 'boolean') ||
    (Object.hasOwn(input, 'outputRecovery') && typeof input.outputRecovery !== 'boolean')
  )
    throw new Error('INVALID_EVALUATION_TOOL_OPTIONS');
  return {
    contextMode: input.contextMode as EvaluationToolOptions['contextMode'],
    approvalReasoningMode:
      input.approvalReasoningMode as EvaluationToolOptions['approvalReasoningMode'],
    ...(Object.hasOwn(input, 'metadataProfile')
      ? { metadataProfile: input.metadataProfile as EvaluationMetadataProfile }
      : {}),
  };
}

/** Read old settings without restoring a retired mode or rewriting archived evidence. */
export function readEvaluationToolOptions(value: unknown): EvaluationToolOptions | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const input = value as Record<string, unknown>;
    if (input.contextMode === 'source-bound') {
      validateEvaluationToolOptions({ ...input, contextMode: 'model-selected' });
      return undefined;
    }
  }
  return validateEvaluationToolOptions(value);
}
