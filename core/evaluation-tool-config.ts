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
  contextMode: 'model-selected' | 'preloaded' | 'source-bound';
  approvalReasoningMode: 'configured' | 'economized';
  maximumToolRounds: number;
  terminalLateCorrections: boolean;
  metadataProfile?: EvaluationMetadataProfile;
};

export function defaultEvaluationToolOptions(): EvaluationToolOptions {
  return {
    contextMode: 'model-selected',
    approvalReasoningMode: 'configured',
    maximumToolRounds: 8,
    terminalLateCorrections: false,
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
  if (!['model-selected', 'preloaded', 'source-bound'].includes(String(input.contextMode)))
    throw new Error('INVALID_EVALUATION_TOOL_OPTIONS');
  if (!['configured', 'economized'].includes(String(input.approvalReasoningMode)))
    throw new Error('INVALID_EVALUATION_TOOL_OPTIONS');
  if (
    Object.hasOwn(input, 'metadataProfile') &&
    !['openai', 'anthropic', 'deepmind', 'neutral'].includes(String(input.metadataProfile))
  )
    throw new Error('INVALID_EVALUATION_TOOL_OPTIONS');
  if (
    !Number.isSafeInteger(input.maximumToolRounds) ||
    Number(input.maximumToolRounds) < 0 ||
    Number(input.maximumToolRounds) > 32
  )
    throw new Error('INVALID_EVALUATION_TOOL_OPTIONS');
  if (
    typeof input.terminalLateCorrections !== 'boolean' ||
    (Object.hasOwn(input, 'outputRecovery') && typeof input.outputRecovery !== 'boolean')
  )
    throw new Error('INVALID_EVALUATION_TOOL_OPTIONS');
  return {
    contextMode: input.contextMode as EvaluationToolOptions['contextMode'],
    approvalReasoningMode:
      input.approvalReasoningMode as EvaluationToolOptions['approvalReasoningMode'],
    maximumToolRounds: Number(input.maximumToolRounds),
    terminalLateCorrections: input.terminalLateCorrections,
    ...(Object.hasOwn(input, 'metadataProfile')
      ? { metadataProfile: input.metadataProfile as EvaluationMetadataProfile }
      : {}),
  };
}
